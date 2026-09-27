import ptdb from "@components/ptdb";
import { authFetch, moduleApi } from "./serverApi";
import md5 from "md5";

const PREFIX = "libraryCache:v1:";
const MANIFEST = PREFIX + "manifest";
const PAGE_SIZE = 40;
let revision = 0;
let writes: Promise<any> = Promise.resolve();
const pending = new Map<string, Promise<string>>();

function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = writes.then(action);
    writes = result.catch(() => undefined);
    return result;
}
async function read(key: string, fallback: any = null): Promise<any> {
    return ptdb.gameConfig.get(key).catch(() => fallback);
}
export async function readLibrary() {
    const manifest = await read(MANIFEST);
    if (!manifest) return null;
    const pages = await Promise.all(
        Array.from({ length: manifest.pages }, (_, i) => read(PREFIX + "page:" + i))
    );
    if (pages.some(p => !Array.isArray(p))) return null;
    return { charts: pages.flat(), chapters: manifest.chapters || [] };
}
export function saveLibrary(charts: any[], chapters: any[], expectedRevision = revision) {
    // Vue lists are proxies, which IndexedDB cannot structured-clone.
    charts = JSON.parse(JSON.stringify(charts));
    chapters = JSON.parse(JSON.stringify(chapters));
    return serialize(async () => {
        if (expectedRevision !== revision) return;
        const old = await read(MANIFEST);
        const pages = Math.ceil(charts.length / PAGE_SIZE);
        const entries = Array.from({ length: Math.max(pages, old?.pages || 0) }, (_, i) => ({
            id: PREFIX + "page:" + i,
            mutator: () => (i < pages ? charts.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE) : null),
        }));
        // OneTap records.batch is limited to 200 operations; don't publish partial snapshots.
        if (entries.length >= 200) throw new Error("Library cache is too large");
        await ptdb.gameConfig.updateBatch([
            ...entries,
            { id: MANIFEST, mutator: () => ({ pages, chapters, covers: old?.covers || [] }) },
        ]);
    });
}
export function libraryRevision() {
    return revision;
}

export function clearLibrary() {
    revision++;
    return serialize(async () => {
        const old = await read(MANIFEST);
        const keys = [
            ...Array.from({ length: old?.pages || 0 }, (_, i) => PREFIX + "page:" + i),
            ...(old?.covers || []),
        ];
        // Remove the published snapshot first. Empty values release payload space on both backends.
        await ptdb.gameConfig.save({}, MANIFEST);
        for (let i = 0; i < keys.length; i += 100)
            await ptdb.gameConfig.updateBatch(
                keys.slice(i, i + 100).map(id => ({ id, mutator: () => null }))
            );
        pending.clear();
    });
}

async function thumbnail(blob: Blob): Promise<string> {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("Invalid cover"));
            img.src = url;
        });
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 192 / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.8);
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Small persistent thumbnails; never store expiring object URLs or duplicate song audio. */
export function cachedCover(source: string, version = "", localUrl = ""): Promise<string> {
    if (!source && !localUrl) return Promise.resolve("");
    const key = PREFIX + "cover:" + md5(source || localUrl);
    const requestKey = key + ":" + version;
    if (pending.has(requestKey)) return pending.get(requestKey)!;
    const startRevision = revision;
    const task = (async () => {
        const old = await read(key);
        if (old?.data && old.version === version) return old.data;
        let blob: Blob | null = null;
        // Local files work without authentication or network and don't consume bandwidth.
        if (localUrl && !source && !old) {
            try {
                const resp = await ptdb.fetch(localUrl);
                if (resp.ok) blob = await resp.blob();
            } catch {}
        }
        try {
            if (!blob && source) {
                const api = moduleApi();
                if (api?.game && !source.includes("/")) {
                    const got = await api.game.download(source);
                    try {
                        blob = new Blob([await api.blobs.read(got.blobId)]);
                    } finally {
                        await api.blobs.release(got.blobId).catch(() => undefined);
                    }
                } else {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10000);
                    try {
                        const resp = await authFetch(
                            source +
                                (version
                                    ? (source.includes("?") ? "&" : "?") +
                                      "v=" +
                                      encodeURIComponent(version)
                                    : ""),
                            { signal: controller.signal }
                        );
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        blob = await resp.blob();
                    } finally {
                        clearTimeout(timeout);
                    }
                }
            }
            if (!blob) return old?.data || "";
            const data = await thumbnail(blob);
            await serialize(async () => {
                if (startRevision !== revision) return;
                await ptdb.gameConfig.updateBatch([
                    { id: key, mutator: () => ({ version, data }) },
                    {
                        id: MANIFEST,
                        mutator: (cur: any) => ({
                            ...cur,
                            covers: [...new Set([...(cur?.covers || []), key])],
                        }),
                    },
                ]);
            });
            return data;
        } catch (error) {
            if (old?.data) return old.data;
            if (localUrl) {
                try {
                    return await thumbnail(await (await ptdb.fetch(localUrl)).blob());
                } catch {}
            }
            throw error;
        }
    })().finally(() => pending.delete(requestKey));
    pending.set(requestKey, task);
    return task;
}
