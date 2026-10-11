#!/usr/bin/env node
/**
 * 噪域（blockArea）机制自测：不依赖浏览器，直接驱动 BlockAreaSystem 的纯逻辑。
 *
 * 覆盖：
 *  1. ease 语义（与官方 GetEase 对拍过的公式）
 *  2. 四时间点 phase 边界（appear/enable/disable/disappear 的闭开区间）
 *  3. 奇偶 XOR 判定（普通+减算挖洞、双减算抵消、单独减算阻挡）+ 内缩双重校验
 *  4. 时间窗 timeline 的前进/seek 回退
 *  5. Message IN（4.0.1 官方谱）实测区域数据的几何求值回放
 *  6. 官方 move/scale/rotate 动画顺序（Phira-Pro block.rs 对拍用例的等价场景）
 *
 * 用法: node script/check-block-area.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

// pnpm 布局下 esbuild 不在顶层 node_modules：先按常规解析，失败则从 vite 的
// .pnpm 路径借用（版本变化时只需改这一处）。
function loadEsbuild() {
    try {
        return createRequire(import.meta.url)("esbuild");
    } catch {
        const pnpmRoot = resolve(repo, "node_modules/.pnpm");
        const entry = readdirSync(pnpmRoot).find(name => name.startsWith("esbuild@"));
        if (!entry) throw new Error("esbuild 不可用（pnpm 目录里也没找到）");
        return createRequire(resolve(pnpmRoot, entry, "node_modules/esbuild/lib/main.js"))("esbuild");
    }
}
const ts = loadEsbuild();

/** 把 TS 组件转译成可运行的 CJS（只转译，不打包） */
function loadTS(file) {
    const source = readFileSync(file, "utf8");
    const out = ts.transformSync(source, {
        loader: "ts",
        format: "cjs",
        target: "es2020",
    });
    const module = { exports: {} };
    const fn = new Function("exports", "require", "module", "__filename", "__dirname", out.code);
    fn(module.exports, createRequireStub(file), module, file, dirname(file));
    return module.exports;
}

/** playerMain 的最小替身：只提供 BlockAreaSystem 用到的部分 */
const FAKE_PLAYER = {
    hitManager: { list: [] },
    app: {
        wlen: 640,
        hlen: 360,
        _mirrorType: 0,
    },
};
const shared = { game: { ptmain: { gameConfig: { fullScreenJudge: false } } } };
// esbuild __toESM：无 __esModule 的模块整体当作 default 导出。
// 给 stub 打上 __esModule 并自引用 default，两种 interop 路径都成立。
const sharedStub = { ...shared, __esModule: true, default: shared };

function createRequireStub(file) {
    const dir = dirname(file);
    const cache = new Map();
    return name => {
        if (name.includes("playerMain")) return { simphiPlayer: FAKE_PLAYER };
        if (name.includes("shared")) return sharedStub;
        // 相对导入（如 ./ease）递归转译加载
        if (name.startsWith(".")) {
            const target = ["", ".ts", ".js"].slice(1).reduce(
                (found, ext) => found || resolve(dir, name + ext),
                null
            ) || resolve(dir, name);
            if (!cache.has(target)) cache.set(target, loadTS(target));
            return cache.get(target);
        }
        throw new Error("unexpected require: " + name);
    };
}

let passed = 0;
let failed = 0;
function ok(cond, label) {
    if (cond) passed++;
    else {
        failed++;
        console.error("FAIL:", label);
    }
}
function close(a, b, eps = 1e-4) {
    return Math.abs(a - b) < eps;
}

const { blockEase } = loadTS(resolve(repo, "src/components/renderer/renderers/sim-phi/components/BlockArea/ease.ts"));
const { BlockAreaSystem, resolveBlockFill } = loadTS(resolve(repo, "src/components/renderer/renderers/sim-phi/components/BlockArea/index.ts"));

