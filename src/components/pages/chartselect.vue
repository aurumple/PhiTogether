<script>
    import shared from "@utils/js/shared.js";
    import { audio } from "@utils/js/aup";
    import ptdb from "@components/ptdb";
    import ploading from "@utils/js/ploading.js";
    import { authFetch, moduleApi } from "@utils/serverApi";
    import { chartDownloadQueue } from "@utils/chartDownloadQueue";
    import {
        cachedCover,
        readLibrary,
        saveLibrary,
        clearLibrary,
        libraryRevision,
    } from "@utils/libraryCache";
    import { ptServer } from "@utils/ptServer";
    import { formatChartLevel, mergeLocalSongCharts } from "@utils/localChartGrouping.mjs";

    // 单人游戏：Phigros 式章节选曲，统一「浏览 / 下载 / 游玩」。
    // 客户端只拉取服务端谱面资源列表（含章节归属），.pez 资源按需下载；
    // 曲绘懒加载，无音频预览。难度徽章双态：未下载 → 下载，已下载 → 开玩。
    // 章节划分数据来自 server/tools/phigros_chapters.json（拉谱脚本写入 meta），
    // 无章节归属与自定义上传的谱面归入「其他」。
    const LEVEL_COLORS = {
        EZ: "#3ba55d",
        HD: "#2f7fd3",
        IN: "#d34040",
        AT: "#8e44d3",
        SP: "#7a8288",
    };

    export default {
        name: "chartSelect",
        data() {
            return {
                search: "",
                selectedChapter: "__downloaded__",
                cacheProgress: { done: 0, total: 0, failed: 0 },
                chapters: [],
                serverFiles: [],
                localSongs: [],
                importedIndex: {},
                queueItems: [],
                paused: false,
                expandedKey: null,
                boardKey: null,
                boards: {},
                favouriteSongs: [],
                coverUrls: {},
                loadError: "",
                cacheError: "",
                loading: false,
                settingsOpen: false,
                playSettings: {
                    speed: "",
                    mirror: false,
                    practiseMode: false,
                    previewMode: false,
                    adjustOffset: false,
                    videoRecorder: false,
                },
                forceOffline: false,
            };
        },
        computed: {
            pendingCount() {
                return this.queueItems.filter(
                    i =>
                        i.status === "queued" ||
                        i.status === "downloading" ||
                        i.status === "importing"
                ).length;
            },
            localById() {
                const map = {};
                for (const song of this.localSongs) map[String(song.id)] = song;
                return map;
            },
            // 服务端条目 + 本地缓存 合并成「一曲一行」的分组模型
            songGroups() {
                const groups = {};
                const ensure = (key, base) => {
                    if (!groups[key]) {
                        groups[key] = {
                            key,
                            name: base.name || "",
                            composer: base.composer || "",
                            illustrator: base.illustrator || "",
                            cover: base.cover || null,
                            coverVersion: base.coverVersion || "",
                            chapter: base.chapter || "",
                            chapterOrder:
                                typeof base.chapterOrder === "number" ? base.chapterOrder : 999,
                            localSongId: null,
                            localSong: null,
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
                        coverVersion: file.cover_version,
                        chapter: file.chapter,
                        chapterOrder: file.chapter_order,
                    });
                    const link = this.importedIndex[file.name] || null;
                    const localSong =
                        link && link.songId ? this.localById[String(link.songId)] : null;
                    let localChart = null;
                    if (localSong) {
                        const charts = localSong.charts || [];
                        if (link.chartId)
                            localChart =
                                charts.find(c => String(c.id) === String(link.chartId)) || null;
                        if (!localChart) {
                            const lv = String(file.level || "").toUpperCase();
                            if (lv)
                                localChart =
                                    charts.find(c => String(c.level || "").toUpperCase() === lv) ||
                                    null;
                        }
                        group.localSongId = String(link.songId);
                        group.localSong = localSong;
                    }
                    group.diffs.push({
                        key: "s:" + file.name,
                        level: String(file.level || "").toUpperCase() || "SP",
                        rating: Number(file.rating) || 0,
                        charter: file.charter || "",
                        file,
                        link,
                        localChart,
                        outdated: !!(link && localSong && link.size !== file.size),
                    });
                }

                for (const song of this.localSongs) {
                    const songId = String(song.id);
                    let merged = false;
                    for (const key in groups) {
                        if (groups[key].localSongId === songId) {
                            merged = true;
                            break;
                        }
                    }
                    if (merged) continue;
                    const group = ensure("local:" + songId, {
                        name: song.name,
                        composer: song.composer,
                        illustrator: song.illustrator,
                    });
                    group.localSongId = songId;
                    group.localSong = song;
                    for (const chart of song.charts || []) {
                        group.diffs.push({
                            key: "c:" + chart.id,
                            level: String(chart.level || "").toUpperCase() || "SP",
                            rating: Number(chart.difficulty) || 0,
                            charter: chart.charter || "",
                            file: null,
                            link: null,
                            localChart: chart,
                            outdated: false,
                        });
                    }
                }

                return Object.values(groups);
            },
            // 章节条：收藏 + 有内容的章节 + 固定的 单曲精选集/隐秘/其他
            chapterItems() {
                const fixed = ["单曲精选集", "隐秘", "其他"];
                const byChapter = new Map();
                for (const group of this.songGroups) {
                    const name = group.chapter || "其他";
                    if (!byChapter.has(name)) byChapter.set(name, []);
                    byChapter.get(name).push(group);
                }
                const items = [
                    {
                        id: "__downloaded__",
                        name: this.$t("chartSelect.offline.downloaded"),
                        groups: this.songGroups
                            .filter(g => g.diffs.some(d => d.localChart))
                            .map(g => ({ ...g, diffs: g.diffs.filter(d => d.localChart) })),
                    },
                ];
                const favGroups = this.songGroups.filter(g => this.isFavourite(g));
                if (favGroups.length)
                    items.push({
                        id: "__fav__",
                        name: this.$t("chartSelect.chapters.favorites"),
                        groups: favGroups,
                    });
                for (const chapter of this.chapters) {
                    const groups = byChapter.get(chapter.name) || [];
                    if (!groups.length && !fixed.includes(chapter.name)) continue;
                    items.push({
                        id: chapter.id || chapter.name,
                        name: chapter.name,
                        groups: groups.slice().sort((a, b) => a.name.localeCompare(b.name, "zh")),
                    });
                }
                // 章节表之外的（手动 pez / 本地上传）统一归入「其他」
                const known = new Set(this.chapters.map(c => c.name));
                const rest = this.songGroups.filter(g => !known.has(g.chapter) && g.chapter !== "");
                const other = byChapter.get("其他") || [];
                const mergedOther = [...other, ...rest.filter(r => !other.includes(r))];
                const otherItem = items.find(i => i.name === "其他");
                if (otherItem) {
                    otherItem.groups = mergedOther
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
                } else if (mergedOther.length) {
                    items.push({ id: "other", name: "其他", groups: mergedOther });
                }
                // 本地导入的谱面没有服务端章节，归「其他」
                for (const item of items) {
                    for (const g of item.groups) {
                        if (!g.chapter && item.name !== "其他") {
                            /* 保持原分组 */
                        }
                    }
                }
                return items;
            },
            currentChapter() {
                if (!this.chapterItems.length) return null;
                return (
                    this.chapterItems.find(i => i.id === this.selectedChapter) ||
                    this.chapterItems[0]
                );
            },
            visibleSongs() {
                const chapter = this.currentChapter;
                if (!chapter) return [];
                let list = chapter.groups;
                const query = this.search.trim().toLowerCase();
                if (query) {
                    list = list.filter(g =>
                        [g.name, g.composer, g.illustrator].join(" ").toLowerCase().includes(query)
                    );
                }
                return list;
            },
            canBoard() {
                return ptServer.available() && !this.forceOffline;
            },
        },
        methods: {
            formatSize(size) {
                if (!size && size !== 0) return "";
                if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
                return Math.max(1, Math.round(size / 1024)) + " KB";
            },
            levelColor(level) {
                return LEVEL_COLORS[level] || LEVEL_COLORS.SP;
            },
            ratingText(diff) {
                return diff.rating ? String(diff.rating) : "?";
            },
            isFavourite(group) {
                return (
                    this.favouriteSongs.includes(group.key) ||
                    (!!group.localSongId && this.favouriteSongs.includes(group.localSongId))
                );
            },
            toggleFavourite(group) {
                const on = this.isFavourite(group);
                if (on) {
                    this.favouriteSongs = this.favouriteSongs.filter(
                        i => i !== group.key && i !== group.localSongId
                    );
                } else {
                    this.favouriteSongs = [...this.favouriteSongs, group.key];
                }
                ptdb.gameConfig.save(this.favouriteSongs, "favouriteSongs");
                shared.game.msgHandler.sendMessage(
                    on
                        ? this.$t("chartSelect.favourites.removedSuccessfully", [group.name])
                        : this.$t("chartSelect.favourites.addedSuccessfully", [group.name])
                );
            },
            queueItemOf(diff) {
                return diff.file
                    ? this.queueItems.find(i => i.name === diff.file.name) || null
                    : null;
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
            onBadge(group, diff) {
                const state = this.diffState(diff);
                if (state.kind === "idle" && diff.file) this.downloadDiff(diff);
                else if (state.kind === "done") this.playDiff(group, diff);
                else this.expandedKey = this.expandedKey === group.key ? null : group.key;
            },
            downloadDiff(diff) {
                if (this.forceOffline) {
                    shared.game.msgHandler.sendMessage(
                        this.$t("chartSelect.offline.connectToDownload")
                    );
                    return;
                }
                if (!diff.file || diff.file.valid === false) return;
                chartDownloadQueue.enqueue([diff.file]);
            },
            retryItem(diff) {
                const item = this.queueItemOf(diff);
                if (item) chartDownloadQueue.retry(item.name);
            },
            async updateDiff(diff) {
                if (this.forceOffline) {
                    shared.game.msgHandler.sendMessage(
                        this.$t("chartSelect.offline.connectToDownload")
                    );
                    return;
                }
                if (!diff.file || diff.file.valid === false) return;
                await this.deleteDiffSilent(diff);
                chartDownloadQueue.enqueue([diff.file]);
            },
            async deleteDiff(group, diff) {
                const ok = await shared.game.msgHandler.confirm(
                    this.$t("chartManage.confirmBeforeDelete")
                );
                if (!ok) return;
                await this.deleteDiffSilent(diff);
                shared.game.msgHandler.sendMessage(this.$t("chartManage.deleted"));
                await this.refreshAll();
            },
            async deleteDiffSilent(diff) {
                if (diff.localChart) {
                    await ptdb.chart.chart.delete(diff.localChart.id).catch(() => {});
                }
                if (diff.file) await chartDownloadQueue.unlinkFile(diff.file.name);
            },
            async deleteSongGroup(group) {
                const ok = await shared.game.msgHandler.confirm(
                    this.$t("chartManage.confirmDeleteGroup", [
                        group.name || this.$t("chartManage.unnamed"),
                    ])
                );
                if (!ok) return;
                for (const diff of group.diffs) await this.deleteDiffSilent(diff);
                if (group.localSongId) {
                    await ptdb.chart.song.delete(group.localSongId).catch(() => {});
                    await chartDownloadQueue.unlinkSong(group.localSongId);
                }
                shared.game.msgHandler.sendMessage(this.$t("chartManage.deleted"));
                this.expandedKey = null;
                await this.refreshAll();
            },

            // ===== 游玩：与旧选曲页一致的 loadChart/playChart 链路 =====
            playDiff(group, diff) {
                const songMeta = group.localSong;
                const chartMeta = diff.localChart;
                if (!songMeta || !chartMeta) return;
                shared.game.ptmain.playConfig = JSON.parse(JSON.stringify(this.playSettings));
                if (this.playSettings.previewMode || this.playSettings.adjustOffset) {
                    shared.game.ptmain.playConfig.practiseMode = true;
                    shared.game.ptmain.playConfig.mode = "preview";
                } else {
                    shared.game.ptmain.playConfig.mode = "play";
                }
                ploading.l(this.$t("chartSelect.loadingChart"), "loadChart");
                shared.game.ptmain.loadChart(songMeta, chartMeta, this.chartLoaded);
            },
            chartLoaded() {
                if (this.$route.path !== "/chartSelect") return;
                ploading.r("loadChart");
                audio.stop();
                shared.game.ptmain.playChart();
            },
            bestScoreOf(chart) {
                const records = shared.game.ptmain.gameConfig.ptBestRecords || {};
                const data = records[chart && chart.id];
                if (!data) return null;
                // [score, acc, isFc, maxAcc, runAt]：前三项是最佳单局（见 global.js）
                return { score: data[0], acc: data[1], isFc: data[2] };
            },
            scoreBadge(score) {
                if (!score) return null;
                const s = score.score;
                return s === 1000000
                    ? "φ"
                    : score.isFc
                      ? "V"
                      : s >= 960000
                        ? "V"
                        : s >= 920000
                          ? "S"
                          : s >= 880000
                            ? "A"
                            : s >= 820000
                              ? "B"
                              : s >= 700000
                                ? "C"
                                : "F";
            },

            // ===== 每难度排行榜（手风琴，同时只开一个，懒加载） =====
            chartIdOf(diff) {
                return (
                    (diff.localChart && String(diff.localChart.id)) ||
                    (diff.file && diff.file.chart_id) ||
                    ""
                );
            },
            toggleBoard(diff) {
                if (this.boardKey === diff.key) {
                    this.boardKey = null;
                    return;
                }
                this.boardKey = diff.key;
                const cached = this.boards[diff.key];
                if (!cached || cached.error) this.loadBoard(diff);
            },
            async loadBoard(diff) {
                const chartId = this.chartIdOf(diff);
                if (!chartId) return;
                this.boards[diff.key] = { loading: true, entries: [], me: null, error: "" };
                const board = await ptServer.fetchChartLeaderboard(chartId);
                if (!board) {
                    this.boards[diff.key] = {
                        loading: false,
                        entries: [],
                        me: null,
                        error: this.$t("chartSelect.board.loadFailed"),
                    };
                    return;
                }
                this.boards[diff.key] = {
                    loading: false,
                    entries: board.entries,
                    me: board.me,
                    error: "",
                };
            },
            boardDate(runAt) {
                return runAt ? String(runAt).slice(0, 10) : "";
            },

            // ===== 数据装载 =====
            async loadServerList() {
                if (this._loadingServer) return;
                this._loadingServer = true;
                this._cacheCleared = false;
                const cacheRevision = libraryRevision();
                this.loading = true;
                this.loadError = "";
                this.cacheError = "";
                try {
                    const api = moduleApi();
                    if (api && api.game) {
                        // 模块模式走宿主网关 game.charts（每页 ≤200）：集成条目转独立版字段，
                        // 下载地址统一为 /api/game/charts/<contentId>（chartDiscovery 按此取内容 ID）。
                        const charts = [];
                        let chapters = [];
                        for (let page = 1; ; page++) {
                            const data = await api.game.call("game.charts", {
                                page,
                                pageSize: 200,
                            });
                            const items = (data && data.items) || [];
                            for (const item of items) {
                                const contentId = String(item.contentId || "");
                                charts.push({
                                    // song_id 可含点号（如 光.姜米條）：必须用集成条目自带的 song_id，
                                    // 按 contentId 切第一段会把同前缀的歌并成一组。
                                    song_id:
                                        String(item.song_id || "") || String(item.chart_id || ""),
                                    name: contentId,
                                    path: "/api/game/charts/" + encodeURIComponent(contentId),
                                    size: Number(item.contentBytes) || 0,
                                    song_name: item.song_name,
                                    level: item.difficulty_tier,
                                    rating: item.rating,
                                    charter: item.charter,
                                    chapter: item.chapter,
                                    chapter_order: item.chapter_order,
                                    chart_id: item.chart_id,
                                    composer: item.composer || "",
                                    illustrator: item.illustrator || "",
                                    cover: item.cover || null,
                                    cover_version: item.cover_version || "",
                                });
                            }
                            if (!chapters.length && data && data.chapters) chapters = data.chapters;
                            const total = data ? Number(data.total) || 0 : 0;
                            if (!items.length || charts.length >= total || page >= 200) break;
                        }
                        if (cacheRevision !== libraryRevision()) return;
                        this.serverFiles = charts;
                        this.chapters = chapters;
                    } else {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 10000);
                        let resp;
                        try {
                            resp = await authFetch("/api/game/charts", {
                                signal: controller.signal,
                            });
                        } finally {
                            clearTimeout(timeout);
                        }
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const data = await resp.json();
                        if (cacheRevision !== libraryRevision()) return;
                        this.serverFiles = data.charts || [];
                        this.chapters = data.chapters || [];
                    }
                    this.forceOffline = false;
                    this._lastServerLoad = Date.now();
                    try {
                        await saveLibrary(this.serverFiles, this.chapters, cacheRevision);
                    } catch {
                        this.cacheError = this.$t("chartSelect.offline.storageFailed");
                    }
                    void this.prefetchCovers();
                } catch (e) {
                    this.forceOffline = true;
                    this.loadError = e?.message || this.$t("chartManage.loadFailed");
                } finally {
                    this._loadingServer = false;
                    this.loading = false;
                }
            },
            async loadLocal() {
                try {
                    const resp = await ptdb.chart.renderApi();
                    this.localSongs = mergeLocalSongCharts(resp.results || []);
                } catch {
                    this.localSongs = [];
                }
            },
            async loadImported() {
                this.importedIndex = await chartDownloadQueue.getImportedIndex();
            },
            async refreshAll(force = true) {
                if (this._refreshing) return this._refreshing;
                this._refreshing = this.refreshLibrary(force).finally(() => {
                    this._refreshing = null;
                });
                return this._refreshing;
            },
            async refreshLibrary(force) {
                this.loading = true;
                await ptServer.activateLocalRecords().catch(console.error);
                await Promise.all([this.loadImported(), this.loadLocal()]);
                if (!this._cacheLoaded) {
                    const cached = await readLibrary();
                    if (cached) {
                        this.serverFiles = cached.charts;
                        this.chapters = cached.chapters;
                    }
                    this.selectedChapter = await ptdb.gameConfig
                        .get("selectedChapter", "__downloaded__")
                        .catch(() => "__downloaded__");
                    this._cacheLoaded = true;
                }
                this.loading = false;
                if (force || !this._lastServerLoad || Date.now() - this._lastServerLoad > 60000)
                    void this.loadServerList();
                this.loading = false;
                if (
                    this.selectedChapter &&
                    !this.chapterItems.some(i => i.id === this.selectedChapter)
                ) {
                    this.selectedChapter = "__downloaded__";
                }
            },
            refreshQueue() {
                this.queueItems = chartDownloadQueue.items.map(i => ({ ...i }));
                this.paused = chartDownloadQueue.paused;
            },

            // ===== 曲绘懒加载 =====
            async ensureCover(key, coverUrl, localSongId) {
                const group = this.songGroups.find(g => g.cover === coverUrl && coverUrl);
                const version = group?.coverVersion || "";
                const stamp = `${coverUrl}:${localSongId}:${version}`;
                if (this._coverStamps?.[key] === stamp && this.coverUrls[key]) return;
                if (!this._coverStamps) this._coverStamps = {};
                const song = this.localById[String(localSongId)];
                try {
                    const data = await cachedCover(
                        coverUrl || "",
                        version,
                        song?.illustration || ""
                    );
                    this.coverUrls[key] = data;
                    this._coverStamps[key] = stamp;
                } catch {
                    /* Failed images retry on refresh/reconnect. */
                }
            },
            async prefetchCovers() {
                if (this._prefetching) return;
                this._prefetching = true;
                const generation = libraryRevision();
                const groups = this.songGroups.filter(g => g.cover);
                this.cacheProgress = { done: 0, total: groups.length, failed: 0 };
                try {
                    // Two workers keep the UI responsive; don't compete with gameplay or chart downloads.
                    let next = 0;
                    const worker = async () => {
                        while (next < groups.length && generation === libraryRevision()) {
                            if (chartDownloadQueue.paused || chartDownloadQueue.busy) break;
                            const group = groups[next++];
                            const song = this.localById[String(group.localSongId)];
                            try {
                                const data = await cachedCover(
                                    group.cover,
                                    group.coverVersion,
                                    song?.illustration || ""
                                );
                                if (generation !== libraryRevision()) break;
                                this.coverUrls[group.key] = data;
                                if (data) this.cacheProgress.done++;
                                else this.cacheProgress.failed++;
                            } catch {
                                this.cacheProgress.failed++;
                            }
                        }
                    };
                    await Promise.all([worker(), worker()]);
                    this.observeRows();
                } finally {
                    this._prefetching = false;
                }
            },
            async clearLibraryCache() {
                if (
                    !(await shared.game.msgHandler.confirm(
                        this.$t("chartSelect.offline.clearConfirm")
                    ))
                )
                    return;
                this._cacheCleared = true;
                this._observer?.disconnect();
                await clearLibrary();
                this.serverFiles = [];
                this.chapters = [];
                this.coverUrls = {};
                this._coverStamps = {};
                this.cacheProgress = { done: 0, total: 0, failed: 0 };
                this._lastServerLoad = Date.now();
                this.loadError = "";
                this.cacheError = "";
            },
            observeRows() {
                if (!this._observer || !this.$el) return;
                const rows = this.$el.querySelectorAll("[data-coverkey]");
                for (const row of rows) {
                    const stamp = [
                        row.getAttribute("data-coverurl"),
                        row.getAttribute("data-localsong"),
                    ].join(":");
                    if (
                        row.getAttribute("data-observed") === stamp &&
                        this.coverUrls[row.getAttribute("data-coverkey")]
                    )
                        continue;
                    row.setAttribute("data-observed", stamp);
                    this._observer.observe(row);
                }
            },
            coverInitial(name) {
                return (name || "?").trim().charAt(0).toUpperCase();
            },
        },
        async activated() {
            audio.stop();
            if (window.stage) window.stage.style.display = "none";
            this._seenDone = new Set(
                chartDownloadQueue.items.filter(i => i.status === "done").map(i => i.name)
            );
            this.refreshQueue();
            this.boardKey = null;
            this.boards = {}; // 成绩可能刚变（游玩后返回），榜单重新懒加载
            await this.refreshAll(false);
        },
        mounted() {
            this._online = () => {
                if (this.$route.path === "/chartSelect") this.refreshAll();
            };
            window.addEventListener("online", this._online);
            this._retryTimer = setInterval(() => {
                if (this.$route.path !== "/chartSelect" || document.hidden || this._cacheCleared)
                    return;
                if (this.forceOffline) void this.loadServerList();
                else if (this.cacheProgress.done < this.cacheProgress.total)
                    void this.prefetchCovers();
            }, 30000);
            this._seenDone = new Set(
                chartDownloadQueue.items.filter(i => i.status === "done").map(i => i.name)
            );
            this._unsubscribe = chartDownloadQueue.subscribe(() => {
                this.refreshQueue();
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
                    this.loadLocal();
                }
            });
            if (typeof IntersectionObserver !== "undefined") {
                this._observer = new IntersectionObserver(
                    entries => {
                        for (const en of entries) {
                            if (!en.isIntersecting) continue;
                            const el = en.target;
                            const key = el.getAttribute("data-coverkey");
                            if (key)
                                this.ensureCover(
                                    key,
                                    el.getAttribute("data-coverurl"),
                                    el.getAttribute("data-localsong")
                                );
                            this._observer.unobserve(el);
                        }
                    },
                    { rootMargin: "300px 0px" }
                );
            }
            ptdb.gameConfig
                .get("favouriteSongs", [])
                .then(v => (this.favouriteSongs = v))
                .catch(() => {});
            this.refreshAll(false);
        },
        updated() {
            this.observeRows();
        },
        deactivated() {
            audio.stop();
            ploading.r();
            ploading.r("loadChart");
        },
        beforeUnmount() {
            clearInterval(this._retryTimer);
            window.removeEventListener("online", this._online);
            if (this._unsubscribe) this._unsubscribe();
            if (this._observer) this._observer.disconnect();
            for (const key of Object.keys(this.coverUrls)) {
                if (this.coverUrls[key]) URL.revokeObjectURL(this.coverUrls[key]);
            }
        },
        watch: {
            selectedChapter(value) {
                ptdb.gameConfig.save(value, "selectedChapter").catch(() => {});
            },
        },
        meta: {
            keepAlive: true,
        },
    };
