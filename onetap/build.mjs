/**
 * PhiTogether → OneTap 模块包构建（pnpm build:onetap）。
 *
 * 与独立版 `pnpm build` 完全分开：构建参数显式决定模式，不根据是否被 iframe 嵌入猜测。
 * 产物结构遵循 OneTap 模块契约：单 IIFE 入口 + 扁平化资源 + onetap-module.json；
 * releaseId 用 vendored 摘要算法（与 OneTap 服务端 release_digest 逐字节一致）。
 *
 * 程序包只放启动必需的脚本、CSS、字体、UI 图像与默认皮肤；谱库、解锁视频等内容
 * 走游戏网关的可下载内容通道，不进模块包（不抬高单文件/包体上限去迁就它们）。
 */
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { precompileTemplate } from './precompile-template.mjs';
import { releaseDigest, mimeOf } from './vendor/module-sdk/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/** 原路径 → 包内扁平名：空格/多层目录/特殊字符都压平，满足清单路径限制（≤2 段 ASCII）。 */
export function flattenPath(original) {
  return original.replace(/^\/+/, '').replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 程序包内置资源：字体（含带空格路径）、UI 图标/图、默认皮肤、主脚本库。清单外的资源不会下发。 */
const ASSET_DIRS = [
  { dir: 'public/lib', prefix: '/lib/' },
  { dir: 'public/src/core/fonts', prefix: '/src/core/fonts/' },
  { dir: 'public/src/core/icons', prefix: '/src/core/icons/' },
  { dir: 'public/src/respack/shared', prefix: '/src/respack/shared/' },
  { dir: 'public/src/respack/together-pack-1', prefix: '/src/respack/together-pack-1/' },
  { dir: 'public/src/respack/together-pack-2', prefix: '/src/respack/together-pack-2/' },
];

/** 散装 UI 资源（模板/CSS/代码按原路径引用，容器内按映射供给）：加载图、全屏底纹、校准音。 */
const ASSET_FILES = [
  { file: 'public/src/core/ptwithtitle.png', original: '/src/core/ptwithtitle.png' },
  { file: 'public/src/core/bgGradient.jpg', original: '/src/core/bgGradient.jpg' },
  { file: 'public/src/core/lg512y512.png', original: '/src/core/lg512y512.png' },
  { file: 'public/src/core/calibrate.mp3', original: '/src/core/calibrate.mp3' },
];

async function listAssets() {
  const items = [];
  for (const entry of ASSET_DIRS) {
    const absolute = join(repo, entry.dir);
    for (const name of await readdir(absolute)) {
      const source = join(absolute, name);
      if (!(await stat(source)).isFile()) continue;
      items.push({ original: entry.prefix + name, source, out: flattenPath(entry.dir + sep + name) });
    }
  }
  for (const entry of ASSET_FILES) {
    items.push({ original: entry.original, source: join(repo, entry.file), out: flattenPath(entry.file) });
  }
  return items;
}

export async function buildModule({ displayVersion } = {}) {
  const config = JSON.parse(await readFile(join(here, 'module.config.json'), 'utf8'));
  const version = displayVersion || config.displayVersion;
  const outDir = join(here, 'out', `${config.moduleId}-${version}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 1) 构建期编译 #app 主模板（容器 CSP 无 unsafe-eval）。
  await precompileTemplate();

  // 2) 两段脚本各自单 IIFE、Chrome 89 目标；模板/i18n 都不走运行时编译。
  //    entry.js（SDK + 平台适配）与 boot.js（整张游戏图，见 boot-entry.js）分开打：
  //    dynamic import 会被 inlineDynamicImports 拍平成“顶层立即执行 + 命名空间 thunk”，
  //    把 global.js/playerMain.js 的挂载提前到 entry 建 DOM/恢复设置之前；拆成两个
  //    文件后由 entry.js 在正确时机注入 boot.js，顺序与独立版 await import() 一致。
  const shared = {
    configFile: false,
    // publicDir 只为解析代码里的 /src/... 公共资源引用（保留为字面 URL，容器内由
    // 资源解析器按 assets-map 供给）；copyPublicDir=false 防止 74MB 公共目录进包。
    publicDir: resolve(repo, 'public'),
    logLevel: 'warn',
    root: repo,
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(repo, 'src'),
        '@utils': resolve(repo, 'src/utils'),
        '@components': resolve(repo, 'src/components'),
        '@locales': resolve(repo, 'src/locales'),
        '@renderers': resolve(repo, 'src/components/renderer/renderers'),
        'app-view': resolve(here, 'appView.module.js'),
        // 调试控制台不需要且含 eval 路径：模块构建换占位实现。
        eruda: resolve(here, 'stubs/eruda.js'),
        'vue/dist/vue.esm-bundler': 'vue/dist/vue.runtime.esm-bundler.js',
        'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.mjs',
      },
    },
    define: {
      // vite lib 模式不替换 process.env.NODE_ENV：容器里没有 process，逐字留着会在
      // eval 期直接抛 "process is not defined"（旧版 OneTap 是 app 模式编译所以没事）。
      'process.env.NODE_ENV': '"production"',
      // vue-i18n 走 JIT（AST 解释器）：不再出现 new Function，配合无 unsafe-eval 的 CSP。
      __INTLIFY_JIT_COMPILATION__: 'true',
      __INTLIFY_DROP_MESSAGE_COMPILER__: 'false',
    },
    esbuild: { drop: ['console', 'debugger'] },
  };
  for (const [entry, name, file] of [
    [resolve(here, 'entry.js'), 'PhiTogetherModule', 'entry.js'],
    [resolve(here, 'boot-entry.js'), 'PhiTogetherBoot', 'boot.js'],
  ]) {
    await build({
      ...shared,
      build: {
        target: 'chrome89',
        cssTarget: 'chrome89',
        outDir,
        emptyOutDir: false,
        copyPublicDir: false,
        minify: true,
        assetsInlineLimit: 0,
        cssCodeSplit: false,
        lib: { entry, name, formats: ['iife'], fileName: () => file },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
  }

  // 3) 扁平化资源 + 原路径映射（统一资源解析器在容器内按映射取字节）。
  const assets = await listAssets();
  const map = {};
  for (const item of assets) {
    await copyFile(item.source, join(outDir, item.out));
    map[item.original] = item.out;
    map[item.original.replace(/^\//, '')] = item.out;
  }
  await writeFile(join(outDir, 'assets-map.json'), JSON.stringify(map, null, 1), 'utf8');

  // 4) 收集产物清单（入口/CSS/资源）→ onetap-module.json，releaseId=内容摘要。
  const names = ['entry.js', 'boot.js', 'assets-map.json', ...assets.map(item => item.out)];
  for (const name of await readdir(outDir)) {
    if (name.endsWith('.css') && !names.includes(name)) names.push(name);
  }
  const files = [];
  for (const name of names.sort()) {
    const bytes = await readFile(join(outDir, name));
    files.push({ path: name, mime: mimeOf(name), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const styles = files.filter(item => item.path.endsWith('.css')).map(item => item.path);
  const manifest = {
    formatVersion: 1,
    moduleId: config.moduleId,
    name: config.name,
    summary: config.summary || '',
    icon: config.icon || null,
    displayVersion: version,
    bridgeMajor: config.bridgeMajor,
    storageSchema: config.storageSchema,
    entry: 'entry.js',
    styles,
    capabilities: config.capabilities,
    files,
    packageBytes: files.reduce((sum, item) => sum + item.bytes, 0),
    source: {
      repository: 'https://github.com/aurumple/PhiTogether',
      adapterRevision: 'codex/onetap-next',
      toolVersion: 'onetap/build.mjs-1',
    },
  };
  manifest.releaseId = releaseDigest(manifest);
  await writeFile(join(outDir, 'onetap-module.json'), JSON.stringify(manifest, null, 1), 'utf8');
  return { outDir, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  buildModule({ displayVersion: process.argv[2] }).then(({ outDir, manifest }) => {
    console.log(`模块包已生成：${relative(repo, outDir)}`);
    console.log(`releaseId=${manifest.releaseId} 文件 ${manifest.files.length} 个 共 ${(manifest.packageBytes / 1048576).toFixed(1)} MB`);
  }).catch(error => { console.error(error); process.exit(1); });
}
