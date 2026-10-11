/**
 * Phigros 4.0 第九章「噪域/红区」（官方谱面 JSON 顶层 `blockAreaList`）。
 *
 * 语义依据（均为对官方客户端逆向所得的公开描述，代码为本仓库独立实现）：
 *  - percentage 相对整个渲染视口（非 6 轨判定区），原点左下、y 向上，可超界；
 *  - 四时间点均为音乐秒（不做 BPM 换算）：appear..disappear 为可见区间，
 *    enable..disable 为 Active（吃触点），其余显示时段为 Disabled（暗态不判定）；
 *  - isSubtract 是判定奇偶 XOR 的一部分：触点被阻挡 ⇔
 *    (普通块覆盖) XOR (减算块覆盖数为奇数)，且对原始矩形与内缩矩形都成立；
 *  - 手指进入 Active 块即「染色」：整根手指从触点列表移除直至松手
 *    （移出区域不解除、区域失效不解除），其下音符全部走正常 miss 流程。
 *  - move 事件的 endPosition 是方块中心的绝对目标；scale/rotate 围绕各自 anchor；
 *    官方动画顺序：已完成的 scale/rotate 关键帧 anchor 累积偏移 → 当前段插值 →
 *    最后 center += moveTarget - originalCenter（move 不破坏 anchor 累积）。
 */
import { blockEase } from "./ease";
import { DEFAULT_BLOCK_FILL, parseBlockFill } from "./color";
import shared from "@utils/js/shared";
import { simphiPlayer } from "../../playerMain";

/** 官方 JudgeControl.maxBlockTouchInsetLocal */
const TOUCH_INSET_LOCAL = 0.05;
/** 官方 JudgeControl.blockTouchInsetScreenHeightRatio（同时也是单轴占比上限） */
const TOUCH_INSET_RATIO = 0.25;
/** DisabledBlockShow 渐显时长（官方预制体常量） */
const FADE_IN = 0.5;

/**
 * 噪域填充色（仅视觉，判定不受影响）。可在设置页用取色盘改（`blockAreaColor`），
 * 默认 rgb(77,34,32)：官方材质 _FillColor 是 rgb(182,60,60)，实机观感偏浅，按用户要求加深。
 */
export { DEFAULT_BLOCK_FILL, parseBlockFill, toColorInputValue, toRgbText } from "./color";
export type { BlockFill } from "./color";
let cachedColorKey: unknown = null;
let cachedColorValue: readonly [number, number, number] = DEFAULT_BLOCK_FILL;

/**
 * 读当前配置色。设置页每帧都可能被读到，用「配置字符串」作缓存键，
 * 避免逐帧解析；配置未变时连字符串比较都省掉常见分支。
 */
export function resolveBlockFill(): readonly [number, number, number] {
    const raw = shared.game?.ptmain?.gameConfig?.blockAreaColor;
    if (raw === cachedColorKey) return cachedColorValue;
    cachedColorKey = raw;
    cachedColorValue = parseBlockFill(raw);
    return cachedColorValue;
}

interface Vec2 {
    x: number;
    y: number;
}

interface PctEvent {
    anchor?: Vec2; // rotate/scale
    endPosition?: Vec2; // move
    time: number;
    easeType?: number; // rotate
    easeTypeX?: number; // move/scale
    easeTypeY?: number; // move/scale
    rotation?: number; // rotate
    scale?: Vec2; // scale
}

interface RawArea {
    topRightPercentage?: Vec2;
    bottomLeftPercentage?: Vec2;
    appearTime?: number;
    enableTime?: number;
    disableTime?: number;
    disappearTime?: number;
    isSubtract?: boolean;
    rotateEvents?: (PctEvent | null)[];
    moveEvents?: (PctEvent | null)[];
    scaleEvents?: (PctEvent | null)[];
}

/** 求值后的矩形：中心 + 半尺寸 + 逆时针角度（弧度）。chart 空间 y 向上。 */
interface Rect {
    cx: number;
    cy: number;
    hx: number;
    hy: number;
    rot: number;
}

export interface ResolvedArea {
    id: number;
    appearTime: number;
    enableTime: number;
    disableTime: number;
    disappearTime: number;
    isSubtract: boolean;
    /** 出现时还不是 Active 才有 0.5s 渐显（官方 fades_in 语义） */
    fadesIn: boolean;
    bottomLeftPct: Vec2;
    topRightPct: Vec2;
    rotateEvents: PctEvent[];
    moveEvents: PctEvent[];
    scaleEvents: PctEvent[];
}

