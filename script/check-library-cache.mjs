import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { reactive } from "vue";
import md5 from "md5";

const rows = new Map();
let fetches = 0;
let offline = false;
globalThis.__libraryTest = {
    md5,
    ptdb: {
        gameConfig: {
            get: async key => {
                if (!rows.has(key)) throw new Error("missing");
                return structuredClone(rows.get(key));
            },
            save: async (value, key) => rows.set(key, structuredClone(value)),
            updateBatch: async items => {
                const next = items.map(item => [
                    item.id,
                    structuredClone(item.mutator(rows.get(item.id))),
                ]);
                for (const [key, value] of next) rows.set(key, value);
            },
        },
        fetch: async () => new Response(new Blob(["local"])),
    },
    moduleApi: () => null,
    authFetch: async () => {
        fetches++;
        if (offline) throw new Error("offline");
        return new Response(new Blob(["cover"]));
    },
};
globalThis.Image = class {
    naturalWidth = 1920;
    naturalHeight = 1080;
    set src(_) {
        queueMicrotask(() => this.onload());
    }
};
globalThis.document = {
    createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => "data:image/jpeg;base64,Y292ZXI=",
    }),
};
let source = await readFile(new URL("../src/utils/libraryCache.ts", import.meta.url), "utf8");
source = source
    .replace(/import ptdb[^;]+;/, "const { ptdb } = globalThis.__libraryTest;")
    .replace(
        /import \{ authFetch[^;]+;/,
        "const { authFetch, moduleApi } = globalThis.__libraryTest;"
    )
    .replace(/import md5[^;]+;/, "const { md5 } = globalThis.__libraryTest;");
const code = (await transformWithEsbuild(source, "libraryCache.ts", { loader: "ts" })).code;
const cache = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

const charts = reactive(
    Array.from({ length: 85 }, (_, i) => ({ name: `song${i}`, cover: `/cover/${i}` }))
);
await cache.saveLibrary(charts, reactive([{ name: "chapter" }]));
assert.equal((await cache.readLibrary()).charts.length, 85);
assert.equal((await cache.readLibrary()).chapters[0].name, "chapter");
const covers = await Promise.all([
    cache.cachedCover("/cover/0", "1"),
    cache.cachedCover("/cover/0", "1"),
]);
assert.equal(fetches, 1, "simultaneous chapter/song rows share a download");
assert.equal(covers[0], covers[1]);
await cache.cachedCover("/cover/0", "1");
assert.equal(fetches, 1, "a warm thumbnail never fetches again");
await cache.cachedCover("/cover/0", "2");
assert.equal(fetches, 2, "changed artwork invalidates only its own thumbnail");
offline = true;
assert.equal(
    await cache.cachedCover("/cover/0", "3"),
    covers[0],
    "offline refresh retains old artwork"
);
assert.equal((await cache.readLibrary()).charts.length, 85);
assert.equal(await cache.cachedCover("", "", "local-cover"), covers[0]);

rows.set("unrelated-scores", { a: 42 });
const oldRevision = cache.libraryRevision();
await cache.clearLibrary();
await cache.saveLibrary(charts, [], oldRevision);
assert.equal(
    (await cache.readLibrary()).charts.length,
    0,
    "late responses cannot restore a cleared snapshot"
);
assert.deepEqual(rows.get("unrelated-scores"), { a: 42 });
assert.ok([...rows].filter(([key]) => key.includes("cover:")).every(([, value]) => value === null));
delete globalThis.__libraryTest;
delete globalThis.Image;
delete globalThis.document;
console.log(
    "Library cache: reactive snapshots, paging, deduplication, invalidation, offline fallback and clearing passed"
);
