function normalizeSongField(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

export function getLocalSongGroupKey(song) {
    return [song.name, song.composer, song.edition].map(normalizeSongField).join("\u0000");
}

export function getChartDifficulty(chart) {
    const levelText = String(chart.level || "");
    const embeddedDifficulty = levelText.match(/lv\.?\s*(\d+(?:\.\d+)?)/i);
    if (embeddedDifficulty) return Number(embeddedDifficulty[1]);

    const difficulty = Number(chart.difficulty);
    return Number.isFinite(difficulty) ? difficulty : Number.MAX_SAFE_INTEGER;
}

export function formatChartLevel(chart) {
    const level = String(chart.level || "SP").trim();
    if (/lv\.?\s*\d+(?:\.\d+)?/i.test(level)) return level;

    const difficulty = getChartDifficulty(chart);
    return `${level} Lv.${difficulty === Number.MAX_SAFE_INTEGER || difficulty === 0 ? "?" : difficulty}`;
}

function getLevelRank(chart) {
    const level = String(chart.level || "").trim().toUpperCase().split(/\s+/)[0];
    return { EZ: 0, HD: 1, IN: 2, AT: 3, SP: 4 }[level] ?? 5;
}

export function sortChartsByDifficulty(charts) {
    return [...charts].sort((left, right) => {
        const difficultyDelta = getChartDifficulty(left) - getChartDifficulty(right);
        if (difficultyDelta) return difficultyDelta;

        const levelDelta = getLevelRank(left) - getLevelRank(right);
        if (levelDelta) return levelDelta;

        return String(left.id).localeCompare(String(right.id));
    });
}

export function mergeLocalSongCharts(songs) {
    const groupedSongs = new Map();

    for (const song of songs || []) {
        const key = getLocalSongGroupKey(song);
        const existing = groupedSongs.get(key);
        if (!existing) {
            groupedSongs.set(key, { ...song, charts: [...(song.charts || [])] });
            continue;
        }

        const chartIds = new Set(existing.charts.map(chart => String(chart.id)));
        for (const chart of song.charts || []) {
            if (chartIds.has(String(chart.id))) continue;
            existing.charts.push(chart);
            chartIds.add(String(chart.id));
        }
    }

    return Array.from(groupedSongs.values()).map(song => ({
        ...song,
        charts: sortChartsByDifficulty(song.charts),
    }));
}
