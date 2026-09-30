import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { createFakeApi } from "./check-ptdb-fakeapi.mjs";
import { createPlatformBackend } from "../src/components/ptdb/platformBackend.js";
import {
    addRun,
    acknowledge,
    playerRks,
    estimateRank,
    bestRows,
    rankKey,
} from "../src/utils/offlineRecords.mjs";

const backend = createPlatformBackend(createFakeApi());
let user = { id: 1, username: "one" };
let online = false;
let beforeUpload = null;
let moduleMode = false;
const uploads = [];
const shared = { game: { ptmain: { gameConfig: { account: { userBasicInfo: {} } } } } };
const chartBoards = new Map();
let leaderboardRows = [];
globalThis.__offlineTest = {
    shared,
    ptdb: {
        gameConfig: {
            get: async key => {
                const value = await backend.getUserData(key);
                if (value == null) throw new Error("Not found");
                return value;
            },
            update: backend.updateUserData,
            updateBatch: backend.updateUserDataBatch,
        },
        chart: { renderApi: async () => ({ results: [] }) },
    },
    currentUser: () => user,
    isLoggedIn: () => !!user,
    moduleApi: () => (moduleMode ? globalThis.window.__onetapPlatform.api : null),
    moduleProfile: async () => (user ? { id: user.id, displayName: user.username } : null),
    authFetch: async (url, options) => {
        if (!online) throw new Error("Offline");
        const owner = user?.id;
        if (options?.method === "POST") {
            const rec = JSON.parse(options.body);
            if (beforeUpload) {
                const fn = beforeUpload;
                beforeUpload = null;
                await fn();
            }
            uploads.push({ owner, rec });
            return { ok: true };
        }
        return {
            ok: true,
            json: async () => ({
                records: [
                    {
                        chart_id: "remote",
                        song_name: "remote",
                        difficulty: "IN",
                        rating: 15,
                        score: 950000,
                        acc: 95,
                        best_acc: 99,
                        is_fc: 0,
                    },
                ],
            }),
        };
    },
};
const source = (await readFile(new URL("../src/utils/ptServer.ts", import.meta.url), "utf8"))
    .replace(/import ptdb[^;]+;/, "const { ptdb } = globalThis.__offlineTest;")
    .replace(/import shared[^;]+;/, "const { shared } = globalThis.__offlineTest;")
    .replace(
        /import \{ authFetch[^;]+;/,
        "const { authFetch, currentUser, isLoggedIn, moduleApi, moduleProfile } = globalThis.__offlineTest;"
    )
    .replace(
        '"./offlineRecords.mjs"',
        JSON.stringify(new URL("../src/utils/offlineRecords.mjs", import.meta.url).href)
    );
const code = (await transformWithEsbuild(source, "ptServer.ts", { loader: "ts" })).code;
/** 每次调用得到一份全新的模块实例，共享同一个假后端（模拟一次页面重载）。 */
const newClient = async () =>
    await import(
        "data:text/javascript;base64," + Buffer.from(code).toString("base64") + "#" + Math.random()
    );
const client = await newClient();
const run = {
    chart_id: "a",
    song_name: "A",
    difficulty: "IN",
    rating: 10,
    score: 990000,
    acc: 95,
    is_fc: false,
    max_acc: 95,
    run_at: "2026-09-27T00:00:00Z",
};

await client.queueRecord(run);
assert.equal(await client.flushPending(), false);
assert.equal(shared.game.ptmain.gameConfig.localRks, 9.025);
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 1);
// Reload the displayed state from durable storage, without any network.
shared.game.ptmain.gameConfig.ptBestRecords = {};
await client.activateLocalRecords();
assert.equal(shared.game.ptmain.gameConfig.ptBestRecords.a[0], 990000);

// Higher accuracy on a lower scoring run must change RKS without replacing the best run.
await client.queueRecord({ ...run, score: 980000, acc: 99, max_acc: 99 });
assert.equal(shared.game.ptmain.gameConfig.localRks, 9.801);
assert.equal(shared.game.ptmain.gameConfig.ptBestRecords.a[0], 990000);

user = { id: 2, username: "two" };
online = true;
await client.activateLocalRecords();
assert.deepEqual(shared.game.ptmain.gameConfig.ptBestRecords, {});
await client.flushPending();
assert.equal(uploads.length, 0, "account two must not upload account one's outbox");
user = null;
await client.queueRecord({ ...run, chart_id: "guest" });
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 0);
user = { id: 1, username: "one" };

