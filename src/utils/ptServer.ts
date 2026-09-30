// Self-hosted leaderboard bridge: score upload, rks sync and the offline
// upload queue. Mirrors the semantics of the community-era record flow, but
// targets the local server (see server/routers/game.py) instead of PhiZone.
//
// 离线优先是这份文件的中心思想：热点会在关联 5 分钟后把设备踢下线（deploy 的
// ap-watchdog），所以「打完歌的那一刻」大概率已经没有网络。于是：
//   - 成绩先落本地事务（records + pending 同一批），再尽力上传；
//   - 单谱榜在**开打前**抓一份快照存本地，结算时用它算预估名次；
//   - 全站榜缓存最后一次成功结果，离线时照常展示并标注缓存时刻；
//   - 我的 Best30 完全由本地成绩算出，任何时候都有内容。
import ptdb from "@components/ptdb";
import shared from "@utils/js/shared";
import {
    mergeRecord,
    playerRks,
    addRun,
    acknowledge,
    estimateRank,
    bestRows,
    pendingCount,
} from "./offlineRecords.mjs";
import { authFetch, currentUser, isLoggedIn, moduleApi, moduleProfile } from "./serverApi";

export interface PtRecordInput {
    chart_id: string;
    song_name: string;
    difficulty: string;
    rating: number;
    score: number;
    /** Accuracy (%) of the best run — the run maximizing (score, acc, is_fc). */
    acc: number;
    is_fc: boolean;
    /** Highest accuracy (%) ever achieved on the chart; drives rks. */
    max_acc?: number;
    /** When the best run happened (ISO string). */
    run_at?: string;
}

export interface ChartLeaderboardEntry {
    rank: number;
    user_id: number;
    name: string;
    score: number;
    /** Accuracy in percent (0-100). */
    acc: number;
    is_fc: boolean;
    run_at: string | null;
    rks: number;
    is_me: boolean;
}

export interface ChartLeaderboardData {
    chart_id: string;
    entries: ChartLeaderboardEntry[];
    me: ChartLeaderboardEntry | null;
}

export interface PtLeaderboardEntry {
    user_id: number;
    name: string;
    rks: number;
    plays: number;
}

export interface PtLeaderboardData {
    entries: PtLeaderboardEntry[];
    my_rank: number | null;
    my_rks: number;
}

/** 榜单快照：刚取回的实时数据与本地缓存的旧数据用 stale 区分，UI 必须如实标注。 */
export interface ChartBoardSnapshot {
    chart_id: string;
    entries: ChartLeaderboardEntry[];
    me: ChartLeaderboardEntry | null;
    /** 取得时刻（epoch ms）。 */
    at: number;
    /** true = 这份数据来自本地缓存，不是刚刚取回的。 */
    stale: boolean;
}

export interface LeaderboardSnapshot extends PtLeaderboardData {
    at: number;
    stale: boolean;
}

/** 我的单曲名次预估：rank 为 null 表示落在 top 之外（outside）。 */
export interface RankEstimate {
    rank: number | null;
    outside: boolean;
    /** 快照里就含全榜时为 true（曲线少人时名次是确定值）。 */
    exact: boolean;
    at: number;
    stale: boolean;
    /** 快照覆盖的行数，UI 用来解释预估的可信度。 */
    rows: number;
}

export interface PtMyStats {
    records: Array<{
        chart_id: string;
        song_name: string;
        difficulty: string;
        rating: number;
        score: number;
        acc: number;
        is_fc: number;
        chart_rks: number;
        updated_at: string;
        best_acc?: number;
        run_at?: string;
    }>;
    rks: number;
    limit: number;
}

/** Display name of the signed-in player (nickname first). null when logged out. */
export function playerName(): string | null {
    const u = currentUser();
    if (u) return u.nickname || u.username;
    // 离线冷启动的模块：宿主身份暂时取不到，用上次记住的显示名（见 rememberIdentity）。
    return identityMemory && identityMemory.owner === recordOwner() ? identityMemory.name : null;
}

