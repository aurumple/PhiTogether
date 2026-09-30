import { createApp } from "vue/dist/vue.esm-bundler";
// 根组件视图来源由构建决定：独立版=DOM 模板（运行时编译），模块版=构建期 render
//（隔离容器 CSP 无 unsafe-eval）。别名 `app-view` 见 vite.config.js / onetap/vite.onetap.config.mjs。
import viewOptions, { moduleMode } from "app-view";
import * as VueRouter from "vue-router";
import { msgHandler } from "@utils/js/msgHandler";
import eruda from "eruda";
import { App } from "@capacitor/app";

import packageConfig from "../package.json";

import { routes } from "@components/router";
import multiplayerinst from "@components/multiplayer.vue";

import { uploader } from "@renderers/sim-phi/assetsProcessor/reader";
import shared from "@utils/js/shared.js";
import i18n from "@locales";
import { ptServer } from "@utils/ptServer";
import * as serverApi from "@utils/serverApi";
import { chartDownloadQueue } from "@utils/chartDownloadQueue";
import ploading from "@utils/js/ploading.js";
import { full } from "@utils/js/common.js";
import { tipsHandler } from "@components/tips";
import { recordMgr } from "@components/recordMgr/recordMgr.js";
import { replayMgr } from "@components/recordMgr/replayMgr.js";
import ptdb from "@components/ptdb";
import "@utils/js/errHandler";
import { Utils } from "@utils/js/utils";

if (import.meta.env.DEV) self.ptdb = ptdb;

document.oncontextmenu = e => e.preventDefault();
import { renderers } from "@components/renderer";

var searchParams;

// 顶部玩家条头像描边色：按用户名哈希取色（原 PhiZone 角色色板的本地替代）
const getUserColor = name => {
    const palette = ["#66bbff", "#7dd3a0", "#f2b134", "#e06666", "#b088f9", "#f28ab2"];
    let h = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
};

// gameConfig 落盘防抖：挂载流程（填充玩家信息等）会触发深度 watcher，
// 若立即保存会在恢复存档前用默认值覆盖 IndexedDB 里的用户设置
// （「每次重进设置都被重置」的根因）。恢复完成前不落盘，之后 500ms 防抖保存。
let configRestored = false;
let configSaveTimer = null;
const queueConfigSave = () => {
    if (configSaveTimer) clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(() => {
        configSaveTimer = null;
        if (configRestored) ptdb.gameConfig.save(ptmain.gameConfig);
    }, 500);
};

ploading.init({
    whenShow: () => {
        ploading.tip = tipsHandler.getTip(ploading.msg);
    },
});
if (spec.isPhiTogetherApp) {
    App.addListener("appUrlOpen", (event /* : URLOpenListenerEvent */) => {
        location.href = event.url.replace("https:", "capacitor:");
    });
}

const mainCtn = document.querySelector("div.main");
const requestFullscreen = async forced => {
    // 模块模式：铺满呈现由宿主（ui.fullscreen 能力）负责。容器沙箱没有 allow-fullscreen，
    // 请求浏览器全屏只会抛错弹提示；直接视为已处理，loadingPage 的 untilFullscreen 不空等。
    if (moduleMode) {
        shared.game.requestedFullscreen = true;
        return;
    }
    if (
        !forced &&
        (spec.isPhiTogetherApp ||
            spec.isDesktop ||
            location.hostname === "localhost" ||
            (searchParams &&
                searchParams.get("flag") &&
                searchParams.get("flag").includes("noRequestingFullscreen")))
    ) {
        shared.game.requestedFullscreen = true;
        return;
    }
    if (spec.isiOSDevice && !spec.isPhiTogetherApp) {
        if (await msgHandler.confirm(i18n.global.t("requestFullscreen.requestDownloadiOSApp")))
            window.location.href = "https://testflight.apple.com/join/PvFpBSft";
        shared.game.requestedFullscreen = true;
        return;
    }
    if (!full.enabled) {
        msgHandler.sendMessage(i18n.global.t("requestFullscreen.unsupported"), "error");
        shared.game.requestedFullscreen = true;
        return;
    }
    if (!full.check(mainCtn)) {
        if (
            await msgHandler.confirm(
                i18n.global.t("requestFullscreen.requestFullscreen"),
                i18n.global.t("info.info"),
                i18n.global.t("requestFullscreen.clickToFullscreen"),
                i18n.global.t("info.cancel")
            )
        )
            full.toggle(mainCtn);
        shared.game.requestedFullscreen = true;
    }
    return;
};
shared.game.requestedFullscreen = false;
shared.game.requestFullscreen = requestFullscreen;

if (window.devicePixelRatio >= 3) document.documentElement.style.fontSize = "80%";
if (moduleMode) {
    // 模块容器是 blob 文档：绝不操作宿主地址，路由走内存；深链参数在模块模式不适用。
    // 呈现方式由宿主负责：这里直接视为已处理，loadingPage 的 untilFullscreen 不空等。
    shared.game.requestedFullscreen = true;
} else {
    if (location.hash.split("?")[1]) {
        searchParams = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1));
    }
    if (!location.hash || location.hash != "#/loading") location.hash = "#/loading";
}
scrollTo(0, 0);
document.body.style.overflow = "hidden";

// 模块模式用内存路由（容器地址是 blob URL，hash 路由会污染/失效）；独立版保持 hash 路由。
const routerHistory = moduleMode
    ? VueRouter.createMemoryHistory()
    : VueRouter.createWebHashHistory();
