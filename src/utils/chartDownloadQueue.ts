// 服务端谱面（data/charts/*.pez）下载队列：模块级单例，跨页面导航存活。
// chartmanage.vue 只负责渲染队列状态；global.js 在进入/退出游玩路由时调用
// pause()/resume()，游玩中暂停下载以免抢占网络与 IO。
import { importPezChartFromServer } from "@utils/chartDiscovery";
import ptdb from "@components/ptdb";
import i18n from "@locales";

export interface ChartFileMeta {
    name: string;
    path: string;
    size: number;
    /** 服务端校验结果：损坏包禁止下载 */
    valid?: boolean;
    error?: string;
}

export type QueueStatus = "queued" | "downloading" | "importing" | "done" | "failed";

export interface QueueItem extends ChartFileMeta {
    status: QueueStatus;
    /** 0-100：下载阶段为字节进度，解包入库阶段为估算值 */
    progress: number;
    error?: string;
}

// 已导入索引：{ [服务端文件名]: { size, songId, chartId } }，存 ptdb userData。
// - size：导入时的文件字节数，用于「服务端文件有更新」提示（大小变化）；
// - songId：导入生成的本地歌曲 id（同曲多难度共用一个），用于歌曲级联动；
// - chartId：导入生成的本地谱面 id，用于按难度单独更新/删除/清标记。
// 旧版本记录是 { [文件名]: 字节数 }（无 songId），按 typeof 兼容读取。
const IMPORTED_ID = "serverChartsImported";

export interface ImportedEntry {
    size: number;
    songId?: string;
    chartId?: string;
}

/** 旧版数字记录与新版对象记录统一为 ImportedEntry（无 songId 的为未关联旧数据） */
export function normalizeImportedIndex(
    raw: Record<string, unknown>
): Record<string, ImportedEntry> {
    const idx: Record<string, ImportedEntry> = {};
    for (const name of Object.keys(raw || {})) {
        const v = raw[name];
        if (typeof v === "number") idx[name] = { size: v };
        else if (v && typeof v === "object" && typeof (v as ImportedEntry).size === "number")
            idx[name] = v as ImportedEntry;
    }
    return idx;
}

class ChartDownloadQueue {
    items: QueueItem[] = [];
    paused = false;
    private processing = false;
    private controller: AbortController | null = null;
    private listeners = new Set<() => void>();

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private notify() {
        for (const fn of this.listeners) {
            try {
                fn();
            } catch {
                /* 页面回调异常不影响队列 */
            }
        }
    }

    async getImportedIndex(): Promise<Record<string, ImportedEntry>> {
        try {
            const saved = await ptdb.gameConfig.get(IMPORTED_ID, {});
            return normalizeImportedIndex(saved as Record<string, unknown>);
        } catch {
            return {};
        }
    }

    private async saveImportedIndex(idx: Record<string, ImportedEntry>) {
        await ptdb.gameConfig.save(idx, IMPORTED_ID);
    }

    private async markImported(
        item: QueueItem,
        imported: { songId: string; chartId: string } | null
    ) {
        try {
            const idx = await this.getImportedIndex();
            idx[item.name] = {
                size: item.size,
                ...(imported ? { songId: imported.songId, chartId: imported.chartId } : {}),
            };
            await this.saveImportedIndex(idx);
        } catch {
            /* 标记失败不影响已导入数据 */
        }
    }

    /** 删除单个难度的本地记录时清掉对应文件的「已下载」标记。 */
    async unlinkFile(name: string) {
        try {
            const idx = await this.getImportedIndex();
            if (name in idx) {
                delete idx[name];
                await this.saveImportedIndex(idx);
            }
        } catch {
            /* 清理失败只影响标记展示，不影响删除本身 */
        }
    }

    /** 删除本地歌曲时同步清掉「已下载」标记（按 songId 反查文件名）。 */
    async unlinkSong(songId: string) {
        try {
            const idx = await this.getImportedIndex();
            let changed = false;
            for (const name of Object.keys(idx)) {
                if (idx[name].songId === songId) {
                    delete idx[name];
                    changed = true;
                }
            }
            if (changed) await this.saveImportedIndex(idx);
        } catch {
            /* 清理失败只影响标记展示，不影响删除本身 */
        }
    }

    /** 入队一批服务端谱面文件：进行中的同名项跳过；已结束（done/failed）
     * 的同名项重置重新排队（支持删除后重新下载、更新后再次导入）。 */
    enqueue(files: ChartFileMeta[]) {
        for (const file of files) {
            const existing = this.items.find(i => i.name === file.name);
            if (existing) {
                if (
                    existing.status === "queued" ||
                    existing.status === "downloading" ||
                    existing.status === "importing"
                )
                    continue;
                existing.status = "queued";
                existing.progress = 0;
                delete existing.error;
                existing.size = file.size;
                existing.valid = file.valid;
                existing.error = file.error;
            } else {
                this.items.push({ ...file, status: "queued", progress: 0 });
            }
        }
        this.notify();
        void this.process();
    }

    /** 重新入队一个失败项 */
    retry(name: string) {
        const item = this.items.find(i => i.name === name);
        if (!item || item.status === "downloading" || item.status === "importing") return;
        item.status = "queued";
        item.progress = 0;
        delete item.error;
        this.notify();
        void this.process();
    }

    /** 从队列移除未开始/已结束的项（下载中的项不可移除） */
    remove(name: string) {
        const item = this.items.find(i => i.name === name);
        if (!item || item.status === "downloading" || item.status === "importing") return;
        this.items = this.items.filter(i => i.name !== name);
        this.notify();
    }

    /** 暂停：中断进行中的下载（该项回到队首重新排队），不再开始新下载。 */
    pause() {
        if (this.paused) return;
        this.paused = true;
        this.controller?.abort();
        this.notify();
    }

    /** 恢复：继续处理队列。 */
    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.notify();
        void this.process();
    }

    get busy() {
        return this.items.some(i => i.status === "queued" || i.status === "downloading" || i.status === "importing");
    }

    private async process() {
        if (this.processing) return;
        this.processing = true;
        try {
            while (!this.paused) {
                const next = this.items.find(i => i.status === "queued");
                if (!next) break;
                next.status = "downloading";
                next.progress = 0;
                this.notify();
                this.controller = new AbortController();
                try {
                    const imported = await importPezChartFromServer(next.path, next.name, {
                        signal: this.controller.signal,
                        onProgress: p => {
                            next.progress = p;
                            this.notify();
                        },
                        onImporting: () => {
                            next.status = "importing";
                            this.notify();
                        },
                    });
                    const ok = imported !== null;
                    next.status = ok ? "done" : "failed";
                    next.progress = ok ? 100 : next.progress;
                    if (!ok) next.error = i18n.global.t("chartManage.importInvalid");
                    if (ok) await this.markImported(next, imported);
                } catch (e: any) {
                    if (this.paused || e?.name === "AbortError") {
                        // 暂停中断：重新排队等待恢复
                        next.status = "queued";
                        next.progress = 0;
                    } else {
                        next.status = "failed";
                        next.error = String(e?.message || e);
                    }
                }
                this.controller = null;
                this.notify();
            }
        } finally {
            this.processing = false;
        }
    }
}

export const chartDownloadQueue = new ChartDownloadQueue();
