import { getBackend } from "./backend";
import { GameConfig, defaultGameConfig } from "@utils/types/GameConfig";

/**
 * 保存用户设置
 * @param {Object} gameConfig - ptAppInstance中的gameConfig
 */
export function saveGameConfig(gameConfig: GameConfig | Object, id: string = "gameConfig") {
    if (!gameConfig) gameConfig = id === "gameConfig" ? defaultGameConfig : {};
    // 只存可序列化的部分（模块模式下值要过桥面 JSON 通道，Blob/函数一律剥掉）
    gameConfig = JSON.parse(JSON.stringify(gameConfig));
    return getBackend().putUserData(id, gameConfig);
}

/**
 * 读取用户设置
 */
export function getGameConfig(
    id: string = "gameConfig",
    defaultConfig?: Object
): Promise<Object | null> {
    return getBackend()
        .getUserData(id)
        .then(async result => {
            if (result !== null && result !== undefined) return result;
            if (defaultConfig) {
                await saveGameConfig(defaultConfig, id);
                return defaultConfig;
            }
            return Promise.reject(new Error("Not Found"));
        });
}

/**
 * 原子 read-merge-write 一行用户数据：mutator(当前值|null) → 新值（undefined 放弃写入）。
 * 模块模式下 expectRev CAS，冲突即重读重合并；IDB 同一事务内完成。
 */
export function updateUserData(id: string, mutator: (cur: any) => any): Promise<any> {
    return getBackend().updateUserData(id, mutator);
}

/**
 * 多行用户数据在同一个原子批里提交（模块模式同一个 api.records.batch）。
 * 用于「本地成绩 + pendingPtUploads」这类必须同生共死的写入，防止互相覆盖。
 */
export function updateUserDataBatch(
    items: { id: string; mutator: (cur: any) => any }[]
): Promise<any[]> {
    return getBackend().updateUserDataBatch(items);
}

interface ParsedGameConfig {
    gameConfig: GameConfig;
    ptBestRecords: Object | null;
}
/**
 * Parse gameConfig(废)
 */
function parseGameConfig(gameConfig: GameConfig): ParsedGameConfig {
    const parsed: ParsedGameConfig = {
        gameConfig: {
            account: {
                tokenInfo: null,
                userBasicInfo: null,
                defaultConfig: null,
            },
            showPoint: false,
            showTimer: false,
            JITSOpen: false,
            defaultRankMethod: "",
            denyChartSettings: false,
            showTransition: false,
            feedback: false,
            imageBlur: false,
            highLight: false,
            showCE2: false,
            lineColor: false,
            showAcc: false,
            showStat: false,
            lowRes: false,
            noUIBlur: false,
            enhanceRankVis: false,
            lockOri: false,
            aspectRatio: "",
            noteScale: "",
            backgroundDim: "",
            volume: "",
            inputOffset: "",
            notifyFinished: false,
            isMaxFrame: false,
            maxFrame: 0,
            isForcedMaxFrame: false,
            enableVP: false,
            enableFR: false,
            autoDelay: false,
            usekwlevelOverbgm: false,
            resourcesType: "",
            enableFilter: false,
            filterInput: "",
            customResourceLink: "",
            autoplay: false,
            competeMode: false,
            fullScreenJudge: false,
            stopWhenNoLife: false,
            useSeparateOffscreenCanvas: false,
            reviewWhenResume: false,
        },
        ptBestRecords: null,
    };
    for (const i in gameConfig) {
        switch (i) {
            case "ptBestRecords":
                parsed.ptBestRecords = gameConfig.ptBestRecords || {};
                break;
            default:
                parsed.gameConfig[i] = gameConfig[i];
        }
    }
    return parsed;
}
