/**
 * 噪域 CPU 扫描线渲染（Chrome 89 / TBS WebView 兼容，不用 WebGL/FBO）。
 *
 * 思路同 Phira-Pro 的极简路径（block_simple.rs）：把每块矩形拆成扫描带，
 * 带内做左右区间合并，普通/减算覆盖按官方 parity（奇偶 XOR）合成；
 * 视觉反转只在恰好 1 层减算时发生（双层减算互相抵消 → 无覆盖）。
 * 不做逐像素 destination-out —— 那是 GPU 材质路径的近似，语义不精确。
 */
import { simphiPlayer } from "../../playerMain";
import { BLOCK_FILL } from "./index";

const DISABLED_FILL_ALPHA = 0.4; // 官方 uDisabledFillOpacity
const READY_SHINE_SPEED = 37.9; // 官方 _ShineSpeed
const READY_SHINE_BRIGHTNESS = 0.12; // 官方 _ShineBrightness
/** 掩码画布相对主画布的分辨率比：1/4 为默认，超载时可降到 1/6 */
const MASK_SCALE = 0.25;

let maskCanvas: HTMLCanvasElement | null = null;
let maskCtx: CanvasRenderingContext2D | null = null;

interface Band {
    y0: number; // mask 像素行上边界
    y1: number;
    /** 该行内每块的左右区间（已按 x 排序的边交点推入） */
    edges: { x: number; delta: number; subtract: boolean }[];
}

/**
 * 收集一块旋转矩形在 [y0,y1) 行内的边交点。
 * 旋转矩形四角直接投影，逐行线性插值左/右边——足够精确且比逐边斜率法省。
 */
function collectBands(
    ctx: CanvasRenderingContext2D,
    blocks: { rect: { cx: number; cy: number; hx: number; hy: number; rot: number }; subtract: boolean }[],
    width: number,
    height: number,
    toMaskX: (chartX: number) => number,
    toMaskY: (chartY: number) => number
): Band[] {
    const cuts = new Set<number>([0, height]);
    const cornersList: { p: { x: number; y: number }[]; subtract: boolean }[] = [];
    for (const { rect, subtract } of blocks) {
        const cos = Math.cos(rect.rot);
        const sin = Math.sin(rect.rot);
        const corners = [
            { x: -rect.hx, y: -rect.hy },
            { x: rect.hx, y: -rect.hy },
            { x: rect.hx, y: rect.hy },
            { x: -rect.hx, y: rect.hy },
        ].map(local => ({
            x: rect.cx + local.x * cos - local.y * sin,
            y: rect.cy + local.x * sin + local.y * cos,
        }));
        const pix = corners.map(p => ({ x: toMaskX(p.x), y: toMaskY(p.y) }));
        let inside = false;
        for (const p of pix) {
            if (p.y > 0 && p.y < height && p.x > 0 && p.x < width) inside = true;
        }
        // 完全出屏也保留：大块可能罩住全屏（四角都在屏外）
        const minX = Math.min(...pix.map(p => p.x));
        const maxX = Math.max(...pix.map(p => p.x));
        const minY = Math.min(...pix.map(p => p.y));
        const maxY = Math.max(...pix.map(p => p.y));
        if (inside || (minX <= 0 && maxX >= width && minY <= 0 && maxY >= height)) {
            cornersList.push({ p: pix, subtract });
            for (const p of pix) {
                const cy = Math.max(0, Math.min(height, p.y));
                cuts.add(cy);
            }
        }
    }
    const sorted = Array.from(cuts).sort((a, b) => a - b);
    const bands: Band[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const y0 = sorted[i];
        const y1 = sorted[i + 1];
        if (y1 - y0 < 1e-6) continue;
        const mid = (y0 + y1) / 2;
        const edges: Band["edges"] = [];
        for (const { p, subtract } of cornersList) {
            // 行中点的左右区间
            let left = Infinity;
            let right = -Infinity;
            let count = 0;
            for (let c = 0; c < 4; c++) {
                const a = p[c];
                const b = p[(c + 1) % 4];
                if (a.y === b.y) continue;
                const lo = Math.min(a.y, b.y);
                const hi = Math.max(a.y, b.y);
                if (mid < lo || mid > hi) continue;
                const t = (mid - a.y) / (b.y - a.y);
                const x = a.x + t * (b.x - a.x);
                if (x < left) left = x;
                if (x > right) right = x;
                count++;
            }
            if (count >= 2 && right > left) {
                edges.push({ x: left, delta: 1, subtract });
                edges.push({ x: right, delta: -1, subtract });
            }
        }
        if (edges.length) bands.push({ y0, y1, edges });
    }
    return bands;
}

/**
 * 主入口：在主画布上绘制本帧噪域。ctx 已 resetTransform（屏幕像素系）。
 * blocks 来自 blockArea.visibleAreas()（含 disabled 与 active）。
 */
