/**
 * ptdb 的模块模式存储后端（OneTap SDK records + blobs）。
 *
 * 容器是 opaque 来源：没有 IndexedDB/localStorage/网络。所有持久化经
 * `window.__onetapPlatform.api` 回到宿主，键的账号隔离由宿主负责，模块侧只写
 * collection/key。数据布局（值里只存稳定 id/blobId，绝不持久化 Blob URL）：
 *
 *   charts   元数据行（key=String(chart_id)）：原索引字段 + chartBlobId +
 *            assets[{id,type,name,blobId,mime}] + 同曲音频/曲绘的引用占位
 *            （songBlobId/illustrationBlobId：字节在 songs 行，占位只为引用计数）
 *   songs    元数据行（key=String(songId)）：音频/曲绘各自一个 blobId
 *   skins    元数据行（key=skinId）：config + files[{type,kind,blobId,mime,imgOptions}]
 *   settings 用户数据行（key=原 id，如 gameConfig/pendingPtUploads）：值即负载
 *
 * 引用计数约定（宿主：commit 后 refs=1，release 到 0 即删字节）：
 *   - 新写入的 blob 由「第一个引用它的行」继承 commit 自带的那 1 个引用；
 *   - 其余引用它的行各 retain 一次（同曲不同难度的谱面行共享同一音频 blobId）；
 *   - 行被替换/删除时按持有数逐个 release，最后一条引用删除时字节自动释放。
 *
 * 本文件是自包含的纯 JS（不 import 业务模块），以便用假 api 对象做 node 检查
 * （script/check-ptdb-*.mjs）。
 */

export const COLLECTIONS = {
    charts: "charts",
    songs: "songs",
    skins: "skins",
    settings: "settings",
};

/** records.batch 单批上限（宿主契约 ≤200 条）。超出即整体失败，保持旧状态。 */
const BATCH_LIMIT = 200;
/** expectRev 冲突重试次数：并发写同一行时重新读取-合并。 */
const CAS_RETRIES = 8;

function conflictError(message) {
    const error = new Error(message || "存储冲突重试次数耗尽");
    error.code = "CONFLICT";
    return error;
}

function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

/** 多重集差：before→after 每个 blobId 的 retain/release 次数（同 id 多次引用按次数计）。 */
function refDelta(before, after) {
    const counts = new Map();
    for (const id of before) counts.set(id, (counts.get(id) || 0) - 1);
    for (const id of after) counts.set(id, (counts.get(id) || 0) + 1);
    return [...counts.entries()];
}

