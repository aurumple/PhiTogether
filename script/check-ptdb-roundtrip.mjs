/**
 * 检查 1：platformBackend 的 records/blobs 往返。
 * 歌曲/谱面/皮肤/设置四类行写入后读回，元数据与大字节逐项一致；列表接口只出元数据，
 * 不触发任何大对象读取（列表不得偷偷把音频整段读回内存）。
 * 运行：node script/check-ptdb-roundtrip.mjs
 */
import assert from "node:assert/strict";
import { createFakeApi } from "./check-ptdb-fakeapi.mjs";
import { createPlatformBackend } from "../src/components/ptdb/platformBackend.js";

const api = createFakeApi();
const db = createPlatformBackend(api);
const text = new TextEncoder();

await db.putSong({
    id: "s1",
    name: "Test Song",
    composer: "Composer",
    illustrator: "Illustrator",
    from: 3,
    origin: { id: "s1", name: "Test Song" },
    songFile: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }),
    illustrationFile: new Blob([new Uint8Array([9, 8])], { type: "image/png" }),
});
await db.putChart({
    id: "c1",
    level: "IN",
    difficulty: 12.5,
    from: 3,
    charter: "Charter",
    notes: 100,
    song: "s1",
    md5: "md5-of-chart",
    origin: { id: "c1" },
    chartFile: new Blob([text.encode('{"formatVersion":3}')], { type: "application/json" }),
    assetsFile: [{ id: "0", type: -1, name: "assets.zip", file: new Blob([new Uint8Array([7, 7])]) }],
});
await db.putSkin({
    id: "skin-1",
    name: "Skin",
    author: "Author",
    config: { holdAtlas: [1, 2] },
    files: new Map([
        ["Tap", { type: "Tap", kind: "image", file: new Uint8Array([4, 5]) }],
        ["HitSong0", { type: "HitSong0", kind: "audio", file: new Uint8Array([6]) }],
    ]),
});
await db.putUserData("gameConfig", { volume: 2, ptBestRecords: { c1: [100, 99, true, 99, "t"] } });

// ===== 歌曲：音频/曲绘字节与 mime 原样回来 =====
const song = await db.getSong("s1");
assert.equal(song.name, "Test Song");
assert.equal(song.from, 3);
assert.deepEqual(song.origin, { id: "s1", name: "Test Song" });
assert.deepEqual([...new Uint8Array(await song.songFile.arrayBuffer())], [1, 2, 3]);
assert.equal(song.songFile.type, "audio/ogg");
assert.deepEqual([...new Uint8Array(await song.illustrationFile.arrayBuffer())], [9, 8]);

// ===== 谱面：图表字节、assets 条目与索引字段原样回来 =====
const chart = await db.getChart("c1");
assert.equal(chart.level, "IN");
assert.equal(chart.difficulty, 12.5);
assert.equal(chart.md5, "md5-of-chart");
assert.equal(chart.song, "s1");
assert.equal(await chart.chartFile.text(), '{"formatVersion":3}');
assert.equal(chart.assetsFile.length, 1);
assert.equal(chart.assetsFile[0].name, "assets.zip");
assert.deepEqual([...new Uint8Array(await chart.assetsFile[0].file.arrayBuffer())], [7, 7]);
// 行里不能出现任何 Blob URL / 未序列化对象
for (const row of api.__records.values()) assert.equal(JSON.stringify(row.value).includes("blob:"), false);

// ===== 皮肤：files 是 Map，图片/音频字节按 kind 原样回来 =====
const skin = await db.getSkin("skin-1");
assert.equal(skin.author, "Author");
assert.deepEqual(skin.config, { holdAtlas: [1, 2] });
assert.ok(skin.files instanceof Map);
assert.equal(skin.files.get("Tap").kind, "image");
assert.deepEqual([...new Uint8Array(await skin.files.get("Tap").file.arrayBuffer())], [4, 5]);
assert.equal(skin.files.get("HitSong0").kind, "audio");
assert.deepEqual([...new Uint8Array(await skin.files.get("HitSong0").file.arrayBuffer())], [6]);

// ===== 设置行 =====
assert.deepEqual(await db.getUserData("gameConfig"), {
    volume: 2,
    ptBestRecords: { c1: [100, 99, true, 99, "t"] },
});

// ===== 列表只出元数据：整个流程不新增大对象读取 =====
const readsBefore = api.__stats.reads;
const charts = await db.listCharts();
const songs = await db.listSongs();
assert.equal(charts.length, 1);
assert.equal(charts[0].assetsFile.length, 1);
assert.equal(charts[0].chartFile, undefined);
assert.equal(songs.length, 1);
assert.equal(songs[0].songFile, undefined);
assert.equal(api.__stats.reads, readsBefore, "列表不得读取大字节");

console.log("check-ptdb-roundtrip: OK");