// New result arriving while an older request is in flight survives acknowledgement.
beforeUpload = () =>
    client.queueRecord({ ...run, score: 1000000, acc: 100, max_acc: 100, is_fc: true });
await client.flushPending();
assert.equal(uploads.length, 2);
assert.equal(uploads[1].rec.score, 1000000);
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 0);
assert.ok(uploads.every(u => u.owner === 1 && u.rec.chart_id !== "guest"));
await client.refreshLocalPlayerRks();
assert.equal(shared.game.ptmain.gameConfig.localRks, 12.3508);
assert.equal(shared.game.ptmain.gameConfig.scoreBaselineKnown, true);

// Account changes during an upload stop further submissions from the old queue.
await client.queueRecord({ ...run, chart_id: "b" });
await client.queueRecord({ ...run, chart_id: "c" });
beforeUpload = async () => {
    user = { id: 2, username: "two" };
};
await client.flushPending();
assert.equal(uploads.at(-1).owner, 1);
assert.equal((await backend.getUserData("ptRecords:v2:user:1")).pending.c.chart_id, "c");

const state = addRun({}, run, true);
assert.deepEqual(
    acknowledge(state, { ...run, score: 1 }).pending,
    state.pending,
    "nonidentical acknowledgement is conservative"
);
const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [i, { rating: i + 1, acc: 100 }])
);
assert.equal(playerRks(many), 25.5);

// The same durable flow also works through the module gateway, including legacy queue migration.
await backend.putUserData("pendingPtUploads", { legacy: { ...run, chart_id: "legacy" } });
moduleMode = true;
online = false;
const moduleUploads = [];
globalThis.window = {
    __onetapPlatform: {
        api: {
            game: {
                call: async (operation, input) => {
                    if (!online) throw new Error("gateway offline");
                    if (operation === "game.records") {
                        moduleUploads.push(input);
                        return {};
                    }
                    if (operation === "game.me") return { records: [], rks: 0, limit: 30 };
                    if (operation === "game.chart-leaderboard")
                        return chartBoards.get(input.chartId) || { entries: [], me: null };
                    if (operation === "game.leaderboard")
                        return { items: leaderboardRows, myRank: 1, myRks: 12.3 };
                    throw new Error(`unexpected operation: ${operation}`);
                },
            },
        },
    },
};
// 断网冷启动的模块也必须把成绩排进待上传队列（旧实现按 module-guest 分区，永远传不上去）。
assert.equal(client.available(), true, "模块模式断网仍视为已绑定账号");
assert.equal(client.recordOwner(), "module", "模块模式的 owner 不随网络状态变化");
await client.queueRecord({ ...run, chart_id: "module-chart" });
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 2);
assert.equal(await client.flushPending(), false);
online = true;
await client.syncPending();
assert.deepEqual(moduleUploads.map(r => r.chartId).sort(), ["legacy", "module-chart"]);
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 0);
assert.deepEqual(await backend.getUserData("pendingPtUploads"), {});
// 网关对 isFc 只接受 JSON 布尔/0/1；客户端必须发真布尔（否则整条上传被判数值无效）。
assert.ok(
    moduleUploads.every(r => typeof r.isFc === "boolean"),
    "成绩上传的 isFc 必须是布尔"
);
// 身份记忆：宿主身份取不到时（断网冷启动）玩家卡不该退回 GUEST
assert.equal((await backend.getUserData("ptIdentity:v1:module")).name, "two");
user = null;
const coldClient = await newClient();
await coldClient.activateLocalRecords();
assert.equal(shared.game.ptmain.noAccountMode, false);
assert.equal(shared.game.ptmain.gameConfig.account.userBasicInfo.userName, "two");
user = { id: 2, username: "two" };

