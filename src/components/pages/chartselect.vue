<script>
    import shared from "@utils/js/shared.js";
    import { audio } from "@utils/js/aup";
    import { partyMgr } from "@utils/js/partyMgr";
    import ptdb from "@components/ptdb";
    import ploading from "@utils/js/ploading.js";
    import {
        formatChartLevel,
        getLocalSongGroupKey,
        mergeLocalSongCharts,
    } from "@utils/localChartGrouping.mjs";
    export default {
        name: "chartSelect",
        data() {
            return {
                search: {
                    name: "",
                    composer: "",
                    illustrator: "",
                },
                chartList: {},
                beforeSearch: [],
                beforePagination: [],
                page: 1,
                toPage: null,
                showMoreSearchQueryInput: false,
                selectChoice: "local",
                forceOffline: false,
                selectedSongData: null,
                selectedPlayingSettings: {
                    speed: "",
                    mirror: false,
                    practiseMode: false,
                    previewMode: false,
                    adjustOffset: false,
                    videoRecorder: false,
                },
                ct: {},
                toSyncOrPlay: 0,
                scrolledTop: 0,
                configDialogOpened: false,
                chartSelectorOpenedTab: "chartSelect", // chartSelect config
                canEdit: false,
                favouriteSongs: [],
                showBlank: false,
                loadingImages: new Map(),
                imageCache: new Map(),
            };
        },
        computed: {
            isPTApp() {
                return window.spec.isPhiTogetherApp;
            },
            canPrev() {
                if (this.selectChoice === "favorite") return this.chartList.hasPrevious;
                return this.page - 1 > 0;
            },
            canNext() {
                if (this.selectChoice === "favorite") return this.chartList.hasNext;
                return this.page + 1 <= this.pageAll;
            },
            pageAll() {
                try {
                    if (this.selectChoice === "favorite") {
                        const count = this.chartList.total;
                        if (count) {
                            return Math.ceil(count / 32);
                        } else return 1;
                    }
                    const count = this.beforePagination.length;
                    if (count) {
                        return Math.ceil(count / 32);
                    } else return 1;
                } catch (e) {
                    return 1;
                }
            },
            isSingle() {
                return shared.game.ptmain.gameMode === "single";
            },
            canFav() {
                return !!this.selectedSongData;
            },
            isMulti() {
                return shared.game.ptmain.gameMode === "multi";
            },
            // 离线且本地无缓存谱面时，给出更有引导性的空状态提示。
            isEmptyOffline() {
                return (
                    this.forceOffline ||
                    (!navigator.onLine && this.selectChoice === "local")
                );
            },
        },
        async mounted() {
            if (this.$route.query.offline == 1) {
                this.forceOffline = true;
            }
            this.loadOffline();
        },
        activated() {
            audio.stop();
            stage.style.display = "none";
            this.showBlank = false;

            if (this.chartList && this.selectedSongData) {
                const indexOfSelectedChart = this.chartList.results.indexOf(this.selectedSongData);
                const page = this.page;
                this.selectedSongData = null;
                (() => {
                    if (this.selectChoice === "favorite") return this.loadFavouriteSongs();
                    return this.loadOffline().then(() => {
                        this.page = page;
                        this.updatePagination();
                    });
                })()
                    .then(() => this.goDetails(this.chartList.results[indexOfSelectedChart]))
                    .catch(e => (this.showBlank = false));
            }

            if (this.$route.query.toSyncOrPlay && this.$route.query.toSyncOrPlay == 3) {
                this.selectChoice = "empty";
                const ct = JSON.parse(sessionStorage.getItem("loadedChart"));
                this.ct = ct;
                this.toSyncOrPlay = 3;
                // TODO
                // this.loadChart(ct);
                return;
            }
            if (this.selectChoice === "empty") {
                this.selectedSongData = null;
                this.selectChoice = "local";
                this.loadOffline();
            }
            if (this.selectedSongData) this.playPreview(this.selectedSongData);
            this.toSyncOrPlay = 0;
            this.ct = null;
            if (!navigator.onLine && !this.forceOffline && this.selectChoice !== "local")
                (this.forceOffline = true), this.loadOffline();
            if (["local"].includes(this.selectChoice)) this.loadOffline();
            const d = document.querySelector("#songSelectList");
            d && (d.scrollTop = this.scrolledTop);

            ptdb.gameConfig
                .get("favouriteSongs", [])
                .then(favouriteSongs => (this.favouriteSongs = favouriteSongs))
                .catch(e => e);
        },
        deactivated() {
            audio.stop();
            ploading.r();
            ploading.r("loadChart");
        },
        unmounted() {
            this.clearImageCache();
        },
        beforeRouteLeave(to, from, next) {
            this.scrolledTop = document.querySelector("#songSelectList")
                ? document.querySelector("#songSelectList").scrollTop
                : 0;
            next();
        },
        methods: {
            processIllustrationURL(i) {
                let d = i.split("/");
                let idx = d.length - 1;
                d[idx] = encodeURIComponent(d[idx]).replace("(", "\\(").replace(")", "\\)");
                return d.join("/");
            },
            back2song() {
                this.showBlank = false;
                document.querySelector("#songSelectList").scrollTop = this.scrolledTop;
                this.selectedSongData = null;
                audio.stop();
            },
            async goJustPageAsk() {
                const res = await shared.game.msgHandler.prompt(
                    this.$t("chartSelect.jumpto", [this.pageAll])
                );
                if (res) this.goJustPage(res);
            },
            goJustPage(i) {
                if (!(i >= 1 && i <= this.pageAll)) {
                    shared.game.msgHandler.sendMessage(
                        this.$t("chartSelect.inputDosentMatchRequirement"),
                        "error"
                    );
                    return;
                }
                if (this.selectChoice === "favorite") return;
                this.page = i;
                this.updatePagination();
            },
            loadPrevPage() {
                if (this.selectChoice === "favorite") return;
                this.page = this.page - 1;
                this.updatePagination();
            },
            loadNextPage() {
                if (this.selectChoice === "favorite") return;
                this.page = this.page + 1;
                this.updatePagination();
            },
            updatePagination() {
                if (this.page < 1) this.page = 1;
                if (this.page > this.pageAll) this.page = this.pageAll;
                this.chartList = {
                    results: this.beforePagination
                        ? this.beforePagination.slice(32 * this.page - 32, 32 * this.page)
                        : [],
                };
                if (this.selectChoice === "local") {
                    const selectedKey = this.selectedSongData
                        ? getLocalSongGroupKey(this.selectedSongData)
                        : null;
                    const selectedSong =
                        this.chartList.results.find(
                            song => getLocalSongGroupKey(song) === selectedKey
                        ) || this.chartList.results[0];
                    if (selectedSong) {
                        this.goDetails(selectedSong, false).catch(() => (this.showBlank = false));
                    } else {
                        this.selectedSongData = null;
                        audio.stop();
                    }
                }
            },
            async loadOffline() {
                if (this.forceOffline && this.selectChoice !== "favorite")
                    this.selectChoice = "local";
                // 服务端谱面不再自动全量下载（慢且无进度），改由「谱面下载」页面
                // （/chartManage）按需选择下载；此处只读本地 IndexedDB 缓存，离线可用。
                let { results } = await ptdb.chart.renderApi();
                let newlist = [];
                for (const t of results) {
                    if (t.song && t.illustration && t.charts) newlist.push(t);
                }
                this.beforeSearch = mergeLocalSongCharts(newlist);
                this.beforePagination = this.beforeSearch;
                this.updatePagination();
            },
            async goDetails(para, allowAutoScroll = true) {
                if (this.selectedSongData === para) return;
                const autoScroll = allowAutoScroll && !this.selectedSongData;
                if (!para.charts || !para.charts.length) para.charts = [];
                sessionStorage.setItem("chartDetailsData", JSON.stringify(para));
                ptdb.chart.song.has(para.id).then(h => (this.canEdit = h));
                if (autoScroll) {
                    const songList = document.querySelector("#songSelectList");
                    if (songList) {
                        this.scrolledTop = songList.scrollTop;
                        songList.scrollTop =
                            Math.max((0.39275 * window.innerWidth - 2) * 0.2 + 2, 100) *
                            this.chartList.results.indexOf(para);
                    }
                    // setTimeout(() => document.querySelector("#songSelectList").scrollTop = Math.max(0.08 * window.innerWidth, 100) * this.chartList.results.indexOf(para), 100);
                }
                this.selectedSongData = para;
                this.selectChart(para.charts[0]);
                audio.stop();
                this.playPreview(para);
            },
            async playPreview(para) {
                this.previewAbortController = new AbortController();
                ptdb.chart.song
                    .fetch(para, {
                        signal: this.previewAbortController.signal,
                    })
                    .then(async e => {
                        audio.stop();
                        const buffer = await e.arrayBuffer();
                        const bfs = await audio.decode(buffer);
                        if (
                            this.selectedSongData.id !== para.id ||
                            this.$route.path !== "/chartSelect"
                        )
                            return;
                        audio.play(bfs, {
                            loop: true,
                            offset: this.toSecond(para.preview_start || 0),
                            singleAudioAllowed: true,
                            gainrate: 0,
                            gainrateTo: 1,
                            gainrateToTime: 5,
                        });
                        // shared.game.msgHandler.sendMessage("正在播放音频预览...");
                        this.previewAbortController = null;
                    })
                    .catch(e => {
                        if (this.previewAbortController)
                            shared.game.msgHandler.sendMessage(
                                this.$t("chartSelect.previewLoadFailed"),
                                "error"
                            );
                        if (import.meta.env.DEV) console.error(e);
                    });
            },
            doSearch() {
                if (partyMgr.list.aprfool2024.hook(this.search, this.loadChart)) return;
                if (this.selectChoice === "favorite") {
                    if (!this.chartList.resultsbak)
                        this.chartList.resultsbak = this.chartList.results;
                    this.chartList.results = this.chartList.resultsbak.filter(i =>
                        i.name.toLowerCase().includes(this.search.name.toLowerCase())
                    );
                } else {
                    this.beforePagination = this.beforeSearch.filter(x => {
                        return (
                            x.name.toLowerCase().includes(this.search.name.toLowerCase()) &&
                            x.composer.toLowerCase().includes(this.search.composer.toLowerCase()) &&
                            x.illustrator
                                .toLowerCase()
                                .includes(this.search.illustrator.toLowerCase())
                        );
                    });
                    this.page = 1;
                    this.updatePagination();
                }
            },
            toggleInput() {
                this.showMoreSearchQueryInput = !this.showMoreSearchQueryInput;
            },
            async loadFavouriteSongs() {
                ploading.l(this.$t("chartSelect.loadingChartList"));
                this.page = 1;
                const chartList = {
                    total: 0,
                    perPage: 114514,
                    hasPrevious: false,
                    hasNext: false,
                    results: [],
                };
                chartList.results = await ptdb.chart
                    .renderApi()
                    .then(resp => resp.results)
                    .then(results =>
                        results.filter(result => this.favouriteSongs.includes(result.id))
                    );
                this.chartList = chartList;
                document.querySelector("#app").scrollTop = 0;
                ploading.r();
            },
            getDifficultyActual(chartInfo) {
                if (typeof chartInfo.difficulty === "string" || !chartInfo.difficulty)
                    return chartInfo.difficulty;
                else return chartInfo.difficulty === 0 ? "?" : Math.floor(chartInfo.difficulty);
            },
            formatChartLevel,
            toSecond(str) {
                try {
                    const d = str.split(":");
                    return d[0] * 3600 + d[1] * 60 + d[2] * 1;
                } catch (e) {
                    return 0;
                }
            },
            cleanStr(i) {
                return i.replace(
                    new RegExp(
                        [
                            ...i.matchAll(
                                new RegExp(
                                    "\\[PZ([A-Za-z]+):([0-9]+):((?:(?!:PZRT]).)*):PZRT\\]",
                                    "g"
                                )
                            ),
                        ].length === 0
                            ? "\\[PZ([A-Za-z]+):([0-9]+):([^\\]]+)\\]" // legacy support
                            : "\\[PZ([A-Za-z]+):([0-9]+):((?:(?!:PZRT]).)*):PZRT\\]",
                        "gi"
                    ),
                    "$3"
                );
            },
            getLevelColor(levelText) {
                levelText = levelText.trim().toUpperCase().split(/\s+/)[0];
                if (levelText === "IN") return "#d31314";
                if (levelText === "AT") return "#443";
                if (levelText === "HD") return "#2bf";
                if (levelText === "EZ") return "#5d0";
                return "#00dddd";
            },
            selectChart(chart) {
                if (!chart) return;
                for (const chart of this.selectedSongData.charts) chart.selected = false;
                if (!chart.userScore) {
                    if (!shared.game.ptmain.gameConfig.ptBestRecords)
                        shared.game.ptmain.gameConfig.ptBestRecords = {};
                    const scoreData = shared.game.ptmain.gameConfig.ptBestRecords[chart.id] || [
                        0,
                        0,
                        false,
                        true,
                    ];
                    if (!scoreData[3]) {
                        const score = scoreData[0];
                        chart.userScore = [
                            score === 1000000
                                ? ["φ", "goldenrod", "50px", -1]
                                : scoreData[2]
                                  ? ["V", "deepskyblue", "50px", -1]
                                  : score >= 960000
                                    ? ["V", "gray", "50px", -1]
                                    : score >= 920000
                                      ? ["S", "gray", "50px", -1]
                                      : score >= 880000
                                        ? ["A", "gray", "50px", -1]
                                        : score >= 820000
                                          ? ["B", "gray", "50px", -1]
                                          : score >= 700000
                                            ? ["C", "gray", "50px", -1]
                                            : ["F", "gray", "50px", -1],
                            this.scoreStr(scoreData[0]),
                            `${(scoreData[1] * 100).toFixed(2)}%`,
                        ];
                    } else {
                        chart.userScore = [["NEW", "gray", "15px", 0.6], "0000000", "0.00%"];
                    }
                }
                chart.selected = true;
            },
            async loadChart(ct) {
                if (partyMgr.list.aprfool2024.hookCheckRT(ct.id)) return;
                const localCharts = {
                    "c9e42da0-2149-4037-98be-e50070be9ad6": {
                        type: "pgm",
                        link: "/src/core/charts/pgm/c22in.json",
                    },
                };
                if (ct.id && ct.id in localCharts) {
                    const ctpr = localCharts[ct.id];
                    ct.chart = ctpr.link;
                    switch (ctpr.type) {
                        case "pgm":
                            await shared.game.msgHandler.info(this.$t("chartSelect.pgmChartNote"));
                            break;
                        default:
                            break;
                    }
                }
                if (!ct.chart) {
                    shared.game.msgHandler.failure(
                        this.$t("chartSelect.unableToSelectDueToCopyrightReasons")
                    );
                    return;
                }
                if (this.previewAbortController)
                    this.previewAbortController.abort(), (this.previewAbortController = null);
                this.ct = ct;
                if (shared.game.ptmain.gameMode === "multi") {
                    if (
                        shared.game.multiInstance.owner &&
                        shared.game.multiInstance.room.stage === 1
                    ) {
                        audio.stop();
                        this.multiSyncChart();
                        return;
                    } else return;
                }
                if (shared.game.ptmain.gameMode !== "multi") {
                    shared.game.ptmain.playConfig = JSON.parse(
                        JSON.stringify(this.selectedPlayingSettings)
                    );
                    if (
                        this.selectedPlayingSettings.previewMode ||
                        this.selectedPlayingSettings.adjustOffset
                    ) {
                        shared.game.ptmain.playConfig.practiseMode = true;
                        shared.game.ptmain.playConfig.mode = "preview";
                    } else shared.game.ptmain.playConfig.mode = "play";
                } else shared.game.ptmain.playConfig = {};
                ploading.l(this.$t("chartSelect.loadingChart"), "loadChart");
                shared.game.ptmain.loadChart(this.selectedSongData, ct, this.chartLoaded);
            },
            chartLoaded(songInfo, chartInfo) {
                if (this.$route.path !== "/chartSelect") return;
                if (shared.game.ptmain.gameMode !== "multi") {
                    this.toSyncOrPlay = 1;
                    ploading.r("loadChart");
                    audio.stop();
                    if (this.selectedSongData.unlockVideo)
                        this.showUnlockVideo().then(this.playChart);
                    else this.playChart();
                }
            },
            async playChart() {
                shared.game.ptmain.playChart();
            },
            edit() {
                this.$router.push({
                    path: "/chartEdit",
                });
            },
            async deleteChart() {
                if (
                    !(await shared.game.msgHandler.confirm(
                        this.$t("chartManage.confirmBeforeDelete")
                    ))
                )
                    return;
                // this.deleteCacheAll(this.selectedSongData);
                ptdb.chart.song.delete(this.selectedSongData.id);
                for (const chart of this.selectedSongData.charts) ptdb.chart.chart.delete(chart.id);

                this.selectedSongData = null;
                audio.stop();
                /* if (this.selectChoice === "local")  */ this.loadOffline();
            },
            scoreStr(t) {
                const a = Math.round(t);
                return "0".repeat(a.length < 7 ? 7 - a.length : 0) + a;
            },
            async favourite() {
                if (this.favouriteSongs.includes(this.selectedSongData.id)) {
                    this.favouriteSongs = this.favouriteSongs.filter(
                        item => item !== this.selectedSongData.id
                    );
                    shared.game.msgHandler.sendMessage(
                        this.$t("chartSelect.favourites.removedSuccessfully", [
                            this.selectedSongData.name,
                        ])
                    );
                } else {
                    this.favouriteSongs.push(this.selectedSongData.id);
                    shared.game.msgHandler.sendMessage(
                        this.$t("chartSelect.favourites.addedSuccessfully", [
                            this.selectedSongData.name,
                        ])
                    );
                }
            },
            async multiSyncChart() {
                try {
                    ploading.l(this.$t("chartSelect.multiSyncChart.sync"), "syncChart");
                    await shared.game.multiInstance.syncChart(
                        this.selectedSongData,
                        this.ct,
                        this.selectedPlayingSettings.speed
                    );
                    this.toSyncOrPlay = 3;
                } catch (e) {
                    ploading.r("syncChart");
                    shared.game.msgHandler.sendMessage(
                        this.$t("chartSelect.multiSyncChart.failed"),
                        "error"
                    );
                }
            },
            showUnlockVideo() {
                return new Promise(res => {
                    if (
                        !this.selectedSongData.unlockVideo ||
                        localStorage.getItem(this.selectedSongData.id + "_Unlocked") ||
                        document.querySelector(".main > video")
                    )
                        return res();
                    const main = document.querySelector(".main");
                    // const videoContainer = document.createElement("div");
                    // videoContainer.style.zIndex = 1145141919810;
                    // videoContainer.style += ";position:fixed;width:100vw;height:100vh;";
                    const video = document.createElement("video");
                    video.style +=
                        ";position:fixed;left:0;right:0;top:0;bottom:0;width:100vw;height:100vh;background-color:black;z-index:1145141919810;";
                    const source = document.createElement("source");
                    source.src = this.selectedSongData.unlockVideo + "?nocache=nocache";
                    video.appendChild(source);
                    video.autoplay = true;
                    video.addEventListener("ended", evt => {
                        main.removeChild(evt.target);
                        localStorage.setItem(this.selectedSongData.id + "_Unlocked", "y");
                        res();
                    });
                    main.appendChild(video);
                });
            },
            // 释放缓存里的 blob object URL（不 revoke 会随整页存续泄漏），
            // 列表刷新与组件销毁时调用
            clearImageCache() {
                for (const url of this.imageCache.values()) {
                    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
                }
                this.imageCache.clear();
            },
            async fetchImage(url) {
                if (!url.startsWith("/PTVirtual/")) return;
                if (this.imageCache.has(url)) return this.imageCache.get(url);

                this.loadingImages.set(url, true);

                try {
                    const response = await ptdb.fetch(url);
                    const blob = await response.blob();
                    const objectURL = URL.createObjectURL(blob);

                    this.imageCache.set(url, objectURL);
                    this.loadingImages.set(url, false);

                    return objectURL;
                } catch (error) {
                    alert(error);
                    console.error("Error loading image:", error);
                    this.loadingImages.set(url, false);
                    return url; // Fallback to original URL
                }
            },
        },
        watch: {
            selectChoice: {
                handler(newVal, oldVal) {
                    if (oldVal === "empty") this.selectChoice = oldVal;
                    if (newVal === "local") this.loadOffline();
                    else if (newVal === "favorite") this.loadFavouriteSongs();
                    else if (newVal === "empty") this.chartList = [];
                    this.selectedSongData = null;
                    this.scrolledTop = 0;
                    document.querySelector("#songSelectList").scrollTop = 0;
                    this.showBlank = false;
                    audio.stop();
                    this.search.name = "";
                },
            },
            favouriteSongs: {
                handler(newVal) {
                    ptdb.gameConfig.save(newVal, "favouriteSongs");
                },
                deep: true,
            },
            "chartList.results": {
                handler(newVal) {
                    this.clearImageCache();
                    newVal.forEach(chart => {
                        if (chart.illustration) this.fetchImage(chart.illustration);
                    });
                },
                // deep: true,
            },
        },
        meta: {
            keepAlive: true,
        },
    };
