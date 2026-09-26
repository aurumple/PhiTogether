import bitmapUrl from "@renderers/sim-phi/assetsProcessor/external/createImageBitmap.js?url";
import webpUrl from "@renderers/sim-phi/assetsProcessor/external/webp-bundle.js?url";
export const urls = {
    jszip: ["/lib/jszip.js"],
    bitmap: [bitmapUrl],
    webp: [webpUrl],
};

export function loadJS(urls) {
    // 模块容器的地址是 blob URL：原样保留路径字符串，由资源解析器按映射取字节。
    const arr = Array.from(
        urls instanceof Array ? urls : arguments,
        i => (window.__onetapPlatform ? String(i) : new URL(i, location).href)
    );
    const args = (function* (arg) {
        yield* arg;
    })(arr);
    // 模块容器 CSP 只放行 blob: 脚本：先按资源映射取字节（fetch 已被解析器接管），
    // 再以 Blob URL 注入；独立版保持直接 script src。
    const inline = async url => {
        const text = await fetch(url).then(r => {
            if (!r.ok) throw new DOMException(url, "NetworkError");
            return r.text();
        });
        const script = document.createElement("script");
        script.src = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
        await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = () => reject(new DOMException(url, "NetworkError"));
            document.head.appendChild(script);
        });
        return script;
    };
    const load = url =>
        new Promise((resolve, reject) => {
            if (!url)
                return reject(
                    new DOMException("All urls are invalid\n" + arr.join("\n"), "NetworkError")
                );
            if (window.__onetapPlatform) {
                inline(url)
                    .then(script => resolve(script))
                    .catch(() => load(args.next().value).then(s => resolve(s)).catch(e => reject(e)));
                return;
            }
            const script = document.createElement("script");
            script.onload = () => resolve(script);
            script.onerror = () =>
                load(args.next().value)
                    .then(script => resolve(script))
                    .catch(e => reject(e));
            script.src = url;
            script.crossOrigin = "anonymous";
            document.head.appendChild(script);
        });
    return load(args.next().value);
}
