/**
 * ptdb 存储后端选择层：公开 API（charts.ts/skin.ts/userData.ts）只依赖这里描述的
 * 一套接口，两种实现按运行模式二选一——
 *
 *   idbBackend       独立版：IndexedDB PTv0（现行为原样，逐操作搬自旧实现）；
 *   platformBackend  模块模式：window.__onetapPlatform.api 的 records + blobs。
 *
 * 模块运行在宿主隔离容器（opaque 来源）：没有 IndexedDB/localStorage/网络，
 * 选择依据是「容器里才有 __onetapPlatform」，不看构建宏。
 */
import openDB from "./openDB";
import ObjectStores from "./ObjectStores";
import shared from "@utils/js/shared";
import { createPlatformBackend, isPlatformMode, getPlatformApi } from "./platformBackend.js";

export interface PtdbBackend {
    kind: "idb" | "platform";
    getChart(id: string | number): Promise<any | null>;
    putChart(chart: any): Promise<boolean>;
    deleteChart(id: string | number): Promise<boolean>;
    listCharts(): Promise<any[]>;
    getSong(id: string | number): Promise<any | null>;
    putSong(song: any): Promise<boolean>;
    deleteSong(id: string | number): Promise<boolean>;
    listSongs(): Promise<any[]>;
    hasSong(id: string | number): Promise<boolean>;
    getSkin(id: string): Promise<any | null>;
    putSkin(skin: any): Promise<any>;
    deleteSkin(id: string): Promise<boolean>;
    listSkins(): Promise<any[]>;
    getUserData(id: string): Promise<any | null>;
    putUserData(id: string, value: any): Promise<boolean>;
    /** 原子 read-merge-write：mutator(当前值|null)→新值，undefined 表示放弃写入。 */
    updateUserData(id: string, mutator: (cur: any) => any): Promise<any>;
    /** 多行同一原子批提交（模块模式同一 records.batch；IDB 同一事务）。 */
    updateUserDataBatch(items: { id: string; mutator: (cur: any) => any }[]): Promise<any[]>;
}

