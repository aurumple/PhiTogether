/**
 * 检查「组件方法被裸调用」这一类会直接打出白屏的错误。
 *
 * 起因：chartselect.vue 的 boardMyBest() 里写了 `bestScoreOf(...)`，而 bestScoreOf 是
 * methods 里的方法。方法体的作用域是模块作用域，裸调用命中不了 this，运行时抛
 * ReferenceError；模板又会在渲染期调用它，于是整个渲染函数一起失败——表现就是白屏。
 * Vite 不做类型检查，prettier 也看不出这种错，所以单列一条静态检查。
 *
 * 用法: node script/check-method-scope.mjs [目录...]   默认扫描 src/
 * 退出码: 0 通过，1 有裸调用。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const root = process.cwd();
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];

function walk(path, out = []) {
    if (statSync(path).isDirectory()) {
        for (const entry of readdirSync(path)) walk(join(path, entry), out);
    } else if (/\.(vue|js|ts)$/.test(path)) {
        out.push(path);
    }
    return out;
}

/** 去掉注释与字符串字面量，行数保持不变，避免把注释/文本里的括号算进配对。 */
function stripNoise(code) {
    let out = "";
    const keepLines = text => text.replace(/[^\n]/g, "");
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1];
        if (ch === "/" && next === "/") {
            let end = i;
            while (end < code.length && code[end] !== "\n") end++;
            out += " ".repeat(end - i);
            i = end - 1;
        } else if (ch === "/" && next === "*") {
            let end = i + 2;
            while (end < code.length && !(code[end] === "*" && code[end + 1] === "/")) end++;
            out += keepLines(code.slice(i, end + 2));
            i = end + 1;
        } else if (ch === '"' || ch === "'" || ch === "`") {
            let end = i + 1;
            while (end < code.length && code[end] !== ch) {
                if (code[end] === "\\") end++;
                end++;
            }
            out += ch + keepLines(code.slice(i + 1, end)) + ch;
            i = end;
        } else {
            out += ch;
        }
    }
    return out;
}

/** 模块作用域里已有的绑定：同名方法被裸调用时解析到的是这些，不算错误。 */
function localBindings(code) {
    const bindings = new Set();
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        bindings.add(match[1]);
    }
    for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) bindings.add(match[1]);
    for (const match of code.matchAll(/\bimport\s+([\s\S]*?)\s+from\s/g)) {
        for (const id of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) bindings.add(id[0]);
    }
    return bindings;
}

/** 取出 `methods: {` 对象里顶层方法名的声明位置（键名在 code 中的下标）。 */
function methodDeclarations(code) {
    const declarations = new Map();
    for (const match of code.matchAll(/(^|\n)([ \t]*)methods[ \t]*:[ \t]*\{/g)) {
        const start = match.index + match[0].length;
        let depth = 0;
        let end = code.length;
        for (let i = start; i < code.length; i++) {
            const ch = code[i];
            if (ch === "{") depth++;
            else if (ch === "}") {
                if (depth === 0) {
                    end = i; // methods 对象的右括号
                    break;
                }
                depth--;
            }
        }
        // 逐行取顶层键：方法体内部的缩进行不算（那里的括号把 depth 顶上去）。
        const block = code.slice(start, end);
        let inner = 0;
        let offset = start;
        for (const line of block.split("\n")) {
            if (inner === 0) {
                const key = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*[:(]/.exec(line);
                if (key) declarations.set(offset + key[0].indexOf(key[1]), key[1]);
            }
            inner += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            offset += line.length + 1;
        }
    }
    return declarations;
}

const problems = [];
for (const target of targets) {
    for (const file of walk(isAbsolute(target) ? target : join(root, target))) {
        const raw = readFileSync(file, "utf8");
        for (const block of raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
            const code = stripNoise(block[1]);
            const declarations = methodDeclarations(code);
            if (!declarations.size) continue;
            const bindings = localBindings(code);
            const contentStart = block.index + block[0].indexOf(">") + 1;
            const lineOffset = raw.slice(0, contentStart).split("\n").length - 1;
            for (const [index, name] of declarations) {
                if (bindings.has(name)) continue; // 模块作用域里另有同名绑定
                const call = new RegExp(`(?<![\\w.$])${name}[ \\t]*\\(`, "g");
                for (const hit of code.matchAll(call)) {
                    if (hit.index === index) continue; // 自己的声明
                    const line = lineOffset + code.slice(0, hit.index).split("\n").length;
                    problems.push({ file: relative(root, file), line, name });
                }
            }
        }
    }
}

if (problems.length) {
    console.error("发现裸调用组件方法（渲染期会抛 ReferenceError → 整页白屏）：");
    for (const problem of problems) {
        console.error(`  ${problem.file}:${problem.line}  ${problem.name}(...)`);
    }
    console.error(`\n改成 this.${problems[0].name}(...) 之类的显式调用。`);
    process.exitCode = 1;
} else {
    console.log("PASS：没有裸调用组件方法");
}
