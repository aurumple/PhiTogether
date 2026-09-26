/**
 * 统一资源解析器（模块模式）：把原路径引用改到模块包内扁平化资源。
 *
 * 容器没有网络：/src/core/、/src/respack/、/lib/ 等请求一律由这里按构建期生成的
 * 原路径→清单路径映射从 api.assets 取字节应答：
 *   - XHR/fetch：按映射返回 Blob（含 meta.json 等 JSON 文本）；
 *   - CSS：加载时改写 url(...) 为本实例的 Blob URL（字体等）；
 *   - Blob URL 由容器自己创建与释放（宿主造的 URL 在 opaque 来源不可读）。
 * 直接给 img/audio/video 的 DOM src 赋原路径暂未拦截，属迁移遗留（见交接文档）。
 */

export async function loadAssetMap(api) {
  const bytes = api.assets.read('assets-map.json');
  if (!bytes) return {};
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}

function toBlobUrl(api, path, map) {
  const target = map[path] ?? map[path.replace(/^\//, '')];
  if (!target) return null;
  const file = api.assets.read(target);
  return file ? URL.createObjectURL(new Blob([file], { type: mimeOf(target) })) : null;
}

function mimeOf(path) {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

/** 把 CSS 文本里的 url(...) 改写成实例 Blob URL；包外引用（data:/blob:/远程）原样保留。
 *  压缩器会把空格编码成 %20（带空格字体名），查映射前先尝试解码。 */
export function rewriteCssText(api, text, map) {
  return text.replace(/url\((['"]?)([^'")]+)\1\)/g, (whole, quote, raw) => {
    const path = raw.trim();
    if (path.startsWith('data:') || path.startsWith('blob:')) return whole;
    const resolved = path.startsWith('/') ? path : '/' + path;
    let decoded = resolved;
    try { decoded = decodeURIComponent(resolved); } catch { /* 保持原样 */ }
    const url = toBlobUrl(api, resolved, map) ?? toBlobUrl(api, decoded, map) ??
      toBlobUrl(api, path, map) ?? toBlobUrl(api, decoded.replace(/^\//, ''), map);
    return url ? `url("${url}")` : whole;
  });
}

/** 读取包内 CSS 并把 url(...) 改写成 Blob URL；返回可注入的 CSS 文本。 */
export function cssWithRewrittenUrls(api, cssPath, map) {
  const file = api.assets.read(cssPath);
  if (!file) return '';
  return rewriteCssText(api, new TextDecoder().decode(file), map);
}

/** img/audio/video/source 的 src 与 video 的 poster：DOM 属性赋值也按映射换成 Blob URL。
 *  模板编译产物里全是原路径字面量（/src/core/icons/... 等），不拦就全裂图。 */
export function installDomAssetResolution(api, map) {
  const rewrite = value => {
    if (typeof value !== 'string' || !value || value.startsWith('data:') ||
        value.startsWith('blob:') || value.startsWith('http')) return value;
    return toBlobUrl(api, value, map) ?? toBlobUrl(api, value.replace(/^\//, ''), map) ?? value;
  };
  for (const proto of [HTMLImageElement.prototype, HTMLSourceElement.prototype, HTMLMediaElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(proto, 'src', {
      ...descriptor,
      set(value) { descriptor.set.call(this, rewrite(value)); },
    });
  }
  const poster = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'poster');
  if (poster && poster.set) {
    Object.defineProperty(HTMLVideoElement.prototype, 'poster', {
      ...poster,
      set(value) { poster.set.call(this, rewrite(value)); },
    });
  }
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === 'src' || name === 'poster') value = rewrite(value);
    return originalSetAttribute.call(this, name, value);
  };
}

/** 安装 XHR/fetch 拦截：映射命中的原路径由包内字节应答，其余（未知）明确失败。 */
export function installAssetResolution(api, map) {
  // serve 用原始 fetch 取 Blob 字节；被替换后的 window.fetch 再调它会绕回拦截器自身。
  const originalFetch = window.fetch.bind(window);
  const serve = path => {
    const normalized = path.split('?')[0];
    const url = toBlobUrl(api, normalized, map) ?? toBlobUrl(api, normalized.replace(/^\//, ''), map);
    return url ? originalFetch(url) : null;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    // Chrome 89 rejects /src/... against a blob document in open(), before send()
    // can intercept it. Resolve first, then let native XHR preserve responseType,
    // progress, abort and error semantics (audio/image loaders depend on these).
    const path = typeof url === 'string' ? url.split('?')[0] : '';
    const resolved = toBlobUrl(api, path, map);
    return originalOpen.call(this, method, resolved || url, ...rest);
  };

  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const hit = !url.startsWith('http') && !url.startsWith('blob:') ? serve(url) : null;
    // 未命中必须交还原生 fetch：用 ?? 会在 hit=false 时把 false 当结果返回，
    // 调用方拿到的不是 Promise，.then 直接炸且报错指向无关代码。
    return hit ? hit : originalFetch(input, init);
  };
}
