import { saveGameConfig, getGameConfig, updateUserData, updateUserDataBatch } from "./userData";
export const gameConfig = {
    get: getGameConfig,
    save: saveGameConfig,
    // 原子 read-merge-write（CAS 合并）；updateBatch 把多行放进同一个原子批提交，
    // 用于「本地成绩 + pendingPtUploads」必须同生共死的写入。
    update: updateUserData,
    updateBatch: updateUserDataBatch,
};

import { fetch as dbfetch } from "./fetch";
export const fetch = dbfetch;

import * as charts from "./charts";
export const chart = {
    chart: {
        download: charts.downloadChart,
        save: charts.saveCachedChart,
        get: charts.getCachedChart,
        delete: charts.deleteCachedChart,
    },
    song: {
        download: charts.downloadSong,
        save: charts.saveCachedSong,
        get: charts.getCachedSong,
        delete: charts.deleteCachedSong,
        fetch: charts.getSongFile,
        has: charts.haveSong,
    },
    illustration: {
        getAsB64: charts.getSongsIllustrationAsB64,
    },
    getChartsFiles: {
        id: charts.getChartsFiles,
        meta: charts.getChartsFilesByMeta,
    },
    renderApi: charts.renderPZApi,
    renderCacheList: charts.renderCacheList,
    blobs2responses: charts.blobs2responses,
    checkLocalChart: charts.checkLocalChart,
};

import { saveSkin, getAllSkins, getSkin, deleteSkin } from "./skin";
const skin = {
    save: saveSkin,
    getAll: getAllSkins,
    get: getSkin,
    delete: deleteSkin,
};

// import { openDB } from './openDB';

export default { gameConfig, fetch, chart, skin /* , openDB */ };
