/**
 * OneTap-Next 模块 SDK（运行期）。
 *
 * 这个文件会被打包进模块自己的入口 JS，运行在宿主提供的隔离 iframe 里（opaque 来源、
 * 无 localStorage/IndexedDB、无网络）。模块能拿到的能力只有下面这些，宿主在另一侧逐条
 * 校验方法白名单、体积与账号隔离；模块不能自行指定 accountId，也拿不到会话令牌、
 * 安装密钥、密码/PIN 校验值或数据库句柄。
 *
 * 协议方言按实例协商：模块清单声明 bridgeMajor 1 或 2，容器告知实际方言。
 * v1 只有 assets/storage 等基础接口；v2 增加 records/blobs/game/files（需声明对应能力）。
 *
 * 模块的写法：
 *
 *   import { defineModule } from '@onetap/module-sdk';
 *   defineModule({
 *     async start(api) {
 *       const bytes = api.assets.read('assets/logo.png');
 *       const saved = await api.storage.get('counter');
 *       ...
 *       api.ready();
 *     }
 *   });
 *
 * 宿主在容器就绪后调用 start(api)；`api.ready()` 才会撤掉加载遮罩。
 */
const BRIDGE_MAJOR = 2;

function bridge(host) {
  if (!host || typeof host.invoke !== 'function') throw new Error('模块容器桥面不可用');
  if (host.bridgeMajor !== 1 && host.bridgeMajor !== BRIDGE_MAJOR) {
    throw new Error(`模块要求桥面版本 1~${BRIDGE_MAJOR}，当前容器为 ${host.bridgeMajor}`);
  }
  return host;
}

/** v2 扩展接口在 v1 容器里明确拒绝，不能静默半运行。 */
function requireV2(host) {
  if (host.bridgeMajor < 2) {
    const error = new Error('本模块功能需要桥面版本 2，请更新主程序');
    error.code = 'UNSUPPORTED_PROTOCOL';
    throw error;
  }
}

