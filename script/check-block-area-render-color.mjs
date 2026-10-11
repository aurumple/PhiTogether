#!/usr/bin/env node
/**
 * 噪域渲染取色的定向检查：加载**真实** renderer.ts，用记录型 canvas stub 拦截填充色，
 * 断言绘制时用的 rgba 就是设置里的颜色（含默认值与改色后的值）。
 *
 * 覆盖了从「配置」到「实际画布指令」这一整段，避免只验证解析、却漏掉渲染端用错分量。
 *
 * 用法: node script/check-block-area-render-color.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

function loadEsbuild() {
    try {
        return createRequire(import.meta.url)("esbuild");
    } catch {
        const pnpmRoot = resolve(repo, "node_modules/.pnpm");
        const entry = readdirSync(pnpmRoot).find(name => name.startsWith("esbuild@"));
        if (!entry) throw new Error("esbuild 不可用");
        return createRequire(resolve(pnpmRoot, entry, "node_modules/esbuild/lib/main.js"))("esbuild");
    }
}
const ts = loadEsbuild();

function loadTS(file) {
    const out = ts.transformSync(readFileSync(file, "utf8"), {
        loader: "ts",
        format: "cjs",
        target: "es2020",
    });
    const module = { exports: {} };
    const fn = new Function("exports", "require", "module", "__filename", "__dirname", out.code);
    fn(module.exports, requireStub(file), module, file, dirname(file));
    return module.exports;
}

/** 记录所有 fillStyle / fillRect 的 2D 上下文替身 */
function makeCtx() {
    const fills = [];
    let style = "";
    return {
        fills,
        get fillStyle() {
            return style;
        },
        set fillStyle(value) {
            style = value;
        },
        globalCompositeOperation: "source-over",
        clearRect() {},
        fillRect(x, y, w, h) {
            if (w > 0 && h > 0) fills.push(style);
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        stroke() {},
        drawImage() {},
    };
}

const mainCtx = makeCtx();
const maskCtx = makeCtx();
// renderer 内部会 document.createElement("canvas") 拿掩码画布
globalThis.document = {
    createElement() {
        return { width: 0, height: 0, getContext: () => maskCtx };
    },
};

const config = { fullScreenJudge: false };
const FAKE_PLAYER = {
    hitManager: { list: [] },
    app: { wlen: 640, hlen: 360, _mirrorType: 0 },
    blockArea: null,
};
const shared = { game: { ptmain: { gameConfig: config } } };
const sharedStub = { ...shared, __esModule: true, default: shared };

function requireStub(file) {
    const dir = dirname(file);
    const cache = new Map();
    return name => {
        if (name.includes("playerMain")) return { simphiPlayer: FAKE_PLAYER };
        if (name.includes("shared")) return sharedStub;
        if (name.startsWith(".")) {
            const target =
                ["", ".ts", ".js"]
                    .slice(1)
                    .reduce((found, ext) => found || resolve(dir, name + ext), null) ||
                resolve(dir, name);
            if (!cache.has(target)) cache.set(target, loadTS(target));
            return cache.get(target);
        }
        throw new Error("unexpected require: " + name);
    };
}

const BlockAreaDir = resolve(repo, "src/components/renderer/renderers/sim-phi/components/BlockArea");
const { BlockAreaSystem } = loadTS(resolve(BlockAreaDir, "index.ts"));
const { drawBlockAreas } = loadTS(resolve(BlockAreaDir, "renderer.ts"));

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
    if (cond) passed++;
    else {
        failed++;
        console.error("FAIL:", label);
    }
};

/** 造一个覆盖全屏、已生效（active）的噪域 */
function makeSystem() {
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.25, y: 0.25 },
            topRightPercentage: { x: 0.75, y: 0.75 },
            appearTime: 0,
            enableTime: 0,
            disableTime: 100,
            disappearTime: 200,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    return sys;
}

function drawAndCollect(timeBgm = 5) {
    maskCtx.fills.length = 0;
    FAKE_PLAYER.blockArea = makeSystem();
    // 渲染取的是 update() 求值出的帧状态（visibleAreas 依赖 evaluatedTime），必须先推进一帧
    FAKE_PLAYER.blockArea.update(timeBgm);
    drawBlockAreas(mainCtx, 640, 360, timeBgm);
    return maskCtx.fills.slice();
}

// 1. 默认值（配置未设）→ rgb(77,34,32)
delete config.blockAreaColor;
{
    const fills = drawAndCollect();
    ok(fills.length > 0, "默认配置下确实绘制了填充");
    ok(
        fills.every(f => f === "rgba(77,34,32,1)"),
        `默认填充色为 rgba(77,34,32,1)，实际: ${[...new Set(fills)].join(" / ")}`
    );
}

// 2. 设置页改色后 → 渲染跟随（无需重开谱面）
config.blockAreaColor = "#8b0000";
{
    const fills = drawAndCollect();
    ok(
        fills.every(f => f === "rgba(139,0,0,1)"),
        `改色后填充为 rgba(139,0,0,1)，实际: ${[...new Set(fills)].join(" / ")}`
    );
}

// 3. 旧写法（三元组文本）也能生效
config.blockAreaColor = "12, 200, 90";
{
    const fills = drawAndCollect();
    ok(
        fills.every(f => f === "rgba(12,200,90,1)"),
        `三元组写法生效，实际: ${[...new Set(fills)].join(" / ")}`
    );
}

// 4. 坏值不能把噪域画没（回退默认而非透明）
config.blockAreaColor = "not-a-color";
{
    const fills = drawAndCollect();
    ok(fills.length > 0, "非法值仍会绘制（不是透明）");
    ok(
        fills.every(f => f === "rgba(77,34,32,1)"),
        `非法值回退默认，实际: ${[...new Set(fills)].join(" / ")}`
    );
}

// 5. disabled 态用同一颜色、带 0.4 alpha
config.blockAreaColor = "#4d2220";
{
    maskCtx.fills.length = 0;
    const sys = new BlockAreaSystem();
    sys.load([
        {
            bottomLeftPercentage: { x: 0.25, y: 0.25 },
            topRightPercentage: { x: 0.75, y: 0.75 },
            appearTime: 0,
            enableTime: 10,
            disableTime: 20,
            disappearTime: 30,
        },
    ]);
    sys.setTouchAspect(16 / 9);
    FAKE_PLAYER.blockArea = sys;
    sys.update(5); // 5 < enableTime=10 → disabled
    drawBlockAreas(mainCtx, 640, 360, 5);
    const fills = maskCtx.fills.slice();
    ok(fills.length > 0, "disabled 态也绘制");
    ok(
        fills.every(f => f === "rgba(77,34,32,0.4)"),
        `disabled 用同色 0.4 alpha，实际: ${[...new Set(fills)].join(" / ")}`
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
