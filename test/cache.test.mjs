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

test('后端回 206 时原样透传，且绝不入缓存', async () => {
    // 非 gzip 的后端（本地 wrangler dev 那条链路）会真的分片。206 是部分内容，
    // 放进按 URL 索引的缓存会污染整文件条目。
    const storage = inner({ status: 206, headers: { 'content-range': 'bytes 0-1/5' } });
    const { cached, kv, cache, ctx } = build(storage);

    const first = await cached.get(KEY, { range: 'bytes=0-1' });
    await ctx.settle();
    assert.equal(first.status, 206);
    assert.equal(metadataOf(first).get('content-range'), 'bytes 0-1/5');
    assert.equal(metadataOf(first).get('X-Cache'), 'BYPASS');
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);
    assert.equal(storage.calls.get[0].options.range, 'bytes=0-1', 'Range 必须原样带给后端');
});

test('后端忽略 Range 回完整 200 时照常入缓存', async () => {
    // 这是生产环境的形状：mod_deflate 压了响应，Apache 忽略 Range。200 按定义是
    // 完整表示，可以缓存 —— 这也是只被 Range 访问过的视频唯一的入缓存机会。
    const storage = inner();
    const { cached, kv, cache, ctx } = build(storage);

    const first = await cached.get(KEY, { range: 'bytes=0-1' });
    assert.equal(first.status, 200);
    assert.equal(metadataOf(first).get('X-Cache'), 'MISS');
    assert.deepEqual(new Uint8Array(await new Response(first.body).arrayBuffer()), BYTES, '客户端拿到完整内容');
    await ctx.settle();
    assert.equal(kv.store.size, 1, '应已入缓存');
    assert.equal(cache.store.size, 1);

    // 下一次 seek 就该由本层切片，不再回源。
    const second = await cached.get(KEY, { range: 'bytes=1-3' });
    assert.equal(second.status, 206);
    assert.equal(metadataOf(second).get('content-range'), 'bytes 1-3/5');
    assert.equal(storage.calls.get.length, 1, '第二次 seek 不该回源');
});

test('从缓存切出真正的 206', async () => {
    const storage = inner();
    const { cached, cache, ctx } = build(storage);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    for (const [label, prepare] of [['L1', async () => {}], ['L2', async () => cache.store.clear()]]) {
        await prepare();
        const object = await cached.get(KEY, { range: 'bytes=1-3' });
        const headers = metadataOf(object);
        assert.equal(object.status, 206, label);
        assert.equal(headers.get('X-Cache'), label === 'L1' ? 'HIT-L1' : 'HIT-L2', label);
        assert.equal(headers.get('content-range'), 'bytes 1-3/5', label);
        assert.equal(headers.get('content-length'), '3', label);
        assert.equal(headers.get('accept-ranges'), 'bytes', label);
        assert.deepEqual(
            new Uint8Array(await new Response(object.body).arrayBuffer()),
            BYTES.slice(1, 4), label
        );
    }
    assert.equal(storage.calls.get.length, 1, '三次读取只回源了一次');
});

test('Range 的三种写法都能正确切片', async () => {
    const storage = inner();
    const { cached, ctx } = build(storage);
    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    // BYTES 是 [1,2,3,4,5]，共 5 字节。
    const cases = [
        ['bytes=0-0', 'bytes 0-0/5', [1]],
        ['bytes=2-4', 'bytes 2-4/5', [3, 4, 5]],
        ['bytes=2-', 'bytes 2-4/5', [3, 4, 5]],          // 开放上界
        ['bytes=-2', 'bytes 3-4/5', [4, 5]],             // 后缀式：最后 2 字节
        ['bytes=-99', 'bytes 0-4/5', [1, 2, 3, 4, 5]],   // 后缀长度超过总长 = 整个对象
        ['bytes=0-99', 'bytes 0-4/5', [1, 2, 3, 4, 5]],  // 上界截断到末尾
    ];

    for (const [header, expectedRange, expectedBytes] of cases) {
        const object = await cached.get(KEY, { range: header });
        assert.equal(object.status, 206, header);
        assert.equal(metadataOf(object).get('content-range'), expectedRange, header);
        assert.deepEqual(
            new Uint8Array(await new Response(object.body).arrayBuffer()),
            new Uint8Array(expectedBytes), header
        );
    }
});

