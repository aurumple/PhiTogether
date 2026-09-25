import ChartSelectPageComponent from "../pages/chartselect.vue";
import StartPageComponent from "../pages/startpage.vue";
import PlayingPageComponent from "../pages/playing.vue";
import LoginPageComponent from "../pages/login.vue";
import CalibratePageComponent from "../pages/calibrate.vue";
import AboutPageComponent from "../pages/aboutpage.vue";
import UserChartUploadComponent from "../pages/userChartUpload.vue";
import UserChartEditComponent from "../pages/userChartEdit.vue";
import ReplayPageComponent from "../pages/replayPage.vue";
import ChangeLogsComponent from "../pages/changelogs.vue";
import LoadingPageComponent from "../pages/loadingPage.vue";
import PtLeaderboardComponent from "../pages/ptLeaderboard.vue";
import multiIndexPageComponent from "../pages/multiIndex.vue";

const EmptyPageComponent = { name: "Empty", template: "<span></span>" };

const routes = [
    { path: "/", redirect: "/startPage" },
    { path: "/startPage", component: StartPageComponent },
    { path: "/chartSelect", component: ChartSelectPageComponent },
    { path: "/playing", component: PlayingPageComponent },
    { path: "/login", component: LoginPageComponent },
    { path: "/calibrate", component: CalibratePageComponent },
    // 谱面管理页已并入单人游戏（章节选曲），旧书签兜底
    { path: "/chartManage", redirect: "/chartSelect" },
    { path: "/cacheManage", redirect: "/chartSelect" },
    { path: "/aboutPage", component: AboutPageComponent },
    { path: "/chartUpload", component: UserChartUploadComponent },
    { path: "/chartEdit", component: UserChartEditComponent },
    // 社区排行榜页面已移除，保留空壳避免旧链接报错
    { path: "/playerB20", component: EmptyPageComponent },
    { path: "/pzRankSingle", component: EmptyPageComponent },
    { path: "/replayPage", component: ReplayPageComponent },
    { path: "/changelogs", component: ChangeLogsComponent },
    { path: "/ptLeaderboard", component: PtLeaderboardComponent },
    { path: "/loading", component: LoadingPageComponent },
    { path: "/multiIndex", component: multiIndexPageComponent },
    // 虚拟页面
    { path: "/multipanel", component: EmptyPageComponent },
    { path: "/settings", component: EmptyPageComponent },
];

export default routes;
