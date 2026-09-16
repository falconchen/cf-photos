/**
 * 媒体读取缓存层。
 *
 * 它实现与 WebDAVStorage 完全相同的 R2-Bucket 形状接口并包住后者，所以
 * ImageService 一行都不用改 —— 缓存只是「另一个符合同一接口的存储实现」，
 * 正好落在仓库既有的存储抽象里。
 *
 * 缓存的是**后端原始字节 + 后端原始响应头**，而不是 fetchImage 组装好的
 * Response。这样 MIME 回填、RISKY_EXTENSIONS 降级、CSP、nosniff 每次命中都
 * 重新计算一遍，改了安全策略立刻对存量缓存生效，不会出现「已缓存的响应保留
 * 旧头长达一天」那个问题。
 *
 * 两层各司其职：
 *   L1 caches.default —— 免费、不限体积、但**按数据中心分片**，只挡同 colo 的重复请求；
 *   L2 KV            —— 全球一份，挡的是跨 colo 的回源风暴，这才是 WebDAV 读取下降的主因，
 *                       且 delete 全球生效，是唯一真正可用的失效手段。
 *
 * 两层都是按绑定存在与否自动启用：没有 KV 绑定、或运行环境没有 caches（例如
 * node --test），本类静默退化成对内层存储的纯透传。
 */

/**
 * 单个文件进缓存的体积上限。
 *
 * 与 index.js 的 MAX_BUFFERED_UPLOAD 同源的理由：写缓存必须把字节读进内存，
 * 而 128 MB 的 isolate 内存是并发请求共享的，后台任务的 buffer 又与其他请求
 * 同时存活。10 MB 覆盖库里全部图片，只把视频排除在外，而视频本来就主要走
 * Range 路径（那条路径完全不碰缓存）。KV 单值硬限 25 MiB，这个数也在其下。
 */
const MAX_CACHE_BYTES = 10 * 1024 * 1024;

/** L1 副本的存活时间。删除只能清掉当前 colo 的副本，其余 colo 靠它自然过期。 */
const L1_TTL_SECONDS = 3600;

/** L2 兜底过期时间，防止绕过本层删掉的文件永久占用 KV 存储。 */
const L2_TTL_SECONDS = 30 * 24 * 3600;

/** 与 WebDAVStorage.get() 完全一致的元数据白名单，不能多也不能少。 */
const METADATA_HEADERS = ['content-type', 'content-length', 'last-modified', 'content-range', 'accept-ranges'];

/**
 * 把后台任务交给 ctx.waitUntil，没有就退化成即发即忘
 *
 * 现有测试（test/mcp.test.mjs、test/oauth.test.mjs）给 worker.fetch 传的 ctx
 * 是空对象字面量 {}，直接调 ctx.waitUntil 会抛 TypeError。这里兜住，免得为了
 * 缓存去改七处与缓存无关的测试。
 * @param {Object|null} ctx Worker 执行上下文
 * @param {Promise} promise 后台任务
 * @returns {Promise} 已吞掉异常的同一任务
 */
function defer(ctx, promise) {
    const guarded = Promise.resolve(promise).catch(error => {
        console.error(`[Cache] 后台任务失败: ${error.message}`);
    });
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(guarded);
    return guarded;
}

/**
 * 读完整个流，超过上限就放弃
 * @param {ReadableStream} stream 待读取的流
 * @param {number} cap 字节上限
 * @returns {Promise<Uint8Array|null>} 超限时返回 null
 */
async function drain(stream, cap) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        // Content-Length 可能缺失或撒谎，边读边数才是真的约束。
        if (size > cap) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/** 带两层缓存的存储装饰器；接口与 WebDAVStorage 逐个方法对齐。 */
export class CachedStorage {
    /**
     * @param {Object} storage 内层存储（WebDAVStorage）
     * @param {Object} env 环境变量，用于取 PHOTO_CACHE 绑定
     * @param {Object} [options]
     * @param {Object|null} [options.ctx] Worker 执行上下文，用于 waitUntil
     * @param {string} [options.origin] 构造 L1 缓存键用的源；必须是本 zone 内的主机名
     * @param {Object|null} [options.cache] 注入的 Cache 对象，仅测试用
     */
    constructor(storage, env = {}, { ctx = null, origin = 'https://cache.invalid', cache } = {}) {
        this.storage = storage;
        this.ctx = ctx;
        this.origin = origin;
        this.kv = env?.PHOTO_CACHE || null;
        // caches 在 node --test 下不存在，必须特性探测而不是直接引用。
        this.edge = cache !== undefined
            ? cache
            : (typeof caches !== 'undefined' && caches?.default ? caches.default : null);
    }

