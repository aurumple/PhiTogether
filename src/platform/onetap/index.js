/**
 * OneTap 平台适配层（模块模式专用）。
 *
 * 模块运行在宿主隔离容器（opaque 来源）：没有 localStorage/sessionStorage/IndexedDB、
 * 没有网络、没有 Worker/Service Worker。所有外部能力一律经 OneTap SDK（api.*）回到宿主，
 * 身份由宿主绑定（模块不能自行指定 accountId，也不接触任何令牌）。
 *
 * 这里是游戏代码与 SDK 之间唯一的桥：
 *   - env/spec：替代 index.html 内联脚本提供的 window.spec；
 *   - identity：game.call('game.profile'/'game.me') 替代 JWT 登录；
 *   - settings：设置经 api.records 异步恢复后再挂载应用（localStorage 不可用）；
 *     localStorage 业务键（ptlocale、PTSavedOffsets）读写都汇到 settings/prefs 行，
 *     由这里统一持久化（CAS + 防抖）；
 *   - session：sessionStorage 业务键（loadedChart、chartDetailsData）是实例内会话
 *     数据，替身对象挂在 window.__onetapPlatform.session，随实例销毁；
 *   - storage shim：给尚未逐键迁移的代码提供内存版 localStorage/sessionStorage，
 *     防止访问抛 SecurityError（见 storage-shim.js）。
 */
import { createStorageShim, installStorageShims } from './storage-shim.js';
import { loadAssetMap, installAssetResolution, installDomAssetResolution, rewriteCssText } from './assets.js';

/** localStorage 业务键 → settings/prefs 行里的字段（只持久化这些，其余键仍是会话级）。 */
const PERSISTED_LOCAL_KEYS = {
  ptlocale: 'locale',
  PTSavedOffsets: 'savedOffsets',
};

/** 容器引导脚本用 <link> 注入的包内 CSS：取回文本，把 url(...) 改写成实例 Blob URL
 * （字体、底纹等）。拿不回来就保持原样，不阻断启动。 */
async function fixStylesheetUrls(api, map) {
  for (const link of [...document.querySelectorAll('link[rel="stylesheet"]')]) {
    try {
      const text = await fetch(link.href).then(response => response.text());
      const style = document.createElement('style');
      style.textContent = rewriteCssText(api, text, map);
      link.replaceWith(style);
    } catch { /* 样式缺失只影响装饰，不值得中断启动 */ }
  }
}

export function createPlatform(api) {
  let restoring = true;
  let persistTimer = null;

  const platform = {
    api,
    spec: {
      thisVersion: (api.env && api.env.displayVersion) || 'onetap-dev',
      isPhiTogetherApp: false,
      isDesktop: false,
      isAndroidApp: false,
      isiOSDevice: false,
      antiAddictionEnabled: false,
    },
    /** sessionStorage 替身（loadedChart/chartDetailsData 等实例内会话对象）。 */
    session: createStorageShim(),
    settings: createStorageShim(onLocalChange),
    prefs: null,

    /** 启动前准备：装资源解析与存储替身 → 异步恢复设置/身份。 */
    async prepare() {
      // 资源解析先行：包内映射 + XHR/fetch/媒体 src 拦截 + 已注入样式的 url() 改写，都必须
      // 在 boot.js 跑起来之前装好——字体、背景图、UI 图标的原路径引用全靠它们落到包内字节。
      const assetMap = await loadAssetMap(api);
      installAssetResolution(api, assetMap);
      installDomAssetResolution(api, assetMap);
      await fixStylesheetUrls(api, assetMap);
      // 先读后装：恢复写入不再回灌持久化（restoring 期间 onChange 直接忽略）
      const row = await api.records.get('settings', 'prefs').catch(() => null);
      this.prefs = (row && row.value) || {};
      installStorageShims(this.settings, this.session);
      // 恢复写入只进内存替身，不回灌持久化（restoring 期间 onChange 忽略）
      if (this.prefs.locale) {
        try { window.localStorage.setItem('ptlocale', this.prefs.locale); } catch { /* shim 一定可用 */ }
      }
      if (this.prefs.savedOffsets) {
        try {
          window.localStorage.setItem('PTSavedOffsets', JSON.stringify(this.prefs.savedOffsets));
        } catch { /* shim 一定可用 */ }
      }
      restoring = false;
      this.identity = await api.game.call('game.profile').catch(() => null);
    },

    /** 首屏就绪判定：路由替换完成 + 一帧绘制后认为可交互。 */
    async firstFrame() {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },

    /** 设置保存：把 prefs 行整体写回（expectRev CAS，冲突重读重写）。 */
    async savePrefs(prefs) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const row = await api.records.get('settings', 'prefs').catch(() => null);
        try {
          await api.records.put(
            'settings',
            'prefs',
            prefs,
            row && row.rev !== undefined ? { expectRev: row.rev } : undefined
          );
          this.prefs = prefs;
          return;
        } catch (e) {
          if (e && e.code === 'CONFLICT') continue;
          throw e;
        }
      }
    },
  };

  /** localStorage 业务键写入 → 合并进 prefs 行（防抖落盘，退出时窗口很短）。 */
  function onLocalChange(key, value) {
    if (restoring) return;
    const field = PERSISTED_LOCAL_KEYS[key];
    if (!field) return;
    const prefs = { ...(platform.prefs || {}) };
    if (value === null || value === undefined || value === '') {
      delete prefs[field];
    } else if (field === 'savedOffsets') {
      try { prefs.savedOffsets = JSON.parse(value); } catch { return; }
    } else {
      prefs[field] = value;
    }
    platform.prefs = prefs;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      platform.savePrefs(platform.prefs).catch(() => { /* 下次写入会带上本次值 */ });
    }, 300);
  }

  return platform;
}
