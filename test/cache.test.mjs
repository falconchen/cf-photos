import test from 'node:test';
import assert from 'node:assert/strict';
import { CachedStorage } from '../src/services/CachedStorage.js';

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** 记录调用次数的假内层存储，形状对齐 WebDAVStorage。 */
function inner({ bytes = BYTES, status = 200, headers = {}, missing = false } = {}) {
    const calls = { get: [], put: [], delete: [], list: [] };
    const base = {
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
        'last-modified': 'Tue, 15 Sep 2026 00:00:00 GMT',
        'accept-ranges': 'bytes',
        ...headers,
    };
    return {
        calls,
        async get(key, options = {}) {
            calls.get.push({ key, options });
            if (missing) return null;
            const source = new Headers(base);
            return {
                body: new Response(bytes).body,
                status,
                httpEtag: '"abc123"',
                writeHttpMetadata(target) {
                    for (const name of ['content-type', 'content-length', 'last-modified', 'content-range', 'accept-ranges']) {
                        if (source.has(name)) target.set(name, source.get(name));
                    }
                },
            };
        },
        async put(key, body, options) { calls.put.push({ key, body, options }); },
        async delete(key) { calls.delete.push(key); },
        async list(options) { calls.list.push(options); return { objects: [], truncated: false, cursor: null }; },
    };
}

/** Map 撑起来的假 KV，只实现本层用到的三个方法。 */
function fakeKV() {
    const store = new Map();
    return {
        store,
        async getWithMetadata(key) {
            const entry = store.get(key);
            return entry ? { value: entry.value, metadata: entry.metadata } : { value: null, metadata: null };
        },
        async put(key, value, options = {}) {
            // 真实 KV 收到的是字节；存一份拷贝，避免测试里被后续改动影响。
            store.set(key, { value: new Uint8Array(value).buffer, metadata: options.metadata || null });
        },
        async delete(key) { store.delete(key); },
    };
}

/** 假 Cache，按 Request.url 索引。 */
function fakeCache() {
    const store = new Map();
    return {
        store,
        async match(request) {
            const hit = store.get(request.url);
            return hit ? hit.clone() : undefined;
        },
        async put(request, response) { store.set(request.url, response.clone()); },
        async delete(request) { return store.delete(request.url); },
    };
}

/** 收集 waitUntil 的假 ctx，便于在断言前等后台任务落地。 */
function fakeCtx() {
    const pending = [];
    return { pending, waitUntil(p) { pending.push(p); }, async settle() { await Promise.all(pending); } };
}

const KEY = 'i/2026/09/16/aaaaaaaa.png';

/** 建一个装好两层的实例 */
function build(storage, { kv = fakeKV(), cache = fakeCache(), ctx = fakeCtx() } = {}) {
    return { kv, cache, ctx, cached: new CachedStorage(storage, { PHOTO_CACHE: kv }, { ctx, origin: 'https://photos.example.com', cache }) };
}

/** 取出返回对象经 writeHttpMetadata 写出的头 */
function metadataOf(object) {
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    return headers;
}

test('首次读取回源并把字节写进两层缓存', async () => {
    const storage = inner();
    const { cached, kv, cache, ctx } = build(storage);

    const first = await cached.get(KEY);
    assert.equal(metadataOf(first).get('X-Cache'), 'MISS');
    assert.deepEqual(new Uint8Array(await new Response(first.body).arrayBuffer()), BYTES);

    await ctx.settle();
    assert.equal(kv.store.size, 1, 'L2 应写入');
    assert.equal(cache.store.size, 1, 'L1 应写入');
    assert.equal(storage.calls.get.length, 1);
});

test('第二次读取命中 L1，不再回源', async () => {
    const storage = inner();
    const { cached, ctx } = build(storage);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    const second = await cached.get(KEY);
    assert.equal(metadataOf(second).get('X-Cache'), 'HIT-L1');
    assert.equal(storage.calls.get.length, 1, '内层存储不该被第二次调用');
    assert.deepEqual(new Uint8Array(await new Response(second.body).arrayBuffer()), BYTES);
});

test('L1 失效后命中 L2 并回填 L1', async () => {
    const storage = inner();
    const { cached, cache, ctx } = build(storage);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    // 模拟换了一个数据中心：L1 空，L2 仍在。
    cache.store.clear();

    const hit = await cached.get(KEY);
    const headers = metadataOf(hit);
    assert.equal(headers.get('X-Cache'), 'HIT-L2');
    assert.equal(headers.get('content-type'), 'image/png');
    assert.equal(headers.get('content-length'), String(BYTES.byteLength));
    assert.deepEqual(new Uint8Array(await new Response(hit.body).arrayBuffer()), BYTES);
    assert.equal(storage.calls.get.length, 1, 'L2 命中不该回源');

    await ctx.settle();
    assert.equal(cache.store.size, 1, 'L2 命中应回填 L1');
});

test('Range 请求必定穿透到内层，且不读不写任何一层', async () => {
    const storage = inner({ status: 206, headers: { 'content-range': 'bytes 0-1/5' } });
    const { cached, kv, cache, ctx } = build(storage);

    const first = await cached.get(KEY, { range: 'bytes=0-1' });
    await ctx.settle();
    assert.equal(first.status, 206);
    assert.equal(metadataOf(first).get('X-Cache'), null, 'Range 响应不该带 X-Cache');
    assert.equal(metadataOf(first).get('content-range'), 'bytes 0-1/5');
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);

    await cached.get(KEY, { range: 'bytes=2-3' });
    assert.equal(storage.calls.get.length, 2, '每次 Range 都要打后端');
    assert.equal(storage.calls.get[0].options.range, 'bytes=0-1');
});

