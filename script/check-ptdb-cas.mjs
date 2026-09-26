/**
 * 检查 2：expectRev CAS 冲突。
 *   1) 过期的 expectRev 一定抛 CONFLICT（假 api 自检）；
 *   2) updateUserDataBatch 读取与提交之间被并发写入 → 整批冲突重试，重读后合并，
 *      双方改动都保留（旧结论不覆盖新数据——flush 队列「旧响应不能删掉新成绩」的
 *      前提就是 mutator 每次都拿最新行重算）；
 *   3) 注入式冲突（宿主主动拒绝一次）后重试成功。
 * 运行：node script/check-ptdb-cas.mjs
 */
import assert from "node:assert/strict";
import { createFakeApi } from "./check-ptdb-fakeapi.mjs";
import { createPlatformBackend } from "../src/components/ptdb/platformBackend.js";

const api = createFakeApi();
const db = createPlatformBackend(api);

// ===== 1) 过期 expectRev 抛 CONFLICT =====
await api.records.put("settings", "pendingPtUploads", {}, undefined);
const row = await api.records.get("settings", "pendingPtUploads");
await api.records.put("settings", "pendingPtUploads", { a: 1 }, { expectRev: row.rev });
await assert.rejects(
    () => api.records.put("settings", "pendingPtUploads", { a: 2 }, { expectRev: row.rev }),
    e => e.code === "CONFLICT"
);

// ===== 2) 读取与提交之间的并发写入：整批重读合并，不覆盖对方 =====
// 模拟 queueRecord 的合并写：本端要记 mine，另一端（flush/另一次入队）先落了 other。
const origBatch = api.records.batch.bind(api.records);
let raced = false;
api.records.batch = async ops => {
    if (!raced) {
        raced = true;
        // 并发写入者抢先改了同一行（rev 前移，本批的 expectRev 必然过期）
        await origBatch([
            {
                op: "put",
                collection: "settings",
                key: "pendingPtUploads",
                value: { other: { score: 200 } },
            },
        ]);
    }
    return origBatch(ops);
};
await db.updateUserDataBatch([
    {
        id: "pendingPtUploads",
        mutator: cur => ({ ...(cur || {}), mine: { score: 100 } }),
    },
]);
const merged = await db.getUserData("pendingPtUploads");
assert.deepEqual(merged, {
    other: { score: 200 },
    mine: { score: 100 },
}, "冲突重试后应合并双方改动（mutator 拿到的是重读后的最新行）");

// mutator 每次重试都收到最新行：能看到并发写入者留下的数据
let seen = null;
await db.updateUserData("pendingPtUploads", cur => {
    seen = cur;
    return cur;
});
assert.equal(seen.other.score, 200);

// ===== 3) 宿主注入一次冲突：重试后成功 =====
api.__injectConflicts(1);
await db.updateUserData("pendingPtUploads", cur => ({ ...cur, third: 3 }));
assert.equal((await db.getUserData("pendingPtUploads")).third, 3);

// 多行同批（本地成绩 + pendingPtUploads）也走同一原子批：都写成功
await db.updateUserDataBatch([
    { id: "gameConfig", mutator: () => ({ ptBestRecords: { c1: [100, 99, true, 99, "t"] } }) },
    { id: "pendingPtUploads", mutator: cur => ({ ...cur, c1: { score: 100 } }) },
]);
assert.equal((await db.getUserData("gameConfig")).ptBestRecords.c1[0], 100);
assert.equal((await db.getUserData("pendingPtUploads")).c1.score, 100);

console.log("check-ptdb-cas: OK");