/**
 * True when a self-hosted session is active (guest play uploads nothing).
 *
 * 模块模式恒为 true：身份由宿主绑定，宿主只给已登录且有权运行的账号开容器；
 * `game.profile` 取不到只说明**网络断了**，不代表账号消失。以前这里返回 false，
 * 于是断网时打的成绩落进另一个 owner 分区（module-guest）并且不进待上传队列——
 * 联网后再也看不到、也永远不会上传。这正是「离线成绩不同步」的根因之一。
 */
export function available(): boolean {
    if (moduleApi()) return true;
    return isLoggedIn();
}

/** 模块模式：容器无网络，上传经宿主网关 game.call('game.records')（字段 camelCase）。 */
function platform(): any {
    return (typeof window !== "undefined" && (window as any).__onetapPlatform) || null;
}

/** Upload one best score. Fire-and-forget: failures stay queued locally. */
export async function uploadRecord(rec: PtRecordInput): Promise<boolean> {
    const p = platform();
    if (p && p.api && p.api.game) {
        try {
            // isFc 必须是 JSON 布尔：网关侧曾把布尔当非法数值整条拒收（已修）。
            await p.api.game.call("game.records", {
                chartId: String(rec.chart_id),
                songName: String(rec.song_name || ""),
                difficulty: String(rec.difficulty || ""),
                rating: Number(rec.rating) || 0,
                score: Number(rec.score) || 0,
                acc: Number(rec.acc) || 0,
                isFc: !!rec.is_fc,
                maxAcc: Number(rec.max_acc ?? rec.acc) || 0,
                runAt: rec.run_at || null,
            });
            return true;
        } catch {
            return false;
        }
    }
    try {
        const resp = await authFetch("/api/game/pt/records", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rec),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

export async function fetchLeaderboard(): Promise<PtLeaderboardData | null> {
    try {
        const api = moduleApi();
        if (api && api.game) {
            // 网关返回 {items, myRank, myRks, …}，转独立版 {entries, my_rank, my_rks}。
            const data: any = await api.game.call("game.leaderboard", {});
            if (!data) return null;
            return {
                entries: data.entries || data.items || [],
                my_rank: data.my_rank ?? data.myRank ?? null,
                my_rks: Number(data.my_rks ?? data.myRks ?? 0) || 0,
            };
        }
        const resp = await authFetch("/api/game/pt/leaderboard");
        if (!resp.ok) return null;
        return (await resp.json()) as PtLeaderboardData;
    } catch {
        return null;
    }
}

/** Top-10 ranks of one chart plus my own standing (even outside the top 10). */
export async function fetchChartLeaderboard(chartId: string): Promise<ChartLeaderboardData | null> {
    try {
        const api = moduleApi();
        if (api && api.game) {
            // 网关与独立版同形状（entries + me），直通即可。
            return (await api.game.call("game.chart-leaderboard", {
                chartId,
            })) as ChartLeaderboardData;
        }
        const resp = await authFetch(
            `/api/game/pt/chart-leaderboard?chart_id=${encodeURIComponent(chartId)}`
        );
        if (!resp.ok) return null;
        return (await resp.json()) as ChartLeaderboardData;
    } catch {
        return null;
    }
}

export async function fetchMyStats(): Promise<PtMyStats | null> {
    try {
        const api = moduleApi();
        if (api && api.game) {
            return (await api.game.call("game.me", {})) as PtMyStats;
        }
        const resp = await authFetch("/api/game/pt/me");
        if (!resp.ok) return null;
        return (await resp.json()) as PtMyStats;
    } catch {
        return null;
    }
}

/** The module host isolates its storage; standalone accounts need explicit namespaces. */
export function recordOwner(): string {
    // 模块模式只有一个 owner：宿主绑定账号，离线时也必须是同一个分区。
    if (moduleApi()) return "module";
    const user = currentUser();
    return user ? `user:${user.id}` : "guest";
}
const stateKey = (owner: string) => `ptRecords:v2:${owner}`;
const boardsKey = (owner: string) => `ptBoards:v1:${owner}`;
const leaderboardKey = (owner: string) => `ptLeaderboard:v1:${owner}`;
const identityKey = (owner: string) => `ptIdentity:v1:${owner}`;
const guestMergedKey = "ptMigration:v1:module-guest-merged";
const inflight = new Map<string, Promise<boolean>>();
const migrating = new Map<string, Promise<void>>();
let guestMerged: Promise<void> | null = null;

/** 单谱榜快照最多缓存多少张谱面（每张 ≤10 行；一条 records 值上限 256KiB）。 */
const BOARD_CACHE_LIMIT = 60;

/** 当前 owner 的成绩状态与榜单快照的内存镜像：结算画面要同步读，不能等 IO。 */
let stateMemory: { owner: string; records: any; pending: any; syncedAt?: number } | null = null;
let identityMemory: { owner: string; name: string; id: any; role: string; at: number } | null =
    null;
const boardMemory = new Map<string, ChartBoardSnapshot>();

function memoryKey(owner: string, chartId: string) {
    return `${owner}\u0000${chartId}`;
}

async function readState(owner: string): Promise<any> {
    // 顺序要紧：先认领旧版无账号队列（它只在目标行不存在时才接管），再做 module-guest 救济。
    await migrateLegacy(owner);
    await mergeModuleGuestRecords(owner);
    return await ptdb.gameConfig.get(stateKey(owner)).catch(() => ({ records: {}, pending: {} }));
}

/**
 * 一次性救济：模块模式曾把「断网启动」当成游客，那时的成绩落进 `module-guest`
 * 分区——界面上能看到（玩家卡显示本地 RKS），但 `signedIn=false` 让它从来不进
 * 待上传队列，联网后 owner 换回 `module` 更是彻底看不见。
 *
 * 模块模式只有一个宿主绑定账号，所以这个分区里的成绩必定属于当前账号：并回
 * `module` 并全部入队补传（服务端合并是幂等的，重复提交无害）。独立版的
 * `guest` 分区不动——那里的游客成绩是另一回事。
 */
function mergeModuleGuestRecords(owner: string): Promise<void> {
    if (owner !== "module") return Promise.resolve();
    if (guestMerged) return guestMerged;
    guestMerged = (async () => {
        const marker: any = await ptdb.gameConfig.get(guestMergedKey).catch(() => null);
        if (marker && marker.done) return;
        const guest: any = await ptdb.gameConfig.get(stateKey("module-guest")).catch(() => null);
        const rescued: any = guest?.records || {};
        const count = Object.keys(rescued).length;
        await ptdb.gameConfig.updateBatch([
            {
                id: stateKey("module"),
                mutator: (cur: any) => {
                    const state = cur || { records: {}, pending: {} };
                    const records = { ...state.records };
                    const pending = { ...state.pending };
                    for (const [chartId, rec] of Object.entries(rescued)) {
                        records[chartId] = mergeRecord(records[chartId], rec);
                        pending[chartId] = records[chartId];
                    }
                    return { ...state, records, pending };
                },
            },
            // 并完即清，避免下一轮重复入队；标记行保证只做一次。
            { id: stateKey("module-guest"), mutator: () => null },
            { id: guestMergedKey, mutator: () => ({ done: true, at: Date.now(), count }) },
        ]);
    })().catch(error => {
        guestMerged = null; // 失败（存储满等）下次启动再试，不吞掉成绩
        throw error;
    });
    return guestMerged;
}

/** Preserve old records. Only claim an unscoped upload queue when its stored owner is known. */
function migrateLegacy(owner: string): Promise<void> {
    if (migrating.has(owner)) return migrating.get(owner)!;
    const task = (async () => {
        const existing: any = await ptdb.gameConfig.get(stateKey(owner)).catch(() => null);
        if (existing) return;
        const config: any = await ptdb.gameConfig.get("gameConfig").catch(() => ({}));
        const storedId = config?.account?.userBasicInfo?.id;
        const matches =
            owner === "module" ||
            (owner === "guest" ? !config?.account?.userBasicInfo : owner === `user:${storedId}`);
        const legacyPending: any =
            matches && owner !== "guest"
                ? await ptdb.gameConfig.get("pendingPtUploads").catch(() => ({}))
                : {};
        const records: any = { ...legacyPending };
        if (matches) {
            // Old tuples lack ratings. Resolve them from downloaded chart metadata where possible.
            const charts: any = await ptdb.chart.renderApi().catch(() => ({ results: [] }));
            const meta = new Map<string, any>();
            for (const song of charts.results || [])
                for (const chart of song.charts || [])
                    meta.set(String(chart.id), { ...chart, song_name: song.name });
            for (const [id, tuple] of Object.entries(config?.ptBestRecords || {}) as any) {
                const chart = meta.get(id);
                const rec = {
                    chart_id: id,
                    song_name: chart?.song_name || "",
                    difficulty: chart?.level || "",
                    rating: Number(chart?.difficulty) || 0,
                    score: Number(tuple[0]) || 0,
                    acc: (Number(tuple[1]) || 0) * 100,
                    is_fc: !!tuple[2],
                    max_acc:
                        (typeof tuple[3] === "number" ? tuple[3] : Number(tuple[1]) || 0) * 100,
                    run_at: typeof tuple[4] === "string" ? tuple[4] : undefined,
                };
                records[id] = mergeRecord(rec, records[id] || rec);
            }
        }
        await ptdb.gameConfig.updateBatch([
            {
                id: stateKey(owner),
                mutator: (cur: any) => cur || { records, pending: legacyPending },
            },
            // Keep ambiguous legacy data untouched, rather than upload under an arbitrary login.
            ...(matches && owner !== "guest"
                ? [{ id: "pendingPtUploads", mutator: () => ({}) }]
                : []),
        ]);
    })().catch(error => {
        migrating.delete(owner);
        throw error;
    });
    migrating.set(owner, task);
    return task;
}

function displayState(owner: string, state: any) {
    if (owner !== recordOwner()) return;
    stateMemory = {
        owner,
        records: state?.records || {},
        pending: state?.pending || {},
        syncedAt: state?.syncedAt,
    };
    const config = shared.game?.ptmain?.gameConfig;
    if (!config) return;
    const records = state?.records || {};
    config.ptBestRecords = Object.fromEntries(
        Object.entries(records).map(([id, r]: [string, any]) => [
            id,
            [r.score, r.acc / 100, r.is_fc, (r.max_acc ?? r.acc) / 100, r.run_at],
        ])
    );
    config.localRks = playerRks(records);
    config.pendingScoreCount = pendingCount(state);
    config.scoreBaselineKnown = !!state?.syncedAt || owner.endsWith("guest");
    if (config.account?.userBasicInfo) config.account.userBasicInfo.rks = config.localRks;
}

/**
 * 模块模式的显示名记忆：断网冷启动时 game.profile 取不到，用上次成功的身份填回
 * 玩家卡（否则整张卡显示成 GUEST，而账号其实还在、成绩还在待上传）。
 */
async function rememberIdentity(owner: string) {
    if (!moduleApi() || owner !== recordOwner()) return;
    const user = currentUser();
    if (user) {
        const name = user.nickname || user.username;
        if (
            identityMemory &&
            identityMemory.owner === owner &&
            identityMemory.name === name &&
            identityMemory.id === user.id
        )
            return;
        identityMemory = {
            owner,
            name,
            id: user.id,
            role: user.is_admin ? "admin" : "player",
            at: Date.now(),
        };
        await ptdb.gameConfig
            .update(identityKey(owner), () => ({ ...identityMemory }))
            .catch(() => undefined);
        return;
    }
    if (identityMemory?.owner === owner) return;
    const row: any = await ptdb.gameConfig.get(identityKey(owner)).catch(() => null);
    if (!row || !row.name) return;
    identityMemory = { owner, ...row };
    const main = shared.game?.ptmain;
    const config = main?.gameConfig;
    if (!config) return;
    main.noAccountMode = false; // 宿主只会给已登录账号开容器，断网不是登出
    if (!config.account) config.account = {};
    config.account.userBasicInfo = {
        userName: row.name,
        id: row.id ?? "server-local",
        role: row.role || "player",
        experience: 0,
        rks: config.localRks || 0,
        avatar: null,
        dateLastLoggedIn: row.at || Date.now(),
        isPTDeveloper: false,
    };
}

/** 载入本地榜单快照（成绩行；与 readState 同生命周期）。 */
async function readBoards(owner: string): Promise<any> {
    const row: any = await ptdb.gameConfig.get(boardsKey(owner)).catch(() => null);
    for (const [chartId, snapshot] of Object.entries(row?.boards || {}) as any) {
        boardMemory.set(memoryKey(owner, chartId), {
            chart_id: chartId,
            ...snapshot,
            stale: true,
        });
    }
    return row || { boards: {}, order: [] };
}

export async function activateLocalRecords() {
    const owner = recordOwner();
    await rememberIdentity(owner);
    const state = await readState(owner);
    if (owner !== recordOwner()) return state;
    await readBoards(owner);
    displayState(owner, state);
    return state;
}

export async function refreshLocalPlayerRks(): Promise<number | null> {
    const owner = recordOwner();
    await activateLocalRecords(); // Always show the durable local value before a network request.
    if (!available()) return null;
    // 模块模式：网络回来时重试一次宿主身份，玩家卡不必等到下次进模块才有名字。
    if (moduleApi() && !currentUser()) {
        await moduleProfile().catch(() => null);
        await rememberIdentity(owner);
    }
    const stats = await fetchMyStats();
    if (!stats || owner !== recordOwner()) return null;
    const state = await ptdb.gameConfig.update(stateKey(owner), (cur: any) => {
        const records = { ...cur?.records };
        for (const row of stats.records || []) {
            const rec = { ...row, is_fc: !!row.is_fc, max_acc: row.best_acc ?? row.acc };
            // Server rating is authoritative even when the local best run wins.
            records[row.chart_id] = {
                ...mergeRecord(records[row.chart_id], rec),
                rating: row.rating,
            };
        }
        return { ...cur, records, syncedAt: Date.now() };
    });
    displayState(owner, state);
    return playerRks(state.records);
}

/** Durable local-first write: guest scores remain local; account scores share one atomic outbox. */
export async function queueRecord(rec: PtRecordInput, owner = recordOwner()): Promise<boolean> {
    await readState(owner);
    const signedIn = !owner.endsWith("guest");
    const state = await ptdb.gameConfig.update(stateKey(owner), (cur: any) =>
        addRun(cur, rec, signedIn)
    );
    displayState(owner, state);
    // Caller need not wait for the server to finish the result screen.
    return signedIn;
}

export function flushPending(): Promise<boolean> {
    if (!available()) return Promise.resolve(false);
    const owner = recordOwner();
    if (inflight.has(owner)) return inflight.get(owner)!;
    const task = (async () => {
        for (;;) {
            const state = await readState(owner);
            if (owner !== recordOwner() || !available()) return false;
            const rec: any = Object.values(state?.pending || {})[0];
            if (!rec) {
                displayState(owner, state);
                return true;
            }
            const ok = await uploadRecord(rec);
            if (!ok) return false;
            const updated = await ptdb.gameConfig.update(stateKey(owner), (cur: any) =>
                acknowledge(cur, rec)
            );
            displayState(owner, updated);
        }
    })()
        .catch(() => false)
        .finally(() => inflight.delete(owner));
    inflight.set(owner, task);
    return task;
}

export async function syncPending() {
    const owner = recordOwner();
    if (await flushPending()) {
        if (owner === recordOwner()) await refreshLocalPlayerRks().catch(() => null);
        return true;
    }
    return false;
}

// ===== 榜单快照：开打前抓、结算时算、离线时看 =====

/** 读内存里的单谱榜快照（同步）：结算画面必须立刻能拿到。 */
export function cachedChartBoard(chartId: string): ChartBoardSnapshot | null {
    const id = String(chartId || "");
    if (!id) return null;
    const snapshot = boardMemory.get(memoryKey(recordOwner(), id));
    return snapshot ? { ...snapshot, stale: true } : null;
}

/** 取单谱榜：优先网络，失败回落本地快照；成功即写入本地供离线使用。 */
export async function loadChartBoard(
    chartId: string,
    force = false
): Promise<ChartBoardSnapshot | null> {
    const id = String(chartId || "");
    if (!id) return null;
    const owner = recordOwner();
    await activateLocalRecords();
    const memory = boardMemory.get(memoryKey(owner, id)) || null;
    if (!force && memory && !memory.stale && Date.now() - memory.at < 60000) return memory;
    if (!available()) return memory ? { ...memory, stale: true } : null;
    const board = await fetchChartLeaderboard(id);
    if (owner !== recordOwner()) return null;
    if (!board) return memory ? { ...memory, stale: true } : null;
    return await writeBoard(owner, {
        chart_id: id,
        entries: board.entries || [],
        me: board.me || null,
        at: Date.now(),
        stale: false,
    });
}

/**
 * 开打前抓一份榜单快照。热点 5 分钟踢人，打完歌时多半已经断网，
 * 结算的预估名次只能靠这一刻的数据。
 */
export function prefetchChartBoard(chartId: string): Promise<ChartBoardSnapshot | null> {
    return loadChartBoard(chartId).catch(() => null);
}

async function writeBoard(
    owner: string,
    snapshot: ChartBoardSnapshot
): Promise<ChartBoardSnapshot> {
    boardMemory.set(memoryKey(owner, snapshot.chart_id), snapshot);
    const stored = { entries: snapshot.entries, me: snapshot.me, at: snapshot.at };
    await ptdb.gameConfig
        .update(boardsKey(owner), (cur: any) => {
            const boards = { ...(cur?.boards || {}) };
            const order = (cur?.order || []).filter((id: string) => id !== snapshot.chart_id);
            boards[snapshot.chart_id] = stored;
            order.push(snapshot.chart_id);
            while (order.length > BOARD_CACHE_LIMIT) delete boards[order.shift()];
            return { boards, order };
        })
        .catch(() => undefined);
    return snapshot;
}

/** 我的本地最佳单局（含未上传的），结算与榜单面板都用它。 */
export function localRecord(chartId: string): any | null {
    const id = String(chartId || "");
    if (!id || !stateMemory) return null;
    return stateMemory.records?.[id] || null;
}

/**
 * 预估名次：用开打前的快照 + 我合并后的最佳单局算。
 * 没有快照就返回 null（UI 只能说「待上传」，绝不编名次）。
 */
export function estimateChartRank(chartId: string, myBest?: any): RankEstimate | null {
    const id = String(chartId || "");
    if (!id) return null;
    const best = myBest || localRecord(id);
    if (!best) return null;
    const snapshot = boardMemory.get(memoryKey(recordOwner(), id));
    if (!snapshot) return null;
    const user = currentUser();
    const mineId = user && typeof user.id === "number" ? user.id : null;
    const result = estimateRank(snapshot.entries, best, {
        isMine: (row: any) =>
            row?.is_me === true || (mineId !== null && Number(row?.user_id) === mineId),
    });
    return { ...result, at: snapshot.at, stale: !!snapshot.stale, rows: snapshot.entries.length };
}

/** 全站榜：优先网络，失败回落本地快照（stale=true 时 UI 必须标注缓存时刻）。 */
export async function leaderboardSnapshot(): Promise<LeaderboardSnapshot | null> {
    const owner = recordOwner();
    const cached: any = await ptdb.gameConfig.get(leaderboardKey(owner)).catch(() => null);
    if (!available()) return cached ? { ...cached, stale: true } : null;
    const data = await fetchLeaderboard();
    if (owner !== recordOwner()) return null;
    if (!data) return cached ? { ...cached, stale: true } : null;
    const snapshot: LeaderboardSnapshot = {
        entries: data.entries || [],
        my_rank: data.my_rank ?? null,
        my_rks: Number(data.my_rks) || 0,
        at: Date.now(),
        stale: false,
    };
    await ptdb.gameConfig
        .update(leaderboardKey(owner), () => ({ ...snapshot }))
        .catch(() => undefined);
    return snapshot;
}

/** 本地 Best30（离线也有内容）：明细行 + RKS + 待上传条数。 */
export function localBest30(limit = 30) {
    const records = stateMemory?.records || {};
    return {
        records: bestRows(records, limit),
        rks: playerRks(records),
        pending: pendingCount(stateMemory),
    };
}

export const ptServer = {
    playerName,
    available,
    uploadRecord,
    queueRecord,
    flushPending,
    syncPending,
    fetchLeaderboard,
    fetchChartLeaderboard,
    fetchMyStats,
    refreshLocalPlayerRks,
    activateLocalRecords,
    recordOwner,
    loadChartBoard,
    cachedChartBoard,
    prefetchChartBoard,
    estimateChartRank,
    localRecord,
    leaderboardSnapshot,
    localBest30,
};
