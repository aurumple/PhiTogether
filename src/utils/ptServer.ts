// Self-hosted leaderboard bridge: score upload, rks sync and the offline
// upload queue. Mirrors the semantics of the community-era record flow, but
// targets the local server (see server/routers/game.py) instead of PhiZone.
import ptdb from "@components/ptdb";
import shared from "@utils/js/shared";
import { authFetch, currentUser, isLoggedIn } from "./serverApi";

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

/** Upload one best score. Fire-and-forget: failures stay queued locally. */
export async function uploadRecord(rec: PtRecordInput): Promise<boolean> {
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
 */
export async function refreshLocalPlayerRks(): Promise<number | null> {
    const stats = await fetchMyStats();
    if (stats === null) return null;
    try {
        const info = shared.game?.ptmain?.gameConfig?.account?.userBasicInfo;
        if (info) info.rks = stats.rks;
    } catch {
        /* sub-app not mounted: nothing to sync */
    }
    return stats.rks;
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

async function savePending(map: Record<string, PtRecordInput>): Promise<void> {
    try {
        await ptdb.gameConfig.save(map, PENDING_UPLOADS_ID);
    } catch {
        /* queue write failure still allows a direct upload attempt */
    }
}

/** Queue one record (latest value per chart wins) and try to flush at once. */
export async function queueRecord(rec: PtRecordInput): Promise<boolean> {
    if (!available()) return false;
    try {
        const map = await loadPending();
        map[rec.chart_id] = rec;
        await savePending(map);
    } catch {
        /* flushPending falls back to uploading directly */
    }
    return flushPending();
}

/** Upload the queue in order; stop on the first failure (offline). */
export async function flushPending(): Promise<boolean> {
    if (!available()) return false;
    if (flushing) return false;
    flushing = true;
    try {
        const map = await loadPending();
        for (const id of Object.keys(map)) {
            const ok = await uploadRecord(map[id]);
            if (!ok) return false;
            delete map[id];
            await savePending(map);
        }
        return true;
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
