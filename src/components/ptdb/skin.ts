import { getBackend } from "./backend";
import { generateUUID } from "@utils/js/uuid";
import shared from "@utils/js/shared";

interface CachedSkin<FileType = Blob> {
    name: string;
    author: string;
    files: FileType[];
    rawConfig?: prprSkinConfig;
}
interface prprSkinConfig {}
interface CachedSkinFile {
    // fileName: string,
    file: ImageBitmap | ArrayBuffer;
    imgOptions?: SkinImgOptions;
    type: SkinFileType;
}
interface SkinImgOptions {
    noteBaseScale: number | 1089;
}
enum SkinFileType {
    Tap = "Tap",
    TapHL = "TapHL",
    Drag = "Drag",
    DragHL = "DragHL",
    Hold = "Hold",
    HoldHL = "HoldHL",
    Flick = "Flick",
    FlickHL = "FlickHL",
    HitFX = "HitFX",
    HitSong0 = "HitSong0",
    HitSong1 = "HitSong1",
    HitSong2 = "HitSong2",
}

export function getCachedSkins(): Promise<CachedSkin<string>> {
    return getAllSkins() as Promise<any>;
}

interface CustomResourceMeta {
    name: string;
    author: string;
}

/**
 * 皮肤文件统一以「原始字节 + kind」交给后端：
 *   - IDB 后端按旧格式落库（图片解码成 ImageBitmap、音频存 ArrayBuffer）；
 *   - 模块后端只落原始字节（blob），解码留到读取时（见 decodeSkinFile）。
 */
function isSkinAudio(type: string): boolean {
    return String(type).startsWith("HitSong");
}

async function decodeSkinFile(entry: { type: string; kind?: string; file?: any }): Promise<any> {
    const file = entry.file;
    if (file === undefined || file === null) return file;
    const kind = entry.kind || (isSkinAudio(entry.type) ? "audio" : "image");
    if (kind === "audio") {
        if (file instanceof ArrayBuffer) return file;
        if (file instanceof Blob) return await file.arrayBuffer();
        return (file as Uint8Array).slice().buffer;
    }
    if (typeof ImageBitmap !== "undefined" && file instanceof ImageBitmap) return file;
    return await createImageBitmap(file instanceof Blob ? file : new Blob([file as BlobPart]));
}

export function saveSkin(
    entries: Map<
        string,
        {
            buffer: ArrayBuffer;
            name: string;
            path: string;
        }
    >,
    meta: CustomResourceMeta,
    config: prprSkinConfig
): Promise<string | void> {
    return new Promise(async (res, rej) => {
        if (
            (await haveCommonSkin(meta)) &&
            (await shared.game.msgHandler.confirm(shared.game.i18n.t("skin.haveCommon")))
        )
            return res();

        const files: Map<string, { type: string; kind: string; file: any; imgOptions?: any }> =
            new Map();

        for (const type of [
            "Tap",
            "TapHL",
            "Drag",
            "DragHL",
            "Flick",
            "FlickHL",
            "Hold",
            "HoldHL",
            "HitFX",
        ]) {
            if (!entries.has(type)) continue;
            files.set(type, {
                type,
                kind: "image",
                file: entries.get(type)!.buffer.slice(0),
            });
        }
        // 读取音频
        for (const type of ["HitSong0", "HitSong1", "HitSong2"]) {
            if (!entries.has(type)) continue;
            files.set(type, {
                type,
                kind: "audio",
                file: entries.get(type)!.buffer.slice(0),
            });
        }

        // 与旧实现一致：只有含 Hold 条目的皮肤才入库（历史行为如此，勿单独放宽）
        if (entries.has("Hold")) {
            const id = generateUUID();
            try {
                await getBackend().putSkin({
                    id,
                    name: meta.name || "unknown",
                    author: meta.author || "unknown",
                    files,
                    config,
                });
            } catch (e) {
                return rej(e);
            }
            // shared.game.msgHandler.sendMessage(shared.game.i18n.t("skin.saved"));
            res(id);
        }
    });
}

export function getAllSkins(): Promise<CachedSkin[]> {
    return getBackend().listSkins();
}
function haveCommonSkin(meta: CustomResourceMeta): Promise<boolean> {
    return new Promise(async res => {
        const allCharts = await getAllSkins();
        for (const i of allCharts) {
            if (i.name === meta.name && i.author === meta.author) return res(true);
        }
        res(false);
    });
}

export function getSkin(id: string): Promise<CachedSkin<CachedSkinFile> | null> {
    return getBackend()
        .getSkin(id)
        .then(async result => {
            if (!result) return Promise.reject(new Error("Skin Not Found"));
            if (result.files instanceof Map) {
                const decoded = new Map();
                for (const [type, entry] of result.files.entries()) {
                    decoded.set(type, {
                        ...entry,
                        type: entry.type || type,
                        file: await decodeSkinFile({ ...entry, type: entry.type || type }),
                    });
                }
                result.files = decoded;
            }
            return result;
        });
}

export function deleteSkin(id: string | null): Promise<boolean> | null {
    if (id === null) return null;
    return getBackend().deleteSkin(id);
}