    /**
     * 构造 L1 缓存键
     *
     * 刻意不用真实媒体 URL：缓存条目存的是后端原始头（没有 CSP、没有降级），
     * 放在一个路由永远不会匹配、外部永远请求不到的前缀下最安全。
     * @param {string} key 存储键，如 i/2026/09/16/xxxx.png
     * @returns {Request}
     */
    _cacheKey(key) {
        const path = key.split('/').map(encodeURIComponent).join('/');
        return new Request(`${this.origin}/__mcache/${path}`);
    }

    /**
     * 组装与 WebDAVStorage.get() 形状完全一致的返回对象
     * @param {ReadableStream|null} body 响应体
     * @param {number} status HTTP 状态
     * @param {string|null} etag 后端 ETag
     * @param {Headers} headers 后端原始响应头
     * @param {string} tag 命中情况，写进 X-Cache 便于 curl 观察
     * @returns {Object}
     */
    _object(body, status, etag, headers, tag) {
        return {
            body,
            status,
            httpEtag: etag,
            writeHttpMetadata(target) {
                for (const name of METADATA_HEADERS) {
                    if (headers.has(name)) target.set(name, headers.get(name));
                }
                target.set('X-Cache', tag);
            },
        };
    }

    /**
     * 读取媒体；Range 请求完全绕过缓存
     *
     * Range 走穿透有两个理由：206 不该进缓存（会污染整文件的条目），以及视频
     * 拖拽本来就不该把大文件读进 isolate 内存。
     * @param {string} key 存储键
     * @param {Object} [options] 透传给内层，options.range 为原始 Range 头
     * @returns {Promise<Object|null>} 不存在时为 null
     */
    async get(key, options = {}) {
        if (options.range) return await this.storage.get(key, options);

        const hit = await this._readEdge(key);
        if (hit) return hit;

        const kvHit = await this._readKV(key);
        if (kvHit) return kvHit;

        const object = await this.storage.get(key, options);
        if (object === null) return null;

        const headers = new Headers();
        object.writeHttpMetadata(headers);

        // Content-Length 只是提前拒绝大文件的快捷方式，**不是**缓存的前提。后端
        // （teracloud 的 Apache 开了 mod_deflate）会 gzip 响应，workerd 透明解压后
        // 这个头就没了 —— 实测生产环境每个文件都缺它，ETag 尾部的 -gzip 是证据。
        // 真正的体积约束是 drain() 里边读边数的那个计数器，头缺失或撒谎都照样兜住。
        const declared = headers.get('content-length');
        const oversize = declared !== null && Number(declared) > MAX_CACHE_BYTES;

        // 只缓存完整的 200；其余（如后端忽略我们意图直接回 206）原样放行。
        if (object.status !== 200 || !object.body || oversize) {
            return this._object(object.body, object.status || 200, object.httpEtag, headers, 'BYPASS');
        }

        // tee 而不是先读完再返回：客户端首字节延迟不受写缓存影响。
        const [toCaller, toCache] = object.body.tee();
        defer(this.ctx, this._store(key, toCache, headers, object.httpEtag));
        return this._object(toCaller, 200, object.httpEtag, headers, 'MISS');
    }