// 与独立版 location.hash="#/loading" 等价：必须从加载页启动——loadingPage 负责注册
// shared.game.loaded 并在就绪后转场 startPage，跳过它 mounted() 里的 loaded() 调用会抛错。
if (moduleMode) routerHistory.replace("/loading");
const router = VueRouter.createRouter({
    history: routerHistory,
    routes,
});

router.beforeEach((to, from) => {
    // $("btn-play").value === "停止" && $("btn-play").click();
    self.hook && self.hook.playController.stop();
    document.getElementById("pageTitle").innerText = i18n.global
        .t(`pages.${to.path.toLocaleLowerCase()}`)
        .toUpperCase();
    if (!["/chartSelect"].includes(to.path)) document.querySelector("#app").scrollTop = 0;
    let s;
    switch (to.path) {
        case "/chartUpload":
            s = document.getElementById("select2");
            shared.game.clearStat();
            break;
        case "/settings":
            s = document.getElementById("settings");
            break;
        case "/multipanel":
            shared.game.multiInstance.forceOpen = true;
            shared.game.multiInstance.panelOpen = true;
            break;
        case "/playing":
            // 游玩时暂停谱面下载队列，避免下载占用网络/IO 影响游玩；
            // 离开游玩页（结算返回等）自动恢复。
            chartDownloadQueue.pause();
            shared.game.bubbleAnimator.stop();
            document.getElementById("backgroundCanvas").style.display = "none";
            document.querySelector(".background").style.display = "none";
            const gameConfig = shared.game.ptmain.gameConfig;
            if (gameConfig && gameConfig.account && gameConfig.account.defaultConfig)
                shared.game.judgeManager.setJudgeTime(
                    gameConfig.account.defaultConfig.perfectJudgment / 1000,
                    gameConfig.account.defaultConfig.goodJudgment / 1000,
                    gameConfig.account.defaultConfig.perfectJudgment / 2000
                );
            else shared.game.judgeManager.setJudgeTime();
            if (window.spec.antiAdditionEnabled)
                if (document.visibilityState !== "hidden")
                    window.nativeApi.antiAddiction_enterGame();
                else
                    shared.game.afterShow.push(
                        () => window.nativeApi && window.nativeApi.antiAddiction_enterGame()
                    );
            break;
        case "/playChart":
            return ptmain.loadFromRedirect(
                new URLSearchParams(to.fullPath.slice(to.fullPath.indexOf("?") + 1))
            );
    }
    if (s) {
        s.classList.remove("out");
        s.classList.remove("to");
        s.classList.add("from");
        s.classList.add("in");
        s.style.display = "block";
        setTimeout(() => {
            s.classList.remove("from");
        }, 50);
    }
    let s2;
    switch (from.path) {
        case "/chartUpload":
            s2 = document.getElementById("select2");
            break;
        case "/settings":
            s2 = document.getElementById("settings");
            break;
        case "/multipanel":
            shared.game.multiInstance.forceOpen = false;
            shared.game.multiInstance.panelOpen = false;
            break;
        case "/playing":
            chartDownloadQueue.resume();
            document.getElementById("backgroundCanvas").style.display = "block";
            document.querySelector(".background").style.display = "block";
            shared.game.bubbleAnimator.start();
            shared.game.ptmain._pzFollowAspectRatio = false;
            if (window.spec.antiAdditionEnabled)
                if (document.visibilityState !== "hidden")
                    window.nativeApi.antiAddiction_leaveGame();
                else
                    shared.game.afterShow.push(
                        () => window.nativeApi && window.nativeApi.antiAddiction_leaveGame()
                    );
            break;
    }
    if (s2) {
        s2.classList.remove("in");
        s2.classList.remove("from");
        s2.classList.add("out");
        setTimeout(() => {
            s2.classList.add("to");
        }, 50);
        setTimeout(() => {
            s2.style.display = "none";
        }, 400);
    }
    if (to.path != "/playing") {
        stage.style.display = "none";
        replayMgr.replaying = false;
    } else {
        stage.style.display = "block";
        shared.game.app.resizeCanvas();
        if (to.query.auto) hook.playController.play();
    }
    const gameAdjustPage = ["/playing"];
    if (gameAdjustPage.includes(from.path) && !gameAdjustPage.includes(to.path)) {
        $("gameAdjust").style.display = "none";
    }
    if (["/chartSelect", "/startPage", "/replayPage", "/loading"].includes(to.path)) {
        document.body.style.overflow = "hidden";
        document.querySelector("div.main").style.overflow = "hidden";
    } else {
        document.body.style.overflow = "auto";
        document.querySelector("div.main").style.overflow = "auto";
    }
    if (window.spec.isiOSDevice && window.spec.isPhiTogetherApp)
        document
            .querySelectorAll(".textInput")
            .forEach(i => (i.disabled = !(i.disabled = !i.disabled)));
});
const ptAppInstance = createApp({
    ...viewOptions(),
    data() {
        return {
            _pzFollowAspectRatio: false,
            currentRenderer: renderers.simphi,
            mpServerURL: "",
            gameConfig: {
                _followAspectRatio: false,
                account: {
                    tokenInfo: null,
                    userBasicInfo: null,
                    defaultConfig: null,
                },
                ptBestRecords: {},
                showPoint: false,
                showTimer: false,
                JITSOpen: true,
                defaultRankMethod: "score",
                denyChartSettings: false,
                showTransition: true,
                feedback: false,
                imageBlur: false,
                highLight: true,
                showCE2: false,
                lineColor: true,
                showAcc: true,
                showStat: false,
                lowRes: true,
                noUIBlur: true,
                enhanceRankVis: false,
                lockOri: true,
                aspectRatio: "1.5",
                noteScale: "1.15",
                backgroundDim: "0.6",
                volume: "1",
                inputOffset: "90",
                notifyFinished: false,
                isMaxFrame: false,
                maxFrame: 60,
                isForcedMaxFrame: false,
                enableVP: true,
                enableFR: false,
                autoDelay: false,
                usekwlevelOverbgm: false,
                resourcesType: "together-pack-1",
                prprRespackID: "",
                enableFilter: false,
                enableLife: true,
                filterInput: "",
                customResourceLink: "",
                autoplay: false,
                competeMode: false,
                fullScreenJudge: false,
                stopWhenNoLife: false,
                useSeparateOffscreenCanvas: false,
                reviewWhenResume: false,
                lastVersion: "lastVer",
            },
            debugEnabled: false,
            multiInstance: null,
            noAccountMode: true,
            gameMode: "single",
            externalHooks: {
                chartLoaded: null,
                playerFinished: null,
            },
            chartOffsetSurface: 0,
            lastLoad: null,
            playConfig: {
                practiseMode: false,
            },
            thisVersion: packageConfig.version,
            afterSimphiLoadedHook: null,
            isSimphiLoaded: false,
            prprRespacks: [],
            canplay: !window.spec.antiAdditionEnabled,
            localeValue: localStorage.getItem("ptlocale"),
        };
    },
    mounted() {
        if (!this.localeValue) this.localeValue = navigator.language.replace("-", "_") || "zh_CN";
        this.localeValue = this.localeValue.startsWith("en")
            ? "en_US"
            : `zh_${
                  this.localeValue.endsWith("HK") || this.localeValue.endsWith("TW") ? "TW" : "CN"
              }`;

        this.$i18n.locale = this.localeValue;
        // 自建服务端模式：用已登录账号填充玩家信息（rks 由本地排行榜接口回填），
        // 使 startpage 玩家卡与回放记录使用真实昵称。
        const srvName = ptServer.playerName();
        if (srvName && this.noAccountMode && !this.gameConfig.account.userBasicInfo) {
            this.gameConfig.account.userBasicInfo = {
                userName: srvName,
                id: "server-local",
                role: "player",
                experience: 0,
                rks: 0,
                avatar: null,
                dateLastLoggedIn: Date.now(),
                isPTDeveloper: false,
            };
        }
        if (srvName) recordMgr.playerInfo.username = srvName;
    },
    computed: {
        aspectRatioComputed() {
            if (this.gameConfig._followAspectRatio || this._pzFollowAspectRatio)
                return this._pzFollowAspectRatio ? 1.5 : parseFloat(this.gameConfig.aspectRatio);
            else return null;
        },
        chartOffsetActual() {
            return this.chartOffsetSurface * 1 + this.gameConfig.inputOffset * 1;
        },
        canBack() {
            if (this.gameMode === "single") {
                return !["/loading", "/startPage"].includes(this.$route.path);
            } else {
                return (
                    this.$route.path === "/chartUpload" && shared.game.multiInstance.user.isOwner
                );
            }
        },
        canSet() {
            if (this.gameMode === "single") {
                return ![
                    "/startPage",
                    "/settings",
                    "/playing",
                    "/calibrate",
                    "/aboutPage",
                    "/chartUpload",
                ].includes(this.$route.path);
            } else {
                return false;
            }
        },
        shouldNotSaveScore() {
            return (
                this.playConfig.practiseMode ||
                this.playConfig.mode === "preview" ||
                shared.game.app.speed != 1 ||
                this.gameConfig.fullScreenJudge ||
                replayMgr.replaying
            );
        },
        userColor() {
            return getUserColor(
                this.gameConfig.account.userBasicInfo
                    ? this.gameConfig.account.userBasicInfo.userName
                    : null
            );
        },
    },
    watch: {
        gameConfig: {
            handler(newVal, oldVal) {
                queueConfigSave();

                if (newVal.noUIBlur === ploading.useBlur) {
                    if (newVal.noUIBlur) document.body.classList.add("noUIBlur");
                    else document.body.classList.remove("noUIBlur");
                    ploading.useBlur = !newVal.noUIBlur;
                    ploading.refreshBlurState();
                }
            },
            deep: true,
        },
        "gameConfig.prprRespackID": {
            async handler(newVal, oldVal) {
                if (!this.isSimphiLoaded) return;
                if (
                    this.gameConfig.resourcesType === "prpr-custom" &&
                    newVal !== oldVal &&
                    newVal
                ) {
                    this.updatePrprCustomRespack();
                }
            },
            deep: true,
        },
        "gameConfig.noteScale": {
            handler(newVal) {
                shared.game.simphi.setNoteScale(Number(newVal));
            },
        },
        debugEnabled: {
            handler(newVal, oldVal) {
                const ele = document.querySelector("#eruda");
                if (newVal) {
                    eruda.init({
                        container: document.querySelector("#forEruda"),
                    });
                    ele && (ele.style.display = "block");
                } else {
                    ele && (ele.style.display = "none");
                }
            },
        },
        chartOffsetSurface: {
            handler(newVal, oldVal) {
                const lc = sessionStorage.getItem("loadedChart");
                if (!lc) return;
                let saved;
                saved = localStorage.getItem("PTSavedOffsets");
                if (!saved) saved = {};
                else saved = JSON.parse(saved);
                const ct = JSON.parse(lc);
                saved[ct.id] = newVal;
                // 用 setItem 而不是属性赋值：模块模式的存储替身按 setItem 转发持久化
                localStorage.setItem("PTSavedOffsets", JSON.stringify(saved));
            },
        },
        "gameConfig.resourcesType": {
            async handler(newVal, oldVal) {
                if (ploading.currentId) return;
                if (newVal.startsWith("together-pack") || newVal === "pt-custom") {
                    try {
                        if (oldVal === "prpr-custom") {
                            const cache = await caches.open("PTv0-User");
                            await cache.delete("/PTVirtual/user/respack.zip");
                        }
                    } catch (e) {}
                    if (newVal.startsWith("together-pack"))
                        this.currentRenderer.loadRespack("/src/respack/" + newVal);
                } else if (newVal === "prpr-custom") {
                    return;
                }
            },
        },
        playConfig: {
            handler(newVal, oldVal) {
                document.getElementById("select-speed").value = newVal.speed || "";
                document.getElementById("select-flip").value = newVal.mirror ? "1" : "0";
                shared.game.simphi.mirrorView(document.getElementById("select-flip").value);
                shared.game.simphi.speed =
                    2 **
                    ({ Slowest: -9, Slower: -4, "": 0, Faster: 3, Fastest: 5 }[
                        document.getElementById("select-speed").value
                    ] /
                        12);
                // if (newVal.videoRecorder) simphiPlayer.plugins.videoRecorder.enable();
                // else this.currentRenderer.plugins.videoRecorder.disable();
                // TODO
            },
        },
        localeValue: {
            async handler(newVal) {
                this.$i18n.locale = this.localeValue;
                document.getElementById("pageTitle").innerText = this.$t(
                    `pages.${this.$route.path.toLocaleLowerCase()}`
                ).toUpperCase();
                localStorage.setItem("ptlocale", newVal);
            },
        },
    },
    methods: {
        loadCustomRes() {
            msgHandler.sendMessage(this.$t("loadingPage.loadingRes"));
            shared.game.simphi.reloadRes(this.gameConfig.customResourceLink, true);
        },
        async removeThisRespack() {
            try {
                await ptdb.skin.delete(this.gameConfig.prprRespackID);
                this.prprRespacks = await ptdb.skin.getAll();
                this.gameConfig.prprRespackID = null;
                msgHandler.sendMessage(i18n.global.t("respack.customResRemoved"));
            } catch {
                msgHandler.sendMessage(i18n.global.t("respack.customResRemoveFailed"));
            }
        },
        uploadCustomRespack() {
            const input = Object.assign(document.createElement("input"), {
                type: "file",
                accept: "",
                /**@this {HTMLInputElement} */
                onchange() {
                    const file = this.files[0];
                    const reader = new FileReader();
                    reader.readAsArrayBuffer(file);
                    reader.onload = async evt => {
                        try {
                            const buffer = evt.target.result;
                            const id = await shared.game.loadSkinFromBuffer(
                                buffer,
                                false,
                                ptdb.skin.save
                            );
                            ptmain.prprRespacks = await ptdb.skin.getAll();
                            ptmain.gameConfig.prprRespackID = id;
                            msgHandler.sendMessage(i18n.global.t("respack.customResApplied"));
                        } catch (e) {
                            console.err(e);
                            ptmain.gameConfig.resourcesType = "together-pack-1";
                        }
                    };
                },
            });
            input.click();
        },
        openMultiPanel() {
            shared.game.multiInstance.panelOpen = true;
            shared.game.multiInstance.panelChoice = "messages";
        },
        doCalibrate() {
            this.$router.push("/calibrate");
        },
        ptAppPause(i) {
            hook.playController.pause();
        },
        async retry() {
            recordMgr.reset();
            shared.game.restartClearRecord();
        },
        async playChart(settings) {
            this._playRecordOwner = ptServer.recordOwner();
            if (settings) this.playConfig = JSON.parse(JSON.stringify(settings));
            // 开打前抓一份本曲榜单快照：热点 5 分钟踢人，打完歌时大概率已断网，
            // 结算画面的预估名次只能用这一刻的数据（联网时它也是最新的）。
            const prefetchId = String(
                JSON.parse(sessionStorage.getItem("loadedChart") || "{}").id || ""
            );
            if (prefetchId) void ptServer.prefetchChartBoard(prefetchId);
            this.$router.push({ path: "/playing", query: { auto: 1 } });
            if (shared.game.restartClearRecord) shared.game.restartClearRecord();
        },
        async playFinished() {
            if (
                replayMgr.replaying ||
                (shared.game.multiInstance?.room?.compete_mode && shared.game.multiInstance.owner)
            ) {
                return;
            }
            shared.game.finishToRecord && shared.game.finishToRecord();
            shared.game.ptRank = null; // 结算画面的本曲排名（上传后异步填入）
            const chartData = JSON.parse(sessionStorage.getItem("loadedChart"));
            const isMulti = shared.game.ptmain.gameMode === "multi";
            if (!this.shouldNotSaveScore) {
                const stat = shared.game.stat;
                const chartId = String(chartData.id);
                const songInfo = JSON.parse(sessionStorage.getItem("chartDetailsData") || "{}");
                try {
                    const queued = await ptServer.queueRecord(
                        {
                            chart_id: chartId,
                            song_name: String(songInfo.name || ""),
                            difficulty: String(chartData.level || ""),
                            rating: Number(chartData.difficulty) || 0,
                            score: Number(stat.scoreNum.toFixed(0)) || 0,
                            acc: (Number(stat.accNum) || 0) * 100,
                            max_acc: (Number(stat.accNum) || 0) * 100,
                            is_fc: stat.lineStatus == 3,
                            run_at: new Date().toISOString(),
                        },
                        this._playRecordOwner || ptServer.recordOwner()
                    );
                    if (queued) {
                        // 先把预估名次摆出来：纯本地、同步，断网也一定有东西看。
                        this.updateResultRank(chartId, "estimate");
                        void ptServer.syncPending().then(ok => {
                            if (
                                String(
                                    JSON.parse(sessionStorage.getItem("loadedChart") || "{}").id
                                ) === chartId
                            )
                                this.updateResultRank(chartId, ok ? "confirmed" : "pending");
                        });
                    }
                } catch (error) {
                    shared.game.ptRank = {
                        text: this.$t("chartSelect.offline.scoreSaveFailed"),
                        color: "#fe4365",
                    };
                    msgHandler.sendMessage(this.$t("chartSelect.offline.scoreSaveFailed"), "error");
                    console.error(error);
                }
            }
            if (isMulti) {
                shared.game.multiInstance.uploadScore();
            }
        },
        /**
         * 结算画面的「本曲排名」。
         *
         * state = "estimate"：用开打前的榜单快照 + 合并后的本地最佳单局算预估名次。
         *   —— 这是主路径：热点随时把设备踢下线，打完歌时通常已经没网，服务端确认
         *      根本来不及，所以预估必须是纯本地、同步、一定能给出的。
         * state = "confirmed"：上传成功，换成服务端确认的名次。
         * state = "pending"：还没传上去，保留预估并承接「待上传」文案。
         */
        async updateResultRank(chartId, state) {
            if (!ptServer.available()) {
                shared.game.ptRank = null;
                return;
            }
            const pendingText = {
                text: this.$t("chartSelect.board.pendingUpload"),
                color: "#fe4365",
            };
            // 预估名次先算好：后面每条失败分支都回落到它，绝不显示空白。
            const estimate = ptServer.estimateChartRank(chartId);
            const estimatedText = estimate
                ? {
                      text: estimate.outside
                          ? this.$t("chartSelect.board.estimateOutside")
                          : this.$t("chartSelect.board.estimateRank", [estimate.rank]),
                      color: "#ffd479",
                  }
                : null;
            if (state !== "confirmed") {
                shared.game.ptRank = estimatedText || pendingText;
                return;
            }
            const board = await ptServer.fetchChartLeaderboard(chartId);
            if (!board) {
                shared.game.ptRank = estimatedText || pendingText;
                return;
            }
            shared.game.ptRank = board.me
                ? {
                      text: this.$t("chartSelect.board.resultRank", [board.me.rank]),
                      color: "#a2e27f",
                  }
                : estimatedText;
        },
        async playerLoaded() {
            // add lchzh pause
            self.hook.pauseHook = this.ptAppPause;
            // 恢复保存的设置并使其生效
            await ptdb.gameConfig
                .get()
                .catch(() => {
                    // 首次使用（IndexedDB 无存档）：默认应用低性能设备推荐配置
                    //（隐藏距离较远的音符等，与 OneTap 一致）；用户可在设置页
                    // 自由改回，之后以用户设置为准。
                    const gc = ptmain.gameConfig;
                    gc.imageBlur = false; // 关闭背景模糊
                    gc.enableVP = true; // 隐藏距离较远的音符
                    gc.noUIBlur = true; // 禁用界面模糊
                    gc.lowRes = true; // 降低渲染精度
                    gc.autoDelay = false; // 禁用实时延迟矫正
                    gc.inputOffset = "90"; // 输入延迟 90ms
                    // 旧版本地存档（localStorage）中的用户设置优先于上述默认值
                    return JSON.parse(localStorage.getItem("PhiTogetherSettings") || "{}");
                })
                .then(parsed => {
                    let upgrade = false;
                    for (const item of Object.keys(ptmain.gameConfig)) {
                        // 自建服务端模式：跳过 account 快照恢复——旧快照会覆盖挂载时
                        // 填充的玩家信息（含已同步的最新 rks）。本地最佳成绩在顶层
                        // ptBestRecords（不受影响）。
                        if (item === "account" && ptServer.available()) continue;
                        if (item in parsed) ptmain.gameConfig[item] = parsed[item];
                        else upgrade = true;
                    }
                    if (upgrade) ptdb.gameConfig.save(ptmain.gameConfig);
                    // 恢复完成：此后 gameConfig 变更才允许落盘（见 queueConfigSave）
                    configRestored = true;

                    for (const item of Object.keys(ptmain.gameConfig)) {
                        const val = ptmain.gameConfig[item];
                        if (item == "volume") {
                            shared.game.app.musicVolume = Math.min(1, 1 / val);
                            shared.game.app.soundVolume = Math.min(1, val);
                        } else if (item == "aspectRatio") {
                            shared.game.stage.resize(Number(val));
                        } else if (item == "noteScale") {
                            shared.game.app.setNoteScale(Number(val));
                        } else if (item == "backgroundDim") {
                            shared.game.app.brightness = Number(val);
                        } else if (item == "lowRes") {
                            shared.game.app.setLowResFactor(
                                val ? (window.devicePixelRatio < 2 ? 0.85 : 0.5) : 1
                            );
                        } else if (item == "maxFrame") {
                            if (ptmain.gameConfig.isMaxFrame)
                                shared.game.frameAnimater.setFrameRate(
                                    val,
                                    ptmain.gameConfig.isForcedMaxFrame
                                );
                            else
                                shared.game.frameAnimater.setFrameRate(
                                    0,
                                    ptmain.gameConfig.isForcedMaxFrame
                                );
                        } else if (item == "enableFilter") {
                            $("enableFilter").dispatchEvent(new Event("change"));
                        } else if (item == "filterInput") {
                            $("filterInput").dispatchEvent(new Event("change"));
                        }
                    }
                });

            // if (this.gameConfig.noUIBlur) {
            //   // document.getElementById("ptTitle").classList.remove("blur");
            //   ploading.useBlur = false;
            //   ploading.refreshBlurState();
            //   document.body.classList.add("noUIBlur");
            // }

            // 请求通知权限以便发送通知（模块模式没有通知能力，也不弹这个询问）
            if (!moduleMode && !this.gameConfig.notifyFinished) {
                let onerr = e => {
                    if (window.spec.isPhiTogetherApp) return;
                    msgHandler.sendMessage(
                        this.$t("askPermission.notification.err"),
                        "error",
                        false
                    );
                    this.gameConfig.notifyFinished = true;
                };
                if ("Notification" in self) {
                    if (await msgHandler.confirm(this.$t("askPermission.notification.msg"))) {
                        Notification.requestPermission()
                            .then(() => {
                                this.gameConfig.notifyFinished = true;
                            })
                            .catch(onerr);
                    } else onerr();
                } else onerr();
            }

            // 版本更新（模块版本由宿主模块系统分发，容器内既无更新源也无跳转余地）
            if (!moduleMode) {
                try {
                    const resp = await fetch(`/latestVersion.json?nocacahe=nocache`);
                    const result = await resp.json();
                    if (window.spec.thisVersion != result.ver) {
                        if (
                            await msgHandler.confirm(
                                this.$t("update.newVersionNotify", [
                                    window.spec.thisVersion,
                                    result.ver,
                                ])
                            )
                        ) {
                            this.update();
                            return;
                        }
                    }
                } catch (e) {
                    msgHandler.sendMessage(this.$t("update.autoUpdateCheckFailed"), "error");
                }
            }

            document.addEventListener("fullscreenchange", () => {
                if (full.check(mainCtn)) {
                    if (this.$route.path === "/playing") {
                        if (!shared.game.app.isFull) shared.game.doFullScreen();
                    }
                } else requestFullscreen();
            });

            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    if (shared.game.afterShow) {
                        for (const i of shared.game.afterShow) i();
                        shared.game.afterShow = [];
                    }
                    requestFullscreen();
                }
            });

            const requestLandscape = async () => {
                if (!full.check(mainCtn) && window.innerHeight > window.innerWidth)
                    requestFullscreen();
            };

            this.prprRespacks = await ptdb.skin.getAll();

            window.addEventListener("resize", Utils.throttle(requestLandscape, 200));

            setTimeout(requestLandscape, 500);

            // 自建服务端会话恢复：刷新 token 并同步 rks / 离线成绩队列
            this.restoreServerSession();

            shared.game.loaded();

            stage.style.display = "none";

            if (searchParams && searchParams.get("play")) {
                this.loadFromRedirect(searchParams);
            }
        },
        updatePrprCustomRespack() {
            ploading.l(this.$t("loadingPage.loadingRes"), "loadResPack");
            shared.game
                .loadSkinFromDB(this.gameConfig.prprRespackID)
                .catch(() =>
                    shared.game.msgHandler.sendMessage(this.$t("simphi.prprCustomRes.err"), "error")
                )
                .then(() => ploading.r("loadResPack"));
        },
        async simphiLoaded() {
            if (this.afterSimphiLoadedHook) {
                ploading.r("simphiloading");
                this.afterSimphiLoadedHook();
            } else this.afterSimphiLoadedHook = true;
            this.isSimphiLoaded = true;
            if (this.gameConfig.resourcesType === "prpr-custom") this.updatePrprCustomRespack();
        },
        async loadFromRedirect(searchParams) {
            ploading.l(this.$t("loadChart.loading"), "loadChartfr");

            try {
                let chartData;
                if (searchParams.get("type") === "custom") {
                    chartData = {
                        id: searchParams.get("name"),
                        // song: searchParams.get("name"),
                        charter: searchParams.get("charter"),
                        chart: searchParams.get("chart"),
                        level: searchParams.get("level"),
                        difficulty: searchParams.get("difficulty"),
                        ranked: false,
                        isFromURL: true,
                        song: {
                            id: searchParams.get("name"),
                            composer: searchParams.get("composer"),
                            name: searchParams.get("name"),
                            song: searchParams.get("song"),
                            edition: "From URL",
                            illustration: searchParams.get("illustration"),
                            illustrator: searchParams.get("illustrator"),
                            bpm: "0",
                            duration: "00:00:00",
                            preview_start: "00:00:00",
                            isFromURL: true,
                        },
                    };
                    if (searchParams.get("mode") === "preview")
                        this.playConfig = {
                            mode: "preview",
                            practiseMode: true,
                        };
                    if (
                        searchParams.get("flag") &&
                        searchParams.get("flag").includes("adjustOffset")
                    )
                        this.playConfig.adjustOffset = true;
                    this._pzFollowAspectRatio = true;
                } else if (searchParams.get("type") === "selfUploadChart") {
                    if (searchParams.get("mode") === "preview")
                        this.playConfig = {
                            mode: "preview",
                            practiseMode: true,
                        };
                    if (
                        searchParams.get("flag") &&
                        searchParams.get("flag").includes("adjustOffset")
                    )
                        this.playConfig.adjustOffset = true;

                    let resources = [];
                    if (searchParams.get("illustration"))
                        resources.push(searchParams.get("illustration") + "?nocacahe=nocache");
                    if (searchParams.get("song"))
                        resources.push(searchParams.get("song") + "?nocacahe=nocache");
                    if (searchParams.get("assets")) {
                        try {
                            const assets = searchParams.get("assets").split(",");
                            for (const asset of assets) resources.push(asset + "?nocacahe=nocache");
                        } catch {}
                    }

                    // 清 加载完的东西
                    shared.game.clearStat();

                    const resNum = resources.length;
                    uploader.reset(resNum);
                    if (resNum)
                        Promise.all(
                            resources.map(e => {
                                return fetch(e).then(async e => {
                                    return e;
                                });
                            })
                        )
                            .then(async responses => {
                                let loaded = 0;
                                for (const response of responses) {
                                    loaded++;
                                    ploading.l(
                                        this.$t("loadChart.info", { loaded, resNum }),
                                        "loadSong"
                                    );
                                    uploader.fireLoad(
                                        { name: response.url },
                                        await response.arrayBuffer()
                                    );
                                }
                            })
                            .catch(e => {
                                msgHandler.sendMessage(this.$t("loadChart.failed"), "error"),
                                    ploading.r("loadSong");
                            });
                    else ploading.r("loadChartfr");

                    return this.$router.push({
                        path: "/chartUpload",
                        query: {
                            name: searchParams.get("name"),
                            composer: searchParams.get("composer"),
                            charter: this.cleanStr(searchParams.get("charter")),
                            illustrator: searchParams.get("illustrator"),
                            level: searchParams.get("level"),
                            difficulty: searchParams.get("difficulty"),
                            then: "playing",
                        },
                    });
                }
                ploading.l(this.$t("loadChart.loading"), "loadChart");
                this.loadChart(chartData.song, chartData, () => {
                    ploading.r("loadChartfr");
                    ploading.r("playChart");
                    ploading.r("loadChart");
                    msgHandler.info(this.$t("simphi.askActionForSound")).then(() => {
                        shared.game.ptmain.$router.push({
                            path: "/playing",
                            query: { auto: 1 },
                        });
                    });
                });
            } catch (err) {
                msgHandler.sendMessage(this.$t("loadChart.failed"), "error");
                console.error(err);
                ploading.r("loadChartfr");
            }
        },
        async restoreServerSession() {
            // 自建服务端会话恢复：刷新 token 并重新拉取 /me。离线时保留本地会话信息
            // （下次联网重试），未登录则保持游客模式。
            const user = await serverApi.restoreSession();
            if (user) this.applyServerUser(user);
            else if (serverApi.currentUser()) this.applyServerUser(serverApi.currentUser());
        },
        applyServerUser(user) {
            if (!user) return;
            this.noAccountMode = false;
            this.gameConfig.ptBestRecords = {};
            this.gameConfig.localRks = 0;
            this.gameConfig.account.userBasicInfo = {
                userName: user.nickname || user.username,
                id: user.id,
                role: user.is_admin ? "admin" : "player",
                experience: 0,
                rks: 0,
                avatar: null,
                dateLastLoggedIn: Date.now(),
                isPTDeveloper: false,
            };
            recordMgr.reset(this.gameConfig.account.userBasicInfo);
            void ptServer.refreshLocalPlayerRks().catch(console.error);
            void ptServer.syncPending();
        },
        serverLogout() {
            serverApi.logout();
            this.gameConfig.account = {
                tokenInfo: null,
                userBasicInfo: null,
                defaultConfig: null,
            };
            this.noAccountMode = true;
            this.gameConfig.ptBestRecords = {};
            void ptServer.activateLocalRecords().catch(console.error);
        },
        async clearLocalData(t) {
            // 原谱面管理页的「高级清理」，现居设置页。
            // 模块模式先挡住：里面的 caches/indexedDB 在 opaque 来源不可用，location.reload()
            // 更会把整个容器文档（blob URL 已回收）刷成空白，属于致命路径。
            if (moduleMode) {
                shared.game.msgHandler.sendMessage("模块模式暂不支持清理本机数据", "error");
                return;
            }
            const ok = await msgHandler.confirm(
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
                                msgHandler.success(this.$t("chartManage.clearOk"));
                            });
                        });
                    });
                    break;
            }
        },
        update() {
            // 模块模式版本由宿主分发：这里跳转/刷新只会把容器（blob 文档）弄丢。
            if (moduleMode) return;
            caches.delete("PTv0-Main").then(() => {
                const url = `/#${
                    searchParams ? `/updateAndPlayChart?${searchParams.toString()}` : "update"
                }`;
                fetch(url, {
                    headers: {
                        Pragma: "no-cache",
                        Expires: "-1",
                        "Cache-Control": "no-cache",
                    },
                }).then(() => {
                    window.location.href = url;
                    window.location.reload();
                });
            });
        },
        cleanStr(i) {
            return (
                i &&
                i.replace(
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
                )
            );
        },
        chartLoadedCB() {
            if (this.$route.path === "/chartUpload") {
                shared.game.adjustInfo();
                $("uploader").classList.remove("disabled");
                ploading.r("loadChart");
                shared.game.userChartUploaded();
                this.lastLoad = hook.chartData.chartsMD5.get(hook.selectchart.value);
                return;
            }

            const chartInfo = JSON.parse(sessionStorage.getItem("loadedChart"));
            const songInfo = JSON.parse(sessionStorage.getItem("chartDetailsData"));
            this.lastLoad = chartInfo.id;
            hook.chartInfo.name = songInfo.name;
            hook.chartInfo.illustrator = songInfo.illustrator;
            hook.chartInfo.composer = songInfo.composer;
            hook.chartInfo.charter = this.cleanStr(chartInfo.charter);
            hook.chartInfo.difficultyString = `${chartInfo.level} Lv.${
                typeof chartInfo.difficulty === "string"
                    ? chartInfo.difficulty
                    : chartInfo.difficulty === 0
                      ? "?"
                      : Math.floor(chartInfo.difficulty).toString()
            }`;
            let saved;
            saved = localStorage.getItem("PTSavedOffsets");
            if (saved) {
                saved = JSON.parse(saved);
                if (saved[chartInfo.id]) this.chartOffsetSurface = saved[chartInfo.id];
                else this.chartOffsetSurface = 0;
            }
            this.externalHooks.chartLoaded && this.externalHooks.chartLoaded(songInfo, chartInfo);
        },
        loadChart(songInfo, chartInfo, callback) {
            if (!this.afterSimphiLoadedHook) {
                ploading.l(this.$t("loadChart.simphiLoading"), "simphiloading");
                return (this.afterSimphiLoadedHook = () =>
                    this.loadChart(songInfo, chartInfo, callback));
            }
            const speedInfo = {
                val: $("select-speed").selectedIndex,
                disp: $("select-speed").selectedOptions[0].value,
            };
            recordMgr.chartInfo = {
                songData: songInfo,
                chartData: chartInfo,
                speedInfo,
            };
            let resources = [songInfo.illustration, songInfo.song, chartInfo.chart];
            if (chartInfo.assets) resources.push(chartInfo.assets);
            else if (chartInfo.assetsNum) {
                for (let i = 0; i < chartInfo.assetsNum; i++) {
                    resources.push(`/PTVirtual/assets/${chartInfo.id}/${i}`);
                }
            }
            sessionStorage.setItem("loadedChart", JSON.stringify(chartInfo));
            sessionStorage.setItem("chartDetailsData", JSON.stringify(songInfo));

            let customRes = chartInfo["customRes"];
            if (!customRes && chartInfo.origin && chartInfo.origin.customRes)
                customRes = chartInfo.origin.customRes;

            if (customRes) shared.game.simphi.reloadRes(customRes);
            else shared.game.simphi.reloadRes();

            this.externalHooks.chartLoaded = callback;
            if (this.lastLoad === chartInfo.id) {
                this.chartLoadedCB();
                return;
            }
            // 清 加载完的东西
            shared.game.clearStat();

            //if (this.isMulti) this.chartLoaded = false; // 多人模式：标记谱面未加载
            const resNum = resources.length;
            // console.log(resNum);
            uploader.reset(resNum);
            // window.debug = { chartInfo, songInfo }
            ptdb.chart.getChartsFiles
                .meta(chartInfo, songInfo)
                .then(async blobs => {
                    let loaded = 0;
                    const responses = {
                        song: new Response(blobs[0]),
                        illustration: new Response(blobs[1]),
                        chart: new Response(blobs[2]),
                    };
                    for (const i in responses) {
                        loaded++;
                        ploading.l(this.$t("loadChart.info", { loaded, resNum }), "loadChart");
                        uploader.fireLoad(
                            { name: `${chartInfo.id}/${i}` },
                            await responses[i].arrayBuffer()
                        );
                    }
                    if (blobs[3]) {
                        for (const i of blobs[3]) {
                            loaded++;
                            ploading.l(this.$t("loadChart.info", { loaded, resNum }), "loadChart");
                            uploader.fireLoad(
                                { name: i.name },
                                await new Response(i.file).arrayBuffer()
                            );
                        }
                    }
                })
                .catch(e => {
                    msgHandler.sendMessage(this.$t("loadChart.failed"), "error"),
                        ploading.r("loadChart");
                    console.error(e);
                });
        },
    },
});

