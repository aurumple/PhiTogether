/**
 * 模块版的根组件视图：使用构建期编译的 render（CSP 无 unsafe-eval，不能运行时编译）。
 * 由 onetap/vite.onetap.config.mjs 把 `app-view` 别名指到本文件。
 */
import { render } from './generated/app-view.mjs';

/** 模块模式：内存路由、不操作宿主地址、能力一律走平台适配层。 */
export const moduleMode = true;

export default function viewOptions() {
  return { render };
}
