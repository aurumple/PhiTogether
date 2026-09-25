// 自建服务端模式下的账号信息（替代原 PhiZone PZUser* 类型）。
// 字段与 global.js applyServerUser 填充的对象保持一致。
export interface PTUserBasicInfo {
    userName: string;
    id: string | number;
    role: string;
    experience: number;
    rks: number;
    avatar: string | null;
    dateLastLoggedIn: number;
    isPTDeveloper: boolean;
}

export interface GameConfigAccount {
    tokenInfo: unknown;
    userBasicInfo: PTUserBasicInfo | null;
    defaultConfig: unknown;
}

export interface GameConfig {
    account: GameConfigAccount;
    ptBestRecords?: Object;
    showPoint: boolean;
    showTimer: boolean;
    JITSOpen: boolean;
    defaultRankMethod: string;
    denyChartSettings: boolean;
    showTransition: boolean;
    feedback: boolean;
    imageBlur: boolean;
    highLight: boolean;
    showCE2: boolean;
    lineColor: boolean;
    showAcc: boolean;
    showStat: boolean;
    lowRes: boolean;
    noUIBlur: boolean;
    enhanceRankVis: boolean;
    lockOri: boolean;
    aspectRatio: string;
    noteScale: string;
    backgroundDim: string;
    volume: string;
    inputOffset: string;
    notifyFinished: boolean;
    isMaxFrame: boolean;
    maxFrame: number;
    isForcedMaxFrame: boolean;
    enableVP: boolean;
    enableFR: boolean;
    autoDelay: boolean;
    usekwlevelOverbgm: boolean;
    resourcesType: string;
    enableFilter: boolean;
    filterInput: string;
    customResourceLink: string;
    autoplay: boolean;
    competeMode: boolean;
    fullScreenJudge: boolean;
    stopWhenNoLife: boolean;
    useSeparateOffscreenCanvas: boolean;
    reviewWhenResume: boolean;
}

export const defaultGameConfig = {
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
    imageBlur: true,
    highLight: true,
    showCE2: false,
    lineColor: true,
    showAcc: true,
    showStat: false,
    lowRes: false,
    noUIBlur: false,
    enhanceRankVis: false,
    lockOri: true,
    aspectRatio: "1.5",
    noteScale: "1.15",
    backgroundDim: "0.6",
    volume: "2",
    inputOffset: "0",
    notifyFinished: false,
    isMaxFrame: false,
    maxFrame: 60,
    isForcedMaxFrame: false,
    enableVP: false,
    enableFR: false,
    autoDelay: true,
    usekwlevelOverbgm: false,
    resourcesType: "together-pack-1",
    enableFilter: false,
    filterInput: "",
    customResourceLink: "",
    autoplay: false,
    competeMode: false,
    fullScreenJudge: false,
    stopWhenNoLife: false,
    useSeparateOffscreenCanvas: false,
    reviewWhenResume: false,
    lastVersion: "lastVer",
};
