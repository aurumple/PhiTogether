/**
 * 标准包构建辅助（模块仓库侧使用，与主仓库的构建完全独立）。
 *
 * 输入：模块仓库自己的源码 + module.config.json
 * 输出：<out>/<moduleId>-<displayVersion>/ 目录，内含 onetap-module.json 与逐文件成品。
 *
 * 产物要点：
 *   - JS 构建为独立 IIFE 并把动态 import 合并进来（容器内不做运行时 chunk 拉取）；
 *   - 包内只有清单里声明过的文件，清单没声明的资源不会下发；
 *   - releaseId 是内容摘要，不取系统时间：同一份源码两次构建得到同一个版本号，
 *     服务端导入时会用同一算法重新计算并比对，不符即拒绝。
 */
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

export const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm'
};
export const CAPABILITIES = ['assets', 'storage', 'lan.leaderboard', 'data.records', 'data.blobs', 'service.phitogether', 'files', 'ui.fullscreen'];

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function mimeOf(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`不支持的资源类型：${path}（请改用清单支持的扩展名）`);
  return mime;
}

/** 内容摘要格式 v1，必须与服务端 server/modules.py 的 release_digest 完全一致。 */
export function releaseDigest(manifest) {
  const lines = ['onetap-module-v1',
    `moduleId:${manifest.moduleId}`,
    `displayVersion:${manifest.displayVersion}`,
    `bridgeMajor:${manifest.bridgeMajor}`,
    `storageSchema:${manifest.storageSchema}`,
    `entry:${manifest.entry}`,
    `styles:${manifest.styles.join(',')}`,
    `capabilities:${[...manifest.capabilities].sort().join(',')}`,
    'files:'];
  for (const item of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    lines.push([item.path, item.mime, String(item.bytes), item.sha256].join('\t'));
  }
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 32);
}

export async function readConfig(root) {
  const config = JSON.parse(await readFile(join(root, 'module.config.json'), 'utf8'));
  const required = ['moduleId', 'name', 'displayVersion', 'entrySource'];
  for (const key of required) if (!config[key]) throw new Error(`module.config.json 缺少 ${key}`);
  return { entry: 'entry.js', capabilities: ['assets', 'storage'], assets: [], styles: [], ...config };
}

export async function bundle(entrySource, name, cssTarget) {
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'warn',
    build: { target: 'chrome89', cssTarget: 'chrome89', write: false, minify: true,
      modulePreload: false, assetsInlineLimit: 0, reportCompressedSize: false,
      lib: { entry: resolve(entrySource), name, formats: ['iife'], fileName: () => 'entry.js' },
      rollupOptions: { output: { inlineDynamicImports: true } } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') }
  });
  return result[0].output;
}

export async function buildModule(options) {
  const root = resolve(options.root);
  const config = { ...(await readConfig(root)), ...(options.config || {}) };
  const out = resolve(options.out || join(root, 'build'));
  if (options.displayVersion || options.moduleId) {
    // 允许用命令行覆盖版本号：同一份源码发布第二个版本（阶段 D 的 A → B → 回滚 A）时不必改配置文件。
    for (const key of ['moduleId', 'displayVersion', 'name', 'summary', 'storageSchema', 'icon']) {
      if (options[key] !== undefined) config[key] = options[key];
    }
  }
  const entryName = config.entry;
  const styleName = config.styles.length ? config.styles[0] : undefined;
  const output = await bundle(join(root, config.entrySource), 'OneTapModule', 'chrome89');
  const chunk = output.find(item => item.type === 'chunk');
  if (!chunk) throw new Error('构建没有产出入口脚本');
  if (chunk.imports.length || chunk.dynamicImports.length) throw new Error('模块入口不允许拆分或动态拉取 chunk');
  const css = output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  const stray = output.filter(item => item.type === 'asset' && item !== css);
  if (stray.length) {
    throw new Error('模块自带资源必须放进 assets/ 并在清单里声明，不要在 JS/CSS 里 import：' +
      stray.map(item => item.fileName).join('、'));
  }
  if (css && !styleName) throw new Error('构建产出了样式表，但 module.config.json 没有声明 styles');
  if (styleName && !css) throw new Error(`清单声明了样式表 ${styleName}，但构建没有产出 CSS`);

  const files = new Map();
  files.set(entryName, Buffer.from(chunk.code));
  if (styleName) files.set(styleName, Buffer.from(css.source));
  for (const path of config.assets) files.set(path, await readFile(join(root, path)));

  const manifest = {
    formatVersion: 1, moduleId: config.moduleId, releaseId: '', displayVersion: config.displayVersion,
    bridgeMajor: config.bridgeMajor || 1, storageSchema: config.storageSchema || 1,
    name: config.name, summary: config.summary || '', entry: entryName,
    styles: config.styles, capabilities: config.capabilities,
    ...(config.icon ? { icon: config.icon } : {}),
    files: [...files].map(([path, bytes]) => ({ path, mime: mimeOf(path), bytes: bytes.length, sha256: sha256(bytes) })),
    source: config.provenance || {}
  };
  manifest.releaseId = releaseDigest(manifest);

  const directory = join(out, `${manifest.moduleId}-${manifest.displayVersion}`);
  await rm(directory, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(directory, 'onetap-module.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, directory, files };
}