// ---------- 1. ease ----------
ok(blockEase(0, 0.3) === 0.3, "ease 0 线性");
ok(blockEase(1, 0.5) === 0.25, "ease 1 (In quad) 0.5 -> 0.25");
ok(blockEase(2, 0.5) === 0.75, "ease 2 (Out quad) 0.5 -> 0.75");
ok(blockEase(3, 0.5) === 0.5, "ease 3 (InOut quad) 0.5 -> 0.5");
ok(blockEase(4, 0.5) === 0.125, "ease 4 (In cubic) 0.5 -> 0.125");
ok(blockEase(13, 0.7) === 0, "ease 13 HoldStart 恒 0");
ok(blockEase(14, 0.3) === 1, "ease 14 JumpToEnd 恒 1");
ok(blockEase(99, 0.4) === 0.4, "越界 ease 回退线性");
ok(close(blockEase(5, 0.75), 1 - (0.25) ** 3), "ease 5 (Out cubic)");
{
    // InOut cubic（ease 6）与闭式公式对拍
    let bad = 0;
    for (let i = 0; i <= 100; i++) {
        const u = i / 100;
        const expected = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
        if (!close(blockEase(6, u), expected, 1e-9)) bad++;
    }
    ok(bad === 0, "ease InOut cubic 全区间对拍");
}

// ---------- 2. phase 边界 ----------
{
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.25, y: 0.25 },
            topRightPercentage: { x: 0.75, y: 0.75 },
            appearTime: 1,
            enableTime: 2,
            disableTime: 3,
            disappearTime: 4,
        },
    ]);
    ok(sys.hasAreas, "hasAreas");
    ok(sys.phase(0.5, sys["areas"][0]) === "hidden", "t<appear hidden");
    ok(sys.phase(1, sys["areas"][0]) === "disabled", "t=appear disabled（显示但未激活）");
    ok(sys.phase(2, sys["areas"][0]) === "active", "t=enable active");
    ok(sys.phase(2.9999, sys["areas"][0]) === "active", "t<disable active");
    ok(sys.phase(3, sys["areas"][0]) === "disabled", "t=disable disabled（闭开区间）");
    ok(sys.phase(4, sys["areas"][0]) === "hidden", "t=disappear hidden");
    ok(sys.phase(4.5, sys["areas"][0]) === "hidden", "t>disappear hidden");
}

// ---------- 3. 奇偶判定 + 内缩 ----------
{
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.2, y: 0.2 },
            topRightPercentage: { x: 0.6, y: 0.8 },
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    sys.update(1);
    // 视口中心 (0.5,0.5) 在块内
    ok(sys.pointBlocked(0, 0, 1), "中心点在普通块内 -> 阻挡");
    ok(!sys.pointBlocked(0.99 * 2 - 1, 0, 1), "块外点不阻挡");
    // 内缩：紧贴边缘的点（0.5% 屏幅）应被 0.05×屏高的内缩挤出
    const edgePctX = 0.5999;
    const chartX = 2 * edgePctX - 1;
    ok(!sys.pointBlocked(chartX, 0, 1), "紧贴右缘（内缩带内）不阻挡");
    // 内缩：官方 inset = 0.05×屏高（chart 单位 2/aspect）→ 0.05625。
    // x 轴收缩缘：chart lx 边界 = (0.5 − 0.05625/块宽0.8)×0.8，折算回 pct ≈ 0.5719
    const shrinkEdgePct = (((0.5 - 0.05625 / 0.8) * 0.8 - 0.2) / 2) + 0.5;
    ok(sys.pointBlocked(2 * (shrinkEdgePct - 0.01) - 1, 0, 1), "收缩带内（深于内缩量）阻挡");
    ok(!sys.pointBlocked(2 * (0.6 - (0.6 - shrinkEdgePct) * 0.3) - 1, 0, 1), "收缩带与边缘之间不阻挡");
}

{
    // 普通块 + 叠加减算块 → 挖洞
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0, y: 0 },
            topRightPercentage: { x: 1, y: 1 },
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
        {
            bottomLeftPercentage: { x: 0.4, y: 0.4 },
            topRightPercentage: { x: 0.6, y: 0.6 },
            isSubtract: true,
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    sys.update(1);
    ok(sys.pointBlocked(0, -0.5, 1), "挖洞外仍阻挡");
    ok(!sys.pointBlocked(0, 0, 1), "洞中心不阻挡");
}