// ===== 榜单快照、预估名次与本地 Best30（离线主路径） =====
const top3 = [
    {
        rank: 1,
        user_id: 11,
        name: "甲",
        score: 999000,
        acc: 99.5,
        is_fc: true,
        rks: 15.2,
        is_me: false,
    },
    {
        rank: 2,
        user_id: 22,
        name: "乙",
        score: 980000,
        acc: 98,
        is_fc: false,
        rks: 14.8,
        is_me: false,
    },
    { rank: 3, user_id: 2, name: "我", score: 900000, acc: 95, is_fc: false, rks: 13, is_me: true },
];
const full10 = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    user_id: 100 + i,
    name: `p${i}`,
    score: 990000 - i * 1000,
    acc: 99 - i * 0.5,
    is_fc: false,
    rks: 15,
    is_me: false,
}));
chartBoards.set("a", { chart_id: "a", entries: top3, me: top3[2] });
chartBoards.set("dense", { chart_id: "dense", entries: full10, me: null });

// 开打前抓快照：联网时拿到实时数据并落到本地
const prefetched = await client.prefetchChartBoard("a");
assert.equal(prefetched.stale, false);
assert.equal((await backend.getUserData("ptBoards:v1:module")).boards.a.entries.length, 3);
await client.prefetchChartBoard("dense");

// 打完歌时已经断网：预估名次必须纯本地、同步地成立
online = false;
const precise = client.estimateChartRank("a", { score: 985000, acc: 98.5, is_fc: false });
assert.equal(precise.rank, 2, "只有甲排在我前面");
assert.equal(precise.exact, true, "不到 10 行的榜单就是全榜");
assert.equal(precise.outside, false);
// 我自己在快照里的旧成绩不挡我：1000000 应该直接登顶
assert.equal(client.estimateChartRank("a", { score: 1000000, acc: 100, is_fc: true }).rank, 1);
// 满 10 行的榜：打不过任何人是「10 名以外」，不编具体名次
const outside = client.estimateChartRank("dense", { score: 500000, acc: 50, is_fc: false });
assert.equal(outside.outside, true);
assert.equal(outside.rank, null);
// 打得过第 10 名就是确定名次
assert.equal(client.estimateChartRank("dense", { score: 985000, acc: 98, is_fc: false }).rank, 6);
// 没有快照的谱面绝不猜名次
assert.equal(client.estimateChartRank("unknown", { score: 990000, acc: 99, is_fc: false }), null);

// 页面重载：新实例只能靠本地快照（离线）与本地成绩
const reloaded = await newClient();
assert.equal(reloaded.available(), true);
const offlineBoard = await reloaded.loadChartBoard("a");
assert.equal(offlineBoard.stale, true, "离线时读回本地快照并标注 stale");
assert.equal(offlineBoard.entries.length, 3);
assert.equal(reloaded.cachedChartBoard("a").entries[0].name, "甲");
assert.equal(reloaded.estimateChartRank("a", { score: 985000, acc: 98.5, is_fc: false }).rank, 2);
// 冷启动时本地成绩与 Best30 立即可用（不需要网络）
assert.equal(shared.game.ptmain.gameConfig.ptBestRecords["module-chart"][0], 990000);
const localTop = reloaded.localBest30(30);
assert.equal(localTop.records.length, 2);
assert.equal(localTop.rks, 9.025);
assert.ok(localTop.records.every(row => row.chart_rks > 0));

// 全站榜：联网存快照，离线读快照
leaderboardRows = [
    { rank: 1, user_id: 11, name: "甲", rks: 15.2, plays: 30 },
    { rank: 2, user_id: 22, name: "乙", rks: 14.8, plays: 12 },
];
online = true;
const live = await reloaded.leaderboardSnapshot();
assert.equal(live.stale, false);
assert.equal(live.entries.length, 2);
online = false;
const cachedBoard = await (await newClient()).leaderboardSnapshot();
assert.equal(cachedBoard.stale, true);
assert.equal(cachedBoard.entries[1].name, "乙");
assert.equal(cachedBoard.my_rank, 1);

// 纯函数：名次关键字与 Best30 排序
assert.deepEqual(rankKey({ score: 1, acc: 2, is_fc: true }), [1, 2, 1]);
assert.equal(estimateRank(top3, { score: 980000, acc: 98, is_fc: false }).rank, 2, "同分并列");
assert.deepEqual(
    bestRows(
        { x: { chart_id: "x", rating: 10, acc: 100 }, y: { chart_id: "y", rating: 20, acc: 50 } },
        1
    ).map(r => r.chart_id),
    ["x"]
);
delete globalThis.window;
delete globalThis.__offlineTest;
console.log(
    "Offline records: persistence, account isolation, guest separation, concurrent retry, RKS, " +
        "module ownership, board snapshots, rank estimation and local Best30 passed"
);
