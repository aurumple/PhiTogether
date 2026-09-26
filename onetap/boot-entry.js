/**
 * 模块包第二段脚本 boot.js 的入口：整张游戏图（global.js 挂载 Vue/路由、playerMain.js
 * 绑定播放器，及其全部依赖），外加独立版由 index.html <link>/<script> 提供的全局样式
 * 与背景气泡层。
 *
 * 与 entry.js 分开打成独立 IIFE 的原因：单包内 dynamic import 会被打包器拍平成“顶层
 * 立即执行 + 命名空间 thunk”，把 global.js 的挂载提前到 entry 建 DOM/恢复设置之前。
 * 拆成两个文件后，entry.js 在“设置恢复 → DOM 骨架”之后显式注入本文件，顺序与独立版
 * 的 `await import()` 语义一致。
 */
// 独立版由 index.html 的 <link> 先于脚本加载这三张全局样式表：整页布局基准
//（footer 固定底部、.routerRealPage 铺满、#app 滚动容器等）都在里面，缺了排版会散架。
import '../src/style.css';
import '../src/animation.css';
import '../src/components/background/background.css';
import '../src/global.js';
import '../src/components/renderer/renderers/sim-phi/playerMain.js';
import '../src/components/background/index.js';
