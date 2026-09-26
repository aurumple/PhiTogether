// Self-hosted leaderboard bridge: score upload, rks sync and the offline
// upload queue. Mirrors the semantics of the community-era record flow, but
// targets the local server (see server/routers/game.py) instead of PhiZone.
import ptdb from "@components/ptdb";
import shared from "@utils/js/shared";
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
    }>;
    rks: number;
    limit: number;
}

/** Display name of the signed-in player (nickname first). null when logged out. */
export function playerName(): string | null {
    const u = currentUser();
    return u ? u.nickname || u.username : null;
}

/** True when a self-hosted session is active (guest play uploads nothing). */
export function available(): boolean {
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
            return (await api.game.call("game.chart-leaderboard", { chartId })) as ChartLeaderboardData;
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

/**
 * Pull the server-side rks and sync it onto the player info bar
 * (gameConfig.account.userBasicInfo.rks, read by #pzrks in the top bar).
 * Returns the fresh rks, or null when unavailable.
 * 模块模式：统计随 game.profile 一起取（不走 HTTP 排行接口）。
 */
export async function refreshLocalPlayerRks(): Promise<number | null> {
    let rks: number | null = null;
    const p = platform();
    if (p) {
        const profile = await moduleProfile();
        const stats = profile && (profile.stats || profile);
        const value = stats && (stats.rks ?? stats.RKS);
        if (typeof value === "number") rks = value;
    } else {
        const stats = await fetchMyStats();
        if (stats !== null) rks = stats.rks;
    }
    if (rks === null) return null;
    try {
        const info = shared.game?.ptmain?.gameConfig?.account?.userBasicInfo;
        if (info) info.rks = rks;
    } catch {
        /* sub-app not mounted: nothing to sync */
    }
    return rks;
}

// ===== Offline score queue =====
// Pending uploads live in the ptdb userData store (id=pendingPtUploads); one
// merged best value per chart (same merge rule as the server). Flush triggers:
// a finished play, the browser `online` event, or re-entering the game.
const PENDING_UPLOADS_ID = "pendingPtUploads";
let flushing = false;

async function loadPending(): Promise<Record<string, PtRecordInput>> {
    try {
        const saved = await ptdb.gameConfig.get(PENDING_UPLOADS_ID, {});
        return (saved as Record<string, PtRecordInput>) || {};
    } catch {
        return {};
    }
}

/**
 * 单谱面最佳单局合并（与服务端榜单同键：(score, acc, is_fc) 字典序最大的一局胜出），
 * max_acc 取历史最高：并发/重试时旧响应既不能删掉新成绩，也不能降低最佳值。
 */
function mergeRecord(prev: PtRecordInput | undefined, rec: PtRecordInput): PtRecordInput {
    if (!prev) return rec;
    const score = (r: PtRecordInput) => Number(r.score) || 0;
    const acc = (r: PtRecordInput) => Number(r.acc) || 0;
    const better =
        score(prev) !== score(rec)
            ? score(prev) > score(rec)
            : acc(prev) !== acc(rec)
              ? acc(prev) > acc(rec)
              : !!prev.is_fc && !rec.is_fc;
    const best = better ? prev : rec;
    return {
        ...best,
        max_acc: Math.max(Number(prev.max_acc ?? prev.acc) || 0, Number(rec.max_acc ?? rec.acc) || 0),
    };
}

/** 本地成绩合并：ptBestRecords 里每谱面一行 [score, acc, isFc, maxAcc, runAt]。 */
function mergeBestTuples(a: any, b: any): any {
    if (!a) return b;
    if (!b) return a;
    const better =
        (Number(a[0]) || 0) !== (Number(b[0]) || 0)
            ? (Number(a[0]) || 0) > (Number(b[0]) || 0)
            : (Number(a[1]) || 0) !== (Number(b[1]) || 0)
              ? (Number(a[1]) || 0) > (Number(b[1]) || 0)
              : !!a[2] && !b[2];
    const best = better ? a : b;
    return [best[0], best[1], best[2], Math.max(Number(a[3]) || 0, Number(b[3]) || 0), best[4]];
}

/**
 * Queue one record and try to flush at once.
 * @param localGameConfig 本次游玩的 gameConfig 快照（含 ptBestRecords）：本地成绩与
 *   pendingPtUploads 必须在同一个原子批里提交（模块模式同一个 api.records.batch），
 *   分开写会互相覆盖。
 */
export async function queueRecord(rec: PtRecordInput, localGameConfig?: any): Promise<boolean> {
    if (!available()) return false;
    const chartId = String(rec.chart_id);
    try {
        const mergePending = (cur: any) => {
            const map = { ...(cur || {}) };
            map[chartId] = mergeRecord(map[chartId], rec);
            return map;
        };
        if (localGameConfig) {
            await ptdb.gameConfig.updateBatch([
                {
                    id: "gameConfig",
                    mutator: (cur: any) => {
                        // 以存储里的最新配置为基底（不覆盖并发改动），只按最佳值合并成绩；
                        // 存储里还没有配置行时用本次快照兜底，避免写出残缺行
                        const base =
                            cur && typeof cur === "object"
                                ? { ...cur }
                                : { ...(localGameConfig || {}) };
                        const curBest = (cur && cur.ptBestRecords) || {};
                        const newBest = (localGameConfig && localGameConfig.ptBestRecords) || {};
                        const merged: any = { ...curBest };
                        for (const id of Object.keys(newBest))
                            merged[id] = mergeBestTuples(curBest[id], newBest[id]);
                        base.ptBestRecords = merged;
                        return base;
                    },
                },
                { id: PENDING_UPLOADS_ID, mutator: mergePending },
            ]);
        } else {
            await ptdb.gameConfig.update(PENDING_UPLOADS_ID, mergePending);
        }
    } catch {
        /* 队列写失败仍允许直接尝试上传 */
    }
    return flushPending();
}

/** Upload the queue in order; stop on the first failure (offline). */
export async function flushPending(): Promise<boolean> {
    if (!available()) return false;
    if (flushing) return false;
    flushing = true;
    try {
        for (;;) {
            const map = await loadPending();
            const id = Object.keys(map)[0];
            if (!id) return true;
            const rec = map[id];
            const ok = await uploadRecord(rec);
            if (!ok) return false;
            // 只移除「本次刚上传的那条」。上传期间若同谱面又进来了新成绩（或更好的
            // 值），保留合并结果并留给下一轮上传——旧响应不能删掉新成绩。
            await ptdb.gameConfig.update(PENDING_UPLOADS_ID, (cur: any) => {
                const next = { ...(cur || {}) };
                const now = next[id];
                if (!now) return next;
                const unchanged =
                    String(now.chart_id ?? id) === String(rec.chart_id ?? id) &&
                    Number(now.score) === Number(rec.score) &&
                    Number(now.acc) === Number(rec.acc) &&
                    !!now.is_fc === !!rec.is_fc &&
                    Number(now.max_acc ?? now.acc) === Number(rec.max_acc ?? rec.acc);
                if (unchanged) delete next[id];
                else next[id] = mergeRecord(rec, now);
                return next;
            });
        }
    } finally {
        flushing = false;
    }
}

/** Aggregated entry point for untyped callers (global.js). */
export const ptServer = {
    playerName,
    available,
    uploadRecord,
    queueRecord,
    flushPending,
    fetchLeaderboard,
    fetchChartLeaderboard,
    fetchMyStats,
    refreshLocalPlayerRks,
};