function createApi(host) {
  const instance = host.instance || {};
  const call = (method, params, binary, timeoutMs) => host.invoke(method, params, binary, timeoutMs);
  const api = {
    /** 当前实例信息。不含账号标识：存储命名空间由宿主按当前账号自动隔离。 */
    env: {
      moduleId: instance.moduleId, releaseId: instance.releaseId, displayVersion: instance.displayVersion,
      storageSchema: instance.storageSchema, capabilities: instance.capabilities || [],
      bridgeMajor: host.bridgeMajor
    },
    /** 完成挂载：撤去模块加载遮罩。 */
    ready() { host.ready(); },
    /** 返回模块目录：宿主释放当前实例。 */
    exit() { host.exit(); },
    /** 走全局“新对话”锁定链路。 */
    conceal() { host.conceal(); },
    assets: {
      /** 读取本版本包内不可变字节的副本；不存在返回 null。不触发任何外网补下载。 */
      read(path) { const file = host.file(path); return file ? new Uint8Array(file.bytes) : null; },
      /** 得到当前实例可用的 Blob URL（实例退出时统一释放）。 */
      url(path) { return host.url(path); }
    },
    storage: {
      async get(key) { return (await call('storage.get', { key })).value; },
      async set(key, value) { await call('storage.set', { key, value }); },
      async remove(key) { await call('storage.remove', { key }); },
      /** 只列出当前模块、当前账号的数据键。 */
      async list(prefix) { return (await call('storage.list', { prefix: prefix || '' })).keys; }
    },
    /** 受控权益读取：宿主按“当前账号 + 当前实例”回答，模块无法指定身份，也拿不到赞助档位。
     *  partial 模块必须用它同时控制付费功能的入口与实际执行逻辑，不能只隐藏按钮。
     *  拿不到能力、调用失败或返回未知形状时一律按未解锁处理，绝不默认 fullAccess=true。 */
    entitlements: {
      async get() {
        try {
          const value = await call('entitlements.get', {});
          return { fullAccess: !!(value && value.fullAccess === true) };
        } catch (error) {
          return { fullAccess: false };
        }
      }
    },
    /** 宿主准备退出等通知，用于平时增量保存；绝不作为锁屏前置条件。返回退订函数。 */
    lifecycle(handler) {
      return host.lifecycle((name, payload) => handler({ type: name, detail: payload || null }));
    },
    /** 预留的局域网能力：当前一律明确返回不支持，模块必须按能力缺失降级。 */
    async lanLeaderboard() { return call('lan.leaderboard', {}); }
  };

  // ---- v2：记录（data.records）：元数据分页读写，大二进制走 blobs ----
  api.records = {
    async get(collection, key) {
      requireV2(host);
      return (await call('records.get', { collection, key })).row;
    },
    /** expectRev 为上次读到的 row.rev：带上了就做 compare-and-set，冲突抛 CONFLICT。 */
    async put(collection, key, value, options) {
      requireV2(host);
      return (await call('records.put', { collection, key, value, expectRev: options && options.expectRev })).row;
    },
    async remove(collection, key) {
      requireV2(host);
      return (await call('records.remove', { collection, key })).removed;
    },
    /** 键分页：{rows, next}；next 再传回 cursor 继续。rows 含 {key,value,bytes,rev,updatedMs}。 */
    async list(collection, options) {
      requireV2(host);
      const opts = options || {};
      return call('records.list', { collection, prefix: opts.prefix || '', cursor: opts.cursor || '', limit: opts.limit || 0 });
    },
    /** 有限条原子批处理：全部成功或全部不落盘。ops: [{op:'put'|'remove', collection, key, value?, expectRev?}] */
    async batch(ops) {
      requireV2(host);
      return (await call('records.batch', { ops })).rows;
    }
  };

  // ---- v2：大对象（data.blobs）：分块持久化，commit 校验后原子可见 ----
  api.blobs = {
    /** 开始分块写入。writeId 只在本实例内有意义；commit 返回的 blob 才可持久引用。 */
    async beginWrite(options) {
      requireV2(host);
      const opts = options || {};
      return call('blobs.beginWrite', { size: opts.size, mime: opts.mime || '', sha256: opts.sha256 || '' }, undefined, 0);
    },
    /** bytes: Uint8Array|ArrayBuffer（转移传递，不复制）。同序号重写即幂等替换。 */
    async writeChunk(writeId, index, bytes) {
      requireV2(host);
      const buffer = bytes instanceof ArrayBuffer ? bytes
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return call('blobs.writeChunk', { writeId, index }, buffer, 0);
    },
    async commit(writeId, options) {
      requireV2(host);
      return (await call('blobs.commit', { writeId, sha256: (options && options.sha256) || '' }, undefined, 0)).blob;
    },
    async abort(writeId) {
      requireV2(host);
      return call('blobs.abort', { writeId }, undefined, 0);
    },
    /** 读一段字节（≤512KiB）。需要整对象时用 read()。 */
    async readChunk(blobId, offset, length) {
      requireV2(host);
      const answer = await call('blobs.readChunk', { blobId, offset, length }, undefined, 0);
      return new Uint8Array(answer.binary);
    },
    async remove(blobId) {
      requireV2(host);
      return call('blobs.remove', { blobId });
    },
    async stat(blobId) {
      requireV2(host);
      return (await call('blobs.stat', { blobId })).blob;
    },
    /** 分页列出已完成的大对象：{blobs, next}。 */
    async list(options) {
      requireV2(host);
      const opts = options || {};
      return call('blobs.list', { cursor: opts.cursor || '', limit: opts.limit || 0 });
    },
    /** 引用计数：同曲不同难度共享的音频，最后一次 release 才释放字节。 */
    async retain(blobId) {
      requireV2(host);
      return (await call('blobs.retain', { blobId })).blob;
    },
    async release(blobId) {
      requireV2(host);
      return call('blobs.release', { blobId });
    },
    /** 便捷：整段写入（自动分块 + commit）。返回 blobId。 */
    async write(bytes, options) {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const opts = options || {};
      const started = await api.blobs.beginWrite({ size: view.byteLength, mime: opts.mime, sha256: opts.sha256 });
      try {
        const chunk = started.chunkBytes || 524288;
        for (let offset = 0, index = 0; offset < view.byteLength; offset += chunk, index++) {
          await api.blobs.writeChunk(started.writeId, index, view.subarray(offset, Math.min(offset + chunk, view.byteLength)));
        }
        return (await api.blobs.commit(started.writeId, { sha256: opts.sha256 })).id;
      } catch (error) {
        await api.blobs.abort(started.writeId).catch(() => undefined);
        throw error;
      }
    },
    /** 便捷：读整对象（按 stat 的大小分块）。返回 Uint8Array。 */
    async read(blobId) {
      const meta = await api.blobs.stat(blobId);
      if (!meta) {
        const error = new Error('大对象不存在');
        error.code = 'NOT_FOUND';
        throw error;
      }
      const out = new Uint8Array(meta.size);
      const chunk = 524288;
      for (let offset = 0; offset < meta.size; offset += chunk) {
        out.set(await api.blobs.readChunk(blobId, offset, Math.min(chunk, meta.size - offset)), offset);
      }
      return out;
    }
  };

  // ---- v2：游戏服务（service.phitogether）：固定操作映射，不通任意 URL ----
  api.game = {
    /** operation 白名单：service.status / game.profile / game.charts / game.records /
     *  game.chart-leaderboard / game.leaderboard / game.me。params 为该操作的 JSON 参数。 */
    async call(operation, params) {
      requireV2(host);
      return (await call('game.call', { operation, params: params || {} }, undefined, 0)).result;
    },
    /** 按内容 ID 下载到宿主存储；onProgress(received, total) 可选。
     *  返回 {blobId, size, sha256}；取消用 game.cancel(contentId)，重试复用已验证块。 */
    async download(contentId, options) {
      requireV2(host);
      const opts = options || {};
      let stop = null;
      if (opts.onProgress) {
        stop = host.lifecycle((name, payload) => {
          if (name === 'game.download.progress' && payload && payload.contentId === contentId) {
            opts.onProgress(payload.received, payload.total);
          }
        });
      }
      try {
        return await call('game.download', { contentId }, undefined, 0);
      } finally {
        if (stop) stop();
      }
    },
    async cancel(contentId) {
      requireV2(host);
      return (await call('game.cancel', { contentId })).cancelled;
    }
  };

  // ---- v2：文件控件（files）：宿主真实点击触发，保持浏览器用户激活 ----
  api.files = {
    /** opts: {accept, multiple, maxBytes} → [{name, type, size, blobId}]（字节在 blobs 里）。 */
    async import(options) {
      requireV2(host);
      const opts = options || {};
      return (await call('files.import', {
        accept: opts.accept || '', multiple: opts.multiple === true, maxBytes: opts.maxBytes || 0
      }, undefined, 0)).files;
    },
    /** opts: {name, mime, blobId}：由宿主触发浏览器下载。 */
    async export(options) {
      requireV2(host);
      const opts = options || {};
      return call('files.export', { name: opts.name, mime: opts.mime || '', blobId: opts.blobId }, undefined, 0);
    }
  };

  return api;
}

export function defineModule(definition) {
  if (!definition || typeof definition.start !== 'function') throw new Error('defineModule 需要 { start(api) }');
  globalThis.OneTapModule = {
    start(host) {
      const api = createApi(bridge(host));
      return Promise.resolve(definition.start(api)).then(() => undefined);
    }
  };
  return definition;
}

export { BRIDGE_MAJOR };
