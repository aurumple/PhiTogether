/**
 * 噪域填充色的配置解析。
 *
 * 设置页用浏览器自带 `<input type="color">`（Chrome 89 支持），值恒为 `#rrggbb`；
 * 但用户存档里可能有手工写入的其它写法，因此这里同时接受：
 *  - `#rgb` / `#rrggbb`（可省略 `#`）
 *  - `rgb(r,g,b)` / `r,g,b`（旧版本可能存的是三元组文本）
 * 解析失败一律回退 `DEFAULT_BLOCK_FILL`，绝不让一个坏值把噪域画成透明。
 */

/** 默认填充色 rgb(77,34,32)。官方材质 _FillColor 是 rgb(182,60,60)，实测偏浅，按用户要求加深。 */
export const DEFAULT_BLOCK_FILL: readonly [number, number, number] = [77, 34, 32];

export type BlockFill = readonly [number, number, number];

function clampByte(value: number): number {
    if (!Number.isFinite(value)) return NaN;
    const byte = Math.round(value);
    if (byte < 0) return 0;
    if (byte > 255) return 255;
    return byte;
}

function fromHex(text: string): BlockFill | null {
    const hex = text.replace(/^#/, "");
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    if (hex.length === 3) {
        return [
            parseInt(hex[0] + hex[0], 16),
            parseInt(hex[1] + hex[1], 16),
            parseInt(hex[2] + hex[2], 16),
        ] as const;
    }
    if (hex.length === 6) {
        return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
        ] as const;
    }
    return null;
}

function fromTriple(text: string): BlockFill | null {
    const parts = text
        .replace(/^rgba?\(/i, "")
        .replace(/\)$/, "")
        .split(/[\s,]+/)
        .filter(part => part.length > 0);
    if (parts.length < 3) return null;
    const bytes = parts.slice(0, 3).map(part => clampByte(Number(part)));
    if (bytes.some(byte => Number.isNaN(byte))) return null;
    return bytes as unknown as BlockFill;
}

/** 解析任意受支持的写法；失败回退默认值。 */
export function parseBlockFill(value: unknown): BlockFill {
    if (typeof value !== "string") return DEFAULT_BLOCK_FILL;
    const text = value.trim();
    if (!text) return DEFAULT_BLOCK_FILL;
    const parsed = text.includes(",") || /^rgba?\(/i.test(text) ? fromTriple(text) : fromHex(text);
    return parsed || DEFAULT_BLOCK_FILL;
}

/** 转成 `#rrggbb`，供 `<input type="color">` 回显。 */
export function toColorInputValue(value: unknown): string {
    const [r, g, b] = parseBlockFill(value);
    const hex = (byte: number) => byte.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** 转成 `rgb(r, g, b)` 文本，供设置页显示当前值。 */
export function toRgbText(value: unknown): string {
    const [r, g, b] = parseBlockFill(value);
    return `rgb(${r}, ${g}, ${b})`;
}