test('不支持或无法满足的 Range 回完整 200，而不是 416', async () => {
    // 刻意不回 416：fetchImage 会给每个响应盖上 max-age=86400 且本层覆盖不掉，
    // 一个被缓存一天的 416 会让后续合法 Range 也拿到 416。RFC 9110 允许忽略 Range。
    const storage = inner();
    const { cached, ctx } = build(storage);
    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();

    const cases = [
        'bytes=0-1,3-4',   // 多段
        'bytes=99-',       // 起点越界，不可满足
        'bytes=4-2',       // 起点大于终点
        'bytes=-0',        // 后缀长度为 0
        'bytes=-',         // 两侧都空
        'items=0-1',       // 非 bytes 单位
        'bytes=abc-def',   // 格式不对
        '',                // 空串（options.range 为假值，等同于无 Range）
    ];

    for (const header of cases) {
        const object = await cached.get(KEY, { range: header });
        assert.equal(object.status, 200, header);
        assert.equal(metadataOf(object).get('content-range'), null, header);
        assert.equal(metadataOf(object).get('content-length'), '5', header);
        assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), BYTES, header);
    }
    assert.equal(storage.calls.get.length, 1, '全部由缓存应答，没有一次回源');
});

test('超过体积上限的对象不谎称支持 Range', async () => {
    // 进不了缓存就只能靠后端分片，而后端并不认 Range。
    const storage = inner({ headers: { 'content-length': String(11 * 1024 * 1024) } });
    const { cached, ctx } = build(storage);

    const object = await cached.get(KEY, { range: 'bytes=0-1' });
    await ctx.settle();
    const headers = metadataOf(object);
    assert.equal(headers.get('X-Cache'), 'BYPASS');
    assert.equal(headers.get('accept-ranges'), null, 'accept-ranges 必须被摘掉');
});

test('只有真正命中缓存才声明 accept-ranges', async () => {
    // MISS 时还不知道对象装不装得进缓存 —— 后端（被 gzip 后）不给 Content-Length，
    // 只有读完才知道。没进缓存就等于不支持 Range，所以 MISS 不能提前声明。
    const bare = inner();
    bare.get = async (key, options = {}) => {
        bare.calls.get.push({ key, options });
        return {
            body: new Response(BYTES).body,
            status: 200,
            httpEtag: null,
            writeHttpMetadata(target) { target.set('content-type', 'video/mp4'); },
        };
    };
    const { cached, ctx } = build(bare);

    assert.equal(metadataOf(await cached.get(KEY)).get('accept-ranges'), null, 'MISS 不该声明');
    await ctx.settle();
    assert.equal(metadataOf(await cached.get(KEY)).get('accept-ranges'), 'bytes', 'HIT-L1 才声明');
});

test('缺少 Content-Length 仍然缓存，且补出正确的长度', async () => {
    // 这正是生产环境的形状：Apache 的 mod_deflate 压了响应，workerd 透明解压后
    // Content-Length 消失，ETag 尾部留下 -gzip。把它当缓存前提会让整层彻底失效。
    const gzipped = inner();
    gzipped.get = async (key, options = {}) => {
        gzipped.calls.get.push({ key, options });
        return {
            body: new Response(BYTES).body,
            status: 200,
            httpEtag: 'W/"63eb-65b809d2d5188-gzip"',
            writeHttpMetadata(target) {
                target.set('content-type', 'image/avif');
                target.set('last-modified', 'Tue, 15 Sep 2026 07:36:51 GMT');
            },
        };
    };
    const { cached, kv, cache, ctx } = build(gzipped);

    const first = await cached.get(KEY);
    assert.equal(metadataOf(first).get('X-Cache'), 'MISS', '缺 Content-Length 不该退化成 BYPASS');
    assert.deepEqual(new Uint8Array(await new Response(first.body).arrayBuffer()), BYTES);
    await ctx.settle();
    assert.equal(kv.store.size, 1);
    assert.equal(cache.store.size, 1);

    for (const [label, prepare] of [['L1', async () => {}], ['L2', async () => cache.store.clear()]]) {
        await prepare();
        const hit = await cached.get(KEY);
        const headers = metadataOf(hit);
        assert.equal(headers.get('X-Cache'), label === 'L1' ? 'HIT-L1' : 'HIT-L2', label);
        assert.equal(headers.get('content-type'), 'image/avif', label);
        // 后端没给长度，但缓存里字节是确定的，可以补出来 —— 比回源那次更完整。
        assert.equal(headers.get('content-length'), String(BYTES.byteLength), label);
        assert.equal(hit.httpEtag, 'W/"63eb-65b809d2d5188-gzip"', label);
        assert.deepEqual(new Uint8Array(await new Response(hit.body).arrayBuffer()), BYTES, label);
    }
    assert.equal(gzipped.calls.get.length, 1, '三次读取只回源了一次');
});

test('声明的 Content-Length 超限时提前拒绝，不读 body', async () => {
    const storage = inner({ headers: { 'content-length': String(11 * 1024 * 1024) } });
    const { cached, kv, cache, ctx } = build(storage);

    assert.equal(metadataOf(await cached.get(KEY)).get('X-Cache'), 'BYPASS');
    await ctx.settle();
    assert.equal(kv.store.size, 0);
    assert.equal(cache.store.size, 0);
});

