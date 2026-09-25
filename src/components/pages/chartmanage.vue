<script>
    import shared from "@utils/js/shared.js";
    import ptdb from "@components/ptdb";
    import { authFetch } from "@utils/serverApi";
    import { chartDownloadQueue } from "@utils/chartDownloadQueue";

    // 谱面管理：合并原「缓存」与「谱面下载」两页。
    // 单列表同时呈现本地已缓存谱面（曲名/难度/大小，整组或按难度删除）与
    // 服务端谱面包（下载/进度/服务端校验出的损坏标记）；通过已下载索引的
    // songId 关联同一首谱面，支持「更新=删旧导新」「删除清标记」联动。
    export default {
        name: "chartManage",
        data() {
            return {
                search: "",
                localEntries: [],
                localLoading: false,
                serverFiles: [],
                serverLoading: false,
                loadError: "",
                importedIndex: {},
                queueItems: [],
                paused: false,
                expanded: {},
                dangerOpen: false,
            };
        },
        computed: {
            pendingCount() {
                return this.queueItems.filter(
                    i => i.status === "queued" || i.status === "downloading" || i.status === "importing"
                ).length;
            },
            localCount() {
                return this.localEntries.length;
            },
            localTotalSize() {
                return this.localEntries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
            },
            // songId → 服务端文件 的反查表（同一文件名只取索引一次）
            linkedFileOf() {
                const map = {};
                for (const file of this.serverFiles) {
                    const link = this.importedIndex[file.name];
                    if (link && link.songId) map[link.songId] = file;
                }
                return map;
            },
            serverOnlyFiles() {
                // 未被任何本地歌曲关联（songId 缺失或对不上）的服务端文件
                return this.serverFiles.filter(file => {
                    const link = this.importedIndex[file.name];
                    if (!link) return true;
                    if (link.songId && this.localEntries.some(e => String(e.song.id) === String(link.songId)))
                        return false;
                    return true; // 旧版记录（无 songId）或本地已被删除
                });
            },
            downloadableFiles() {
                return this.serverOnlyFiles.filter(f => f.valid !== false);
            },
            mergedEntries() {
                const entries = [];
                for (const entry of this.localEntries) {
                    const linkedFile = this.linkedFileOf[String(entry.song.id)];
                    const link = linkedFile ? this.importedIndex[linkedFile.name] : null;
                    entries.push({
                        kind: "local",
                        key: "local:" + entry.song.id,
                        song: entry.song,
                        sizeBytes: entry.sizeBytes,
                        linkedFile: linkedFile || null,
                        outdated: !!(linkedFile && link && link.size !== linkedFile.size),
                    });
                }
                for (const file of this.serverOnlyFiles) {
                    entries.push({
                        kind: "server",
                        key: "server:" + file.name,
                        file: file,
                        legacyImported: !!this.importedIndex[file.name],
                    });
                }
                const query = this.search.trim().toLowerCase();
                const filtered = query
                    ? entries.filter(e =>
                          (e.kind === "local"
                              ? String(e.song.name || "")
                              : String(e.file.name || "")
                          ).toLowerCase().includes(query))
                    : entries;
                const nameOf = e => (e.kind === "local" ? e.song.name : e.file.name) || "";
                filtered.sort((a, b) => nameOf(a).localeCompare(nameOf(b), "zh"));
                return filtered;
            },
        },
        methods: {
            formatSize(size) {
                if (!size && size !== 0) return "";
                if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
                return Math.max(1, Math.round(size / 1024)) + " KB";
            },
            difficultyText(chart) {
                if (typeof chart.difficulty === "string") return chart.difficulty;
                return chart.difficulty === 0 ? "?" : chart.difficulty.toFixed(1);
            },
            difficultySummary(song) {
                const charts = song.charts || [];
                if (!charts.length) return this.$t("chartManage.noCharts");
                return charts.map(c => `${c.level} ${this.difficultyText(c)}`).join(" / ");
            },
            queueItemOf(name) {
                return this.queueItems.find(i => i.name === name) || null;
            },
            isBusy(item) {
                return item && (item.status === "downloading" || item.status === "importing" || item.status === "queued");
            },
            toggleExpand(entry) {
                this.expanded = {
                    ...this.expanded,
                    [entry.song.id]: !this.expanded[entry.song.id],
                };
            },
            refreshQueue() {
                this.queueItems = chartDownloadQueue.items.map(i => ({ ...i }));
                this.paused = chartDownloadQueue.paused;
            },
            downloadFile(file) {
                if (file.valid === false) return;
                chartDownloadQueue.enqueue([file]);
            },
            downloadAll() {
                if (!this.downloadableFiles.length) return;
                chartDownloadQueue.enqueue(this.downloadableFiles);
            },
            retryItem(item) {
                chartDownloadQueue.retry(item.name);
            },
            async updateFile(entry) {
                // 更新 = 删旧导新（旧版本谱面先整组删除，再重新下载）
                if (!entry.linkedFile || entry.linkedFile.valid === false) return;
                await this.deleteSongGroup(entry, true);
                chartDownloadQueue.enqueue([entry.linkedFile]);
            },
            async deleteSongGroup(entry, silent = false) {
                const song = entry.song;
                if (!silent) {
                    const ok = await shared.game.msgHandler.confirm(
                        this.$t("chartManage.confirmDeleteGroup", [song.name || this.$t("chartManage.unnamed")])
                    );
                    if (!ok) return;
                }
                for (const chart of song.charts || []) {
                    await ptdb.chart.chart.delete(chart.id).catch(() => {});
                }
                await ptdb.chart.song.delete(song.id).catch(() => {});
                await chartDownloadQueue.unlinkSong(String(song.id));
                if (!silent)
                    shared.game.msgHandler.sendMessage(this.$t("chartManage.deleted"));
                // unlinkSong 只清了持久化索引，页面内存的 importedIndex 需同步刷新
                await Promise.all([this.reloadLocal(), this.loadImported()]);
            },
            async deleteChart(entry, chart) {
                await ptdb.chart.chart.delete(chart.id).catch(() => {});
                await this.reloadLocal();
            },
            async reloadLocal() {
                this.localLoading = true;
                try {
                    const songs = await ptdb.chart.renderCacheList();
                    const entries = [];
                    for (const song of songs) {
                        // Blob.size 是元数据读取，不触发文件内容加载
                        let sizeBytes = 0;
                        const cachedSong = await ptdb.chart.song
                            .get(song.id)
                            .catch(() => null);
                        if (cachedSong) {
                            sizeBytes +=
                                (cachedSong.songFile && cachedSong.songFile.size) || 0;
                            sizeBytes +=
                                (cachedSong.illustrationFile &&
                                    cachedSong.illustrationFile.size) ||
                                0;
                        }
                        for (const chart of song.charts || []) {
                            const cachedChart = await ptdb.chart.chart
                                .get(chart.id)
                                .catch(() => null);
                            if (cachedChart)
                                sizeBytes +=
                                    (cachedChart.chartFile && cachedChart.chartFile.size) || 0;
                        }
                        entries.push({ song, sizeBytes });
                    }
                    this.localEntries = entries;
                } finally {
                    this.localLoading = false;
                }
            },
            async loadServerList() {
                this.serverLoading = true;
                this.loadError = "";
                try {
                    const resp = await authFetch("/api/game/charts");
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = await resp.json();
                    this.serverFiles = (data.charts || []).slice().sort((a, b) =>
                        a.name.localeCompare(b.name)
                    );
                } catch (e) {
                    this.loadError = e.message || this.$t("chartManage.loadFailed");
                    this.serverFiles = [];
                } finally {
                    this.serverLoading = false;
                }
            },
            async loadImported() {
                this.importedIndex = await chartDownloadQueue.getImportedIndex();
            },
            async refreshAll() {
                await Promise.all([this.loadImported(), this.reloadLocal()]);
                await this.loadServerList();
            },
            async clearAll(t) {
                const ok = await shared.game.msgHandler.confirm(
                    this.$t("chartManage.confirmClear"),
                    this.$t("chartManage.dangerTitle"),
                    this.$t("info.delete"),
                    this.$t("info.cancel")
                );
                if (!ok) return;
                switch (t) {
                    case "charts":
                        window.caches.delete("PTv0-Charts").then(async () => {
                            await indexedDB.deleteDatabase("PTv0");
                            location.reload();
                        });
                        break;
                    case "self":
                        window.caches.delete("PTv0-Main").then(() => {
                            location.reload();
                        });
                        break;
                    case "all":
                        window.caches.delete("PTv0-Main").then(() => {
                            window.caches.delete("PTv0-Charts").then(() => {
                                window.caches.delete("PTv0-User").then(async () => {
                                    await indexedDB.deleteDatabase("PTv0");
                                    shared.game.msgHandler.success(this.$t("chartManage.clearOk"));
                                });
                            });
                        });
                        break;
                }
            },
        },
        async activated() {
            // 基线：当前已完成的下载不再触发刷新（refreshAll 本身会重载列表）
            this._seenDone = new Set(
                chartDownloadQueue.items
                    .filter(i => i.status === "done")
                    .map(i => i.name)
            );
            this.refreshQueue();
            await this.refreshAll();
        },
        // keep-alive 下 activated 在首次挂载与每次进入页面时都会触发，
        // mounted 只负责订阅队列变化
        mounted() {
            this._seenDone = new Set(
                chartDownloadQueue.items
                    .filter(i => i.status === "done")
                    .map(i => i.name)
            );
            this._unsubscribe = chartDownloadQueue.subscribe(() => {
                this.refreshQueue();
                // 有新完成的导入时刷新本地列表与已下载索引：
                // markImported 在 notify 之前完成，不能靠比对索引发现新完成项；
                // 同名项重新入队（删除后重下/更新）时先移出已完成集合，
                // 否则再次完成会被误判为「已见过」而不刷新列表。
                let changed = false;
                for (const item of chartDownloadQueue.items) {
                    if (item.status === "done") {
                        if (!this._seenDone.has(item.name)) {
                            this._seenDone.add(item.name);
                            changed = true;
                        }
                    } else {
                        this._seenDone.delete(item.name);
                    }
                }
                if (changed) {
                    this.loadImported();
                    this.reloadLocal();
                }
            });
        },
        beforeUnmount() {
            if (this._unsubscribe) this._unsubscribe();
        },
    };
