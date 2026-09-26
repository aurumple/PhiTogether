/**
 * 检查 3：同曲两难度共享音频的引用计数。
 *   - 一首歌的音频/曲绘各只写一次（第二条难度不重写字节）；
 *   - 每条谱面行各持有共享音频的一个引用（提交后 retain，删除时 release）；
 *   - 删掉一条难度音频仍在；删掉最后一条难度级联删歌曲行，字节随之释放；
 *   - 替换歌曲字节（重新下载）时旧字节释放、谱面占位行原子换成新 blobId。
 * 运行：node script/check-ptdb-refcount.mjs
 */
import assert from "node:assert/strict";
import { createFakeApi } from "./check-ptdb-fakeapi.mjs";
import { createPlatformBackend } from "../src/components/ptdb/platformBackend.js";

const api = createFakeApi();
const db = createPlatformBackend(api);

const songRow = () => api.__records.get("songs s1");
const chartRow = id => api.__records.get(`charts ${id}`);
const audio = () => api.__blobs.get(songRow().value.songBlobId);

await db.putSong({
    id: "s1",
    name: "Song",
    composer: "C",
    illustrator: "I",
    from: 3,
    origin: { id: "s1" },
    songFile: new Blob([new Uint8Array([1])], { type: "audio/ogg" }),
    illustrationFile: new Blob([new Uint8Array([2])], { type: "image/png" }),
});
const audioId = songRow().value.songBlobId;
assert.equal(audio().refs, 1, "歌曲行持有 commit 自带的 1 个引用");
const writesAfterSong = api.__stats.writes; // 音频 + 曲绘各 1 次

// 同曲两个难度：音频字节不重复写，每条谱面行 retain 一次
await db.putChart(makeChart("c1"));
assert.equal(audio().refs, 2, "难度1 谱面行共享同一音频 blobId（retain 一次）");
assert.equal(chartRow("c1").value.songBlobId, audioId);
await db.putChart(makeChart("c2"));
assert.equal(audio().refs, 3, "难度2 谱面行再 retain 一次");
assert.equal(
    api.__stats.writes - writesAfterSong,
    2,
    "两条难度只新增谱面 JSON 两个 blob，音频/曲绘字节不重写"
);

// 删掉难度1：只释放它持有的引用，音频仍在
await db.deleteChart("c1");
assert.equal(audio().refs, 2);
assert.ok(api.__blobs.has(audioId), "同曲还有其他难度，音频不能删");

// 删掉难度2：级联删歌曲行（charts.ts 的删除语义），字节全部释放
await db.deleteChart("c2");
assert.equal(songRow(), undefined, "最后一条难度删除后歌曲行级联删除");
assert.equal(api.__blobs.has(audioId), false, "最后一条引用删除后音频字节释放");

// 替换歌曲字节（重新下载同曲）：旧字节释放、两条谱面的占位行原子指向新 blobId
await db.putSong(makeSong([9]));
const newAudioId = songRow().value.songBlobId;
assert.notEqual(newAudioId, audioId);
await db.putChart(makeChart("c1"));
await db.putChart(makeChart("c2"));
const oldAudioId = newAudioId;
const thirdAudio = (await db.putSong(makeSong([10])), songRow().value.songBlobId);
assert.notEqual(thirdAudio, oldAudioId);
assert.equal(api.__blobs.has(oldAudioId), false, "换字节后旧音频释放");
assert.equal(api.__blobs.get(thirdAudio).refs, 3, "歌曲行 + 2 条谱面行 = 3 个引用");
assert.equal(chartRow("c1").value.songBlobId, thirdAudio);
assert.equal(chartRow("c2").value.songBlobId, thirdAudio);

function makeSong(bytes) {
    return {
        id: "s1",
        name: "Song",
        composer: "C",
        illustrator: "I",
        from: 3,
        origin: { id: "s1" },
        songFile: new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }),
        illustrationFile: new Blob([new Uint8Array([2])], { type: "image/png" }),
    };
}
function makeChart(id) {
    return {
        id,
        level: "IN",
        difficulty: 12,
        from: 3,
        charter: "X",
        song: "s1",
        md5: `md5-${id}`,
        origin: { id },
        chartFile: new Blob([new TextEncoder().encode("{}")], { type: "application/json" }),
    };
}

console.log("check-ptdb-refcount: OK");