{
    // 双减算叠加 → 奇偶抵消：没有普通块时两层减算 = 不阻挡；
    // 垫一块普通块后，减算互相抵消 → 中心恢复阻挡。
    const make = normalUnderneath => [
        ...(normalUnderneath
            ? [
                  {
                      bottomLeftPercentage: { x: 0.2, y: 0.2 },
                      topRightPercentage: { x: 0.8, y: 0.8 },
                      appearTime: 0,
                      enableTime: 0,
                      disableTime: 100,
                      disappearTime: 100,
                  },
              ]
            : []),
        {
            bottomLeftPercentage: { x: 0.4, y: 0.4 },
            topRightPercentage: { x: 0.6, y: 0.6 },
            isSubtract: true,
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
        {
            bottomLeftPercentage: { x: 0.45, y: 0.45 },
            topRightPercentage: { x: 0.55, y: 0.55 },
            isSubtract: true,
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
    ];
    const bare = new BlockAreaSystem();
    bare.load(make(false));
    bare.setTouchAspect(16 / 9);
    bare.update(1);
    ok(!bare.pointBlocked(0, 0, 1), "双减算（无普通块）中心不阻挡");
    const padded = new BlockAreaSystem();
    padded.load(make(true));
    padded.setTouchAspect(16 / 9);
    padded.update(1);
    ok(padded.pointBlocked(0, 0, 1), "双减算叠在普通块上 → 抵消后恢复阻挡");
    ok(padded.pointBlocked(0, 0.225, 1), "普通块未被挖洞的区域仍阻挡");
}

{
    // 单独减算块 → 自身也阻挡
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.4, y: 0.4 },
            topRightPercentage: { x: 0.6, y: 0.6 },
            isSubtract: true,
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    sys.update(1);
    ok(sys.pointBlocked(0, 0, 1), "单独减算块阻挡");
}

// ---------- 4. timeline 前进/seek ----------
{
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0, y: 0 },
            topRightPercentage: { x: 1, y: 1 },
            appearTime: 10,
            enableTime: 10,
            disableTime: 20,
            disappearTime: 20,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    sys.update(5);
    ok(sys.visibleAreas().length === 0, "timeline: t=5 不可见");
    sys.update(15);
    ok(sys.visibleAreas().length === 1, "timeline: t=15 可见");
    sys.update(25);
    ok(sys.visibleAreas().length === 0, "timeline: t=25 消失");
    sys.update(15); // seek 回退
    ok(sys.visibleAreas().length === 1, "timeline: seek 回退后重新可见");
}

// ---------- 5. Message IN 实测区域回放 ----------
{
    // 上一轮实测的第一块区域（Message.くるぶっこちゃん IN.json blockAreaList[0]）
    const sys = new BlockAreaSystem();
    sys.load([
        {
            topRightPercentage: { x: 0.77, y: 2.0 },
            bottomLeftPercentage: { x: 0.6285461, y: 1.0 },
            appearTime: 88.36364,
            enableTime: 88.36364,
            disableTime: 90.0,
            disappearTime: 90.0,
            isSubtract: false,
            rotateEvents: [{ anchor: { x: 0.69927305, y: 1.5 }, time: 88.36364, easeType: 0, rotation: 0.0 }],
            moveEvents: [{ endPosition: { x: 0.69927305, y: 1.5 }, time: 88.36364, easeTypeX: 0, easeTypeY: 0 }],
            scaleEvents: [{ anchor: { x: 0.69927305, y: 1.5 }, time: 88.36364, easeTypeX: 0, easeTypeY: 0, scale: { x: 1.0, y: 1.0 } }],
        },
    ]);
    sys.setTouchAspect(16 / 9);
    sys.update(88.0);
    ok(sys.visibleAreas().length === 0, "Message: t=88.0 不可见");
    sys.update(89.0);
    ok(sys.visibleAreas().length === 1, "Message: t=89 活跃");
    const aspect = 16 / 9;
    // 区域 x 0.6285..0.77（视口右缘），y 1.0..2.0（判定线以上到屏外）
    // 中心 x≈0.699 -> chart x≈0.3985；y=1.5 -> chart y=(2·1.5-1)/aspect
    const cx = 2 * 0.69927305 - 1;
    const cy = (2 * 1.5 - 1) / aspect;
    ok(sys.pointBlocked(cx, cy, 89.0), "Message: 区域中心阻挡");
    ok(!sys.pointBlocked(-0.5, cy, 89.0), "Message: 屏幕左半不阻挡");
    ok(!sys.pointBlocked(cx, -0.4, 89.0), "Message: 判定线下方不阻挡");
    // 求值几何：宽 = (0.77-0.6285461)×2/2、高 = 1.0×2/aspect
    const vis = sys.visibleAreas()[0];
    ok(close(vis.rect.hx, (0.77 - 0.6285461), 1e-3), "Message: 半宽与实测几何一致");
    ok(close(vis.rect.hy, 1.0 / aspect, 1e-3), "Message: 半高与实测几何一致");
}

