/**
 * 构建期模板预编译：把 index.html 里 #app 的 Vue 主模板编译成 render 函数产物。
 *
 * 模块运行在宿主的隔离容器里（CSP 无 unsafe-eval），运行时编译模板会直接抛错白屏；
 * 所以模块版必须用构建期编译。产物输出到 onetap/generated/app-view.mjs，由
 * onetap/appView.module.js 导出给 global.js 作为根组件视图（独立版仍走 DOM 模板）。
 *
 * 与运行时编译同源：vue 的运行时编译用的就是 @vue/compiler-dom，这里对同一段
 * 模板源文本做同样的编译，保留原 DOM 标识（#stage、#multiplayer 等）不动。
 */
import { compile } from '@vue/compiler-dom';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 取 <div id="app" ...> 的内部模板文本：按 div 深度配对，不依赖完整 HTML 解析器。 */
export function extractTemplate(html) {
  const open = /<div\b[^>]*\bid="app"[^>]*>/i.exec(html);
  if (!open) throw new Error('index.html 里找不到 #app 根节点');
  let depth = 1;
  const token = /<div\b|<\/div>/gi;
  token.lastIndex = open.index + open[0].length;
  let match;
  while ((match = token.exec(html))) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, match.index);
  }
  throw new Error('#app 根节点没有配对的结束标签');
}

export function compileTemplate(template) {
  const { code, errors } = compile(template, {
    mode: 'module',
    hoistStatic: true,
    filename: 'app-view',
  });
  if (errors && errors.length) {
    throw new Error('模板编译失败：' + errors.map(item => item.message).join('; '));
  }
  return '/* 由 onetap/precompile-template.mjs 生成；不要手改。 */\n' + code;
}

export async function precompileTemplate() {
  const html = await readFile(resolve(here, '..', 'index.html'), 'utf8');
  const code = compileTemplate(extractTemplate(html));
  const outDir = join(here, 'generated');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'app-view.mjs'), code, 'utf8');
  return code.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  precompileTemplate().then(size => console.log(`app-view.mjs 已生成（${size} 字节）`))
    .catch(error => { console.error(error); process.exit(1); });
}
