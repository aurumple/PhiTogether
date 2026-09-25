import { ZipReader } from "@renderers/sim-phi/assetsProcessor/reader";
import ptdb from "@components/ptdb";
import { authFetch } from "@utils/serverApi";

interface PezInfo {
    name: string;
    level: string;
    composer: string;
    charter: string;
    illustrator: string;
}

interface FileEntry {
    name: string;
    path: string;
    buffer: ArrayBuffer;
}

interface ExtractedChart {
    chartBuffer: ArrayBuffer;
    songBuffer: ArrayBuffer;
    illustrationBuffer: ArrayBuffer;
    info: PezInfo;
}

export interface ImportProgressOptions {
    /** 中止信号（游玩暂停下载用） */
    signal?: AbortSignal;
    /** 下载字节进度回调，0-90 */
    onProgress?: (percent: number) => void;
    /** 进入解包/入库阶段回调（占 90-100） */
    onImporting?: () => void;
}

function parsePezInfo(text: string): PezInfo {
    const lines = text.split("\n");
    const map: Record<string, string> = {};
    for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (value) map[key] = value;
    }
    return {
        name: map["name"] || "Unknown",
        level: map["level"] || "SP Lv.?",
        composer: map["composer"] || "Unknown",
        charter: map["charter"] || "Unknown",
        illustrator: map["illustrator"] || map["composer"] || "Unknown",
    };
}

function parseLevel(levelStr: string): { level: string; difficulty: number } {
    const match = levelStr.match(/(AT|IN|HD|EZ|SP)\s*Lv\.?\s*(\d+(?:\.\d+)?)/i);
    if (!match) return { level: "SP Lv.?", difficulty: 0 };
    return {
        level: match[1].toUpperCase(),
        difficulty: Number(match[2]) || 0,
    };
}

/**
 * 从服务端下载一个 .pez/.zip 谱面包并导入 PhiTogether IndexedDB。
 * 通过 response body reader 上报字节进度（0-90），解包入库阶段占 90-100。
 * 支持AbortSignal：中止时抛出 AbortError，由调用方决定重新排队。
 * 成功时返回导入生成的本地歌曲 id（供已下载索引建立 文件名↔本地歌曲 关联），
 * 文件无效（解包失败）返回 null，保存失败返回 null。
 */
export async function importPezChartFromServer(
    filePath: string,
    fileName: string,
    opts: ImportProgressOptions = {}
): Promise<string | null> {
    const { signal, onProgress, onImporting } = opts;
    const resp = await authFetch(filePath, { signal });
    if (!resp.ok) throw new Error(`Chart download failed (${resp.status})`);

    const total = Number(resp.headers.get("content-length")) || 0;
    let buffer: ArrayBuffer;
    if (resp.body && typeof resp.body.getReader === "function" && total > 0) {
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            onProgress?.(Math.min(90, Math.floor((received / total) * 90)));
        }
        const merged = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        buffer = merged.buffer;
    } else {
        buffer = await resp.arrayBuffer();
        onProgress?.(80);
    }
    onProgress?.(90);
    onImporting?.();

    const extracted = await extractPez(buffer, fileName);
    if (!extracted) return null;

    const songId = await saveToIndexedDB(extracted);
    onProgress?.(100);
    return songId;
}

async function extractPez(buffer: ArrayBuffer, fileName: string): Promise<ExtractedChart | null> {
    const isZip = buffer.byteLength > 4 &&
        new DataView(buffer).getUint32(0, false) === 0x504b0304;
    if (!isZip) return null;

    const files: FileEntry[] = [];

    const zip = new ZipReader({
        handler: (data: { name: string; path: string; buffer: ArrayBuffer }) => {
            files.push({ name: data.name, path: data.path, buffer: data.buffer.slice(0) });
            return { type: "skip", name: data.name, data: null };
        },
    });

    await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 5000);
        zip.addEventListener("read", () => {
            if (zip.total > 0 && files.length >= zip.total) {
                clearTimeout(timeout);
                resolve();
            }
        });
        zip.addEventListener("loadstart", () => {});
        zip.read({ name: fileName, buffer, path: fileName });
    });

    if (files.length === 0) return null;

    let infoTxt: string | null = null;
    let infoYml: string | null = null;
    let chartBuf: ArrayBuffer | null = null;
    let songBuf: ArrayBuffer | null = null;
    let illBuf: ArrayBuffer | null = null;

    for (const f of files) {
        const name = f.name.toLowerCase();
        if (name === "info.txt") {
            infoTxt = new TextDecoder("utf-8").decode(f.buffer);
        } else if (name === "info.yml") {
            infoYml = new TextDecoder("utf-8").decode(f.buffer);
        } else if (name.endsWith(".json")) {
            chartBuf = f.buffer;
        } else if (name.endsWith(".ogg") || name.endsWith(".mp3") || name.endsWith(".wav")) {
            songBuf = f.buffer;
        } else if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp")) {
            illBuf = f.buffer;
        }
    }

    if (!chartBuf || !songBuf) return null;

    let info: PezInfo;
    if (infoTxt) {
        info = parsePezInfo(infoTxt);
    } else if (infoYml) {
        const parsed = parseYamlInfo(infoYml);
        info = parsed;
    } else {
        info = {
            name: fileName.replace(/\.(pez|zip)$/i, ""),
            level: "SP Lv.?",
            composer: "Unknown",
            charter: "Unknown",
            illustrator: "Unknown",
        };
    }

    return {
        chartBuffer: chartBuf,
        songBuffer: songBuf,
        illustrationBuffer: illBuf || new Uint8Array(0).buffer as ArrayBuffer,
        info,
    };
}

function parseYamlInfo(text: string): PezInfo {
    const map: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (value) map[key] = value;
    }
    return {
        name: map["name"] || "Unknown",
        level: map["level"] || "SP Lv.?",
        composer: map["composer"] || "Unknown",
        charter: map["charter"] || "Unknown",
        illustrator: map["illustrator"] || map["composer"] || "Unknown",
    };
}

async function saveToIndexedDB(extracted: ExtractedChart): Promise<string | null> {
    const { chartBuffer, songBuffer, illustrationBuffer, info } = extracted;
    const { level, difficulty } = parseLevel(info.level);

    const chartText = new TextDecoder("utf-8").decode(chartBuffer);
    let md5hash: string;
    try {
        const md5mod = await import("md5");
        md5hash = md5mod.default(chartText);
    } catch {
        md5hash = "";
    }

    const chartId = md5hash || info.name;

    const songMeta = {
        id: chartId,
        name: info.name,
        composer: info.composer,
        illustrator: info.illustrator,
        song: "",
        illustration: "",
    };

    const chartMeta = {
        id: chartId,
        level: level,
        difficulty: difficulty,
        chart: "",
        charter: info.charter,
        song: chartId,
    };

    try {
        const cachedSong = await ptdb.chart.song.download(
            songMeta,
            new Blob([songBuffer]),
            illustrationBuffer.byteLength > 0
                ? new Blob([illustrationBuffer])
                : undefined
        );
        await ptdb.chart.song.save(cachedSong);
    } catch (e) {
        console.warn("Failed to save song:", info.name, e);
        return null;
    }

    try {
        const cachedChart = await ptdb.chart.chart.download(
            chartMeta,
            new Blob([chartBuffer])
        );
        await ptdb.chart.chart.save(cachedChart);
    } catch (e) {
        console.warn("Failed to save chart:", info.name, e);
        return null;
    }

    return chartId;
}
