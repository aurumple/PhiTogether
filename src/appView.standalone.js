/**
 * 独立版的根组件视图：沿用 index.html 里的 #app 模板（带编译器的 Vue 构建在运行时编译）。
 * 模块版由构建别名换成 onetap/appView.module.js（构建期编译，无 unsafe-eval）。
 */
export const moduleMode = false;

export default function viewOptions() {
  return { template: document.getElementById('app').innerHTML };
}
