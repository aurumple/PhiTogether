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