// ===== IndexedDB 实现：与迁移前的 openDB 调用逐条对应（独立版不回归） =====
const idbBackend: PtdbBackend = {
    kind: "idb",

    getChart(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Chart])
                        .objectStore(ObjectStores.Chart);
                    const getReq = objStore.get(id as string | number);
                    getReq.onsuccess = e => res(getReq.result || null);
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    putChart(chart) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const tx = db.transaction([ObjectStores.Chart], "readwrite");
                    tx.oncomplete = () => res(true);
                    tx.onerror = () => rej(tx.error);
                    tx.onabort = () => rej(tx.error || new Error("Storage write aborted"));
                    const objStore = tx.objectStore(ObjectStores.Chart);
                    const getReq = objStore.get(chart.id);
                    getReq.onsuccess = e => {
                        if (getReq.result) objStore.put(chart);
                        else objStore.add(chart);
                    };
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    // 同曲多难度共用歌曲记录（音频/曲绘只存一份）：删除谱面记录时若该歌曲
    // 已无任何谱面，一并删除歌曲记录，避免残留音频占用空间。
    deleteChart(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Chart], "readwrite")
                        .objectStore(ObjectStores.Chart);
                    const getReq = objStore.get(id as string | number);
                    getReq.onerror = e => rej(e);
                    getReq.onsuccess = e => {
                        const record = getReq.result;
                        objStore.delete(id as string | number);
                        if (!record) return res(true);
                        const left = objStore.openCursor();
                        let remaining = 0;
                        left.onerror = e => rej(e);
                        left.onsuccess = () => {
                            const cursor = left.result;
                            if (cursor) {
                                if (cursor.value && cursor.value.song === record.song) remaining++;
                                cursor.continue();
                            } else {
                                if (!remaining) {
                                    db.transaction([ObjectStores.Song], "readwrite")
                                        .objectStore(ObjectStores.Song)
                                        .delete(record.song);
                                }
                                res(true);
                            }
                        };
                    };
                })
                .catch(e => rej(e));
        });
    },
    listCharts() {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Chart])
                        .objectStore(ObjectStores.Chart);
                    objStore.getAll().onsuccess = e => {
                        res((e.target as IDBRequest).result);
                    };
                })
                .catch(e => rej(e));
        });
    },

    getSong(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Song])
                        .objectStore(ObjectStores.Song);
                    const getReq = objStore.get(id as string | number);
                    getReq.onsuccess = e => res(getReq.result || null);
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    putSong(song) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const tx = db.transaction([ObjectStores.Song], "readwrite");
                    tx.oncomplete = () => res(true);
                    tx.onerror = () => rej(tx.error);
                    tx.onabort = () => rej(tx.error || new Error("Storage write aborted"));
                    const objStore = tx.objectStore(ObjectStores.Song);
                    const getReq = objStore.get(song.id);
                    getReq.onsuccess = e => {
                        if (getReq.result) objStore.put(song);
                        else objStore.add(song);
                    };
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    deleteSong(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Song], "readwrite")
                        .objectStore(ObjectStores.Song);
                    const getReq = objStore.delete(id as string | number);
                    getReq.onsuccess = e => res(true);
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    listSongs() {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Song])
                        .objectStore(ObjectStores.Song);
                    objStore.getAll().onsuccess = e => {
                        res((e.target as IDBRequest).result);
                    };
                })
                .catch(e => rej(e));
        });
    },
    hasSong(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Song])
                        .objectStore(ObjectStores.Song);
                    objStore.getAllKeys().onsuccess = e => {
                        res((e.target as IDBRequest).result.includes(id));
                    };
                })
                .catch(e => rej(e));
        });
    },

    getSkin(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Skin])
                        .objectStore(ObjectStores.Skin);
                    const getReq = objStore.get(id);
                    getReq.onsuccess = e => {
                        const result = getReq.result;
                        if (result) res(normalizeIdbSkin(result));
                        else res(null);
                    };
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    // 皮肤文件按「原始字节 + kind」入参；IDB 存储格式不变（图片解码为 ImageBitmap，
    // 音频存 ArrayBuffer），与迁移前 saveSkin 的落库结果一致。
    async putSkin(skin) {
        const files: Map<string, any> = new Map();
        for (const [type, entry] of skin.files instanceof Map
            ? skin.files.entries()
            : Object.entries(skin.files || {})) {
            const kind = entry.kind || (String(type).startsWith("HitSong") ? "audio" : "image");
            const bytes =
                entry.file instanceof Blob
                    ? new Uint8Array(await entry.file.arrayBuffer())
                    : entry.file instanceof ArrayBuffer
                      ? new Uint8Array(entry.file)
                      : entry.file;
            files.set(entry.type || type, {
                type: entry.type || type,
                imgOptions: entry.imgOptions,
                file:
                    kind === "image"
                        ? await createImageBitmap(new Blob([bytes as BlobPart]))
                        : (bytes as Uint8Array).slice().buffer,
            });
        }
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    db.transaction([ObjectStores.Skin], "readwrite")
                        .objectStore(ObjectStores.Skin)
                        .add({
                            id: skin.id,
                            name: skin.name,
                            author: skin.author,
                            files,
                            config: skin.config,
                        });
                    res(skin.id);
                })
                .catch(e => rej(e));
        });
    },
    deleteSkin(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Skin], "readwrite")
                        .objectStore(ObjectStores.Skin);
                    const getReq = objStore.delete(id);
                    getReq.onsuccess = e => res(true);
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    listSkins() {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.Skin])
                        .objectStore(ObjectStores.Skin);
                    objStore.getAll().onsuccess = e => {
                        const result = (e.target as IDBRequest).result || [];
                        res(result.map(normalizeIdbSkin));
                    };
                })
                .catch(e => rej(e));
        });
    },

    getUserData(id) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const objStore = db
                        .transaction([ObjectStores.UserData])
                        .objectStore(ObjectStores.UserData);
                    const getReq = objStore.get(id);
                    getReq.onsuccess = e => {
                        const result = getReq.result;
                        res(result ? result.gameConfig : null);
                    };
                    getReq.onerror = e => rej(e);
                })
                .catch(e => rej(e));
        });
    },
    putUserData(id, value) {
        return this.updateUserData(id, () => value).then(() => true);
    },
    updateUserData(id, mutator) {
        return this.updateUserDataBatch([{ id, mutator }]).then(nexts => nexts[0]);
    },
    // 多行在同一 readwrite 事务里 get→合并→put：与模块模式的 records.batch 同语义
    //（要么全部落盘要么全不落盘，读改写之间不会被其他写入插队）。
    updateUserDataBatch(items) {
        return new Promise((res, rej) => {
            openDB()
                .then(db => {
                    const tx = db.transaction([ObjectStores.UserData], "readwrite");
                    const objStore = tx.objectStore(ObjectStores.UserData);
                    const nexts: any[] = [];
                    tx.oncomplete = () => res(nexts);
                    tx.onerror = () => rej(tx.error || new Error("Storage write failed"));
                    tx.onabort = () => rej(tx.error || new Error("Storage write aborted"));
                    items.forEach((item, i) => {
                        const getReq = objStore.get(item.id);
                        getReq.onsuccess = e => {
                            try {
                                const cur = getReq.result ? getReq.result.gameConfig : null;
                                const next = item.mutator(cur);
                                nexts[i] = next;
                                if (next !== undefined) {
                                    if (getReq.result)
                                        objStore.put({ id: item.id, gameConfig: next });
                                    else objStore.add({ id: item.id, gameConfig: next });
                                }
                            } catch (err) {
                                tx.abort();
                                rej(err);
                            }
                        };
                        getReq.onerror = e => rej(e);
                    });
                })
                .catch(e => rej(e));
        });
    },
};