const graphicHandler = {
    wpHookList: [],
    resultHookList: [],
    whilePlayingHook: function (ctx, ctxos, lineScale) {
        for (let i = 0; i < this.wpHookList.length; i++) {
            this.wpHookList[i](ctx, ctxos, lineScale);
        }
    },
    resultHook: function (ctx, ctxos) {
        for (let i = 0; i < this.resultHookList.length; i++) {
            this.resultHookList[i](ctx, ctxos);
        }
    },
    register: function (hookType, hookContent) {
        if (hookType == "whilePlayingHook") {
            this.wpHookList.push(hookContent);
        } else if (hookType == "resultHook") {
            this.resultHookList.push(hookContent);
        }
    },
};

ptAppInstance.use(router);
ptAppInstance.use(i18n);

const multiPlayerInstance = createApp(multiplayerinst);
multiPlayerInstance.use(i18n);
multiPlayerInstance.mount("#multiplayer");

const ptmain = ptAppInstance.mount("#app");

document.getElementById("app").style.display = "block";

//全局暴露
shared.game.ptmain = ptmain;
// 会话就绪后统一同步一次 rks 并清空待上传成绩（挂载早期的写回会被守卫跳过）
void ptServer.activateLocalRecords().catch(console.error);
if (ptServer.available()) void ptServer.syncPending();

