/**
 * 存储替身（模块模式过渡用）。
 *
 * 容器是 opaque 来源：window.localStorage / window.sessionStorage 一旦被访问就抛
 * SecurityError。这里提供内存替身挡崩溃；业务键最终都要真正持久化——localStorage
 * 的业务键（ptlocale、PTSavedOffsets）经 onChange 回调转发到 api.records（见
 * platform/onetap/index.js 的 savePrefs），sessionStorage 的业务键（loadedChart、
 * chartDetailsData）本就是实例内会话数据，替身挂在 window.__onetapPlatform.session
 * 上即为实例内对象。
 */

export function createStorageShim(onChange) {
  const map = new Map();
  const notify = (key, value) => {
    if (typeof onChange === 'function') {
      try { onChange(String(key), value); } catch { /* 持久化失败不阻断读写 */ }
    }
  };
  const methods = {
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => {
      map.set(String(key), String(value));
      notify(key, String(value));
    },
    removeItem: key => {
      map.delete(String(key));
      notify(key, null);
    },
    clear: () => {
      const keys = [...map.keys()];
      map.clear();
      for (const key of keys) notify(key, null);
    },
    key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
  // 属性式访问（localStorage.PTSavedOffsets = ... / localStorage.lastMultiInfo）在真实
  // Storage 上是合法写法，替身必须同样支持，否则这类写入会静默丢失。
  return new Proxy(methods, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return target[prop];
      return target.getItem(prop);
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol' || (prop in target && prop !== 'length')) {
        target[prop] = value;
        return true;
      }
      target.setItem(prop, value);
      return true;
    },
  });
}

/** 给 window 装上可安全访问的 localStorage/sessionStorage 替身（真实存储不可用）。 */
export function installStorageShims(local, session) {
  try { window.localStorage.getItem; return; } catch { /* 真实存储不可用，装替身 */ }
  try {
    Object.defineProperty(window, 'localStorage', { value: local, configurable: true });
    Object.defineProperty(window, 'sessionStorage', {
      value: session || createStorageShim(),
      configurable: true,
    });
  } catch { /* 极端环境下仍不可覆盖：由调用方在迁移点逐一规避 */ }
}