/** 旧皮肤行没有 kind 字段：按条目名推断（HitSong* 是音频，其余是图片）。 */
function normalizeIdbSkin(row: any) {
    if (!row || !row.files) return row;
    const map = new Map();
    for (const [type, entry] of row.files instanceof Map
        ? row.files.entries()
        : Object.entries(row.files)) {
        map.set(type, {
            ...entry,
            type: entry.type || type,
            kind: entry.kind || (String(type).startsWith("HitSong") ? "audio" : "image"),
        });
    }
    return { ...row, files: map };
}

// ===== 可恢复存储错误的用户提示（配额/内容校验失败不能静默丢数据） =====
export function isRecoverableStorageError(e: any): boolean {
    return (
        !!e &&
        (e.code === "QUOTA_EXCEEDED" ||
            e.code === "CONTENT_INVALID" ||
            e.name === "QuotaExceededError")
    );
}

function notifyStorageError(e: any) {
    if (!isRecoverableStorageError(e)) return;
    try {
        const handler = shared.game && shared.game.msgHandler;
        if (!handler || !handler.sendMessage) return;
        const t = shared.game.i18n && shared.game.i18n.t;
        const key =
            e.code === "CONTENT_INVALID" ? "storage.contentInvalid" : "storage.quotaExceeded";
        handler.sendMessage((t && t(key)) || key, "error");
    } catch {
        /* 提示失败不影响错误继续向上传播 */
    }
}

/** 写路径包一层：可恢复的存储错误先弹提示再照常抛出（调用方仍可自行兜底）。 */
function withErrorNotice<T extends object>(backend: T): T {
    const wrapped: any = { ...backend };
    for (const name of [
        "putChart",
        "putSong",
        "putSkin",
        "putUserData",
        "updateUserData",
        "updateUserDataBatch",
    ]) {
        const fn = (backend as any)[name];
        if (typeof fn !== "function") continue;
        wrapped[name] = async (...args: any[]) => {
            try {
                return await fn.apply(backend, args);
            } catch (e) {
                notifyStorageError(e);
                throw e;
            }
        };
    }
    return wrapped;
}

let platformInstance: PtdbBackend | null = null;
let idbInstance: PtdbBackend | null = null;

/** 当前生效的存储后端（每次调用现判模式，便于测试与初始化顺序）。 */
export function getBackend(): PtdbBackend {
    if (isPlatformMode()) {
        if (!platformInstance)
            platformInstance = withErrorNotice(createPlatformBackend(getPlatformApi()!));
        return platformInstance;
    }
    if (!idbInstance) idbInstance = withErrorNotice(idbBackend);
    return idbInstance;
}

export { isPlatformMode };