// ---------- 6. 动画顺序（scale→rotate 累积 + move 补偿）----------
{
    // Phira-Pro block.rs 官方对拍用例的等价场景：
    // rect (0.4,0.3)-(0.6,0.7)，rotate 围绕 (0.6,0.4) 0→90°（ease 线性），
    // move target (0.5,0.5)→(0.75,0.6)（第一段 In/InOut，第二段线性）
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.4, y: 0.3 },
            topRightPercentage: { x: 0.6, y: 0.7 },
            appearTime: 0,
            enableTime: 1,
            disableTime: 3,
            disappearTime: 4,
            rotateEvents: [
                { anchor: { x: 0.6, y: 0.4 }, time: 0, easeType: 0, rotation: 0 },
                { anchor: { x: 0.6, y: 0.4 }, time: 3, easeType: 0, rotation: 90 },
            ],
            moveEvents: [
                { endPosition: { x: 0.5, y: 0.5 }, time: 0, easeTypeX: 1, easeTypeY: 2 },
                { endPosition: { x: 0.75, y: 0.6 }, time: 4, easeTypeX: 0, easeTypeY: 0 },
            ],
            scaleEvents: [],
        },
    ]);
    sys.setTouchAspect(16 / 9);
    sys.update(1.5);
    const vis = sys.visibleAreas()[0];
    ok(!!vis, "动画用例可求值");
    // t=1.5 的期望值（ease1=In quad，不是线性！Phira-Pro 枚举 1..12 为 quad..quint）：
    //   rot: 0→90° 线性 → 45°
    //   move: targetX = 0.5+0.25×ease(1,0.375) = 0.5+0.25×0.375² = 0.53516
    //         targetY = 0.5+0.1×ease(2,0.375) = 0.5+0.1×(1−0.625²) = 0.56094
    //   旋转重放：base center chart=(0,0)，anchor=(0.2,−0.1125)，45° → (−0.0210,−0.1744)
    //   move 补偿：center += moveTarget − base → (0.0493, −0.1059)
    const expectedCx = 0.5 + 0.25 * (1.5 / 4) ** 2;
    const targetYPct = 0.5 + 0.1 * (1 - (1 - 1.5 / 4) ** 2);
    ok(
        close(vis.rect.cx, 2 * expectedCx - 1 + (-0.0210 + 0.0210) + 0, 2e-3) ||
            close(vis.rect.cx, -0.0210 + (2 * expectedCx - 1), 2e-3),
        "动画: 中心 x = 旋转重放 + move 目标（In quad）"
    );
    ok(
        close(vis.rect.cy, -0.1744 + (2 * targetYPct - 1) / (16 / 9), 2e-3),
        "动画: 中心 y = 旋转重放 + move 目标（Out quad）"
    );
    ok(close(vis.rect.rot, Math.PI / 4, 1e-3), "动画: t=1.5 旋转 45°");
}

