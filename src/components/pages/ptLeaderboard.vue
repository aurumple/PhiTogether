<script>
    import shared from "@utils/js/shared.js";
    import { ptServer } from "../../utils/ptServer";
    export default {
        name: "ptLeaderboard",
        data() {
            return {
                loading: true,
                entries: [],
                myRank: null,
                myRks: 0,
                // 全站榜快照的来源：实时 / 本地缓存（离线时唯一能显示的东西）
                rankStale: false,
                rankAt: 0,
                rankLoaded: false,
                // 本地 Best30（含未上传）：离线也一定有内容
                localRecords: [],
                localRks: 0,
                pending: 0,
                serverRecords: [],
                serverRks: null,
                tab: "rank", // rank=全站排名 best=我的 Best30
            };
        },
        computed: {
            /** Best30 明细：本地行优先（含待上传的新成绩），服务端补齐元数据与缺行。 */
            bestRows() {
                const remote = new Map(
                    (this.serverRecords || []).map(r => [String(r.chart_id), r])
                );
                const rows = (this.localRecords || []).map(row => {
                    const server = remote.get(String(row.chart_id));
                    remote.delete(String(row.chart_id));
                    return {
                        ...row,
                        song_name: row.song_name || (server && server.song_name) || "",
                        difficulty: row.difficulty || (server && server.difficulty) || "",
                        is_fc: !!row.is_fc,
                        chart_rks: Number(row.chart_rks) || 0,
                    };
                });
                // 服务端有、本地没有的行（换过设备或清过本地数据）同样要展示
                for (const row of remote.values())
                    rows.push({
                        ...row,
                        is_fc: !!row.is_fc,
                        chart_rks: Number(row.chart_rks) || 0,
                    });
                return rows.sort((a, b) => b.chart_rks - a.chart_rks).slice(0, 30);
            },
            /** 本地 RKS 含待上传成绩，与服务端值不同时把两个都摆出来，不假装一致。 */
            rksMismatch() {
                return (
                    this.serverRks !== null &&
                    Math.abs(Number(this.serverRks) - Number(this.localRks)) > 0.0005
                );
            },
        },
        async activated() {
            await this.refresh();
        },
        methods: {
            async refresh() {
                this.loading = true;
                await this.loadLocal();
                const [snapshot, stats] = await Promise.all([
                    ptServer.leaderboardSnapshot().catch(() => null),
                    ptServer.fetchMyStats().catch(() => null),
                ]);
                this.rankLoaded = true;
                if (snapshot) {
                    this.entries = snapshot.entries || [];
                    this.myRank = snapshot.my_rank ?? null;
                    this.myRks = snapshot.my_rks || 0;
                    this.rankStale = !!snapshot.stale;
                    this.rankAt = snapshot.at || 0;
                }
                if (stats) {
                    this.serverRecords = stats.records || [];
                    this.serverRks = Number(stats.rks) || 0;
                }
                this.loading = false;
            },
            async loadLocal() {
                await ptServer.activateLocalRecords().catch(() => null);
                const local = ptServer.localBest30(30);
                this.localRecords = local.records || [];
                this.localRks = local.rks || 0;
                this.pending = local.pending || 0;
            },
            async switchTab(tab) {
                this.tab = tab;
            },
            fmtRks(v) {
                return Number(v || 0).toFixed(3);
            },
            fmtScore(v) {
                return Number(v || 0).toLocaleString();
            },
            fmtAcc(v) {
                return Number(v || 0).toFixed(4) + "%";
            },
            fmtTime(at) {
                if (!at) return "";
                try {
                    return new Date(at).format("m-d H:i");
                } catch {
                    return "";
                }
            },
            back() {
                shared.game.ptmain.$router.push("/startPage");
            },
        },
    };
</script>