/** 待上传队列非空时才值得重试（避免每次回到前台都白跑一趟网关）。 */
function flushPendingScores() {
    if (!ptServer.available()) return;
    if (!ptmain.gameConfig.pendingScoreCount) return;
    void ptServer.syncPending();
}

// 离线成绩同步：网络恢复时清空待上传队列。容器是沙箱 iframe，online 事件不保证
// 一定发到这一层，所以回到前台/重新聚焦时也补一次——热点 5 分钟踢人之后，
// 玩家再拿起平板就是最常见的补传时机。
window.addEventListener("online", flushPendingScores);
window.addEventListener("focus", flushPendingScores);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flushPendingScores();
});
// Retry server outages even when the browser never emits another online event.
setInterval(() => {
    if (!document.hidden && router.currentRoute.value.path !== "/playing") flushPendingScores();
}, 30000);
shared.game.msgHandler = msgHandler;
shared.game.graphicHandler = graphicHandler;
shared.game.recordMgr = recordMgr;
shared.game.replayMgr = replayMgr;
shared.game.init = true;
shared.game.i18n = i18n.global;
shared.game.afterShow = [];
shared.game.antiAddictionCallback = canplay => (ptmain.canplay = canplay);
self.shared = shared;

const $ = q => document.getElementById(q);
const stage = $("stage");