</script>

<template>
    <div id="chartSelectNew" class="routerRealPage">
        <div class="csPanel blur">
            <div class="csHeader">
                <span class="csTitle">{{ $t("chartSelect.chartSelect") }}</span>
                <span class="csActions">
                    <input
                        class="csSearch"
                        type="text"
                        v-model="search"
                        :placeholder="$t('chartSelect.search')"
                    />
                    <input
                        type="button"
                        :value="$t('chartSelect.config')"
                        @click="settingsOpen = !settingsOpen"
                    />
                    <input
                        type="button"
                        :value="$t('chartManage.refresh')"
                        :disabled="loading"
                        @click="refreshAll()"
                    />
                </span>
            </div>

            <div v-if="settingsOpen" class="csSettings">
                <input
                    type="button"
                    :value="$t('chartSelect.offline.clear')"
                    @click="clearLibraryCache()"
                />
                <label class="csSettingItem">
                    {{ $t("chartSelect.playConfig.speed") }}
                    <select v-model="playSettings.speed">
                        <option value="">{{ $t("chartSelect.playConfig.speeds.normal") }}</option>
                        <option value="0.5">
                            {{ $t("chartSelect.playConfig.speeds.slowest") }}
                        </option>
                        <option value="0.75">
                            {{ $t("chartSelect.playConfig.speeds.slower") }}
                        </option>
                        <option value="1.25">
                            {{ $t("chartSelect.playConfig.speeds.faster") }}
                        </option>
                        <option value="1.5">
                            {{ $t("chartSelect.playConfig.speeds.fastest") }}
                        </option>
                    </select>
                </label>
                <label class="csSettingItem">
                    <input type="checkbox" v-model="playSettings.mirror" />
                    {{ $t("chartSelect.playConfig.mirror") }}
                </label>
                <label class="csSettingItem">
                    <input type="checkbox" v-model="playSettings.practiseMode" />
                    {{ $t("chartSelect.playConfig.practiseMode") }}
                </label>
                <label class="csSettingItem">
                    <input type="checkbox" v-model="playSettings.previewMode" />
                    {{ $t("chartSelect.playConfig.previewMode") }}
                </label>
                <label class="csSettingItem">
                    <input type="checkbox" v-model="playSettings.adjustOffset" />
                    {{ $t("chartSelect.playConfig.adjustOffset") }}
                </label>
                <label class="csSettingItem">
                    <input type="checkbox" v-model="playSettings.videoRecorder" />
                    {{ $t("chartSelect.playConfig.videoRecorder") }}
                </label>
            </div>

            <div v-if="paused" class="csNotice">{{ $t("chartManage.pausedNotice") }}</div>
            <div v-else-if="pendingCount" class="csNotice">
                {{ $t("chartManage.downloadingNotice", [pendingCount]) }}
            </div>
            <div v-if="loadError" class="csNotice csNoticeError">
                {{ $t("chartManage.serverUnreachable", [loadError]) }}
                <input type="button" :value="$t('chartManage.retry')" @click="loadServerList()" />
            </div>

            <div v-if="cacheError" class="csNotice csNoticeError">{{ cacheError }}</div>
            <div v-if="cacheProgress.total" class="csNotice">
                {{ $t("chartSelect.offline.progress", [cacheProgress.done, cacheProgress.total]) }}
                <span v-if="cacheProgress.failed">{{ $t("chartSelect.offline.retryCovers") }}</span>
            </div>
            <!-- 章节条 -->
            <div class="csChapters">
                <div
                    v-for="chapter in chapterItems"
                    :key="chapter.id"
                    class="csChapter"
                    :class="{ csChapterOn: currentChapter && currentChapter.id === chapter.id }"
                    @click="selectedChapter = chapter.id"
                >
                    <div
                        class="csChapterCover"
                        :data-coverkey="'ch:' + chapter.id"
                        :data-coverurl="chapter.groups[0] ? chapter.groups[0].cover : ''"
                        :data-localsong="chapter.groups[0] ? chapter.groups[0].localSongId : ''"
                    >
                        <img
                            v-if="coverUrls['ch:' + chapter.id]"
                            :src="coverUrls['ch:' + chapter.id]"
                            alt=""
                        />
                        <span v-else>{{ coverInitial(chapter.name) }}</span>
                    </div>
                    <div class="csChapterName">{{ chapter.name }}</div>
                    <div class="csChapterCount">{{ chapter.groups.length }}</div>
                </div>
            </div>

            <!-- 歌曲列表 -->
            <div class="csList">
                <div v-if="loading && !songGroups.length" class="csEmpty">
                    {{ $t("chartManage.loadingLocal") }}
                </div>
                <div v-else-if="!visibleSongs.length" class="csEmpty">
                    {{
                        currentChapter?.id === "__downloaded__"
                            ? $t("chartSelect.offline.empty")
                            : $t("chartSelect.chartListIsEmpty")
                    }}
                </div>

                <div
                    v-for="group in visibleSongs"
                    :key="group.key"
                    class="csRow"
                    :class="{ csRowOpen: expandedKey === group.key }"
                >
                    <div
                        class="csRowMain"
                        @click="expandedKey = expandedKey === group.key ? null : group.key"
                    >
                        <div
                            class="csCoverWrap"
                            :data-coverkey="group.key"
                            :data-coverurl="group.cover || ''"
                            :data-localsong="group.localSongId || ''"
                        >
                            <img
                                v-if="coverUrls[group.key]"
                                class="csCover"
                                :src="coverUrls[group.key]"
                                alt=""
                            />
                            <div v-else class="csCover csCoverEmpty">
                                {{ coverInitial(group.name) }}
                            </div>
                        </div>
                        <div class="csRowInfo">
                            <div class="csRowName">
                                {{ group.name || $t("chartManage.unnamed") }}
                                <span
                                    v-if="isFavourite(group)"
                                    class="csFavOn"
                                    :title="$t('chartSelect.favourites.remove')"
                                >
                                    ★
                                </span>
                            </div>
                            <div class="csRowMeta">
                                {{ group.composer || $t("chartManage.unknownComposer") }}
                                <template v-if="group.illustrator">
                                    × {{ group.illustrator }}
                                </template>
                            </div>
                        </div>
                        <div class="csBadges">
                            <div
                                v-for="diff in group.diffs"
                                :key="diff.key"
                                class="csBadge"
                                :class="['csBadge-' + diffState(diff).kind]"
                                :style="{ backgroundColor: levelColor(diff.level) }"
                                :title="
                                    diff.charter ? $t('chartManage.charter', [diff.charter]) : ''
                                "
                                @click.stop="onBadge(group, diff)"
                            >
                                <span class="csBadgeLv">{{ diff.level }}</span>
                                <span class="csBadgeRating">{{ ratingText(diff) }}</span>
                                <span v-if="diffState(diff).kind === 'done'" class="csBadgeMark">
                                    <svg
                                        viewBox="0 0 12 12"
                                        width="11"
                                        height="11"
                                        aria-hidden="true"
                                    >
                                        <path
                                            d="M3 6.5 L5.2 8.8 L9 3.6"
                                            fill="none"
                                            stroke="#fff"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        />
                                    </svg>
                                </span>
                                <span
                                    v-else-if="diffState(diff).kind === 'busy'"
                                    class="csBadgeMark csBadgePct"
                                >
                                    {{ diffState(diff).item.progress || 0 }}
                                </span>
                                <span
                                    v-else-if="diffState(diff).kind === 'failed'"
                                    class="csBadgeMark"
                                >
                                    !
                                </span>
                                <span
                                    v-else-if="diffState(diff).kind === 'broken'"
                                    class="csBadgeMark"
                                >
                                    !
                                </span>
                                <span
                                    v-else-if="diffState(diff).kind === 'queued'"
                                    class="csBadgeMark"
                                >
                                    …
                                </span>
                                <span v-else class="csBadgeMark">
                                    <svg
                                        viewBox="0 0 12 12"
                                        width="11"
                                        height="11"
                                        aria-hidden="true"
                                    >
                                        <path
                                            d="M6 2.5 L6 8 M3.5 6.5 L6 9 L8.5 6.5"
                                            fill="none"
                                            stroke="#fff"
                                            stroke-width="1.6"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        />
                                    </svg>
                                </span>
                            </div>
                        </div>
                        <div
                            class="csChevron"
                            :class="{ csChevronOpen: expandedKey === group.key }"
                        >
                            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                                <path
                                    d="M3 4.5 L6 8 L9 4.5"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="1.6"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                />
                            </svg>
                        </div>
                    </div>

                    <div v-if="expandedKey === group.key" class="csDetail">
                        <div v-for="diff in group.diffs" :key="diff.key" class="csDiffWrap">
                            <div class="csDiffRow">
                                <div class="csDiffInfo">
                                    <span
                                        class="csDiffLv"
                                        :style="{ backgroundColor: levelColor(diff.level) }"
                                    >
                                        {{ diff.level }}
                                    </span>
                                    <span class="csDiffText">
                                        Lv.{{ ratingText(diff) }}
                                        <template v-if="diff.charter">
                                            · {{ $t("chartManage.charter", [diff.charter]) }}
                                        </template>
                                        <template v-if="diff.file && !diff.localChart">
                                            · {{ formatSize(diff.file.size) }}
                                        </template>
                                        <template v-if="diff.outdated">
                                            · {{ $t("chartManage.outdated") }}
                                        </template>
                                        <template v-if="diff.file && diff.file.valid === false">
                                            · {{ diff.file.error }}
                                        </template>
                                        <template v-if="bestScoreOf(diff.localChart)">
                                            · {{ scoreBadge(bestScoreOf(diff.localChart)) }}
                                            {{
                                                String(bestScoreOf(diff.localChart).score).padStart(
                                                    7,
                                                    "0"
                                                )
                                            }}
                                            ({{
                                                (bestScoreOf(diff.localChart).acc * 100).toFixed(2)
                                            }}%)
                                        </template>
                                    </span>
                                </div>
                                <div class="csDiffActions">
                                    <template v-if="diffState(diff).kind === 'busy'">
                                        <div class="csProgressWrap">
                                            <div class="csProgressBar">
                                                <div
                                                    class="csProgressFill"
                                                    :style="{
                                                        width:
                                                            (diffState(diff).item.progress || 0) +
                                                            '%',
                                                    }"
                                                ></div>
                                            </div>
                                            <span class="csProgressText">
                                                {{
                                                    diffState(diff).item.status === "importing"
                                                        ? $t("chartManage.importing")
                                                        : (diffState(diff).item.progress || 0) + "%"
                                                }}
                                            </span>
                                        </div>
                                    </template>
                                    <template v-else-if="diffState(diff).kind === 'queued'">
                                        <span class="csTag">{{ $t("chartManage.tagQueued") }}</span>
                                    </template>
                                    <template v-else-if="diffState(diff).kind === 'failed'">
                                        <span class="csFailedText">
                                            {{
                                                diffState(diff).item.error ||
                                                $t("chartManage.downloadFailed")
                                            }}
                                        </span>
                                        <input
                                            type="button"
                                            :value="$t('chartManage.retry')"
                                            @click="retryItem(diff)"
                                        />
                                    </template>
                                    <template v-else-if="diffState(diff).kind === 'broken'">
                                        <span class="csTag csTagBroken" :title="diff.file.error">
                                            {{ $t("chartManage.tagBroken") }}
                                        </span>
                                    </template>
                                    <template v-else-if="diffState(diff).kind === 'done'">
                                        <input
                                            type="button"
                                            class="csPlayBtn"
                                            :value="$t('chartSelect.play')"
                                            @click="playDiff(group, diff)"
                                        />
                                        <input
                                            v-if="diff.file && diff.outdated"
                                            type="button"
                                            :value="$t('chartManage.update')"
                                            @click="updateDiff(diff)"
                                        />
                                        <input
                                            type="button"
                                            :value="$t('chartManage.delete')"
                                            @click="deleteDiff(group, diff)"
                                        />
                                    </template>
                                    <template v-else>
                                        <input
                                            v-if="diff.file"
                                            type="button"
                                            :value="
                                                diff.link
                                                    ? $t('chartManage.redownload')
                                                    : $t('chartManage.download')
                                            "
                                            @click="downloadDiff(diff)"
                                        />
                                    </template>
                                    <input
                                        v-if="canBoard && chartIdOf(diff)"
                                        type="button"
                                        class="csBoardBtn"
                                        :value="
                                            boardKey === diff.key
                                                ? $t('chartSelect.board.close')
                                                : $t('chartSelect.board.open')
                                        "
                                        @click="toggleBoard(diff)"
                                    />
                                </div>
                            </div>
                            <div v-if="boardKey === diff.key" class="csBoard">
                                <template v-if="boards[diff.key]">
                                    <div v-if="boards[diff.key].loading" class="csBoardNote">
                                        {{ $t("chartSelect.board.loading") }}
                                    </div>
                                    <div
                                        v-else-if="boards[diff.key].error"
                                        class="csBoardNote csBoardError"
                                    >
                                        {{ boards[diff.key].error }}
                                    </div>
                                    <div
                                        v-else-if="!boards[diff.key].entries.length"
                                        class="csBoardNote"
                                    >
                                        {{ $t("chartSelect.board.empty") }}
                                    </div>
                                    <template v-else>
                                        <div
                                            v-for="entry in boards[diff.key].entries"
                                            :key="entry.user_id"
                                            class="csBoardRow"
                                            :class="{ csBoardMe: entry.is_me }"
                                        >
                                            <span class="csBoardRank">#{{ entry.rank }}</span>
                                            <span class="csBoardName">{{ entry.name }}</span>
                                            <span class="csBoardScore">
                                                {{ String(entry.score).padStart(7, "0") }}
                                            </span>
                                            <span class="csBoardAcc">
                                                {{ Number(entry.acc).toFixed(2) }}%
                                            </span>
                                            <span class="csBoardFc">
                                                {{ entry.is_fc ? "FC" : "" }}
                                            </span>
                                            <span class="csBoardRks">
                                                {{ Number(entry.rks).toFixed(2) }}
                                            </span>
                                            <span class="csBoardDate">
                                                {{ boardDate(entry.run_at) }}
                                            </span>
                                        </div>
                                        <div v-if="boards[diff.key].me" class="csBoardMeRow">
                                            {{
                                                $t("chartSelect.board.myRank", [
                                                    boards[diff.key].me.rank,
                                                ])
                                            }}
                                            ·
                                            {{
                                                String(boards[diff.key].me.score).padStart(7, "0")
                                            }}
                                            · {{ Number(boards[diff.key].me.acc).toFixed(2) }}%
                                        </div>
                                    </template>
                                </template>
                            </div>
                        </div>
                        <div class="csDetailFoot">
                            <input
                                type="button"
                                :value="
                                    isFavourite(group)
                                        ? $t('chartSelect.favourites.remove')
                                        : $t('chartSelect.favourites.add')
                                "
                                @click="toggleFavourite(group)"
                            />
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
    </div>