test('后端谎报 Content-Length 时由字节计数器兜住', async () => {
    // 声明 5 字节，实际吐 12 MB；快捷检查放过了，drain 必须拦下来。
    const huge = new Uint8Array(12 * 1024 * 1024);
    const liar = inner();
    liar.get = async (key, options = {}) => {
        liar.calls.get.push({ key, options });
        return {
            body: new Response(huge).body,
            status: 200,
            httpEtag: null,
            writeHttpMetadata(target) {
                target.set('content-type', 'image/png');
                target.set('content-length', '5');
            },
        };
    };
    const { cached, kv, cache, ctx } = build(liar);

    const object = await cached.get(KEY);
    assert.equal(metadataOf(object).get('X-Cache'), 'MISS', '快捷检查按声明值放行');
    assert.equal((await new Response(object.body).arrayBuffer()).byteLength, huge.byteLength, '客户端仍拿到完整内容');
    await ctx.settle();
    assert.equal(cache.store.size, 0, 'L1 不该落盘');
    // 内容本身没进 KV，进去的是一条 0 字节的墓碑。
    assert.equal(kv.store.size, 1);
    assert.deepEqual(kv.store.get(KEY).metadata, { big: 1 });
    assert.equal(kv.store.get(KEY).value.byteLength, 0);
});

test('超限墓碑让后续请求立刻 BYPASS，不再白读一遍', async () => {
    // 生产环境后端不给 Content-Length，超限只能读到一半才发现。没有墓碑的话每个
    // 请求都要白读满 MAX_CACHE_BYTES，而且会对一个永远进不了缓存的对象谎称支持 Range。
    const huge = new Uint8Array(12 * 1024 * 1024);
    const liar = inner();
    liar.get = async (key, options = {}) => {
        liar.calls.get.push({ key, options });
        return {
            body: new Response(huge).body,
            status: 200,
            httpEtag: null,
            // 和线上一样：既没有 content-length，也没有 accept-ranges。
            writeHttpMetadata(target) { target.set('content-type', 'video/mp4'); },
        };
    };
    const { cached, kv, ctx } = build(liar);

    // 第一次：读到一半才发现超限，立墓碑。
    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();
    assert.deepEqual(kv.store.get(KEY).metadata, { big: 1 });

    // 第二次：墓碑生效，直接 BYPASS，且不谎称支持 Range。
    const second = await cached.get(KEY);
    const headers = metadataOf(second);
    assert.equal(headers.get('X-Cache'), 'BYPASS');
    assert.equal(headers.get('accept-ranges'), null, '进不了缓存就不该声明 accept-ranges');
    assert.equal((await new Response(second.body).arrayBuffer()).byteLength, huge.byteLength, '内容仍然完整');

    // 带 Range 的请求同样走 BYPASS，而不是被当成缓存命中去切片。
    const ranged = await cached.get(KEY, { range: 'bytes=0-1023' });
    assert.equal(metadataOf(ranged).get('X-Cache'), 'BYPASS');
    assert.equal(metadataOf(ranged).get('accept-ranges'), null);
    assert.equal(liar.calls.get.at(-1).options.range, 'bytes=0-1023', 'Range 原样带给后端');
});

test('墓碑不会被当成一个空文件发出去', async () => {
    // 墓碑的值是 0 字节的 ArrayBuffer，而空 ArrayBuffer 是真值 —— 判断顺序错了
    // 就会静默地把空内容当成缓存命中返回。
    const storage = inner();
    const kv = fakeKV();
    await kv.put(KEY, new Uint8Array(0), { metadata: { big: 1 } });
    const { cached } = build(storage, { kv });

    const object = await cached.get(KEY);
    assert.equal(metadataOf(object).get('X-Cache'), 'BYPASS');
    assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), BYTES, '必须回源拿真内容');
    assert.equal(storage.calls.get.length, 1);
});

test('写入或删除会连墓碑一起清掉', async () => {
    const huge = new Uint8Array(12 * 1024 * 1024);
    const liar = inner();
    liar.get = async (key, options = {}) => {
        liar.calls.get.push({ key, options });
        return {
            body: new Response(huge).body, status: 200, httpEtag: null,
            writeHttpMetadata(target) { target.set('content-type', 'video/mp4'); },
        };
    };
    const { cached, kv, ctx } = build(liar);

    await new Response((await cached.get(KEY)).body).arrayBuffer();
    await ctx.settle();
    assert.equal(kv.store.size, 1, '墓碑已立');

    await cached.delete(KEY);
    assert.equal(kv.store.size, 0, '删除应连墓碑一起清掉，否则换成小文件后一天内都不缓存');
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