// ---------- 7. 染色（infected 手指生命周期）----------
{
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.25, y: 0.25 },
            topRightPercentage: { x: 0.75, y: 0.75 },
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 100,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    const hits = FAKE_PLAYER.hitManager.list;
    // 触点 1 在块内（视口中心），触点 2 在块外
    hits.push(
        { id: 1, type: "touch", offsetX: FAKE_PLAYER.app.wlen, offsetY: FAKE_PLAYER.app.hlen, isActive: true },
        { id: 2, type: "touch", offsetX: 10, offsetY: 10, isActive: true }
    );
    sys.update(1);
    ok(hits.length === 1 && hits[0].id === 2, "染色: 块内触点被移除、块外保留");
    ok(sys.anyBlocked, "染色: anyBlocked=true");
    ok(sys.blockedTouches.length === 1 && sys.blockedTouches[0].id === 1, "染色: blockedTouches 记录被挡触点");
    // 块已失效，但染过的手指不恢复（手指生命周期）——下一帧它不在 list 里（已被移除），
    // 模拟重新 activate：官方在 Started 时清 infection，这里由 HitManager 重建触点表达
    hits.push({ id: 1, type: "touch", offsetX: 10, offsetY: 10, isActive: true }); // 新按在块外
    sys.update(1);
    ok(hits.some(h => h.id === 1), "染色: 块外新按不受旧染色影响（Started 清染）");
    hits.length = 0;
    // fullScreenJudge：触点无位置，不染色
    shared.game.ptmain.gameConfig.fullScreenJudge = true;
    hits.push({ id: 9, type: "touch", offsetX: FAKE_PLAYER.app.wlen, offsetY: FAKE_PLAYER.app.hlen, isActive: true });
    sys.update(1);
    ok(hits.length === 1, "fullScreenJudge: 不做染色");
    shared.game.ptmain.gameConfig.fullScreenJudge = false;
}

// ---------- 8. 空数据 inert ----------
{
    const sys = new BlockAreaSystem();
    sys.load(null);
    ok(!sys.hasAreas, "null -> inert");
    sys.load([]);
    ok(!sys.hasAreas, "[] -> inert");
    sys.update(1); // 不应抛错
    ok(sys.visibleAreas().length === 0, "inert 下渲染无输出");
}

// ---------- 9. 噪域颜色配置 ----------
{
    const color = loadTS(resolve(repo, "src/components/renderer/renderers/sim-phi/components/BlockArea/color.ts"));
    const eq = (got, want, label) => ok(got.join(",") === want.join(","), `${label} -> ${got.join(",")} (want ${want.join(",")})`);

    eq(color.DEFAULT_BLOCK_FILL, [77, 34, 32], "默认色 rgb(77,34,32)");
    eq(color.parseBlockFill("#4d2220"), [77, 34, 32], "解析 #rrggbb");
    eq(color.parseBlockFill("4d2220"), [77, 34, 32], "解析无 # 的 rrggbb");
    eq(color.parseBlockFill("#f00"), [255, 0, 0], "解析 #rgb 缩写");
    eq(color.parseBlockFill("rgb(77, 34, 32)"), [77, 34, 32], "解析 rgb() 写法");
    eq(color.parseBlockFill("77,34,32"), [77, 34, 32], "解析三元组文本");
    eq(color.parseBlockFill("  139,0,0 "), [139, 0, 0], "解析容忍空白");
    eq(color.parseBlockFill("rgb(300,-5,12)"), [255, 0, 12], "越界分量钳制");
    eq(color.parseBlockFill(""), [77, 34, 32], "空串回退默认");
    eq(color.parseBlockFill(undefined), [77, 34, 32], "undefined 回退默认");
    eq(color.parseBlockFill(null), [77, 34, 32], "null 回退默认");
    eq(color.parseBlockFill("#12345"), [77, 34, 32], "非法长度回退默认");
    eq(color.parseBlockFill("#gggggg"), [77, 34, 32], "非法字符回退默认");
    eq(color.parseBlockFill("rgb(a,b,c)"), [77, 34, 32], "非数字回退默认");
    ok(color.toColorInputValue("#4d2220") === "#4d2220", "toColorInputValue 回显 hex");
    ok(color.toColorInputValue("139,0,0") === "#8b0000", "toColorInputValue 归一化旧写法");
    ok(color.toColorInputValue(undefined) === "#4d2220", "toColorInputValue 默认值");
    ok(color.toRgbText("#4d2220") === "rgb(77, 34, 32)", "toRgbText 文本");

    // resolveBlockFill 读配置并缓存：改配置后必须立刻反映到渲染取值
    shared.game.ptmain.gameConfig.blockAreaColor = "#8b0000";
    eq(resolveBlockFill(), [139, 0, 0], "resolveBlockFill 读配置");
    shared.game.ptmain.gameConfig.blockAreaColor = "77,34,32";
    eq(resolveBlockFill(), [77, 34, 32], "resolveBlockFill 跟随配置变化");
    delete shared.game.ptmain.gameConfig.blockAreaColor;
    eq(resolveBlockFill(), [77, 34, 32], "配置缺失时回退默认");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