<template>
    <div id="ptLeaderboard" class="routerRealPage">
        <div class="ptLbCard blur">
            <div class="ptLbHeader">
                <h2>{{ $t("ptLeaderboard.title") }}</h2>
                <div class="ptLbTabs">
                    <button :class="{ active: tab === 'rank' }" @click="switchTab('rank')">
                        {{ $t("ptLeaderboard.tabRank") }}
                    </button>
                    <button :class="{ active: tab === 'best' }" @click="switchTab('best')">
                        {{ $t("ptLeaderboard.tabBest") }}
                    </button>
                    <button :disabled="loading" @click="refresh">
                        {{ $t("ptLeaderboard.refresh") }}
                    </button>
                    <button @click="back">{{ $t("ptLeaderboard.back") }}</button>
                </div>
            </div>

            <div v-if="loading" class="ptLbStatus">{{ $t("ptLeaderboard.loading") }}</div>

            <template v-else>
                <div v-if="tab === 'rank'">
                    <div v-if="rankStale" class="ptLbNotice">
                        {{ $t("ptLeaderboard.offlineCache", [fmtTime(rankAt)]) }}
                    </div>
                    <div class="ptLbSummary">
                        {{ $t("ptLeaderboard.myRank") }}：
                        <b>{{ myRank || $t("ptLeaderboard.notRanked") }}</b>
                        &nbsp;&nbsp;{{ $t("ptLeaderboard.serverRks") }}：
                        <b>{{ fmtRks(myRks) }}</b>
                        <template v-if="pending">
                            &nbsp;&nbsp;
                            <span class="ptLbPending">
                                {{ $t("ptLeaderboard.pendingNote", [pending]) }}
                            </span>
                        </template>
                    </div>
                    <div v-if="!entries.length" class="ptLbStatus">
                        {{
                            rankStale
                                ? $t("ptLeaderboard.offlineNoData")
                                : $t("ptLeaderboard.empty")
                        }}
                    </div>
                    <div v-else class="ptLbTable">
                        <div class="ptLbRow ptLbRowHead">
                            <span class="ptLbRank">#</span>
                            <span class="ptLbName">{{ $t("ptLeaderboard.colPlayer") }}</span>
                            <span class="ptLkNum">RKS</span>
                            <span class="ptLbPlays">{{ $t("ptLeaderboard.colPlays") }}</span>
                        </div>
                        <div
                            v-for="(e, i) in entries"
                            :key="e.user_id"
                            class="ptLbRow"
                            :class="{ ptLbMe: myRank && i + 1 === myRank }"
                        >
                            <span class="ptLbRank">{{ i + 1 }}</span>
                            <span class="ptLbName">{{ e.name }}</span>
                            <span class="ptLkNum">{{ fmtRks(e.rks) }}</span>
                            <span class="ptLbPlays">{{ e.plays }}</span>
                        </div>
                    </div>
                </div>

                <div v-else>
                    <div class="ptLbSummary">
                        {{ $t("ptLeaderboard.localRks") }}：
                        <b>{{ fmtRks(localRks) }}</b>
                        （{{ $t("ptLeaderboard.best30Hint") }}）
                        <template v-if="rksMismatch">
                            &nbsp;&nbsp;{{ $t("ptLeaderboard.serverRks") }}：
                            <b>{{ fmtRks(serverRks) }}</b>
                        </template>
                        <template v-if="pending">
                            &nbsp;&nbsp;
                            <span class="ptLbPending">
                                {{ $t("ptLeaderboard.pendingNote", [pending]) }}
                            </span>
                        </template>
                    </div>
                    <div v-if="!bestRows.length" class="ptLbStatus">
                        {{ $t("ptLeaderboard.noRecords") }}
                    </div>
                    <div v-else class="ptLbTable">
                        <div class="ptLbRow ptLbRowHead">
                            <span class="ptLbRank">#</span>
                            <span class="ptLbName">{{ $t("ptLeaderboard.colSong") }}</span>
                            <span class="ptLkNum">{{ $t("ptLeaderboard.colChartRks") }}</span>
                            <span class="ptLbPlays">{{ $t("ptLeaderboard.colScoreAcc") }}</span>
                        </div>
                        <div v-for="(r, i) in bestRows" :key="r.chart_id" class="ptLbRow">
                            <span class="ptLbRank">{{ i + 1 }}</span>
                            <span class="ptLbName">
                                {{ r.song_name || r.chart_id }}
                                <small v-if="r.difficulty">[{{ r.difficulty }}]</small>
                            </span>
                            <span class="ptLkNum">{{ fmtRks(r.chart_rks) }}</span>
                            <span class="ptLbPlays">
                                {{ fmtScore(r.score) }} / {{ fmtAcc(r.acc) }}
                                <small v-if="r.is_fc">FC</small>
                            </span>
                        </div>
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
    #ptLeaderboard {
        position: fixed;
        top: 7.5vh;
        left: 0;
        right: 0;
        bottom: 0;
        overflow-y: auto;
        display: flex;
        justify-content: center;
    }
    .ptLbCard {
        width: 86vw;
        max-width: 900px;
        margin: 3vh 0 6vh;
        padding: 2vh 2vw;
        border-radius: 12px;
    }
    .ptLbHeader {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 1.5vh;
    }
    .ptLbHeader h2 {
        margin: 0;
        font-size: 1.5em;
    }
    .ptLbTabs button {
        margin-left: 6px;
        padding: 4px 12px;
        border: none;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.25);
        cursor: pointer;
        font-size: 0.95em;
    }
    .ptLbTabs button.active {
        background: rgba(88, 166, 255, 0.55);
        color: #fff;
    }
    .ptLbSummary {
        margin-bottom: 1vh;
        font-size: 1.05em;
    }
    .ptLbNotice {
        margin-bottom: 1vh;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(214, 158, 46, 0.18);
        color: #8a6d1f;
        font-size: 0.92em;
    }
    .ptLbPending {
        color: #c62828;
        font-size: 0.92em;
    }
    .ptLbStatus {
        padding: 4vh 0;
        text-align: center;
        color: #666;
    }
    .ptLbTable {
        width: 100%;
    }
    .ptLbRow {
        display: flex;
        align-items: center;
        padding: 0.7vh 1vw;
        border-bottom: 1px solid rgba(127, 127, 127, 0.2);
    }
    .ptLbRowHead {
        font-weight: bold;
        color: #555;
    }
    .ptLbMe {
        background: rgba(88, 166, 255, 0.18);
        border-radius: 6px;
    }
    .ptLbRank {
        width: 3.2em;
        text-align: center;
    }
    .ptLbName {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .ptLbName small {
        color: #888;
    }
    .ptLkNum {
        width: 5.5em;
        text-align: right;
    }
    .ptLbPlays {
        width: 12em;
        text-align: right;
        white-space: nowrap;
    }
    .ptLbPlays small {
        color: #2e9e44;
        font-weight: bold;
    }
</style>
