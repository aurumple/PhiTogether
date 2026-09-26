/**
 * PhiTogether 的 OneTap 模块入口（仅模块构建使用）。
 *
 * 显式初始化顺序（PHITOGETHER-INTEGRATION-PLAN §7.1）：
 *   创建平台适配器 → 恢复设置 → 构造 DOM → 初始化播放器/路由 → 首屏就绪 → api.ready()。
 * 顶层 import 在 SDK 就绪前不得读 localStorage/发网络请求——所有副作用都在 start 之后发生。
 */
import { defineModule } from './vendor/module-sdk/index.js';
import { createPlatform } from '../src/platform/onetap/index.js';

defineModule({
  async start(api) {
    // 1) 平台适配器 + 环境（独立版由 index.html 内联脚本提供 window.spec）。
    const platform = createPlatform(api);
    window.__onetapPlatform = platform;
    window.spec = platform.spec;

    // 2) 设置与身份异步恢复完成后再挂载应用。
    await platform.prepare();

    // 3) 构造 DOM 骨架：与 index.html 的 body 结构逐项一致（div.main 包裹调试台占位、
    //    背景层、联机面板与应用挂载点——模板外的这些锚点 ploading/global.js 都直接查）。
    const root = document.getElementById('module-root');
    root.innerHTML = '';
    const main = document.createElement('div');
    main.className = 'main';
    main.style.textAlign = 'center';
    const forEruda = document.createElement('div');
    forEruda.id = 'forEruda';
    const background = document.createElement('div');
    background.className = 'background';
    const multiplayer = document.createElement('div');
    multiplayer.id = 'multiplayer';
    const app = document.createElement('div');
    app.id = 'app';
    app.setAttribute('v-cloak', '');
    app.style.display = 'none';
    main.append(forEruda, background, multiplayer, app);
    root.append(main);

    // 4) 启动真实应用：boot.js（global.js 挂载 Vue/路由 + playerMain.js 绑定播放器及
    //    其全部依赖，独立 IIFE，见 boot-entry.js）在 DOM 就绪后注入——打包器拍平动态
    //    import 会把挂载提前到建 DOM 之前，故显式按需加载。播放器在 window load 后
    //    初始化；容器的 load 早已过去，注入后补发一次。
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = api.assets.url('boot.js');
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('boot.js 加载失败'));
      document.head.appendChild(script);
    });
    window.dispatchEvent(new Event('load'));

    // 5) 首屏就绪后才撤掉宿主加载遮罩。
    await platform.firstFrame();
    api.ready();

    // 6) 生命周期：宿主提示（含 dispose）只作增量保存信号，退出动作由宿主决定。
    api.lifecycle(({ type }) => {
      if (type === 'dispose') {
        // 停止声音：播放器随 iframe realm 一起销毁，这里只做礼貌性静音。
        try { window.__onetapPlatform && document.querySelectorAll('audio,video').forEach(el => el.pause()); } catch { /* 清理尽力而为 */ }
      }
    });
  },
});