</script>

<template>
    <div id="songSelect" style="width: 95%; margin: 0 auto" v-if="toSyncOrPlay !== 3">
        <div class="songsSourceSelectContainer">
            <div class="songsSourceSelect">
                <div>
                    <input
                        type="radio"
                        id="sc1"
                        name="selectChoice"
                        v-model="selectChoice"
                        value="local"
                    />
                    <label for="sc1" v-html="$t('chartSelect.songSource.local')"></label>
                </div>

                <div>
                <input
                    type="radio"
                    id="sc2"
                    name="selectChoice"
                    v-model="selectChoice"
                    value="favorite"
                />
                    <label for="sc2" v-html="$t('chartSelect.songSource.favourites')"></label>
                </div>
            </div>
        </div>

        <div
            id="songAndChartSelector"
            class="blur"
            style="width: 90vw; border-radius: 12px; overflow: hidden"
        >
            <div
                id="songSelector"
                style="
                    width: 100%;
                    overflow-y: scroll;
                    margin-top: 2.5vh;
                    height: calc(100% - 2.5vh);
                "
            >
                <div
                    :style="{ width: selectedSongData ? '41.2vw' : '82vw' }"
                    style="display: flex; height: 35px; position: fixed; z-index: 114"
                >
                    <a
                        v-if="selectedSongData && selectChoice !== 'local'"
                        @click="back2song"
                        style="margin-top: 0.75%; margin-right: 0.75%"
                    >
                        ⬅️
                    </a>
                    <input
                        class="input textInput"
                        v-model="search.name"
                        id="searchInput"
                        :placeholder="$t('chartSelect.search')"
                        style="flex: 15"
                        @keyup.enter="doSearch"
                        autocomplete="off"
                    />
                    <input
                        type="button"
                        :value="$t('chartSelect.import')"
                        @click="$router.push('/chartUpload')"
                        style="flex: 1; margin-left: 10px"
                        v-if="selectChoice === 'local'"
                    />
                    <br />
                </div>
                <div
                    id="songSelectList"
                    style="margin-top: 40px; height: calc((100% - 105px) + 2vh)"
                    :style="{ overflow: showBlank && !selectedSongData ? 'hidden' : 'scroll' }"
                >
                    <div v-if="!chartList.results || chartList.results.length == 0">
                        {{
                            selectChoice === "favorite"
                                ? $t("chartSelect.chartListIsEmptyFavorite")
                                : isEmptyOffline
                                ? $t("chartSelect.chartListIsEmptyOffline")
                                : $t("chartSelect.chartListIsEmpty")
                        }}
                        <br />
                        <br />
                        <input
                            v-if="selectChoice === 'local'"
                            type="button"
                            :value="$t('chartSelect.goDownloadCharts')"
                            style="font-size: 1em; width: auto; padding: 0.2em 1em"
                            @click="$router.push('/chartManage')"
                        />
                    </div>
                    <!-- new -->
                    <div id="chartListall" :fullwidth="!selectedSongData">
                        <div
                            class="scoreSongCard songItem"
                            style="color: black; margin: auto"
                            v-for="chart in chartList.results"
                            @click="
                                showBlank = true;
                                goDetails(chart).catch(e => (showBlank = false));
                            "
                            :style="{
                                display: 'flex',
                                background:
                                    selectedSongData == chart
                                        ? 'rgba(255,255,255,0.75)'
                                        : 'rgba(237,247,255,0.4)',
                            }"
                        >
                            <div style="flex: 3; overflow: hidden; aspect-ratio: 3 / 2">
                                <img
                                    :src="
                                        loadingImages.get(chart.illustration)
                                            ? null
                                            : imageCache.get(chart.illustration) ||
                                              chart.illustration
                                    "
                                    style="object-fit: cover; height: 100%; width: 100%"
                                />
                                <div
                                    class="songCardCover"
                                    v-show="!selectedSongData"
                                    style="font-size: 1.25vw; color: white; line-height: 1.2em"
                                    :style="{
                                        '--bg': `url(${loadingImages.get(chart.illustration) ? null : imageCache.get(chart.illustration) || chart.illustration})`,
                                    }"
                                >
                                    <div class="songCardName">{{ chart.name }}</div>
                                    <br />
                                    <div class="songCardComposer">{{ chart.composer }}</div>
                                </div>
                            </div>
                            <div
                                v-if="selectedSongData"
                                :style="{
                                    flex: 7,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    lineHeight: '1.2em',
                                    'margin-left': '1vw',
                                    'margin-top': '1vh',
                                }"
                            >
                                <div>{{ chart.name }}</div>
                                <div style="flex: 1; font-size: 0.6em">{{ chart.composer }}</div>

                                <div
                                    style="
                                        flex: 3;
                                        display: flex;
                                        flex-wrap: wrap;
                                        align-items: center;
                                    "
                                >
                                    <div
                                        v-for="realchart in chart.charts"
                                        class="chartLevel"
                                        :style="{ background: getLevelColor(realchart.level) }"
                                    >
                                        <span>
                                            {{ formatChartLevel(realchart) }}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div v-if="showBlank && !selectedSongData" style="height: 114514px"></div>
                    <!-- old <deleted> -->
                </div>
                <div
                    id="pageControl"
                    :style="{ width: selectedSongData ? '40vw' : '84vw' }"
                    style="text-align: center; font-size: 20px; line-height: 25px; margin-top: 10px"
                >
                    <a v-if="canPrev" @click="loadPrevPage()">◀</a>
                    &nbsp;
                    <span @click="goJustPageAsk()" style="color: black">
                        {{
                            $t("chartSelect.pageCount", {
                                page,
                                pageAll,
                            })
                        }}
                    </span>
                    &nbsp;
                    <a v-if="canNext" @click="loadNextPage()">▶</a>
                </div>
            </div>

            <div
                id="chartSelect"
                v-if="selectedSongData"
                :style="{ width: selectedSongData ? '100%' : '40vw' }"
            >
                <div
                    v-if="selectedSongData"
                    style="margin-top: 2.5vh; overflow-y: scroll; height: calc(100% - 2.5vh)"
                >
                    <div class="scoreSongCard" style="width: 90%; height: 30vh">
                        <img
                            :src="
                                loadingImages.get(selectedSongData.illustration)
                                    ? null
                                    : imageCache.get(selectedSongData.illustration) ||
                                      selectedSongData.illustration
                            "
                            style="object-fit: cover; width: 100%; height: 100%"
                        />
                    </div>
                    <div
                        style="
                            display: flex;
                            justify-content: space-evenly;
                            flex-wrap: wrap;
                            height: max-content;
                        "
                    >
                        <a
                            @click="chartSelectorOpenedTab = 'chartSelect'"
                            v-if="chartSelectorOpenedTab === 'config'"
                        >
                            &nbsp;&nbsp;{{ $t("chartSelect.chartSelect") }}
                        </a>
                        <a
                            @click="chartSelectorOpenedTab = 'config'"
                            v-if="chartSelectorOpenedTab === 'chartSelect'"
                        >
                            &nbsp;&nbsp;{{ $t("chartSelect.config") }}
                        </a>

                        <a @click="favourite">
                            &nbsp;&nbsp;{{
                                favouriteSongs.includes(selectedSongData.id)
                                    ? $t("chartSelect.favourites.remove")
                                    : $t("chartSelect.favourites.add")
                            }}
                        </a>

                        <a @click="edit" v-if="canEdit">
                            &nbsp;&nbsp; {{ $t("chartSelect.edit") }}
                        </a>
                        <a @click="deleteChart" v-if="canEdit">
                            &nbsp;&nbsp; {{ $t("chartSelect.delete") }}
                        </a>
                    </div>

                    <Transition name="slide-fade">
                        <div id="chartSelectCharts" v-if="chartSelectorOpenedTab === 'chartSelect'">
                            <div v-if="selectedSongData.charts.length">
                                <div
                                    class="scoreSongCard chartItem"
                                    style="margin-left: 5%; width: 90%; height: 30%; color: black"
                                    :style="{
                                        minHeight: chart.selected ? '75px' : '30px',
                                        background: chart.selected ? '#d6e9ff' : '#00000016',
                                    }"
                                    v-for="chart in selectedSongData.charts"
                                    @click="selectChart(chart)"
                                >
                                    <div
                                        style="
                                            display: block;
                                            width: 100%;
                                            display: flex;
                                            flex-direction: column;
                                        "
                                    >
                                        <div style="display: flex; flex: 3; padding-top: 5px">
                                            <div class="chartItemLevel" style="margin-left: 2%">
                                                {{ formatChartLevel(chart) }}
                                                {{ chart.ranked ? "Ranked" : "" }}
                                            </div>
                                            <div class="chartItemCharter" style="margin-left: 5%">
                                                {{ cleanStr(chart.charter) }}
                                            </div>
                                        </div>

                                        <div
                                            class="chartSelectChartItemDetalis"
                                            v-if="chart.selected"
                                            style="
                                                display: flex;
                                                text-align: left;
                                                margin-left: 2%;
                                                flex: 7;
                                            "
                                        >
                                            <div
                                                :style="{
                                                    flex: 10,
                                                    'margin-top': `${chart.userScore[0][3] * 20}px`,
                                                }"
                                            >
                                                <span
                                                    :style="{
                                                        color: chart.userScore[0][1],
                                                        'font-size': chart.userScore[0][2],
                                                    }"
                                                >
                                                    {{ chart.userScore[0][0] }}
                                                </span>
                                            </div>
                                            <div style="flex: 75; margin-top: 5px">
                                                <span style="margin-left: 5%; font-size: 25px">
                                                    {{ chart.userScore[1] }}
                                                </span>
                                                <span style="margin-left: 2%; font-size: 15px">
                                                    {{ chart.userScore[2] }}
                                                </span>
                                            </div>
                                            <div class="play" style="display: block; flex: 10">
                                                <input
                                                    type="button"
                                                    @click="loadChart(chart)"
                                                    :value="$t('chartSelect.select')"
                                                    style="margin-right: 8px"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div v-else style="text-align: center; padding-top: 20px">
                                {{ $t("chartSelect.thisSongHasNoPlayableCharts") }}
                            </div>
                        </div>
                    </Transition>
                    <Transition name="slide-fade">
                        <div id="chartSelectConfig" v-if="chartSelectorOpenedTab === 'config'">
                            <div style="display: flex" v-if="!isMulti">
                                <input
                                    type="checkbox"
                                    v-model="selectedPlayingSettings.mirror"
                                    id="selectMirror"
                                />
                                <label for="selectMirror">
                                    {{ $t("chartSelect.playConfig.mirror") }}
                                </label>
                            </div>

                            <div style="display: flex" v-if="!isMulti">
                                <input
                                    type="checkbox"
                                    v-model="selectedPlayingSettings.adjustOffset"
                                    id="adjustOffset"
                                />
                                <label for="adjustOffset">
                                    {{ $t("chartSelect.playConfig.adjustOffset") }}
                                </label>
                            </div>

                            <div style="display: flex" v-if="!isMulti">
                                <input
                                    type="checkbox"
                                    v-model="selectedPlayingSettings.previewMode"
                                    id="previewMode"
                                />
                                <label
                                    for="previewMode"
                                    v-if="!selectedPlayingSettings.adjustOffset"
                                >
                                    {{ $t("chartSelect.playConfig.previewMode") }}
                                </label>
                            </div>

                            <div style="display: flex" v-if="!isMulti">
                                <input
                                    type="checkbox"
                                    v-model="selectedPlayingSettings.practiseMode"
                                    id="practiseMode"
                                    v-if="!selectedPlayingSettings.previewMode"
                                />
                                <label
                                    for="practiseMode"
                                    v-if="
                                        !selectedPlayingSettings.previewMode &&
                                        !selectedPlayingSettings.adjustOffset
                                    "
                                >
                                    {{ $t("chartSelect.playConfig.practiseMode") }}
                                </label>
                            </div>

                            <div style="display: flex" v-if="!isPTApp">
                                <input
                                    type="checkbox"
                                    v-model="selectedPlayingSettings.videoRecorder"
                                    id="videoRecorder"
                                />
                                <label for="videoRecorder">
                                    {{ $t("chartSelect.playConfig.videoRecorder") }}
                                </label>
                            </div>

                            <div style="display: flex">
                                <span>{{ $t("chartSelect.playConfig.speed") }} :&nbsp;&nbsp;</span>
                                <select
                                    v-model="selectedPlayingSettings.speed"
                                    style="width: 4em; height: 30px; margin-top: -0.1em"
                                >
                                    <option value="Slowest">
                                        {{ $t("chartSelect.playConfig.speeds.slowest") }}
                                    </option>
                                    <option value="Slower">
                                        {{ $t("chartSelect.playConfig.speeds.slower") }}
                                    </option>
                                    <option value="">
                                        {{ $t("chartSelect.playConfig.speeds.normal") }}
                                    </option>
                                    <option value="Faster">
                                        {{ $t("chartSelect.playConfig.speeds.faster") }}
                                    </option>
                                    <option value="Fastest">
                                        {{ $t("chartSelect.playConfig.speeds.fastest") }}
                                    </option>
                                </select>
                            </div>
                        </div>
                    </Transition>
                </div>
            </div>
        </div>
    </div>
    <div
        id="songSelect"
        style="
            width: 95%;
            margin: 0 auto;
            display: flex;
            align-items: center;
            justify-content: center;
        "
        v-else
    >
        <p id="waitMsg" style="font-size: 2em">{{ $t("multiplayer.multiWaitLoadChart") }}</p>
    </div>