</script>

<template>
    <div id="chartManage" class="routerRealPage">
        <div class="cmPanel blur">
            <div class="cmHeader">
                <span class="cmTitle">{{ $t("chartManage.title") }}</span>
                <span class="cmSubtitle">
                    {{ $t("chartManage.subtitleLocal", [localCount, formatSize(localTotalSize)]) }}<template v-if="!loadError"> · {{ $t("chartManage.subtitleServer", [serverFiles.length]) }}</template>
                </span>
                <span class="cmActions">
                    <input
                        class="cmSearch"
                        type="text"
                        v-model="search"
                        :placeholder="$t('chartManage.searchPlaceholder')"
                    />
                    <input
                        type="button"
                        :value="$t('chartManage.refresh')"
                        :disabled="serverLoading || localLoading"
                        @click="refreshAll()"
                    />
                    <input
                        type="button"
                        :value="$t('chartManage.downloadAll')"
                        :disabled="serverLoading || !downloadableFiles.length"
                        @click="downloadAll()"
                    />
                </span>
            </div>

            <div v-if="paused" class="cmNotice">
                {{ $t("chartManage.pausedNotice") }}
            </div>
            <div v-else-if="pendingCount" class="cmNotice">
                {{ $t("chartManage.downloadingNotice", [pendingCount]) }}
            </div>
            <div v-if="loadError" class="cmNotice cmNoticeError">
                {{ $t("chartManage.serverUnreachable", [loadError]) }}
                <input type="button" :value="$t('chartManage.retry')" @click="loadServerList()" />
            </div>

            <div class="cmList">
                <div v-if="localLoading && !localEntries.length" class="cmEmpty">
                    {{ $t("chartManage.loadingLocal") }}
                </div>
                <div
                    v-else-if="!mergedEntries.length"
                    class="cmEmpty"
                >
                    {{ $t("chartManage.empty") }}
                </div>
                <div v-for="entry in mergedEntries" :key="entry.key" class="cmItem">
                    <!-- 本地谱面（可能与某个服务端文件关联） -->
                    <template v-if="entry.kind === 'local'">
                        <div class="cmItemMain">
                            <div class="cmItemInfo" @click="toggleExpand(entry)">
                                <div class="cmItemName">
                                    {{ entry.song.name || $t("chartManage.unnamed") }}
                                    <span v-if="entry.linkedFile" class="cmTag cmTagDone">{{ $t("chartManage.tagDownloaded") }}</span>
                                    <span v-else class="cmTag cmTagLocal">{{ $t("chartManage.tagLocalUpload") }}</span>
                                    <span
                                        v-if="entry.linkedFile && entry.linkedFile.valid === false"
                                        class="cmTag cmTagBroken"
                                        :title="entry.linkedFile.error"
                                    >{{ $t("chartManage.tagBrokenServer") }}</span>
                                </div>
                                <div class="cmItemMeta">
                                    {{ entry.song.composer || $t("chartManage.unknownComposer") }} · {{ difficultySummary(entry.song) }} · {{ formatSize(entry.sizeBytes) }}
                                    <template v-if="entry.outdated">· {{ $t("chartManage.outdated") }}</template>
                                </div>
                            </div>
                            <div class="cmItemAction">
                                <template v-if="entry.linkedFile && queueItemOf(entry.linkedFile.name) && isBusy(queueItemOf(entry.linkedFile.name))">
                                    <div class="cmProgressWrap">
                                        <div class="cmProgressBar">
                                            <div
                                                class="cmProgressFill"
                                                :style="{ width: (queueItemOf(entry.linkedFile.name).progress || 0) + '%' }"
                                            ></div>
                                        </div>
                                        <span class="cmProgressText">
                                            {{ queueItemOf(entry.linkedFile.name).status === 'importing' ? $t("chartManage.importing") : (queueItemOf(entry.linkedFile.name).progress || 0) + '%' }}
                                        </span>
                                    </div>
                                </template>
                                <template v-else-if="entry.linkedFile && queueItemOf(entry.linkedFile.name) && queueItemOf(entry.linkedFile.name).status === 'failed'">
                                    <span class="cmFailedText">{{ queueItemOf(entry.linkedFile.name).error || $t("chartManage.downloadFailed") }}</span>
                                    <input type="button" :value="$t('chartManage.retry')" @click="retryItem(queueItemOf(entry.linkedFile.name))" />
                                </template>
                                <input
                                    v-if="entry.outdated && entry.linkedFile.valid !== false"
                                    type="button"
                                    :value="$t('chartManage.update')"
                                    @click="updateFile(entry)"
                                />
                                <input type="button" :value="$t('chartManage.delete')" @click="deleteSongGroup(entry)" />
                                <input
                                    type="button"
                                    class="cmExpandBtn"
                                    :value="expanded[entry.song.id] ? $t('chartManage.collapse') : $t('chartManage.expand')"
                                    @click="toggleExpand(entry)"
                                />
                            </div>
                        </div>
                        <div v-if="expanded[entry.song.id]" class="cmCharts">
                            <div v-if="!(entry.song.charts || []).length" class="cmChartsEmpty">
                                {{ $t("chartManage.noChartFiles") }}
                            </div>
                            <div v-for="chart in entry.song.charts" :key="chart.id" class="cmChartRow">
                                <div class="cmChartInfo">
                                    {{ chart.level }} {{ difficultyText(chart) }}
                                    <template v-if="chart.charter">· {{ $t("chartManage.charter", [chart.charter]) }}</template>
                                </div>
                                <input type="button" :value="$t('chartManage.delete')" @click="deleteChart(entry, chart)" />
                            </div>
                        </div>
                    </template>

                    <!-- 仅服务端的谱面包（或旧版导入记录未关联） -->
                    <template v-else>
                        <div class="cmItemMain">
                            <div class="cmItemInfo">
                                <div class="cmItemName">
                                    {{ entry.file.name }}
                                    <span v-if="entry.file.valid === false" class="cmTag cmTagBroken" :title="entry.file.error">{{ $t("chartManage.tagBroken") }}</span>
                                    <span v-else-if="entry.legacyImported" class="cmTag cmTagLegacy">{{ $t("chartManage.tagUnlinked") }}</span>
                                </div>
                                <div class="cmItemMeta">
                                    {{ formatSize(entry.file.size) }}
                                    <template v-if="entry.file.valid === false">· {{ entry.file.error }}</template>
                                </div>
                            </div>
                            <div class="cmItemAction">
                                <template v-if="queueItemOf(entry.file.name)">
                                    <template v-if="queueItemOf(entry.file.name).status === 'downloading' || queueItemOf(entry.file.name).status === 'importing'">
                                        <div class="cmProgressWrap">
                                            <div class="cmProgressBar">
                                                <div
                                                    class="cmProgressFill"
                                                    :style="{ width: (queueItemOf(entry.file.name).progress || 0) + '%' }"
                                                ></div>
                                            </div>
                                            <span class="cmProgressText">
                                                {{ queueItemOf(entry.file.name).status === 'importing' ? $t("chartManage.importing") : (queueItemOf(entry.file.name).progress || 0) + '%' }}
                                            </span>
                                        </div>
                                    </template>
                                    <span v-else-if="queueItemOf(entry.file.name).status === 'queued'" class="cmTag cmTagQueued">{{ $t("chartManage.tagQueued") }}</span>
                                    <span v-else-if="queueItemOf(entry.file.name).status === 'failed'" class="cmFailed">
                                        <span class="cmFailedText">{{ queueItemOf(entry.file.name).error || $t("chartManage.downloadFailed") }}</span>
                                        <input type="button" :value="$t('chartManage.retry')" @click="retryItem(queueItemOf(entry.file.name))" />
                                    </span>
                                    <!-- done：以已下载索引为准（本地删除后索引被清，
                                         队列里的历史完成态不应继续显示「已下载」） -->
                                    <span v-else-if="entry.legacyImported" class="cmTag cmTagDone">{{ $t("chartManage.tagDownloaded") }}</span>
                                    <input
                                        v-else-if="entry.file.valid !== false"
                                        type="button"
                                        :value="$t('chartManage.download')"
                                        @click="downloadFile(entry.file)"
                                    />
                                </template>
                                <input
                                    v-else-if="entry.file.valid !== false"
                                    type="button"
                                    :value="entry.legacyImported ? $t('chartManage.redownload') : $t('chartManage.download')"
                                    @click="downloadFile(entry.file)"
                                />
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <!-- 高级清理（原「缓存」页的全局操作） -->
        <div class="cmPanel blur cmDangerPanel">
            <div class="cmDangerHeader" @click="dangerOpen = !dangerOpen">
                <span>{{ $t("chartManage.dangerTitle") }}</span>
                <span class="cmDangerHint">{{ dangerOpen ? $t("chartManage.collapse") : $t("chartManage.expand") }}</span>
            </div>
            <div v-if="dangerOpen" class="cmDangerBody">
                <input type="button" :value="$t('chartManage.dangerDeleteAllCharts')" @click="clearAll('charts')" />
                <input type="button" :value="$t('chartManage.dangerForceUpdate')" @click="clearAll('self')" />
                <input type="button" :value="$t('chartManage.dangerClearAll')" @click="clearAll('all')" />
                <div class="cmDangerNote">
                    {{ $t("chartManage.dangerNote") }}
                </div>
            </div>
        </div>
    </div>