export function drawBlockAreas(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    timeBgm: number
): void {
    const system = simphiPlayer.blockArea;
    if (!system || !system.hasAreas) return;
    const visible = system.visibleAreas();
    if (!visible.length) return;

    const mw = Math.max(2, Math.round(width * MASK_SCALE));
    const mh = Math.max(2, Math.round(height * MASK_SCALE));
    if (!maskCanvas) {
        maskCanvas = document.createElement("canvas");
        maskCtx = maskCanvas.getContext("2d");
    }
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
        maskCanvas.width = mw;
        maskCanvas.height = mh;
    }
    const mctx = maskCtx!;
    mctx.clearRect(0, 0, mw, mh);
    const toMaskX = (chartX: number) => ((chartX + 1) / 2) * mw;
    const toMaskY = (chartY: number) => ((1 - chartY) / 2) * mh;

    // chart 空间 y 向上 → mask 像素 y 向下；先画 disabled（暗态），再画 active。
    const activeBlocks: Parameters<typeof collectBands>[1] = [];
    const disabledBlocks: Parameters<typeof collectBands>[1] = [];
    for (const { area, rect } of visible) {
        const phase = system.phase(timeBgm, area);
        if (phase === "hidden") continue;
        const entry = { rect, subtract: area.isSubtract };
        if (phase === "active") activeBlocks.push(entry);
        else disabledBlocks.push(entry);
    }

    // Parity 合成：官方奇偶 lit = (普通块覆盖数>0) XOR (减算块覆盖数为奇数)。
    // 状态机采用「先累计本边 delta、再决定 [本边, 下边) 是否点亮」——因为
    // 区间 [e_i, e_i+1) 的覆盖状态由边 e_i 之后的状态决定。
    const paint = (blocks: Parameters<typeof collectBands>[1], fill: string) => {
        if (!blocks.length) return;
        const bands = collectBands(mctx!, blocks, mw, mh, toMaskX, toMaskY);
        mctx.globalCompositeOperation = "source-over";
        mctx.fillStyle = fill;
        for (const band of bands) {
            band.edges.sort((a, b) => a.x - b.x || Number(a.subtract) - Number(b.subtract));
            let normal = 0;
            let subtract = 0;
            let spanStart: number | null = null;
            for (let ei = 0; ei < band.edges.length; ei++) {
                const edge = band.edges[ei];
                if (edge.subtract) subtract += edge.delta;
                else normal += edge.delta;
                // 注意优先级：> 高于 !==，两侧都必须括号
                const isLit = (normal > 0) !== (subtract % 2 === 1);
                // 亮区间从本边开始；下一条边决定它的终点（含收尾到带末尾）
                if (isLit) {
                    if (spanStart === null) spanStart = edge.x;
                } else if (spanStart !== null) {
                    const x0 = Math.max(0, Math.min(mw, spanStart));
                    const x1 = Math.max(0, Math.min(mw, edge.x));
                    if (x1 > x0) mctx.fillRect(x0, band.y0, x1 - x0, band.y1 - band.y0);
                    spanStart = null;
                }
            }
            // 收尾：若扫描结束仍亮，填到带末尾
            if (spanStart !== null) {
                if (mw > spanStart) mctx.fillRect(spanStart, band.y0, mw - spanStart, band.y1 - band.y0);
            }
        }
    };

    paint(disabledBlocks, `rgba(${BLOCK_FILL[0]},${BLOCK_FILL[1]},${BLOCK_FILL[2]},${DISABLED_FILL_ALPHA})`);
    paint(activeBlocks, `rgba(${BLOCK_FILL[0]},${BLOCK_FILL[1]},${BLOCK_FILL[2]},1)`);

    ctx.drawImage(maskCanvas, 0, 0, mw, mh, 0, 0, width, height);

    // Ready 预警：enable 前 0.5s 的边缘亮度闪烁由官方材质驱动；
    // CPU 路径用描边近似（官方有专属 ReadyBlock 层，这里保持可读性优先）。
    const ready = visible.filter(
        ({ area }) =>
            timeBgm < area.enableTime && timeBgm >= area.enableTime - 0.5 && system.phase(timeBgm, area) === "disabled"
    );
    if (ready.length) {
        const shine = 0.2393 * 255 * (1 + 0.5 * Math.sin(READY_SHINE_SPEED * timeBgm)) * READY_SHINE_BRIGHTNESS * 2;
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.8, shine / 255)})`;
        ctx.lineWidth = Math.max(1, height * 0.002);
        for (const { area, rect } of ready) {
            const cos = Math.cos(rect.rot);
            const sin = Math.sin(rect.rot);
            const corners = [
                { x: -rect.hx, y: -rect.hy },
                { x: rect.hx, y: -rect.hy },
                { x: rect.hx, y: rect.hy },
                { x: -rect.hx, y: rect.hy },
            ].map(local => ({
                x: ((rect.cx + local.x * cos - local.y * sin + 1) / 2) * width,
                y: ((1 - (rect.cy + local.x * sin + local.y * cos)) / 2) * height,
            }));
            ctx.beginPath();
            ctx.moveTo(corners[0].x, corners[0].y);
            for (let c = 1; c < 4; c++) ctx.lineTo(corners[c].x, corners[c].y);
            ctx.closePath();
            ctx.stroke();
        }
    }
}