</template>

<style>
    #songSelect {
        display: flex;
        height: calc(97.5% - 75px);
        position: fixed;
        left: 2.5%;
        top: 75px;
    }

    .songSearch {
        width: 90%;
        margin: auto;
        display: flex;
        justify-content: space-between;
        font-size: 1.5em;
    }

    .songSearch div {
        width: 100%;
    }

    #searchBtn {
        width: auto;
        min-width: 100%;
        text-align: center;
        font-size: 0.75em;
        float: right;
        margin-right: 5%;
        height: auto;
    }

    #searchInput {
        width: 90%;
        margin: left;
    }

    .songsSourceSelectContainer {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 11vw;
        margin-left: -1vw;
        overflow-y: scroll;
    }

    #songAndChartSelector {
        display: flex;
        height: 100%;
        width: 90vw;
        margin-left: 0%;
        background-color: #ffffff60;
    }

    #songSelector {
        height: 100%;
        width: 45vw;
        padding-left: 2.5vw;
        padding-right: 2.5vw;
        overflow-x: hidden;
    }

    #chartSelect {
        height: 100%;
        width: 40vw;
    }

    .chartItem {
        color: black;
    }

    .songItem {
        color: black;
        width: 100%;
        min-height: 100px;
        display: flex;
        box-shadow: 0px 0px 0px 0.8px var(--color-box-shadow);
    }

    .chartLevel {
        min-width: 75px;
        max-width: 100px;
        text-align: center;
        border-radius: 5px;
        color: white;
        margin-left: 0.25vw;
        max-height: 20px;
        overflow: hidden;
    }

    .chartLevel > span {
        min-width: 65px;
        max-width: 90px;
        margin-left: 5px;
        margin-right: 5px;
    }

    #pageControl {
        bottom: 0px;
        height: 25px;
        overflow: hidden;
    }

    .songsSourceSelect {
        display: flex;
        flex-direction: column;
        gap: 1.2vh;
        padding: 1.2vh 0;
    }

    .songsSourceSelect > div input[type="radio"] {
        display: none;
    }

    .songsSourceSelect div {
        width: 90%;
    }

    .songsSourceSelect div label {
        display: block;
        background-color: #ffffff60;
        color: #000000;
        border: none;
        border-radius: 10px;
        font-size: 1.5vw;
        padding: min(4.5vh, 25px) 1.5vw;
        line-height: 0;
    }

    .songsSourceSelect div input:checked ~ label {
        color: #ffffff;
        background-color: #2b5793;
    }

    .songsSourceSelect div label::before {
        content: unset !important;
    }

    #colorPicker {
        color: #00000016;
    }

    #chartSelectCharts,
    #chartSelectConfig {
        width: 100%;
        margin-top: 0.5vh;
        margin-left: -2%;
        color: black;
    }

    #chartSelectConfig {
        /* background: #ffffff60;
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 30%; */
        justify-content: center;
        display: flex;
        flex-direction: column;
        align-content: center;
        align-items: center;
    }

    #chartListall[fullwidth="true"] {
        /* display: grid; */
        /* grid-template-columns: repeat(auto-fit, minmax(25%, 1fr)); */
        display: flex;
        flex-wrap: wrap;
        width: 100%;
    }

    #chartListall[fullwidth="true"] > .songItem {
        /* width: 25%; */
        /* margin: 5px; */
        width: calc(25% - 5px);
        font-size: 1.25vw;

        position: relative;
        -webkit-box-sizing: border-box;
        box-sizing: border-box;
        overflow: hidden;
        color: #fff;
        border: 1px solid var(--color-box-border);
        box-shadow: 0 0 8px 0.8px var(--color-box-shadow);
        border-radius: 10px;
        text-align: left;
        margin: 5px !important;
        display: inline-flex;
        margin-right: 0 !important;
    }

    #chartListall[fullwidth="true"] > .songItem > div > .songCardCover {
        border: unset !important;
    }
</style>