function pctToChartX(x: number): number {
    return 2 * x - 1;
}

function lastIndexOf(events: PctEvent[], t: number): number {
    // 官方 FindCurrentEventIndex：最后一个 time <= t 的下标；t 在首个事件前返回 -1
    let lo = 0;
    let hi = events.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].time <= t) {
            found = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return found;
}

function interpolate(a: number, b: number, progress: number): number {
    return a + progress * (b - a);
}

function normalize(cur: number, next: number, t: number): number {
    return next <= cur ? 1 : (t - cur) / (next - cur);
}

export class BlockAreaSystem {
    private areas: ResolvedArea[] = [];
    /** 时间窗事件 (time, areaId, appears)；加载时排序，运行时游标推进 */
    private timeline: [number, number, boolean][] = [];
    private cursor = 0;
    private timelineTime: number | null = null;
    private visible: number[] = [];
    private visibleSet = new Set<number>();
    /** 本帧 Active 且覆盖判定的块（判定用，与渲染共享同一份求值） */
    private activeIds: number[] = [];
    private evaluatedTime = NaN;
    private evaluatedAspect = 0;
    private rectCache = new Map<number, Rect>();
    /** 已被染色的触点 id（手指级生命周期，松手由 HitManager 移除触点自然失效） */
    private infected = new Set<string | number>();
    /** 本帧被挡的触点（渲染层画白圈用，下一帧覆盖） */
    blockedTouches: { id: string | number; x: number; y: number }[] = [];
    /** 本帧是否存在被挡触点（闷音等功能后续轮次用） */
    anyBlocked = false;
    /** 触点判定坐标系宽高比：canvasos 宽 / 高（含镜像校正已在调用侧完成） */
    private touchAspect = 16 / 9;

    /** 触点坐标系的宽高比：视口像素宽高比。resize 时更新。 */
    setTouchAspect(width: number, height: number): void {
        if (width > 0 && height > 0) this.touchAspect = width / height;
    }

    /** 按官方 serde default 归一化；非法条目丢弃。空列表 = 整体 inert。 */
    load(raw: RawArea[] | null | undefined): void {
        this.areas = [];
        this.timeline = [];
        this.reset();
        if (!Array.isArray(raw) || !raw.length) return;
        raw.forEach((area, id) => {
            if (!area || typeof area !== "object") return;
            const bl = area.bottomLeftPercentage;
            const tr = area.topRightPercentage;
            if (!bl || !tr) return;
            const appearTime = Number(area.appearTime) || 0;
            const enableTime = Number(area.enableTime) || 0;
            const disableTime = Number(area.disableTime) || 0;
            const disappearTime = Number(area.disappearTime) || 0;
            const resolved: ResolvedArea = {
                id: this.areas.length,
                appearTime,
                enableTime,
                disableTime,
                disappearTime,
                isSubtract: area.isSubtract === true,
                fadesIn: !(enableTime <= appearTime && appearTime < disableTime),
                bottomLeftPct: { x: Number(bl.x) || 0, y: Number(bl.y) || 0 },
                topRightPct: { x: Number(tr.x) || 0, y: Number(tr.y) || 0 },
                rotateEvents: (area.rotateEvents || []).filter(
                    e => e && typeof e.time === "number"
                ) as PctEvent[],
                moveEvents: (area.moveEvents || []).filter(
                    e => e && typeof e.time === "number"
                ) as PctEvent[],
                scaleEvents: (area.scaleEvents || []).filter(
                    e => e && typeof e.time === "number"
                ) as PctEvent[],
            };
            this.areas.push(resolved);
            // 时间窗只按可见区间建事件（Hidden 块不参与判定与渲染）
            if (resolved.appearTime < resolved.disappearTime) {
                this.timeline.push([resolved.appearTime, resolved.id, true]);
                this.timeline.push([resolved.disappearTime, resolved.id, false]);
            }
        });
        // appear 升序、同刻先出后进（与 Phira-Pro 事件表排序一致）
        this.timeline.sort((a, b) => a[0] - b[0] || a[1] - b[1] || Number(a[2]) - Number(b[2]));
    }

    /** 谱面是否存在噪域（false 时所有路径零开销） */
    get hasAreas(): boolean {
        return this.areas.length > 0;
    }