</template>

<style>
    #chartManage {
        width: 92%;
        margin: 0 auto;
        padding-bottom: 30px;
    }

    #chartManage .cmPanel {
        margin-top: 12px;
        border-radius: 12px;
        background-color: #ffffff60;
        padding: 12px 16px;
    }

    #chartManage .cmHeader {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 8px 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid #00000022;
    }

    #chartManage .cmTitle {
        font-size: 1.4em;
        font-weight: bold;
        color: darkslategray;
    }

    #chartManage .cmSubtitle {
        flex: 1;
        min-width: 160px;
        font-size: 0.85em;
        color: #00000099;
    }

    #chartManage .cmActions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }

    #chartManage .cmSearch {
        width: 130px;
        padding: 3px 8px;
        border: 1px solid #00000033;
        border-radius: 6px;
        background-color: #ffffff88;
    }

    #chartManage .cmNotice {
        margin-top: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        background-color: #2b57931a;
        color: #2b5793;
        font-size: 0.9em;
    }

    #chartManage .cmNoticeError {
        background-color: #c628281a;
        color: #c62828;
    }

    #chartManage .cmEmpty {
        padding: 24px 8px;
        text-align: center;
        color: #00000088;
        font-style: italic;
    }

    #chartManage .cmItem {
        border-bottom: 1px solid #00000014;
    }

    #chartManage .cmItem:last-child {
        border-bottom: none;
    }

    #chartManage .cmItemMain {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 10px;
    }

    #chartManage .cmItemInfo {
        min-width: 0;
        flex: 1;
        cursor: pointer;
    }

    #chartManage .cmItemName {
        font-size: 0.95em;
        color: black;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartManage .cmItemMeta {
        font-size: 0.78em;
        color: #00000077;
        margin-top: 2px;
    }

    #chartManage .cmItemAction {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        min-width: 160px;
        justify-content: flex-end;
    }

    #chartManage .cmTag {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 8px;
        border-radius: 4px;
        font-size: 0.78em;
        line-height: 1.4;
        white-space: nowrap;
        vertical-align: middle;
    }

    #chartManage .cmTagDone {
        background-color: #4caf5026;
        color: #2e7d32;
        border: 1px solid #4caf5055;
    }

    #chartManage .cmTagLocal {
        background-color: #2b57931a;
        color: #2b5793;
        border: 1px solid #2b579355;
    }

    #chartManage .cmTagLegacy {
        background-color: #9e9e9e26;
        color: #616161;
        border: 1px solid #9e9e9e55;
    }

    #chartManage .cmTagQueued {
        background-color: #9e9e9e26;
        color: #616161;
        border: 1px solid #9e9e9e55;
    }

    #chartManage .cmTagBroken {
        background-color: #c628281a;
        color: #c62828;
        border: 1px solid #c6282855;
    }

    #chartManage .cmProgressWrap {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 160px;
    }

    #chartManage .cmProgressBar {
        flex: 1;
        height: 8px;
        border-radius: 4px;
        background-color: #0000001f;
        overflow: hidden;
    }

    #chartManage .cmProgressFill {
        height: 100%;
        border-radius: 4px;
        background-color: #2b5793;
        transition: width 0.2s;
    }

    #chartManage .cmProgressText {
        width: 44px;
        text-align: right;
        font-size: 0.78em;
        color: #00000099;
        white-space: nowrap;
    }

    #chartManage .cmFailed {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }

    #chartManage .cmFailedText {
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.78em;
        color: #c62828;
    }

    #chartManage .cmCharts {
        padding: 0 10px 8px 24px;
    }

    #chartManage .cmChartRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 4px 0;
    }

    #chartManage .cmChartInfo {
        flex: 1;
        font-size: 0.85em;
        color: #000000aa;
    }

    #chartManage .cmChartsEmpty {
        font-size: 0.85em;
        color: #00000077;
        font-style: italic;
    }

    #chartManage .cmDangerPanel {
        padding: 8px 16px;
    }

    #chartManage .cmDangerHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        font-weight: bold;
        color: #7a3b3b;
        padding: 2px 0;
    }

    #chartManage .cmDangerHint {
        font-weight: normal;
        font-size: 0.8em;
        color: #00000077;
    }

    #chartManage .cmDangerBody {
        padding: 8px 0 4px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
    }

    #chartManage .cmDangerNote {
        flex-basis: 100%;
        font-size: 0.78em;
        color: #00000077;
    }
</style>