test('缺少 Content-Length 时不写缓存但正常返回', async () => {
    // 只写 content-type，刻意不给 content-length（部分 WebDAV 后端就是这样）。
    const bare = inner();
    bare.get = async (key, options = {}) => {
        bare.calls.get.push({ key, options });
        return {
            body: new Response(BYTES).body,
            status: 200,
            httpEtag: null,
            writeHttpMetadata(target) { target.set('content-type', 'image/png'); },
        };
    };
    const { cached, kv, cache, ctx } = build(bare);

    const object = await cached.get(KEY);
    assert.equal(metadataOf(object).get('X-Cache'), 'BYPASS');
    assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), BYTES);
    await ctx.settle();
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);

    await cached.get(KEY);
    assert.equal(bare.calls.get.length, 2, '没进缓存，下次仍要回源');
});

test('超过体积上限的文件不写缓存', async () => {
    const huge = new Uint8Array(16);
    const storage = inner({ bytes: huge, headers: { 'content-length': String(11 * 1024 * 1024) } });
    const { cached, kv, cache, ctx } = build(storage);

    const object = await cached.get(KEY);
    assert.equal(metadataOf(object).get('X-Cache'), 'BYPASS');
    await ctx.settle();
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);
});

test('文件不存在时返回 null，不缓存空结果', async () => {
    const storage = inner({ missing: true });
    const { cached, kv, cache, ctx } = build(storage);

    assert.equal(await cached.get(KEY), null);
    await ctx.settle();
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);

    assert.equal(await cached.get(KEY), null);
    assert.equal(storage.calls.get.length, 2, '404 不缓存，每次都要问后端');
});

test('删除会清掉两层，之后重新回源', async () => {
    const storage = inner();
    const { cached, kv, cache, ctx } = build(storage);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();
    assert.equal(kv.store.size, 1);

    await cached.delete(KEY);
    assert.deepEqual(storage.calls.delete, [KEY]);
    assert.equal(kv.store.size, 0, 'L2 应被清掉');
    assert.equal(cache.store.size, 0, 'L1 应被清掉');

    await cached.get(KEY);
    assert.equal(storage.calls.get.length, 2);
});

test('覆盖写入同一路径会清缓存，避免取回旧字节', async () => {
    const storage = inner();
    const { cached, kv, cache, ctx } = build(storage);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    await cached.put(KEY, new Uint8Array([9]), { httpMetadata: { contentType: 'image/png' } });
    assert.equal(storage.calls.put.length, 1);
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);
});

test('list 纯透传，不缓存', async () => {
    const storage = inner();
    const { cached } = build(storage);

    await cached.list({ prefix: 'i/', order: 'desc' });
    await cached.list({ prefix: 'i/', order: 'desc' });
    assert.equal(storage.calls.list.length, 2);
});

test('没有绑定时退化成纯透传，行为与裸存储一致', async () => {
    const storage = inner();
    // 既没有 PHOTO_CACHE，也显式把 cache 置空，等价于 node --test 下 caches 不存在。
    const cached = new CachedStorage(storage, {}, { ctx: null, cache: null });

    const first = await cached.get(KEY);
    assert.deepEqual(new Uint8Array(await new Response(first.body).arrayBuffer()), BYTES);
    await cached.get(KEY);
    assert.equal(storage.calls.get.length, 2, '无缓存时每次都要回源');

    await cached.delete(KEY);
    await cached.put(KEY, BYTES, {});
    assert.deepEqual(storage.calls.delete, [KEY]);
    assert.equal(storage.calls.put.length, 1);
});

test('ctx 为空对象时不抛异常', async () => {
    // 现有测试给 worker.fetch 传的就是 {}，直接调 ctx.waitUntil 会 TypeError。
    const storage = inner();
    const cached = new CachedStorage(storage, { PHOTO_CACHE: fakeKV() }, { ctx: {}, origin: 'https://photos.example.com', cache: fakeCache() });

    const object = await cached.get(KEY);
    assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), BYTES);
});

test('缓存命中写出的头与 WebDAVStorage.get 的白名单一致', async () => {
    const storage = inner();
    const { cached, cache, ctx } = build(storage);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    for (const [label, prepare] of [['L1', async () => {}], ['L2', async () => cache.store.clear()]]) {
        await prepare();
        const headers = metadataOf(await cached.get(KEY));
        const names = [...headers.keys()].filter(n => n !== 'x-cache').sort();
        assert.deepEqual(names, ['accept-ranges', 'content-length', 'content-type', 'last-modified'], label);
        // 存储用的 Cache-Control 绝不能流到客户端响应上。
        assert.equal(headers.get('cache-control'), null, label);
        assert.equal(headers.get('content-range'), null, label);
    }
});

test('ETag 会穿过两层保留下来', async () => {
    const storage = inner();
    const { cached, cache, ctx } = build(storage);

    assert.equal((await cached.get(KEY)).httpEtag, '"abc123"');
    await ctx.settle();

    assert.equal((await cached.get(KEY)).httpEtag, '"abc123"', 'L1');
    cache.store.clear();
    assert.equal((await cached.get(KEY)).httpEtag, '"abc123"', 'L2');
});