    /**
     * 查 L1
     * @param {string} key 存储键
     * @returns {Promise<Object|null>}
     */
    async _readEdge(key) {
        if (!this.edge) return null;
        try {
            const response = await this.edge.match(this._cacheKey(key));
            if (!response) return null;
            return this._object(response.body, 200, response.headers.get('etag'), response.headers, 'HIT-L1');
        } catch (error) {
            console.error(`[Cache] L1 读取失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 查 L2，命中时顺手回填 L1
     * @param {string} key 存储键
     * @returns {Promise<Object|null>}
     */
    async _readKV(key) {
        if (!this.kv) return null;
        try {
            const { value, metadata } = await this.kv.getWithMetadata(key, { type: 'arrayBuffer' });
            if (!value) return null;
            const bytes = new Uint8Array(value);
            const headers = this._headersFromMetadata(metadata, bytes.byteLength);
            defer(this.ctx, this._writeEdge(key, bytes, headers));
            return this._object(new Response(bytes).body, 200, headers.get('etag'), headers, 'HIT-L2');
        } catch (error) {
            console.error(`[Cache] L2 读取失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 由 KV 元数据还原响应头
     * @param {Object|null} metadata KV 条目的 metadata
     * @param {number} length 字节长度
     * @returns {Headers}
     */
    _headersFromMetadata(metadata, length) {
        const headers = new Headers();
        if (metadata?.ct) headers.set('content-type', metadata.ct);
        if (metadata?.lm) headers.set('last-modified', metadata.lm);
        if (metadata?.ar) headers.set('accept-ranges', metadata.ar);
        if (metadata?.et) headers.set('etag', metadata.et);
        headers.set('content-length', String(length));
        return headers;
    }

    /**
     * 读完 tee 出来的那一路并写进两层缓存
     * @param {string} key 存储键
     * @param {ReadableStream} stream tee 的第二路
     * @param {Headers} headers 后端原始响应头
     * @param {string|null} etag 后端 ETag
     * @returns {Promise<void>}
     */
    async _store(key, stream, headers, etag) {
        const bytes = await drain(stream, MAX_CACHE_BYTES);
        if (!bytes) return;

        const stored = new Headers();
        for (const name of METADATA_HEADERS) {
            // content-range 属于 206，不该出现在整文件条目里。
            // content-length 单独处理：见下。
            if (name !== 'content-range' && name !== 'content-length' && headers.has(name)) {
                stored.set(name, headers.get(name));
            }
        }
        // 长度一律以实际读到的字节数为准，不抄后端那个头 —— 它可能缺失（被 gzip
        // 过又由 workerd 解压）也可能撒谎，而这里的数字是确定的。
        stored.set('content-length', String(bytes.byteLength));
        if (etag) stored.set('etag', etag);

        await Promise.all([this._writeEdge(key, bytes, stored), this._writeKV(key, bytes, stored)]);
    }

    /**
     * 写 L1
     * @param {string} key 存储键
     * @param {Uint8Array} bytes 文件字节
     * @param {Headers} headers 要一并存下的后端原始头
     * @returns {Promise<void>}
     */
    async _writeEdge(key, bytes, headers) {
        if (!this.edge) return;
        const stored = new Headers(headers);
        // s-maxage 决定 L1 条目的存活时间，与发给客户端的 Cache-Control 无关 ——
        // 后者由 ImageService.fetchImage 单独设置，这里的头不会流到客户端。
        stored.set('Cache-Control', `public, s-maxage=${L1_TTL_SECONDS}`);
        await this.edge.put(this._cacheKey(key), new Response(bytes, { status: 200, headers: stored }));
    }

    /**
     * 写 L2
     * @param {string} key 存储键
     * @param {Uint8Array} bytes 文件字节
     * @param {Headers} headers 后端原始头，摘几项存进 KV metadata
     * @returns {Promise<void>}
     */
    async _writeKV(key, bytes, headers) {
        if (!this.kv) return;
        const metadata = {};
        if (headers.has('content-type')) metadata.ct = headers.get('content-type');
        if (headers.has('last-modified')) metadata.lm = headers.get('last-modified');
        if (headers.has('accept-ranges')) metadata.ar = headers.get('accept-ranges');
        if (headers.has('etag')) metadata.et = headers.get('etag');
        // KV metadata 硬限 1024 字节，超了整次写入会失败；ETag 是唯一可能失控的字段。
        if (JSON.stringify(metadata).length > 1024) delete metadata.et;
        await this.kv.put(key, bytes, { metadata, expirationTtl: L2_TTL_SECONDS });
    }

    /**
     * 清掉两层里的某个键
     *
     * 失败只记日志：底层的写入/删除已经成功，不该因为清缓存失败而让请求报错。
     * @param {string} key 存储键
     * @returns {Promise<void>}
     */
    async _purge(key) {
        const tasks = [];
        if (this.kv) tasks.push(this.kv.delete(key));
        if (this.edge) tasks.push(this.edge.delete(this._cacheKey(key)));
        const results = await Promise.allSettled(tasks);
        for (const result of results) {
            if (result.status === 'rejected') console.error(`[Cache] 清除失败: ${result.reason?.message}`);
        }
    }

    /**
     * 写入并失效缓存
     *
     * 自动生成的路径几乎不会撞，但 PUT /i/... 的键由客户端指定，可以覆盖同一路径，
     * 所以每次写入都要清。
     * @param {string} key 存储键
     * @param {ReadableStream|ArrayBuffer} body 文件内容
     * @param {Object} [options] 透传给内层
     * @returns {Promise<void>}
     */
    async put(key, body, options = {}) {
        await this.storage.put(key, body, options);
        await this._purge(key);
    }

    /**
     * 删除并失效缓存
     * @param {string} key 存储键
     * @returns {Promise<void>}
     */
    async delete(key) {
        await this.storage.delete(key);
        await this._purge(key);
    }

    /**
     * 列举；本层不缓存列表，纯透传
     * @param {Object} [options] 透传给内层
     * @returns {Promise<Object>}
     */
    async list(options) {
        return await this.storage.list(options);
    }
}