</template>

<style>
    #chartSelectNew {
        height: calc(100vh - 170px);
        height: calc(100dvh - 170px);
        overflow-y: auto;
        overscroll-behavior-y: contain;
        touch-action: pan-x pan-y;
        -webkit-overflow-scrolling: touch;
        width: 92%;
        margin: 0 auto;
        padding-bottom: 30px;
    }

    #chartSelectNew .csPanel {
        margin-top: 12px;
        border-radius: 12px;
        background-color: #ffffff60;
        padding: 12px 16px;
    }

    #chartSelectNew .csHeader {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 8px 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid #00000022;
    }

    #chartSelectNew .csTitle {
        flex: 1;
        font-size: 1.4em;
        font-weight: bold;
        color: darkslategray;
        text-align: left;
    }

    #chartSelectNew .csActions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }

    #chartSelectNew .csSearch {
        width: 150px;
        padding: 3px 8px;
        border: 1px solid #00000033;
        border-radius: 6px;
        background-color: #ffffff88;
    }

    #chartSelectNew .csSettings {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 18px;
        padding: 10px 4px;
        border-bottom: 1px solid #00000014;
    }

    #chartSelectNew .csSettingItem {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 0.88em;
        color: #000000bb;
    }

    #chartSelectNew .csSettingItem input[type="checkbox"] {
        display: inline-block;
        width: 1em;
        height: 1em;
        accent-color: #0066ff;
    }

    #chartSelectNew .csNotice {
        margin-top: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        background-color: #2b57931a;
        color: #2b5793;
        font-size: 0.9em;
        text-align: left;
    }

    #chartSelectNew .csNoticeError {
        background-color: #c628281a;
        color: #c62828;
    }

    #chartSelectNew .csEmpty {
        padding: 24px 8px;
        text-align: center;
        color: #00000088;
        font-style: italic;
    }

    /* ===== 章节条 ===== */
    #chartSelectNew .csChapters {
        display: flex;
        gap: 10px;
        overflow-x: auto;
        padding: 10px 2px 12px;
        border-bottom: 1px solid #00000014;
    }

    #chartSelectNew .csChapter {
        flex-shrink: 0;
        width: 108px;
        cursor: pointer;
        user-select: none;
        border-radius: 10px;
        padding: 6px;
        text-align: center;
    }

    #chartSelectNew .csChapter:hover {
        background-color: #ffffff70;
    }

    #chartSelectNew .csChapterOn {
        background-color: #ffffffa8;
        box-shadow: 0 1px 6px #00000022;
    }

    #chartSelectNew .csChapterCover {
        width: 88px;
        height: 88px;
        margin: 0 auto;
        border-radius: 10px;
        overflow: hidden;
        background: linear-gradient(135deg, #7d8f9c, #4a5a68);
        color: #ffffffcc;
        font-size: 1.6em;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    #chartSelectNew .csChapterCover img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    #chartSelectNew .csChapterName {
        margin-top: 5px;
        font-size: 0.72em;
        color: #1c2b36;
        line-height: 1.25;
        height: 2.5em;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
    }

    #chartSelectNew .csChapterCount {
        font-size: 0.68em;
        color: #00000077;
    }

    /* ===== 歌曲行 ===== */
    #chartSelectNew .csRow {
        border-bottom: 1px solid #00000014;
    }

    #chartSelectNew .csRow:last-child {
        border-bottom: none;
    }

    #chartSelectNew .csRowMain {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 10px;
        cursor: pointer;
        border-radius: 10px;
    }

    #chartSelectNew .csRowMain:hover {
        background-color: #ffffff70;
    }

    #chartSelectNew .csRowOpen .csRowMain {
        background-color: #ffffff90;
    }

    #chartSelectNew .csCoverWrap {
        flex-shrink: 0;
        width: 72px;
        height: 72px;
    }

    #chartSelectNew .csCover {
        width: 72px;
        height: 72px;
        border-radius: 10px;
        object-fit: cover;
        display: block;
        box-shadow: 0 1px 4px #00000030;
    }

    #chartSelectNew .csCoverEmpty {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.6em;
        font-weight: bold;
        color: #ffffffcc;
        background: linear-gradient(135deg, #7d8f9c, #4a5a68);
    }

    #chartSelectNew .csRowInfo {
        flex: 1;
        min-width: 0;
        text-align: left;
    }

    #chartSelectNew .csRowName {
        font-size: 1.05em;
        font-weight: bold;
        color: #1c2b36;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartSelectNew .csFavOn {
        color: #e6a23c;
        font-size: 0.85em;
        margin-left: 4px;
    }

    #chartSelectNew .csRowMeta {
        font-size: 0.8em;
        color: #00000088;
        margin-top: 3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* ===== 难度徽章 ===== */
    #chartSelectNew .csBadges {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }

    #chartSelectNew .csBadge {
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

    #chartSelectNew .csBadge:hover {
        filter: brightness(1.12);
    }

    #chartSelectNew .csBadge-busy {
        opacity: 0.85;
    }

    #chartSelectNew .csBadge-broken {
        filter: grayscale(0.8);
    }

    #chartSelectNew .csBadgeLv {
        font-size: 0.72em;
        font-weight: bold;
        line-height: 1;
        letter-spacing: 0.06em;
    }

    #chartSelectNew .csBadgeRating {
        font-size: 0.95em;
        font-weight: bold;
        line-height: 1.15;
    }

    #chartSelectNew .csBadgeMark {
        position: absolute;
        right: 3px;
        bottom: 2px;
        font-size: 0.62em;
        line-height: 1;
        opacity: 0.95;
    }

    #chartSelectNew .csBadgePct {
        background-color: #00000055;
        border-radius: 4px;
        padding: 0 2px;
    }

    #chartSelectNew .csChevron {
        flex-shrink: 0;
        color: #00000066;
        transition: transform 0.15s;
    }

    #chartSelectNew .csChevronOpen {
        transform: rotate(180deg);
    }

    /* ===== 展开明细 ===== */
    #chartSelectNew .csDetail {
        padding: 2px 10px 10px 94px;
        text-align: left;
    }

    #chartSelectNew .csDiffWrap {
        border-bottom: 1px dashed #00000014;
    }

    #chartSelectNew .csDiffRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 5px 0;
    }

    #chartSelectNew .csDiffInfo {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }

    #chartSelectNew .csDiffLv {
        flex-shrink: 0;
        min-width: 34px;
        text-align: center;
        padding: 1px 6px;
        border-radius: 5px;
        color: white;
        font-size: 0.78em;
        font-weight: bold;
    }

    #chartSelectNew .csDiffText {
        font-size: 0.82em;
        color: #000000aa;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartSelectNew .csDiffActions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        min-width: 170px;
        justify-content: flex-end;
    }

    #chartSelectNew .csPlayBtn {
        background-color: #2b5793;
        color: white;
        border: none;
        border-radius: 6px;
        padding: 2px 14px;
        cursor: pointer;
    }

    #chartSelectNew .csDetailFoot {
        display: flex;
        align-items: center;
        gap: 10px;
        padding-top: 8px;
    }

    #chartSelectNew .csProgressWrap {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 150px;
    }

    #chartSelectNew .csProgressBar {
        flex: 1;
        height: 8px;
        border-radius: 4px;
        background-color: #0000001f;
        overflow: hidden;
    }

    #chartSelectNew .csProgressFill {
        height: 100%;
        border-radius: 4px;
        background-color: #2b5793;
        transition: width 0.2s;
    }

    #chartSelectNew .csProgressText {
        width: 44px;
        text-align: right;
        font-size: 0.78em;
        color: #00000099;
        white-space: nowrap;
    }

    #chartSelectNew .csFailedText {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.78em;
        color: #c62828;
    }

    #chartSelectNew .csTag {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 4px;
        font-size: 0.75em;
        background-color: #9e9e9e26;
        color: #616161;
        border: 1px solid #9e9e9e55;
    }

    #chartSelectNew .csTagBroken {
        background-color: #c628281a;
        color: #c62828;
        border: 1px solid #c6282855;
    }

    #chartSelectNew .csBoardBtn {
        background-color: #2b579314;
        color: #2b5793;
        border: 1px solid #2b579355;
        border-radius: 6px;
        padding: 2px 12px;
        cursor: pointer;
    }

    #chartSelectNew .csBoard {
        margin: 2px 0 8px;
        padding: 6px 10px;
        border-radius: 8px;
        background-color: #00000008;
        border: 1px solid #00000014;
    }

    #chartSelectNew .csBoardNote {
        padding: 4px 2px;
        font-size: 0.8em;
        color: #00000099;
    }

    #chartSelectNew .csBoardError {
        color: #c62828;
    }

    #chartSelectNew .csBoardRow {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 2px 4px;
        border-radius: 5px;
        font-size: 0.82em;
    }

    #chartSelectNew .csBoardMe {
        background-color: #2b579322;
        font-weight: bold;
    }

    #chartSelectNew .csBoardRank {
        width: 44px;
        flex-shrink: 0;
        color: #2b5793;
        font-weight: bold;
    }

    #chartSelectNew .csBoardName {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    #chartSelectNew .csBoardScore,
    #chartSelectNew .csBoardAcc,
    #chartSelectNew .csBoardRks,
    #chartSelectNew .csBoardDate {
        flex-shrink: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: #000000cc;
    }

    #chartSelectNew .csBoardScore {
        width: 74px;
    }

    #chartSelectNew .csBoardAcc {
        width: 62px;
    }

    #chartSelectNew .csBoardRks {
        width: 48px;
        color: #00000099;
    }

    #chartSelectNew .csBoardDate {
        width: 84px;
        color: #00000099;
    }

    #chartSelectNew .csBoardFc {
        width: 26px;
        flex-shrink: 0;
        text-align: center;
        color: #00bef1;
        font-weight: bold;
    }

    #chartSelectNew .csBoardMeRow {
        margin-top: 4px;
        padding: 3px 4px;
        border-top: 1px dashed #00000022;
        font-size: 0.82em;
        color: #2b5793;
        font-weight: bold;
    }
</style>
