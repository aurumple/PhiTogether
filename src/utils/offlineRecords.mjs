// Pure score rules shared by persistence and its regression checks. Accuracy is percent.
export function mergeRecord(prev, rec) {
    if (!prev) return { ...rec, max_acc: rec.max_acc ?? rec.acc };
    const better =
        prev.score !== rec.score
            ? prev.score > rec.score
            : prev.acc !== rec.acc
              ? prev.acc > rec.acc
              : !!prev.is_fc && !rec.is_fc;
    return {
        ...(better ? prev : rec),
        max_acc: Math.max(prev.max_acc ?? prev.acc, rec.max_acc ?? rec.acc),
    };
}
export function chartRks(rec) {
    return (
        Math.round((Number(rec.rating) || 0) * ((rec.max_acc ?? rec.acc) / 100) ** 2 * 10000) /
        10000
    );
}
export function playerRks(records) {
    const best = Object.values(records)
        .map(chartRks)
        .sort((a, b) => b - a)
        .slice(0, 30);
    return best.length
        ? Math.round((best.reduce((a, b) => a + b, 0) / best.length) * 10000) / 10000
        : 0;
}
export function addRun(state, rec, signedIn) {
    const records = { ...state?.records };
    const pending = { ...state?.pending };
    records[rec.chart_id] = mergeRecord(records[rec.chart_id], rec);
    if (signedIn) pending[rec.chart_id] = mergeRecord(pending[rec.chart_id], records[rec.chart_id]);
    return { ...state, records, pending };
}
export function acknowledge(state, sent) {
    const pending = { ...state?.pending };
    const now = pending[sent.chart_id];
    if (now && JSON.stringify(now) === JSON.stringify(sent)) delete pending[sent.chart_id];
    return { ...state, pending };
}

/** 服务端名次规则的关键字：最佳单局按 (score, acc, is_fc) 字典序。 */
export function rankKey(rec) {
    return [Number(rec?.score) || 0, Number(rec?.acc) || 0, rec?.is_fc ? 1 : 0];
}

/** 关键字比较：>0 表示 a 排在 b 前面（与 server/routers/game.py 的排序同一口径）。 */
export function compareRankKey(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    return 0;
}

/** 单谱榜 top 截断名次数（服务端 select_top_and_me 的 rank <= 10）。 */
export const BOARD_TOP = 10;

/**
 * 预估名次：把「服务端榜单快照」和「我的最佳单局」按并列名次（1,2,2,4）放在一起排。
 *
 * 快照只含名次 ≤ top 的行，所以结论只有两种：
 *   - 快照行数 < top → 快照就是全榜，名次确定；
 *   - 预估名次 ≤ top → 排在前面的人一定都在快照里，名次同样确定；
 *   - 否则只能给出「top 名以外」{rank: null, outside: true}，绝不编一个具体名次。
 *
 * 打完歌大概率已经断网（热点 5 分钟踢出），所以这个函数必须纯本地、同步、无 IO。
 */
export function estimateRank(entries, myBest, options = {}) {
    const rows = Array.isArray(entries) ? entries : [];
    const top = Number(options.top) > 0 ? Number(options.top) : BOARD_TOP;
    const isMine = typeof options.isMine === "function" ? options.isMine : () => false;
    const mine = rankKey(myBest);
    let ahead = 0;
    let mineSeen = false;
    for (const row of rows) {
        // 我自己的旧成绩不能挡我：新成绩已经与它合并成 myBest。
        if (isMine(row)) {
            mineSeen = true;
            continue;
        }
        if (compareRankKey(rankKey(row), mine) > 0) ahead++;
    }
    const rank = ahead + 1;
    if (rows.length < top || rank <= top) return { rank, outside: false, exact: true };
    return { rank: null, outside: true, exact: false, mineSeen };
}

/**
 * 本地 Best30：每个谱面一行（取本地最佳单局），按单曲 RKS 降序前 limit 行。
 * 与服务端 load_me_records 的排序口径一致，因此离线也能给出同一张表。
 */
export function bestRows(records, limit = 30) {
    return Object.entries(records || {})
        .map(([chart_id, rec]) => ({ ...rec, chart_id, chart_rks: chartRks(rec) }))
        .sort((a, b) => b.chart_rks - a.chart_rks)
        .slice(0, limit);
}

/** 待上传队列条数。 */
export function pendingCount(state) {
    return Object.keys(state?.pending || {}).length;
}
