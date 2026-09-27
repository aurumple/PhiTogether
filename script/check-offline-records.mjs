import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { createFakeApi } from "./check-ptdb-fakeapi.mjs";
import { createPlatformBackend } from "../src/components/ptdb/platformBackend.js";
import { addRun, acknowledge, playerRks } from "../src/utils/offlineRecords.mjs";

const backend = createPlatformBackend(createFakeApi());
let user = { id: 1, username: "one" };
let online = false;
let beforeUpload = null;
let moduleMode = false;
const uploads = [];
const shared = { game: { ptmain: { gameConfig: { account: { userBasicInfo: {} } } } } };
globalThis.__offlineTest = {
    shared,
    ptdb: {
        gameConfig: {
            get: async key => {
                const value = await backend.getUserData(key);
                if (value == null) throw new Error("Not found");
                return value;
            },
            update: backend.updateUserData,
            updateBatch: backend.updateUserDataBatch,
        },
        chart: { renderApi: async () => ({ results: [] }) },
    },
    currentUser: () => user,
    isLoggedIn: () => !!user,
    moduleApi: () => (moduleMode ? globalThis.window.__onetapPlatform.api : null),
    authFetch: async (url, options) => {
        if (!online) throw new Error("Offline");
        const owner = user?.id;
        if (options?.method === "POST") {
            const rec = JSON.parse(options.body);
            if (beforeUpload) {
                const fn = beforeUpload;
                beforeUpload = null;
                await fn();
            }
            uploads.push({ owner, rec });
            return { ok: true };
        }
        return {
            ok: true,
            json: async () => ({
                records: [
                    {
                        chart_id: "remote",
                        song_name: "remote",
                        difficulty: "IN",
                        rating: 15,
                        score: 950000,
                        acc: 95,
                        best_acc: 99,
                        is_fc: 0,
                    },
                ],
            }),
        };
    },
};
const source = (await readFile(new URL("../src/utils/ptServer.ts", import.meta.url), "utf8"))
    .replace(/import ptdb[^;]+;/, "const { ptdb } = globalThis.__offlineTest;")
    .replace(/import shared[^;]+;/, "const { shared } = globalThis.__offlineTest;")
    .replace(
        /import \{ authFetch[^;]+;/,
        "const { authFetch, currentUser, isLoggedIn, moduleApi } = globalThis.__offlineTest;"
    )
    .replace(
        '"./offlineRecords.mjs"',
        JSON.stringify(new URL("../src/utils/offlineRecords.mjs", import.meta.url).href)
    );
const code = (await transformWithEsbuild(source, "ptServer.ts", { loader: "ts" })).code;
const client = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const run = {
    chart_id: "a",
    song_name: "A",
    difficulty: "IN",
    rating: 10,
    score: 990000,
    acc: 95,
    is_fc: false,
    max_acc: 95,
    run_at: "2026-09-27T00:00:00Z",
};

await client.queueRecord(run);
assert.equal(await client.flushPending(), false);
assert.equal(shared.game.ptmain.gameConfig.localRks, 9.025);
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 1);
// Reload the displayed state from durable storage, without any network.
shared.game.ptmain.gameConfig.ptBestRecords = {};
await client.activateLocalRecords();
assert.equal(shared.game.ptmain.gameConfig.ptBestRecords.a[0], 990000);

// Higher accuracy on a lower scoring run must change RKS without replacing the best run.
await client.queueRecord({ ...run, score: 980000, acc: 99, max_acc: 99 });
assert.equal(shared.game.ptmain.gameConfig.localRks, 9.801);
assert.equal(shared.game.ptmain.gameConfig.ptBestRecords.a[0], 990000);

user = { id: 2, username: "two" };
online = true;
await client.activateLocalRecords();
assert.deepEqual(shared.game.ptmain.gameConfig.ptBestRecords, {});
await client.flushPending();
assert.equal(uploads.length, 0, "account two must not upload account one's outbox");
user = null;
await client.queueRecord({ ...run, chart_id: "guest" });
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 0);
user = { id: 1, username: "one" };

// New result arriving while an older request is in flight survives acknowledgement.
beforeUpload = () =>
    client.queueRecord({ ...run, score: 1000000, acc: 100, max_acc: 100, is_fc: true });
await client.flushPending();
assert.equal(uploads.length, 2);
assert.equal(uploads[1].rec.score, 1000000);
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 0);
assert.ok(uploads.every(u => u.owner === 1 && u.rec.chart_id !== "guest"));
await client.refreshLocalPlayerRks();
assert.equal(shared.game.ptmain.gameConfig.localRks, 12.3508);
assert.equal(shared.game.ptmain.gameConfig.scoreBaselineKnown, true);

// Account changes during an upload stop further submissions from the old queue.
await client.queueRecord({ ...run, chart_id: "b" });
await client.queueRecord({ ...run, chart_id: "c" });
beforeUpload = async () => {
    user = { id: 2, username: "two" };
};
await client.flushPending();
assert.equal(uploads.at(-1).owner, 1);
assert.equal((await backend.getUserData("ptRecords:v2:user:1")).pending.c.chart_id, "c");

const state = addRun({}, run, true);
assert.deepEqual(
    acknowledge(state, { ...run, score: 1 }).pending,
    state.pending,
    "nonidentical acknowledgement is conservative"
);
const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [i, { rating: i + 1, acc: 100 }])
);
assert.equal(playerRks(many), 25.5);

// The same durable flow also works through the module gateway, including legacy queue migration.
await backend.putUserData("pendingPtUploads", { legacy: { ...run, chart_id: "legacy" } });
moduleMode = true;
online = false;
const moduleUploads = [];
globalThis.window = {
    __onetapPlatform: {
        api: {
            game: {
                call: async (operation, input) => {
                    if (!online) throw new Error("gateway offline");
                    if (operation === "game.records") {
                        moduleUploads.push(input);
                        return {};
                    }
                    if (operation === "game.me") return { records: [], rks: 0, limit: 30 };
                    throw new Error(`unexpected operation: ${operation}`);
                },
            },
        },
    },
};
await client.queueRecord({ ...run, chart_id: "module-chart" });
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 2);
assert.equal(await client.flushPending(), false);
online = true;
await client.syncPending();
assert.deepEqual(moduleUploads.map(r => r.chartId).sort(), ["legacy", "module-chart"]);
assert.equal(shared.game.ptmain.gameConfig.pendingScoreCount, 0);
assert.deepEqual(await backend.getUserData("pendingPtUploads"), {});
delete globalThis.window;
delete globalThis.__offlineTest;
console.log(
    "Offline records: persistence, account isolation, guest separation, concurrent retry and RKS passed"
);
