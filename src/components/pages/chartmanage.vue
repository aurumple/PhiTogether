<script>
    import shared from "@utils/js/shared.js";
    import ptdb from "@components/ptdb";
    import { authFetch } from "@utils/serverApi";
    import { chartDownloadQueue } from "@utils/chartDownloadQueue";

    // 谱面管理：Phigros 式歌曲列表。
    // 每行一首歌（曲绘缩略图 + 曲名/曲师 + 右侧难度徽章），徽章按难度独立
    // 下载/更新/删除；曲绘按滚动可见性懒加载（不在列表中全量加载），无音频预览。
    // 服务端条目（共享库虚拟 pez 与手动 .pez）与本地缓存按「已下载索引」合并：
    // 同曲多难度共用一行，本地音频也只存一份（见 chartDiscovery）。
    const LEVEL_COLORS = {
        EZ: "#3ba55d",
        HD: "#2f7fd3",
        IN: "#d34040",
        AT: "#8e44d3",
        SP: "#7a8288",
    };

    export default {
        name: "chartManage",
        data() {
            return {
                search: "",
                filter: "all",
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
                coverUrls: {},
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
            // 本地歌曲记录 id → { entry, byChartId, byLevel }
            localById() {
                const map = {};
                for (const entry of this.localEntries) {
                    const byChartId = {};
                    const byLevel = {};
                    for (const chart of entry.song.charts || []) {
                        byChartId[String(chart.id)] = chart;
                        byLevel[String(chart.level || "").toUpperCase()] = chart;
                    }
                    map[String(entry.song.id)] = { entry, byChartId, byLevel };
                }
                return map;
            },
            // 歌曲分组列表：服务端难度条目 + 本地记录合并后的行模型
            songs() {
                const groups = {};
                const ensure = (key, base) => {
                    if (!groups[key]) {
                        groups[key] = {
                            key,
                            name: base.name || "",
                            composer: base.composer || "",
                            illustrator: base.illustrator || "",
                            cover: base.cover || null,
                            localSongId: null,
                            diffs: [],
                        };
                    }
                    return groups[key];
                };

                for (const file of this.serverFiles) {
                    const key = file.song_id || "file:" + file.name;
                    const group = ensure(key, {
                        name: file.song_name,
                        composer: file.composer,
                        illustrator: file.illustrator,
                        cover: file.cover,
                    });
                    const link = this.importedIndex[file.name] || null;
                    const local = link && link.songId ? this.localById[String(link.songId)] : null;
                    let localChart = null;
                    if (local) {
                        if (link.chartId) localChart = local.byChartId[String(link.chartId)] || null;
                        if (!localChart) {
                            const lv = String(file.level || "").toUpperCase();
                            if (lv) localChart = local.byLevel[lv] || null;
                        }
                        group.localSongId = String(link.songId);
                    }
                    group.diffs.push({
                        key: "s:" + file.name,
                        level: String(file.level || "").toUpperCase() || "SP",
                        rating: Number(file.rating) || 0,
                        charter: file.charter || "",
                        file,
                        link,
                        localChart,
                        localSong: local ? local.entry : null,
                        outdated: !!(link && local && link.size !== file.size),
                    });
                }

                for (const entry of this.localEntries) {
                    const songId = String(entry.song.id);
                    // 已并入服务端分组的本地歌曲不重复建行
                    let merged = false;
                    for (const key in groups) {
                        if (groups[key].localSongId === songId) {
                            merged = true;
                            break;
                        }
                    }
                    if (merged) continue;
                    const group = ensure("local:" + songId, {
                        name: entry.song.name,
                        composer: entry.song.composer,
                        illustrator: entry.song.illustrator,
                    });
                    group.localSongId = songId;
                    for (const chart of entry.song.charts || []) {
                        group.diffs.push({
                            key: "c:" + chart.id,
                            level: String(chart.level || "").toUpperCase() || "SP",
                            rating: Number(chart.difficulty) || 0,
                            charter: chart.charter || "",
                            file: null,
                            link: null,
                            localChart: chart,
                            localSong: entry,
                            outdated: false,
                        });
                    }
                    if (!(entry.song.charts || []).length) {
                        group.diffs.push({
                            key: "e:" + songId,
                            level: "SP",
                            rating: 0,
                            charter: "",
                            file: null,
                            link: null,
                            localChart: null,
                            localSong: entry,
                            outdated: false,
                        });
                    }
                }

                let list = Object.values(groups);
                const query = this.search.trim().toLowerCase();
                if (query) {
                    list = list.filter(g =>
                        [g.name, g.composer, g.illustrator]
                            .join(" ")
                            .toLowerCase()
                            .includes(query)
                    );
                }
                if (this.filter === "undownloaded")
                    list = list.filter(g =>
                        g.diffs.some(d => d.file && !d.localChart && d.file.valid !== false)
                    );
                else if (this.filter === "downloaded")
                    list = list.filter(g => g.diffs.some(d => d.localChart));
                else if (this.filter === "local")
                    list = list.filter(g => g.diffs.some(d => !d.file && d.localChart));

                list.sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key, "zh"));
                return list;
            },
        },
        methods: {
            formatSize(size) {
                if (!size && size !== 0) return "";
                if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
                return Math.max(1, Math.round(size / 1024)) + " KB";
            },
            ratingText(diff) {
                if (!diff.rating) return "?";
                return String(diff.rating);
            },
            levelColor(level) {
                return LEVEL_COLORS[level] || LEVEL_COLORS.SP;
            },
            queueItemOf(diff) {
                return diff.file ? this.queueItems.find(i => i.name === diff.file.name) || null : null;
            },
            diffState(diff) {
                const item = this.queueItemOf(diff);
                if (item) {
                    if (item.status === "downloading" || item.status === "importing")
                        return { kind: "busy", item };
                    if (item.status === "queued") return { kind: "queued", item };
                    if (item.status === "failed") return { kind: "failed", item };
                }
                if (diff.localChart) return { kind: "done", item };
                if (diff.file && diff.file.valid === false) return { kind: "broken", item };
                return { kind: "idle", item };
            },
            onBadge(diff) {
                const state = this.diffState(diff);
                if (state.kind === "idle" && diff.file) this.downloadDiff(diff);
                else this.toggleExpandByKey(this.groupKeyOf(diff));
            },
            groupKeyOf(diff) {
                for (const g of this.songs) {
                    if (g.diffs.some(d => d.key === diff.key)) return g.key;
                }
                return "";
            },
            downloadDiff(diff) {
                if (!diff.file || diff.file.valid === false) return;
                chartDownloadQueue.enqueue([diff.file]);
            },
            downloadAll() {
                const files = [];
                for (const g of this.songs) {
                    for (const d of g.diffs) {
                        if (d.file && !d.localChart && d.file.valid !== false) files.push(d.file);
                    }
                }
                if (files.length) chartDownloadQueue.enqueue(files);
            },
            retryItem(diff) {
                const item = this.queueItemOf(diff);
                if (item) chartDownloadQueue.retry(item.name);
            },
            toggleExpand(group) {
                this.expanded = { ...this.expanded, [group.key]: !this.expanded[group.key] };
            },
            toggleExpandByKey(key) {
                if (!key) return;
                this.expanded = { ...this.expanded, [key]: !this.expanded[key] };
            },
            groupByKey(key) {
                return this.songs.find(g => g.key === key) || null;
            },
            async deleteDiff(diff) {
                const ok = await shared.game.msgHandler.confirm(
                    this.$t("chartManage.confirmBeforeDelete")
                );
                if (!ok) return;
                await this.deleteDiffSilent(diff);
                shared.game.msgHandler.sendMessage(this.$t("chartManage.deleted"));
            },
            async deleteDiffSilent(diff) {
                if (diff.localChart) {
                    await ptdb.chart.chart.delete(diff.localChart.id).catch(() => {});
                }
                if (diff.file) await chartDownloadQueue.unlinkFile(diff.file.name);
                await Promise.all([this.reloadLocal(), this.loadImported()]);
            },
            async updateDiff(diff) {
                if (!diff.file || diff.file.valid === false) return;
                await this.deleteDiffSilent(diff);
                chartDownloadQueue.enqueue([diff.file]);
            },
            async deleteSongGroup(group) {
                const ok = await shared.game.msgHandler.confirm(
                    this.$t("chartManage.confirmDeleteGroup", [group.name || this.$t("chartManage.unnamed")])
                );
                if (!ok) return;
                for (const diff of group.diffs) {
                    if (diff.localChart) {
                        await ptdb.chart.chart.delete(diff.localChart.id).catch(() => {});
                    }
                    if (diff.file) await chartDownloadQueue.unlinkFile(diff.file.name);
                }
                if (group.localSongId) {
                    await ptdb.chart.song.delete(group.localSongId).catch(() => {});
                    await chartDownloadQueue.unlinkSong(group.localSongId);
                }
                shared.game.msgHandler.sendMessage(this.$t("chartManage.deleted"));
                await Promise.all([this.reloadLocal(), this.loadImported()]);
            },
            refreshQueue() {
                this.queueItems = chartDownloadQueue.items.map(i => ({ ...i }));
                this.paused = chartDownloadQueue.paused;
            },
            async reloadLocal() {
                this.localLoading = true;
                try {
                    const songs = await ptdb.chart.renderCacheList();
                    const entries = [];
                    for (const song of songs) {
                        // Blob.size 是元数据读取，不触发文件内容加载
                        let sizeBytes = 0;
                        const cachedSong = await ptdb.chart.song.get(song.id).catch(() => null);
                        if (cachedSong) {
                            sizeBytes += (cachedSong.songFile && cachedSong.songFile.size) || 0;
                            sizeBytes +=
                                (cachedSong.illustrationFile && cachedSong.illustrationFile.size) || 0;
                        }
                        for (const chart of song.charts || []) {
                            const cachedChart = await ptdb.chart.chart.get(chart.id).catch(() => null);
                            if (cachedChart)
                                sizeBytes += (cachedChart.chartFile && cachedChart.chartFile.size) || 0;
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
                        String(a.song_name || a.name).localeCompare(String(b.song_name || b.name))
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

            // ===== 曲绘懒加载：滚动进入视口才取图（服务端封面/本地曲绘） =====
            async ensureCover(group) {
                const key = group.key;
                if (this.coverUrls[key] !== undefined) return;
                this.coverUrls[key] = ""; // 先占位，避免重复请求
                let url = "";
                try {
                    if (group.cover) {
                        const sep = group.cover.includes("?") ? "&" : "?";
                        const resp = await authFetch(group.cover + sep + "nocache=nocache");
                        if (resp.ok) url = URL.createObjectURL(await resp.blob());
                    } else if (group.localSongId) {
                        const song = await ptdb.chart.song.get(group.localSongId).catch(() => null);
                        if (song && song.illustrationFile && song.illustrationFile.size)
                            url = URL.createObjectURL(song.illustrationFile);
                    }
                } catch {
                    url = "";
                }
                this.coverUrls[key] = url;
            },
            observeRows() {
                if (!this._observer || !this.$el) return;
                const rows = this.$el.querySelectorAll(".cmRow[data-key]:not([data-observed])");
                for (const row of rows) {
                    row.setAttribute("data-observed", "1");
                    this._observer.observe(row);
                }
            },
            coverInitial(name) {
                return (name || "?").trim().charAt(0).toUpperCase();
            },
        },
        async activated() {
            // 基线：当前已完成的下载不再触发刷新（refreshAll 本身会重载列表）
            this._seenDone = new Set(
                chartDownloadQueue.items.filter(i => i.status === "done").map(i => i.name)
            );
            this.refreshQueue();
            await this.refreshAll();
        },
        mounted() {
            this._seenDone = new Set(
                chartDownloadQueue.items.filter(i => i.status === "done").map(i => i.name)
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
            // 曲绘懒加载：进入视口约 300px 内才真正取图
            if (typeof IntersectionObserver !== "undefined") {
                this._observer = new IntersectionObserver(
                    entries => {
                        for (const en of entries) {
                            if (!en.isIntersecting) continue;
                            const key = en.target.getAttribute("data-key");
                            const group = key ? this.groupByKey(key) : null;
                            if (group) this.ensureCover(group);
                            this._observer.unobserve(en.target);
                        }
                    },
                    { rootMargin: "300px 0px" }
                );
                this.$nextTick(() => this.observeRows());
            }
        },
        updated() {
            this.observeRows();
        },
        beforeUnmount() {
            if (this._unsubscribe) this._unsubscribe();
            if (this._observer) this._observer.disconnect();
            for (const key of Object.keys(this.coverUrls)) {
                if (this.coverUrls[key]) URL.revokeObjectURL(this.coverUrls[key]);
            }
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
                        :disabled="serverLoading || filter === 'local'"
                        @click="downloadAll()"
                    />
                </span>
            </div>

            <div class="cmFilters">
                <span
                    class="cmFilter"
                    :class="{ cmFilterOn: filter === 'all' }"
                    @click="filter = 'all'"
                >{{ $t("chartManage.filterAll") }}</span>
                <span
                    class="cmFilter"
                    :class="{ cmFilterOn: filter === 'undownloaded' }"
                    @click="filter = 'undownloaded'"
                >{{ $t("chartManage.filterUndownloaded") }}</span>
                <span
                    class="cmFilter"
                    :class="{ cmFilterOn: filter === 'downloaded' }"
                    @click="filter = 'downloaded'"
                >{{ $t("chartManage.filterDownloaded") }}</span>
                <span
                    class="cmFilter"
                    :class="{ cmFilterOn: filter === 'local' }"
                    @click="filter = 'local'"
                >{{ $t("chartManage.filterLocal") }}</span>
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
                <div v-else-if="!songs.length" class="cmEmpty">
                    {{ $t("chartManage.empty") }}
                </div>

                <div
                    v-for="group in songs"
                    :key="group.key"
                    class="cmRow"
                    :class="{ cmRowOpen: expanded[group.key] }"
                    :data-key="group.key"
                >
                    <div class="cmRowMain" @click="toggleExpand(group)">
                        <div class="cmCoverWrap">
                            <img
                                v-if="coverUrls[group.key]"
                                class="cmCover"
                                :src="coverUrls[group.key]"
                                alt=""
                            />
                            <div v-else class="cmCover cmCoverEmpty">
                                {{ coverInitial(group.name) }}
                            </div>
                        </div>
                        <div class="cmRowInfo">
                            <div class="cmRowName">
                                {{ group.name || $t("chartManage.unnamed") }}
                                <span
                                    v-if="group.diffs.some(d => d.file && !d.localChart)"
                                    class="cmTag cmTagServer"
                                >{{ $t("chartManage.subtitleServer", [group.diffs.filter(d => d.file && !d.localChart).length]) }}</span>
                                <span
                                    v-if="group.diffs.some(d => !d.file && d.localChart)"
                                    class="cmTag cmTagLocal"
                                >{{ $t("chartManage.tagLocalUpload") }}</span>
                            </div>
                            <div class="cmRowMeta">
                                {{ group.composer || $t("chartManage.unknownComposer") }}
                                <template v-if="group.illustrator"> × {{ group.illustrator }}</template>
                            </div>
                        </div>
                        <div class="cmBadges">
                            <div
                                v-for="diff in group.diffs"
                                :key="diff.key"
                                class="cmBadge"
                                :class="[
                                    'cmBadge-' + diffState(diff).kind,
                                    expanded[group.key] ? 'cmBadgeOpen' : ''
                                ]"
                                :style="{ backgroundColor: levelColor(diff.level) }"
                                :title="diff.charter ? $t('chartManage.charter', [diff.charter]) : ''"
                                @click.stop="onBadge(diff)"
                            >
                                <span class="cmBadgeLv">{{ diff.level }}</span>
                                <span class="cmBadgeRating">{{ ratingText(diff) }}</span>
                                <span v-if="diffState(diff).kind === 'done'" class="cmBadgeMark">
                                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                                        <path d="M2 6.5 L5 9.5 L10 3" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                </span>
                                <span v-else-if="diffState(diff).kind === 'busy'" class="cmBadgeMark cmBadgePct">
                                    {{ diffState(diff).item.progress || 0 }}
                                </span>
                                <span v-else-if="diffState(diff).kind === 'failed'" class="cmBadgeMark">!</span>
                                <span v-else-if="diffState(diff).kind === 'broken'" class="cmBadgeMark">!</span>
                                <span v-else class="cmBadgeMark">
                                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                                        <path d="M6 2 L6 8 M3 6.5 L6 9.5 L9 6.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                        <div class="cmChevron" :class="{ cmChevronOpen: expanded[group.key] }">
                            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                                <path d="M3 4.5 L6 8 L9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                        </div>
                    </div>

                    <div v-if="expanded[group.key]" class="cmDetail">
                        <div v-for="diff in group.diffs" :key="diff.key" class="cmDiffRow">
                            <div class="cmDiffInfo">
                                <span class="cmDiffLv" :style="{ backgroundColor: levelColor(diff.level) }">{{ diff.level }}</span>
                                <span class="cmDiffText">
                                    Lv.{{ ratingText(diff) }}
                                    <template v-if="diff.charter"> · {{ $t("chartManage.charter", [diff.charter]) }}</template>
                                    <template v-if="diff.file"> · {{ formatSize(diff.file.size) }}</template>
                                    <template v-if="diff.outdated"> · {{ $t("chartManage.outdated") }}</template>
                                    <template v-if="diff.file && diff.file.valid === false"> · {{ diff.file.error }}</template>
                                </span>
                            </div>
                            <div class="cmDiffActions">
                                <template v-if="diffState(diff).kind === 'busy'">
                                    <div class="cmProgressWrap">
                                        <div class="cmProgressBar">
                                            <div
                                                class="cmProgressFill"
                                                :style="{ width: (diffState(diff).item.progress || 0) + '%' }"
                                            ></div>
                                        </div>
                                        <span class="cmProgressText">
                                            {{ diffState(diff).item.status === 'importing' ? $t("chartManage.importing") : (diffState(diff).item.progress || 0) + '%' }}
                                        </span>
                                    </div>
                                </template>
                                <template v-else-if="diffState(diff).kind === 'queued'">
                                    <span class="cmTag cmTagQueued">{{ $t("chartManage.tagQueued") }}</span>
                                </template>
                                <template v-else-if="diffState(diff).kind === 'failed'">
                                    <span class="cmFailedText">{{ diffState(diff).item.error || $t("chartManage.downloadFailed") }}</span>
                                    <input type="button" :value="$t('chartManage.retry')" @click="retryItem(diff)" />
                                </template>
                                <template v-else-if="diffState(diff).kind === 'broken'">
                                    <span class="cmTag cmTagBroken" :title="diff.file.error">{{ $t("chartManage.tagBroken") }}</span>
                                </template>
                                <template v-else-if="diffState(diff).kind === 'done'">
                                    <input
                                        v-if="diff.file && diff.outdated"
                                        type="button"
                                        :value="$t('chartManage.update')"
                                        @click="updateDiff(diff)"
                                    />
                                    <input
                                        type="button"
                                        :value="$t('chartManage.delete')"
                                        @click="deleteDiff(diff)"
                                    />
                                </template>
                                <template v-else>
                                    <input
                                        v-if="diff.file"
                                        type="button"
                                        :value="diff.link ? $t('chartManage.redownload') : $t('chartManage.download')"
                                        @click="downloadDiff(diff)"
                                    />
                                </template>
                            </div>
                        </div>
                        <div class="cmDetailFoot">
                            <input
                                v-if="group.diffs.some(d => d.localChart)"
                                type="button"
                                :value="$t('chartManage.delete')"
                                @click="deleteSongGroup(group)"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 高级清理（全局操作） -->
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

    #chartManage .cmFilters {
        display: flex;
        gap: 8px;
        padding: 8px 2px 4px;
        flex-wrap: wrap;
    }

    #chartManage .cmFilter {
        padding: 2px 12px;
        border-radius: 999px;
        border: 1px solid #0000002a;
        background-color: #ffffff55;
        color: #00000099;
        font-size: 0.85em;
        cursor: pointer;
        user-select: none;
    }

    #chartManage .cmFilterOn {
        background-color: #2b5793;
        border-color: #2b5793;
        color: white;
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

    /* ===== Phigros 式歌曲行 ===== */
    #chartManage .cmRow {
        border-bottom: 1px solid #00000014;
    }

    #chartManage .cmRow:last-child {
        border-bottom: none;
    }

    #chartManage .cmRowMain {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 10px;
        cursor: pointer;
        border-radius: 10px;
    }

    #chartManage .cmRowMain:hover {
        background-color: #ffffff70;
    }

    #chartManage .cmRowOpen .cmRowMain {
        background-color: #ffffff90;
    }

    #chartManage .cmCoverWrap {
        flex-shrink: 0;
        width: 72px;
        height: 72px;
    }

    #chartManage .cmCover {
        width: 72px;
        height: 72px;
        border-radius: 10px;
        object-fit: cover;
        display: block;
        box-shadow: 0 1px 4px #00000030;
    }

    #chartManage .cmCoverEmpty {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.6em;
        font-weight: bold;
        color: #ffffffcc;
        background: linear-gradient(135deg, #7d8f9c, #4a5a68);
    }

    #chartManage .cmRowInfo {
        flex: 1;
        min-width: 0;
        text-align: left;
    }

    #chartManage .cmRowName {
        font-size: 1.05em;
        font-weight: bold;
        color: #1c2b36;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartManage .cmRowMeta {
        font-size: 0.8em;
        color: #00000088;
        margin-top: 3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartManage .cmTag {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 8px;
        border-radius: 4px;
        font-size: 0.72em;
        line-height: 1.4;
        font-weight: normal;
        white-space: nowrap;
        vertical-align: middle;
    }

    #chartManage .cmTagServer {
        background-color: #2b57931a;
        color: #2b5793;
        border: 1px solid #2b579355;
    }

    #chartManage .cmTagLocal {
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

    /* ===== 难度徽章 ===== */
    #chartManage .cmBadges {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }

    #chartManage .cmBadge {
        position: relative;
        width: 46px;
        height: 46px;
        border-radius: 10px;
        cursor: pointer;
        color: white;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 3px #00000033;
        user-select: none;
    }

    #chartManage .cmBadge:hover {
        filter: brightness(1.12);
    }

    #chartManage .cmBadgeOpen {
        outline: 2px solid #ffffffcc;
    }

    #chartManage .cmBadge-busy {
        opacity: 0.85;
    }

    #chartManage .cmBadge-broken {
        filter: grayscale(0.8);
    }

    #chartManage .cmBadgeLv {
        font-size: 0.72em;
        font-weight: bold;
        line-height: 1;
        letter-spacing: 0.06em;
    }

    #chartManage .cmBadgeRating {
        font-size: 0.95em;
        font-weight: bold;
        line-height: 1.15;
    }

    #chartManage .cmBadgeMark {
        position: absolute;
        right: 3px;
        bottom: 2px;
        font-size: 0.62em;
        line-height: 1;
        opacity: 0.95;
    }

    #chartManage .cmBadgePct {
        background-color: #00000055;
        border-radius: 4px;
        padding: 0 2px;
    }

    #chartManage .cmChevron {
        flex-shrink: 0;
        color: #00000066;
        transition: transform 0.15s;
    }

    #chartManage .cmChevronOpen {
        transform: rotate(180deg);
    }

    /* ===== 展开的难度明细 ===== */
    #chartManage .cmDetail {
        padding: 2px 10px 10px 94px;
        text-align: left;
    }

    #chartManage .cmDiffRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 5px 0;
        border-bottom: 1px dashed #00000014;
    }

    #chartManage .cmDiffRow:last-of-type {
        border-bottom: none;
    }

    #chartManage .cmDiffInfo {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }

    #chartManage .cmDiffLv {
        flex-shrink: 0;
        min-width: 34px;
        text-align: center;
        padding: 1px 6px;
        border-radius: 5px;
        color: white;
        font-size: 0.78em;
        font-weight: bold;
    }

    #chartManage .cmDiffText {
        font-size: 0.82em;
        color: #000000aa;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartManage .cmDiffActions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        min-width: 150px;
        justify-content: flex-end;
    }

    #chartManage .cmDetailFoot {
        display: flex;
        align-items: center;
        gap: 10px;
        padding-top: 8px;
    }

    #chartManage .cmDetailSize {
        font-size: 0.78em;
        color: #00000077;
    }

    #chartManage .cmProgressWrap {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 150px;
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

    #chartManage .cmFailedText {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.78em;
        color: #c62828;
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