    /** 停止游玩/重开时清空运行态 */
    reset(): void {
        this.cursor = 0;
        this.timelineTime = null;
        this.visible = [];
        this.visibleSet.clear();
        this.activeIds = [];
        this.evaluatedTime = NaN;
        this.evaluatedAspect = 0;
        this.rectCache.clear();
        this.infected.clear();
        this.blockedTouches = [];
        this.anyBlocked = false;
    }

    phase(t: number, area: ResolvedArea): "hidden" | "active" | "disabled" {
        if (t < area.appearTime || t >= area.disappearTime) return "hidden";
        if (t >= area.enableTime && t < area.disableTime) return "active";
        return "disabled";
    }

    /**
     * 推进时间窗并求值本帧 Active 集合。判定与渲染都从这里拿数据，
     * 同一帧内重复调用（先判定后绘制）走缓存，不重算几何。
     */
    update(timeBgm: number): void {
        if (!this.hasAreas) return;
        const aspect = this.touchAspect;
        if (this.timelineTime !== null && timeBgm < this.timelineTime) {
            // 回放 seek：时间回退，整体重扫
            this.visibleSet.clear();
            this.cursor = 0;
        }
        const end = this.partitionPoint(timeBgm);
        while (this.cursor < end) {
            const [, id, appears] = this.timeline[this.cursor];
            if (appears) this.visibleSet.add(id);
            else this.visibleSet.delete(id);
            this.cursor++;
        }
        this.timelineTime = timeBgm;
        if (timeBgm !== this.evaluatedTime || aspect !== this.evaluatedAspect) {
            this.evaluatedTime = timeBgm;
            this.evaluatedAspect = aspect;
            this.rectCache.clear();
            this.activeIds = [];
            for (const id of this.visibleSet) {
                const area = this.areas[id];
                if (this.phase(timeBgm, area) === "active") this.activeIds.push(id);
            }
            // 事件索引顺序即 area id 升序，奇偶计数与遍历顺序无关，但保持稳定
            this.activeIds.sort((a, b) => a - b);
        }
        this.blockedTouches = [];
        this.anyBlocked = false;
        const hits = simphiPlayer.hitManager.list;
        if (!this.activeIds.length) {
            // 无活跃块也要做松手清理（见下方 lift 语义）
            this.pruneInfected(hits);
            return;
        }
        for (let i = hits.length - 1; i >= 0; i--) {
            const hit = hits[i];
            // fullScreenJudge 下触点无位置语义，跳过染色（官方无此输入形态）
            if (!shared.game.ptmain.gameConfig.fullScreenJudge && hit.type !== "keyboard") {
                const p = this.touchToChart(hit.offsetX, hit.offsetY);
                if (this.pointBlocked(p.x, p.y, timeBgm)) {
                    this.infected.add(hit.id);
                }
            }
            if (this.infected.has(hit.id)) {
                // 手指级染色：从触点列表移除；其下音符全部走正常 miss 流程。
                // HitEvent 只在 activate 时重新入列，松手/新按会重置，等价
                // Phira-Pro 的 infected HashSet + touches.retain。
                this.blockedTouches.push({ id: hit.id, x: hit.offsetX, y: hit.offsetY });
                hits.splice(i, 1);
                this.anyBlocked = true;
            }
        }
        this.pruneInfected(hits);
    }

    /**
     * 松手（Ended/Cancelled）语义：官方在 Started/Ended/Cancelled 时清感染。
     * 本引擎的触点在松手后整帧不在 hitManager.list 里，因此「上一帧被染、
     * 本帧不在列表」的手指视为已松手，清除其染色；重新按下（Started）由
     * HitManager 以同一 id 新建触点，若按下点仍在块内会立刻重新染上。
     */
    private pruneInfected(hits: { id: string | number }[]): void {
        if (!this.infected.size) return;
        const present = new Set(hits.map(h => h.id));
        for (const id of this.infected) {
            if (!present.has(id)) this.infected.delete(id);
        }
    }

    /** 触点像素坐标（canvasos 位图系，y 向下）→ chart 空间（y 向上，x 居中原点）。 */
    touchToChart(px: number, py: number): Vec2 {
        const { wlen, hlen } = simphiPlayer.app;
        // 镜像视图下绘制与判定同链：x 翻转后与 drawBlockAreas 的视图一致
        const flipX = simphiPlayer.app["_mirrorType"] & 1 ? -1 : 1;
        return { x: (flipX * (px - wlen)) / wlen, y: (hlen - py) / hlen };
    }

