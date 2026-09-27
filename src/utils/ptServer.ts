// Self-hosted leaderboard bridge: score upload, rks sync and the offline
// upload queue. Mirrors the semantics of the community-era record flow, but
// targets the local server (see server/routers/game.py) instead of PhiZone.
import ptdb from "@components/ptdb";
import shared from "@utils/js/shared";
import { mergeRecord, playerRks, addRun, acknowledge } from "./offlineRecords.mjs";
import { authFetch, currentUser, isLoggedIn, moduleApi } from "./serverApi";

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
        best_acc?: number;
        run_at?: string;
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
    if (moduleApi()) return available() ? "module" : "module-guest";
    const user = currentUser();
    return user ? `user:${user.id}` : "guest";
}
const stateKey = (owner: string) => `ptRecords:v2:${owner}`;
const inflight = new Map<string, Promise<boolean>>();
const migrating = new Map<string, Promise<void>>();

async function readState(owner: string): Promise<any> {
    await migrateLegacy(owner);
    return await ptdb.gameConfig.get(stateKey(owner)).catch(() => ({ records: {}, pending: {} }));
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
    config.pendingScoreCount = Object.keys(state?.pending || {}).length;
    config.scoreBaselineKnown = !!state?.syncedAt || owner.endsWith("guest");
    if (config.account?.userBasicInfo) config.account.userBasicInfo.rks = config.localRks;
}

export async function activateLocalRecords() {
    const owner = recordOwner();
    const state = await readState(owner);
    displayState(owner, state);
    return state;
}

export async function refreshLocalPlayerRks(): Promise<number | null> {
    const owner = recordOwner();
    await activateLocalRecords(); // Always show the durable local value before a network request.
    if (!available()) return null;
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
};
