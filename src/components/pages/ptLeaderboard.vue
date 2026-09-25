<script>
    import shared from "@utils/js/shared.js";
    import { fetchLeaderboard, fetchMyStats } from "../../utils/ptServer";
    export default {
        name: "ptLeaderboard",
        data() {
            return {
                loading: true,
                failed: false,
                entries: [],
                myRank: null,
                myRks: 0,
                tab: "rank", // rank=全站排名 best=我的 Best30
                myRecords: [],
            };
        },
        async activated() {
            await this.refresh();
        },
        methods: {
            async refresh() {
                this.loading = true;
                this.failed = false;
                const data = await fetchLeaderboard();
                if (!data) {
                    this.failed = true;
                    this.loading = false;
                    return;
                }
                this.entries = data.entries || [];
                this.myRank = data.my_rank;
                this.myRks = data.my_rks || 0;
                if (this.tab === "best") await this.loadMyRecords();
                this.loading = false;
            },
            async switchTab(tab) {
                this.tab = tab;
                if (tab === "best" && this.myRecords.length === 0) {
                    this.loading = true;
                    await this.loadMyRecords();
                    this.loading = false;
                }
            },
            async loadMyRecords() {
                const stats = await fetchMyStats();
                if (stats) {
                    this.myRecords = stats.records || [];
                    this.myRks = stats.rks || this.myRks;
                }
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
                    <button @click="refresh">{{ $t("ptLeaderboard.refresh") }}</button>
                    <button @click="back">{{ $t("ptLeaderboard.back") }}</button>
                </div>
            </div>

            <div v-if="loading" class="ptLbStatus">{{ $t("ptLeaderboard.loading") }}</div>
            <div v-else-if="failed" class="ptLbStatus">
                {{ $t("ptLeaderboard.failed") }}
            </div>

            <template v-else>
                <div v-if="tab === 'rank'">
                    <div class="ptLbSummary">
                        {{ $t("ptLeaderboard.myRank") }}：<b>{{ myRank || $t("ptLeaderboard.notRanked") }}</b>
                        &nbsp;&nbsp;RKS：<b>{{ fmtRks(myRks) }}</b>
                    </div>
                    <div v-if="entries.length === 0" class="ptLbStatus">
                        {{ $t("ptLeaderboard.empty") }}
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
                        {{ $t("ptLeaderboard.myRks") }}：<b>{{ fmtRks(myRks) }}</b>（{{ $t("ptLeaderboard.best30Hint") }}）
                    </div>
                    <div v-if="myRecords.length === 0" class="ptLbStatus">{{ $t("ptLeaderboard.noRecords") }}</div>
                    <div v-else class="ptLbTable">
                        <div class="ptLbRow ptLbRowHead">
                            <span class="ptLbRank">#</span>
                            <span class="ptLbName">{{ $t("ptLeaderboard.colSong") }}</span>
                            <span class="ptLkNum">{{ $t("ptLeaderboard.colChartRks") }}</span>
                            <span class="ptLbPlays">{{ $t("ptLeaderboard.colScoreAcc") }}</span>
                        </div>
                        <div v-for="(r, i) in myRecords" :key="r.chart_id" class="ptLbRow">
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
