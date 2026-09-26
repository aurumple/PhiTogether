/**
 * 假的 OneTap 宿主 api（records + blobs），供 ptdb platformBackend 的 node 检查使用。
 * 语义镜像 OneTap-Next frontend/modules/cache.ts：
 *   - 记录行 {key, value, rev, updatedMs}，rev 从 1 起递增；不存在的行按 rev=0 做 CAS；
 *   - expectRev 不符抛带 code==='CONFLICT' 的 Error；batch 全部校验通过才落盘；
 *   - 大对象 commit 后 refs=1（归首个引用行）；retain +1；release 到 refs=1 即删字节。
 * 测试钩子：__stats 计数、__injectConflicts(n) 注入冲突、__blobs/__records 直查。
 */

function bridgeError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

export function createFakeApi() {
    const records = new Map(); // `${collection} ${key}` -> row
    const blobs = new Map(); // id -> {id, size, mime, bytes, refs}
    const stats = { writes: 0, reads: 0, retains: 0, releases: 0, removes: 0 };
    let injectedConflicts = 0;
    let blobSeq = 0;

    const rowKey = (collection, key) => `${collection} ${key}`;

    function putRow(collection, key, value, expectRev) {
        const id = rowKey(collection, key);
        const existing = records.get(id);
        if (expectRev !== undefined && (existing ? existing.rev : 0) !== expectRev)
            throw bridgeError("CONFLICT", "数据已被其他写入修改，请读后重试");
        const row = {
            key: String(key),
            value: JSON.parse(JSON.stringify(value)),
            rev: (existing ? existing.rev : 0) + 1,
            updatedMs: Date.now(),
        };
        records.set(id, row);
        return row;
    }

    return {
        records: {
            async get(collection, key) {
                return records.get(rowKey(collection, key)) || null;
            },
            async put(collection, key, value, options) {
                if (injectedConflicts > 0) {
                    injectedConflicts--;
                    throw bridgeError("CONFLICT", "注入的冲突");
                }
                return putRow(collection, key, value, options && options.expectRev);
            },
            async remove(collection, key) {
                return records.delete(rowKey(collection, key));
            },
            async list(collection, options) {
                const opts = options || {};
                const prefix = opts.prefix || "";
                const limit = opts.limit || 200;
                const all = [...records.entries()]
                    .filter(([id]) => id.startsWith(`${collection} ${prefix}`))
                    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
                let start = 0;
                if (opts.cursor) {
                    start = all.findIndex(
                        ([id]) => id.slice(collection.length + 1) > String(opts.cursor)
                    );
                    if (start < 0) start = all.length;
                }
                const page = all.slice(start, start + limit);
                return {
                    rows: page.map(([, row]) => row),
                    next: page.length === limit ? page[page.length - 1][1].key : null,
                };
            },
            async batch(ops) {
                if (injectedConflicts > 0) {
                    injectedConflicts--;
                    throw bridgeError("CONFLICT", "注入的冲突");
                }
                // 先整体校验再落盘：任何一条 expectRev 不符即全部不生效
                for (const op of ops) {
                    const existing = records.get(rowKey(op.collection, op.key));
                    if (op.expectRev !== undefined && (existing ? existing.rev : 0) !== op.expectRev)
                        throw bridgeError("CONFLICT", "数据已被其他写入修改，请读后重试");
                }
                const rows = [];
                for (const op of ops) {
                    if (op.op === "remove") records.delete(rowKey(op.collection, op.key));
                    else rows.push(putRow(op.collection, op.key, op.value, undefined));
                }
                return rows;
            },
        },
        blobs: {
            async write(bytes, options) {
                const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                const id = `blob-${++blobSeq}`;
                blobs.set(id, {
                    id,
                    size: view.byteLength,
                    mime: (options && options.mime) || "",
                    bytes: view.slice(),
                    refs: 1,
                });
                stats.writes++;
                return id;
            },
            async read(blobId) {
                const meta = blobs.get(blobId);
                if (!meta) throw bridgeError("NOT_FOUND", "大对象不存在");
                stats.reads++;
                return meta.bytes.slice();
            },
            async stat(blobId) {
                const meta = blobs.get(blobId);
                return meta
                    ? { id: meta.id, size: meta.size, mime: meta.mime, refs: meta.refs }
                    : null;
            },
            async retain(blobId) {
                const meta = blobs.get(blobId);
                if (!meta) throw bridgeError("NOT_FOUND", "大对象不存在");
                meta.refs++;
                stats.retains++;
                return { id: meta.id, size: meta.size, mime: meta.mime, refs: meta.refs };
            },
            async release(blobId) {
                const meta = blobs.get(blobId);
                if (!meta) return false;
                stats.releases++;
                if (meta.refs > 1) meta.refs--;
                else blobs.delete(blobId); // refs 归零自动释放字节
                return true;
            },
            async remove(blobId) {
                stats.removes++;
                return blobs.delete(blobId);
            },
        },
        // ---- 测试钩子 ----
        __stats: stats,
        __blobs: blobs,
        __records: records,
        __injectConflicts(n) {
            injectedConflicts = n;
        },
    };
}