    private partitionPoint(time: number): number {
        let lo = 0;
        let hi = this.timeline.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.timeline[mid][0] <= time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    private rectAt(area: ResolvedArea, t: number): Rect {
        const cached = this.rectCache.get(area.id);
        if (cached) return cached;
        const aspect = this.evaluatedAspect || this.touchAspect;
        const bx = pctToChartX(area.bottomLeftPct.x);
        const by = (2 * area.bottomLeftPct.y - 1) / aspect;
        const tx = pctToChartX(area.topRightPct.x);
        const ty = (2 * area.topRightPct.y - 1) / aspect;
        const baseCx = (bx + tx) / 2;
        const baseCy = (by + ty) / 2;
        const baseHx = Math.abs(tx - bx) / 2;
        const baseHy = Math.abs(ty - by) / 2;
        const scale = this.scaleAt(area, t);
        const rotationDeg = this.rotateAt(area, t);
        let cx = baseCx;
        let cy = baseCy;
        // 官方顺序：已完成关键帧的 anchor 累积偏移 → 当前段插值 → move 补偿
        const si = lastIndexOf(area.scaleEvents, t);
        if (si >= 0) {
            for (let k = 0; k < si; k++) {
                const cur = area.scaleEvents[k];
                const anchor = this.pctToChart(cur.anchor);
                cx = scaleCenterX(cx, anchor.x, this.scaleAt(area, area.scaleEvents[k + 1].time).x, scale.x);
                cy = scaleCenterY(cy, anchor.y, this.scaleAt(area, area.scaleEvents[k + 1].time).y, scale.y);
            }
            if (si + 1 < area.scaleEvents.length) {
                const anchor = this.pctToChart(area.scaleEvents[si].anchor);
                cx = scaleCenterX(cx, anchor.x, scale.x, this.scaleAt(area, t).x);
                cy = scaleCenterY(cy, anchor.y, scale.y, this.scaleAt(area, t).y);
            }
        }
        const ri = lastIndexOf(area.rotateEvents, t);
        if (ri >= 0) {
            for (let k = 0; k < ri; k++) {
                const cur = area.rotateEvents[k];
                const anchor = this.pctToChart(cur.anchor);
                const nextRot = area.rotateEvents[k + 1].rotation ?? 0;
                const curRot = cur.rotation ?? 0;
                const d = (nextRot - curRot) * (Math.PI / 180);
                const dx = cx - anchor.x;
                const dy = cy - anchor.y;
                cx = anchor.x + dx * Math.cos(d) - dy * Math.sin(d);
                cy = anchor.y + dx * Math.sin(d) + dy * Math.cos(d);
            }
            if (ri + 1 < area.rotateEvents.length) {
                const anchor = this.pctToChart(area.rotateEvents[ri].anchor);
                const curRot = area.rotateEvents[ri].rotation ?? 0;
                const d = (rotationDeg - curRot) * (Math.PI / 180);
                const dx = cx - anchor.x;
                const dy = cy - anchor.y;
                cx = anchor.x + dx * Math.cos(d) - dy * Math.sin(d);
                cy = anchor.y + dx * Math.sin(d) + dy * Math.cos(d);
            }
        }
        const moveTarget = this.moveCenterAt(area, t);
        if (moveTarget) {
            cx += moveTarget.x - baseCx;
            cy += moveTarget.y - baseCy;
        }
        const rect: Rect = {
            cx,
            cy,
            hx: baseHx * Math.abs(scale.x),
            hy: baseHy * Math.abs(scale.y),
            rot: (rotationDeg * Math.PI) / 180,
        };
        this.rectCache.set(area.id, rect);
        return rect;
    }

    private scaleAt(area: ResolvedArea, t: number): Vec2 {
        const ev = area.scaleEvents;
        if (!ev.length) return { x: 1, y: 1 };
        const i = lastIndexOf(ev, t);
        if (i < 0) return { x: 1, y: 1 };
        if (i + 1 >= ev.length) return { x: ev[i].scale?.x ?? 1, y: ev[i].scale?.y ?? 1 };
        const cur = ev[i];
        const next = ev[i + 1];
        const px = blockEase(cur.easeTypeX ?? 0, normalize(cur.time, next.time, t));
        const py = blockEase(cur.easeTypeY ?? 0, normalize(cur.time, next.time, t));
        return {
            x: interpolate(cur.scale?.x ?? 1, next.scale?.x ?? 1, px),
            y: interpolate(cur.scale?.y ?? 1, next.scale?.y ?? 1, py),
        };
    }

    private rotateAt(area: ResolvedArea, t: number): number {
        const ev = area.rotateEvents;
        if (!ev.length) return 0;
        const i = lastIndexOf(ev, t);
        if (i < 0) return 0;
        if (i + 1 >= ev.length) return ev[i].rotation ?? 0;
        const cur = ev[i];
        const next = ev[i + 1];
        const p = blockEase(cur.easeType ?? 0, normalize(cur.time, next.time, t));
        return interpolate(cur.rotation ?? 0, next.rotation ?? 0, p);
    }

    private moveCenterAt(area: ResolvedArea, t: number): Vec2 | null {
        const ev = area.moveEvents;
        if (!ev.length) return null;
        const i = lastIndexOf(ev, t);
        if (i < 0) return null;
        const e = ev[i];
        let x = e.endPosition?.x ?? 0;
        let y = e.endPosition?.y ?? 0;
        if (i + 1 < ev.length) {
            const next = ev[i + 1];
            const px = blockEase(e.easeTypeX ?? 0, normalize(e.time, next.time, t));
            const py = blockEase(e.easeTypeY ?? 0, normalize(e.time, next.time, t));
            x = interpolate(x, next.endPosition?.x ?? 0, px);
            y = interpolate(y, next.endPosition?.y ?? 0, py);
        }
        return { x: pctToChartX(x), y: (2 * y - 1) / (this.evaluatedAspect || this.touchAspect) };
    }

    private pctToChart(p?: Vec2): Vec2 {
        return {
            x: pctToChartX(p?.x ?? 0),
            y: (2 * (p?.y ?? 0) - 1) / (this.evaluatedAspect || this.touchAspect),
        };
    }

    /** chart 空间点是否被阻挡：奇偶 XOR + 原始/内缩双重校验。 */
    pointBlocked(px: number, py: number, t: number): boolean {
        const aspect = this.evaluatedAspect || this.touchAspect;
        const insetWorld = (TOUCH_INSET_LOCAL * 2) / aspect;
        let origNon = false;
        let origSub = 0;
        let insNon = false;
        let insSub = 0;
        for (const id of this.activeIds) {
            const area = this.areas[id];
            if (this.contains(area, px, py, t, 0, aspect)) {
                if (area.isSubtract) origSub++;
                else origNon = true;
            }
            if (this.contains(area, px, py, t, insetWorld, aspect)) {
                if (area.isSubtract) insSub++;
                else insNon = true;
            }
        }
        return (origNon ? 1 : 0) !== (origSub & 1) && (insNon ? 1 : 0) !== (insSub & 1);
    }

    private contains(
        area: ResolvedArea,
        px: number,
        py: number,
        t: number,
        insetWorld: number,
        aspect: number
    ): boolean {
        const rect = this.rectAt(area, t);
        // 旋转到块本地坐标
        const cos = Math.cos(-rect.rot);
        const sin = Math.sin(-rect.rot);
        const dx = px - rect.cx;
        const dy = py - rect.cy;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        // 官方 TryGetBlockTouchHalfSize：内缩/外扩单轴占比 clamp 0.25
        const sign = area.isSubtract ? 1 : -1;
        const insetX = Math.min((insetWorld / Math.max(rect.hx * 2, 1e-6)) as number, TOUCH_INSET_RATIO);
        const insetY = Math.min(insetWorld / Math.max(rect.hy * 2, 1e-6), TOUCH_INSET_RATIO);
        const hx = 0.5 + sign * insetX;
        const hy = 0.5 + sign * insetY;
        return Math.abs(lx) <= hx * rect.hx * 2 && Math.abs(ly) <= hy * rect.hy * 2;
    }

    /** 渲染入口：返回本帧可见块（Hidden 除外）。 */
    visibleAreas(): { area: ResolvedArea; rect: Rect; t: number }[] {
        if (!this.hasAreas) return [];
        const t = this.evaluatedTime;
        if (Number.isNaN(t)) return [];
        const result = [];
        for (const id of this.visibleSet) {
            const area = this.areas[id];
            result.push({ area, rect: this.rectAt(area, t), t });
        }
        return result;
    }
}

function scaleCenterX(center: number, anchor: number, next: number, current: number): number {
    const div = Math.abs(current) < 1e-6 ? 1 : next / current;
    return anchor + div * (center - anchor);
}

function scaleCenterY(center: number, anchor: number, next: number, current: number): number {
    return scaleCenterX(center, anchor, next, current);
}