export function createPlatformBackend(api) {
    /** Blob 对象 → 已提交 blobId：编辑-保存往返（get→改元数据→save）不重写字节。 */
    const blobIds = new WeakMap();

    async function getRow(collection, key) {
        return (await api.records.get(collection, String(key))) || null;
    }

    async function listRows(collection) {
        const rows = [];
        let cursor = "";
        for (;;) {
            const page = await api.records.list(collection, { cursor, limit: 200 });
            if (!page || !Array.isArray(page.rows)) break;
            for (const row of page.rows) rows.push(row);
            if (!page.next) break;
            cursor = page.next;
        }
        return rows;
    }

    /**
     * 把一份字节提交为 blob。传入的 Blob 若是我们之前读/写出过的对象且字节仍在，
     * 直接复用 blobId（fresh=false），避免整段重写大文件。
     * 空内容（缺曲绘的谱面等）不建大对象：桥面拒绝 size≤0 的写入，行上不写引用键，
     * 读取端 readBlobAsBlob 对缺失引用返回空 Blob，语义一致。
     */
    async function ensureBlob(value, mime) {
        if (value instanceof Blob) {
            const known = blobIds.get(value);
            if (known) {
                const meta = await api.blobs.stat(known).catch(() => null);
                if (meta) return { id: known, fresh: false };
            }
            const view = new Uint8Array(await value.arrayBuffer());
            if (!view.byteLength) return { id: null, fresh: false };
            const id = await api.blobs.write(view, { mime: mime || value.type || "" });
            blobIds.set(value, id);
            return { id, fresh: true };
        }
        const bytes = toBytes(value);
        if (!bytes) {
            const error = new Error("无法写入的二进制内容");
            error.code = "CONTENT_INVALID";
            throw error;
        }
        if (!bytes.byteLength) return { id: null, fresh: false };
        const id = await api.blobs.write(bytes, { mime: mime || "" });
        return { id, fresh: true };
    }

    async function readBlobAsBlob(blobId, mime) {
        if (!blobId) return new Blob([]);
        const bytes = await api.blobs.read(blobId);
        const blob = new Blob([bytes], { type: mime || "" });
        blobIds.set(blob, blobId);
        return blob;
    }

    /**
     * 行提交后按持有数补齐/释放引用。fresh 集合里的 blob 是本次新写入的：
     * commit 自带的那 1 个引用归第一个引用它的行，不再 retain。
     */
    async function applyRefDiff(before, after, fresh) {
        for (const [id, delta] of refDelta(before, after)) {
            if (delta > 0) {
                let retain = delta;
                if (fresh.has(id)) {
                    retain -= 1;
                    fresh.delete(id);
                }
                while (retain-- > 0) await api.blobs.retain(id);
            } else if (delta < 0) {
                let release = -delta;
                while (release-- > 0) await api.blobs.release(id);
            }
        }
    }

    /** 写入失败时归还本次新写 blob 的 commit 引用，避免配额泄漏。 */
    async function abortFresh(fresh) {
        const ids = [...fresh];
        fresh.clear();
        for (const id of ids) await api.blobs.release(id).catch(() => undefined);
    }

    function chartRefs(value) {
        return [
            value.chartBlobId,
            ...(Array.isArray(value.assets) ? value.assets.map(a => a && a.blobId) : []),
            value.songBlobId,
            value.illustrationBlobId,
        ].filter(Boolean);
    }
    function songRefs(value) {
        return [value.songBlobId, value.illustrationBlobId].filter(Boolean);
    }
    function skinRefs(value) {
        return (Array.isArray(value.files) ? value.files : [])
            .map(f => f && f.blobId)
            .filter(Boolean);
    }
    function refsOf(collection, value) {
        if (!value) return [];
        if (collection === COLLECTIONS.charts) return chartRefs(value);
        if (collection === COLLECTIONS.songs) return songRefs(value);
        if (collection === COLLECTIONS.skins) return skinRefs(value);
        return [];
    }

    /**
     * 通用「带引用计数的行写入」。
     *   extras(oldRowValue) → 需要同批原子更新/校验的其他行（可 async）：
     *       [{collection, key, value(oldValue|undefined)}]，value 返回 undefined 表示
     *       该行不存在且不需要写（省掉锚点）。
     *   value(oldRowValue, extraOldValues) → 本行新值；extraOldValues 是
     *       Map(`${collection}:${key}` → 最新旧行值)。每次重试都按最新旧行重算，
     *       不覆盖并发改动。
     * 全部行在同一个 records.batch 里提交（expectRev CAS，冲突即重读重算）。
     */
    async function putRowWithRefs(collection, key, extras, value, fresh) {
        for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
            const oldMain = await getRow(collection, key);
            const extraDefs = (await extras(oldMain ? oldMain.value : undefined)) || [];
            const extraRows = [];
            const extraOldValues = new Map();
            for (const def of extraDefs) {
                const old = await getRow(def.collection, def.key);
                extraOldValues.set(`${def.collection}:${def.key}`, old ? old.value : undefined);
                const next = def.value(old ? old.value : undefined);
                if (next !== undefined) extraRows.push({ ...def, old, next });
            }
            const mainValue = await value(oldMain ? oldMain.value : undefined, extraOldValues);
            const before = [
                ...refsOf(collection, oldMain && oldMain.value),
                ...extraRows.flatMap(r => refsOf(r.collection, r.old && r.old.value)),
            ];
            const after = [
                ...refsOf(collection, mainValue),
                ...extraRows.flatMap(r => refsOf(r.collection, r.next)),
            ];
            const ops = [
                {
                    op: "put",
                    collection,
                    key: String(key),
                    value: mainValue,
                    // 宿主 CAS 语义：不存在的行按 rev=0 比对，带 expectRev=0 即「只许新建」
                    expectRev: oldMain ? oldMain.rev : 0,
                },
                ...extraRows.map(r => ({
                    op: "put",
                    collection: r.collection,
                    key: String(r.key),
                    value: r.next,
                    expectRev: r.old ? r.old.rev : 0,
                })),
            ];
            if (ops.length > BATCH_LIMIT) {
                const error = new Error("单次原子写入超出条数上限");
                error.code = "REQUEST_INVALID";
                throw error;
            }
            try {
                await api.records.batch(ops);
            } catch (e) {
                if (e && e.code === "CONFLICT") continue;
                await abortFresh(fresh);
                throw e;
            }
            await applyRefDiff(before, after, fresh);
            return true;
        }
        await abortFresh(fresh);
        throw conflictError();
    }

    /** 通用「带引用计数的行删除」；cascade 里是随行一起删除的其他行。 */
    async function removeRowWithRefs(collection, key, cascade) {
        const row = await getRow(collection, key);
        if (!row) return false;
        const extra = [];
        for (const item of cascade || []) {
            const row2 = await getRow(item.collection, item.key);
            if (row2) extra.push({ ...item, row: row2 });
        }
        const before = [
            ...refsOf(collection, row.value),
            ...extra.flatMap(r => refsOf(r.collection, r.row.value)),
        ];
        const ops = [
            { op: "remove", collection, key: String(key) },
            ...extra.map(r => ({ op: "remove", collection: r.collection, key: String(r.key) })),
        ];
        await api.records.batch(ops);
        await applyRefDiff(before, [], new Set());
        return true;
    }

    // ===== charts =====
    async function getChart(id) {
        const row = await getRow(COLLECTIONS.charts, id);
        if (!row) return null;
        const { chartBlobId, chartMime, assets, songBlobId, illustrationBlobId, ...meta } = row.value;
        const out = { ...meta };
        out.chartFile = await readBlobAsBlob(chartBlobId, chartMime);
        out.assetsFile = [];
        for (const a of assets || []) {
            out.assetsFile.push({
                id: a.id,
                type: a.type,
                name: a.name,
                file: await readBlobAsBlob(a.blobId, a.mime),
            });
        }
        return out;
    }

    async function putChart(chart) {
        const fresh = new Set();
        try {
            const chartBlob = await ensureBlob(chart.chartFile);
            if (chartBlob.fresh) fresh.add(chartBlob.id);
            const assets = [];
            for (const a of chart.assetsFile || []) {
                const blob = await ensureBlob(a.file);
                if (blob.fresh) fresh.add(blob.id);
                assets.push({
                    id: a.id,
                    type: a.type,
                    name: a.name,
                    blobId: blob.id,
                    mime: (a.file && a.file.type) || "",
                });
            }
            const { chartFile, assetsFile, parsedChart, ...meta } = chart;
            const songKey = chart.song != null ? String(chart.song) : null;
            return await putRowWithRefs(
                COLLECTIONS.charts,
                String(chart.id),
                () =>
                    songKey
                        ? [
                              {
                                  collection: COLLECTIONS.songs,
                                  key: songKey,
                                  // 歌曲行只作版本锚点：换音频的 putSong 与本行写入
                                  // 必须互斥，否则占位会指向已释放的字节。
                                  value: old => old,
                              },
                          ]
                        : [],
                (oldValue, extraOldValues) => {
                    const songValue = extraOldValues.get(`${COLLECTIONS.songs}:${songKey}`);
                    const value = {
                        ...meta,
                        chartBlobId: chartBlob.id,
                        chartMime: (chartFile && chartFile.type) || "",
                        assets,
                        // 同曲音频/曲绘的引用占位：字节在 songs 行，这里只为「同曲不同
                        // 难度共享同一音频 blobId」计数——每条谱面行各持有一个引用。
                        songBlobId: songValue ? songValue.songBlobId : undefined,
                        illustrationBlobId: songValue ? songValue.illustrationBlobId : undefined,
                    };
                    for (const k of Object.keys(value)) if (value[k] == null) delete value[k];
                    return value;
                },
                fresh
            );
        } catch (e) {
            await abortFresh(fresh);
            throw e;
        }
    }

    async function deleteChart(id) {
        const key = String(id);
        const row = await getRow(COLLECTIONS.charts, key);
        if (!row) return true;
        const cascade = [];
        // 级联：该歌曲已无任何谱面时一并删除歌曲行（保留 charts.ts 的删除语义）。
        const songKey = row.value.song != null ? String(row.value.song) : null;
        if (songKey) {
            const remaining = (await listRows(COLLECTIONS.charts)).filter(
                r => r.key !== key && String(r.value.song) === songKey
            );
            if (!remaining.length && (await getRow(COLLECTIONS.songs, songKey)))
                cascade.push({ collection: COLLECTIONS.songs, key: songKey });
        }
        await removeRowWithRefs(COLLECTIONS.charts, key, cascade);
        return true;
    }

    async function listCharts() {
        const rows = await listRows(COLLECTIONS.charts);
        return rows.map(r => {
            const { chartBlobId, chartMime, assets, songBlobId, illustrationBlobId, ...meta } =
                r.value;
            // 只给元数据 + assets 条数（cachedChart2Meta 用 assetsFile.length 生成
            // /PTVirtual/assets/ 占位 URL），不读大字节。
            return {
                ...meta,
                assetsFile: (assets || []).map(a => ({ id: a.id, type: a.type, name: a.name })),
            };
        });
    }

    // ===== songs =====
    async function getSong(id) {
        const row = await getRow(COLLECTIONS.songs, id);
        if (!row) return null;
        const { songBlobId, songMime, illustrationBlobId, illustrationMime, ...meta } = row.value;
        return {
            ...meta,
            songFile: await readBlobAsBlob(songBlobId, songMime),
            illustrationFile: await readBlobAsBlob(illustrationBlobId, illustrationMime),
        };
    }

    async function putSong(song) {
        const fresh = new Set();
        try {
            const songBlob = await ensureBlob(song.songFile);
            if (songBlob.fresh) fresh.add(songBlob.id);
            const illustrationBlob = await ensureBlob(song.illustrationFile);
            if (illustrationBlob.fresh) fresh.add(illustrationBlob.id);
            const { songFile, illustrationFile, charts, ...meta } = song;
            const value = {
                ...meta,
                songBlobId: songBlob.id,
                songMime: (songFile && songFile.type) || "",
                illustrationBlobId: illustrationBlob.id,
                illustrationMime: (illustrationFile && illustrationFile.type) || "",
            };
            for (const k of Object.keys(value)) if (value[k] == null) delete value[k];
            // 同曲多难度的谱面行持有同一音频/曲绘的引用占位：换字节时必须与歌曲行
            // 一起原子更新（同一批 batch），否则会出现占位指向已释放字节的半状态。
            return await putRowWithRefs(
                COLLECTIONS.songs,
                String(song.id),
                async () => {
                    const dependents = (await listRows(COLLECTIONS.charts)).filter(
                        r => String(r.value.song) === String(song.id)
                    );
                    return dependents.map(r => ({
                        collection: COLLECTIONS.charts,
                        key: r.key,
                        value: old =>
                            old
                                ? { ...old, songBlobId: songBlob.id, illustrationBlobId: illustrationBlob.id }
                                : undefined,
                    }));
                },
                () => value,
                fresh
            );
        } catch (e) {
            await abortFresh(fresh);
            throw e;
        }
    }

    async function deleteSong(id) {
        // 只删歌曲行：谱面行仍持有各自的共享引用，字节在最后一条引用删除时释放
        //（旧实现里歌曲行一删音频即失效；这里字节保留到谱面也删完，读取语义不变——
        // getChartsFiles 仍先查歌曲行）。
        return await removeRowWithRefs(COLLECTIONS.songs, String(id), []);
    }

    async function listSongs() {
        const rows = await listRows(COLLECTIONS.songs);
        return rows.map(r => {
            const { songBlobId, songMime, illustrationBlobId, illustrationMime, ...meta } = r.value;
            return meta;
        });
    }

    async function hasSong(id) {
        return !!(await getRow(COLLECTIONS.songs, id));
    }

    // ===== skins =====
    async function getSkin(id) {
        const row = await getRow(COLLECTIONS.skins, id);
        if (!row) return null;
        const { files, ...meta } = row.value;
        const map = new Map();
        for (const f of files || []) {
            map.set(f.type, {
                type: f.type,
                kind: f.kind,
                imgOptions: f.imgOptions,
                file: await readBlobAsBlob(f.blobId, f.mime),
            });
        }
        return { ...meta, files: map };
    }

    async function putSkin(skin) {
        const fresh = new Set();
        try {
            const files = [];
            for (const [type, entry] of skin.files instanceof Map
                ? skin.files.entries()
                : Object.entries(skin.files || {})) {
                const blob = await ensureBlob(entry.file);
                if (blob.fresh) fresh.add(blob.id);
                files.push({
                    type: entry.type || type,
                    kind: entry.kind || (String(type).startsWith("HitSong") ? "audio" : "image"),
                    blobId: blob.id,
                    imgOptions: entry.imgOptions,
                });
            }
            const value = {
                id: skin.id,
                name: skin.name,
                author: skin.author,
                config: skin.config,
                files,
            };
            return await putRowWithRefs(
                COLLECTIONS.skins,
                String(skin.id),
                () => [],
                () => value,
                fresh
            );
        } catch (e) {
            await abortFresh(fresh);
            throw e;
        }
    }

    async function deleteSkin(id) {
        return await removeRowWithRefs(COLLECTIONS.skins, String(id), []);
    }

    async function listSkins() {
        const rows = await listRows(COLLECTIONS.skins);
        return rows.map(r => {
            const map = new Map();
            for (const f of r.value.files || [])
                map.set(f.type, { type: f.type, kind: f.kind, imgOptions: f.imgOptions });
            return {
                id: r.value.id,
                name: r.value.name,
                author: r.value.author,
                config: r.value.config,
                files: map,
            };
        });
    }

    // ===== settings（userData 行） =====
    async function getUserData(id) {
        const row = await getRow(COLLECTIONS.settings, id);
        return row ? row.value : null;
    }

    async function putUserData(id, value) {
        await api.records.put(COLLECTIONS.settings, String(id), value);
        return true;
    }

    /**
     * 原子 read-merge-write：mutator(当前值|null) → 新值（undefined 表示放弃写入）。
     * 全部条目在同一个 records.batch 里提交（防止互相覆盖），expectRev 不符即
     * CONFLICT → 重新读取再合并（旧响应不能删掉新成绩、不能降低最佳值）。
     */
    async function updateUserDataBatch(items) {
        for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
            const olds = [];
            for (const item of items) olds.push(await getRow(COLLECTIONS.settings, item.id));
            const nexts = items.map((item, i) => item.mutator(olds[i] ? olds[i].value : null));
            const ops = [];
            items.forEach((item, i) => {
                if (nexts[i] !== undefined)
                    ops.push({
                        op: "put",
                        collection: COLLECTIONS.settings,
                        key: String(item.id),
                        value: nexts[i],
                        // 不存在的行按 rev=0 比对：并发新建也走 CAS，不会互相覆盖
                        expectRev: olds[i] ? olds[i].rev : 0,
                    });
            });
            if (ops.length > BATCH_LIMIT) {
                const error = new Error("单次原子写入超出条数上限");
                error.code = "REQUEST_INVALID";
                throw error;
            }
            if (!ops.length) return nexts;
            try {
                await api.records.batch(ops);
                return nexts;
            } catch (e) {
                if (e && e.code === "CONFLICT") continue;
                throw e;
            }
        }
        throw conflictError();
    }

    async function updateUserData(id, mutator) {
        const nexts = await updateUserDataBatch([{ id, mutator }]);
        return nexts[0];
    }

    return {
        kind: "platform",
        getChart,
        putChart,
        deleteChart,
        listCharts,
        getSong,
        putSong,
        deleteSong,
        listSongs,
        hasSong,
        getSkin,
        putSkin,
        deleteSkin,
        listSkins,
        getUserData,
        putUserData,
        updateUserData,
        updateUserDataBatch,
    };
}

/** 模块模式判定：容器里才有 __onetapPlatform（独立版没有）。 */
export function isPlatformMode() {
    return (
        typeof window !== "undefined" &&
        !!(window.__onetapPlatform && window.__onetapPlatform.api)
    );
}

export function getPlatformApi() {
    return typeof window !== "undefined" && window.__onetapPlatform
        ? window.__onetapPlatform.api
        : null;
}
