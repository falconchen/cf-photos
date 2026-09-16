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
 *
 * Range 也由本层自己满足，而不是透传给后端：实测 teracloud 的 Apache 开了
 * mod_deflate，gzip 与字节范围在 Apache 里互斥，它会直接忽略 Range 回完整 200
 * （ETag 尾部的 -gzip 是标记，库里每种类型都被压，含 mp4）。也就是说线上的
 * <video> 拖拽从来没真正生效过，每次 seek 都是一次整文件回源。缓存里既然躺着
 * 完整字节，就在这里切片回真正的 206。后端那个「忽略 Range 的 200」反而有用：
 * 200 按定义是完整表示，可以照常入缓存，这是只被 Range 访问过的视频唯一的入
 * 缓存机会。本地 wrangler dev 那条链路不压缩，Range 能拿到 206 —— 所以这个问题
 * 只在生产环境复现，别用本地结果判断。
 */

/**
 * 单个文件进缓存的体积上限。
 *
 * 与 index.js 的 MAX_BUFFERED_UPLOAD 同源的理由：写缓存必须把字节读进内存，
 * 而 128 MB 的 isolate 内存是并发请求共享的，后台任务的 buffer 又与其他请求
 * 同时存活。KV 单值硬限 25 MiB，这个数也在其下。
 *
 * 支持从缓存切 Range 之后，这个数**更不该往上调**：切片需要手里有完整对象，
 * 而播放器拖拽会并发发好几个 Range 请求，每一个都短暂持有一份完整副本。按
 * 10 MB 算，6 个并发 seek 就是 60 MB，已经接近 isolate 的一半。写这段时库里
 * 唯一超过它的文件是一个 10,530,343 字节的 mp4，它会继续走 BYPASS：那一个
 * 文件拖不动，换来的是所有其他文件的并发安全，这个取舍是有意的。真要覆盖它，
 * 该做的是让 L1 用 Cache API 原生的 Range 支持（零缓冲）而不是抬高上限。
 */
const MAX_CACHE_BYTES = 10 * 1024 * 1024;

/** L1 副本的存活时间。删除只能清掉当前 colo 的副本，其余 colo 靠它自然过期。 */
const L1_TTL_SECONDS = 3600;

/** L2 兜底过期时间，防止绕过本层删掉的文件永久占用 KV 存储。 */
const L2_TTL_SECONDS = 30 * 24 * 3600;

/**
 * 「这个对象超限」的墓碑存活时间。
 *
 * 比 L2_TTL_SECONDS 短得多是有意的：墓碑说的是「别再尝试缓存」，万一文件被绕过
 * 本层换成了更小的一个（脚本、WebDAV 客户端直连），一天之后自己就会重新试一次。
 * 经本层的 put() / delete() 会连墓碑一起清掉，不需要等它过期。
 */
const OVERSIZE_TTL_SECONDS = 24 * 3600;

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
 * 把 Range 头解析成确定的字节区间
 *
 * 只认单段 bytes=，三种写法：`bytes=start-end`、`bytes=start-`、后缀式 `bytes=-N`。
 * 多段（`bytes=0-1,5-6`）、非 bytes 单位、格式不对、以及无法满足的区间一律返回
 * null —— 调用方会按「忽略 Range」处理，回完整的 200。这是 RFC 9110 明确允许的
 * （服务端 MAY ignore Range），比猜一个区间安全。
 * @param {string} header 原始 Range 头
 * @param {number} total 对象的完整字节数
 * @returns {{start: number, end: number}|null} 闭区间，null 表示不支持或无法满足
 */
function resolveRange(header, total) {
    if (total <= 0) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match) return null;

    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return null;

    // 后缀式：要最后 N 个字节，N 大于总长时就是整个对象。
    if (rawStart === '') {
        const length = Number(rawEnd);
        if (length <= 0) return null;
        return { start: Math.max(0, total - length), end: total - 1 };
    }

    const start = Number(rawStart);
    if (start >= total) return null;
    const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
    if (start > end) return null;
    return { start, end };
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
        // Range 请求：缓存里有完整对象就自己切片。后端在生产环境根本不认 Range
        // （Apache 的 mod_deflate 压了响应，gzip 与字节范围互斥，它会忽略 Range
        // 回完整 200），所以指望它分片等于每次拖拽都整文件回源一次。
        if (options.range) {
            const full = await this._lookup(key, true);
            if (full?.oversize) return await this._fetchAndStore(key, options, true);
            if (full) return this._rangeObject(full, options.range);
            return await this._fetchAndStore(key, options);
        }

        const hit = await this._lookup(key, false);
        if (hit?.oversize) return await this._fetchAndStore(key, options, true);
        if (hit) {
            const headers = new Headers(hit.headers);
            // 手里有完整字节，Range 才是真的可用 —— 只在命中时声明。
            headers.set('accept-ranges', 'bytes');
            return this._object(hit.body, 200, headers.get('etag'), headers, `HIT-${hit.tier}`);
        }

        return await this._fetchAndStore(key, options);
    }

    /**
     * 依次查 L1、L2，L2 命中时顺手回填 L1
     * @param {string} key 存储键
     * @param {boolean} wantBytes true 时把内容读成字节（切 Range 必须持有完整对象），
     *   false 时保持流式 —— 整文件转发不该在 Worker 里缓冲。
     * @returns {Promise<{bytes?: Uint8Array, body?: ReadableStream, headers: Headers, tier: string}|null>}
     */
    async _lookup(key, wantBytes) {
        if (this.edge) {
            try {
                const response = await this.edge.match(this._cacheKey(key));
                if (response) {
                    const headers = response.headers;
                    return wantBytes
                        ? { bytes: new Uint8Array(await response.arrayBuffer()), headers, tier: 'L1' }
                        : { body: response.body, headers, tier: 'L1' };
                }
            } catch (error) {
                console.error(`[Cache] L1 读取失败: ${error.message}`);
            }
        }

        if (this.kv) {
            try {
                const { value, metadata } = await this.kv.getWithMetadata(key, { type: 'arrayBuffer' });
                // 墓碑必须在 value 之前判：它的值是 0 字节的 ArrayBuffer，而空
                // ArrayBuffer 是真值，顺序颠倒会把它当成一个空文件发出去。
                if (metadata?.big) return { oversize: true, tier: 'L2' };
                if (value) {
                    const bytes = new Uint8Array(value);
                    const headers = this._headersFromMetadata(metadata, bytes.byteLength);
                    defer(this.ctx, this._writeEdge(key, bytes, headers));
                    return wantBytes
                        ? { bytes, headers, tier: 'L2' }
                        : { body: new Response(bytes).body, headers, tier: 'L2' };
                }
            } catch (error) {
                console.error(`[Cache] L2 读取失败: ${error.message}`);
            }
        }

        return null;
    }

    /**
     * 从缓存里的完整对象切出 Range 响应
     *
     * 无法满足或不支持的 Range 一律回完整的 200，**刻意不回 416**：
     * ImageService.fetchImage 会给每个响应盖上 Cache-Control: public, max-age=86400，
     * 而那行在 writeHttpMetadata 之后执行，这里覆盖不掉。一个被浏览器缓存一天、
     * 又没有 Vary: Range 的 416 会让后续合法的 Range 请求也拿到 416，比忽略 Range
     * 危险得多。要真正回 416 得先让 fetchImage 区分状态码来设缓存头，而它是三个
     * 分支共用的文件，不在本层的改动范围内。
     * @param {Object} full _lookup(key, true) 的结果
     * @param {string} rangeHeader 原始 Range 头
     * @returns {Object} 与 WebDAVStorage.get() 形状一致的返回对象
     */
    _rangeObject(full, rangeHeader) {
        const total = full.bytes.byteLength;
        const etag = full.headers.get('etag');
        const tag = `HIT-${full.tier}`;
        const headers = new Headers(full.headers);
        // 能从缓存切片，Range 就是真的可用了。
        headers.set('accept-ranges', 'bytes');

        const resolved = resolveRange(rangeHeader, total);
        if (!resolved) {
            headers.set('content-length', String(total));
            headers.delete('content-range');
            return this._object(new Response(full.bytes).body, 200, etag, headers, tag);
        }

        const { start, end } = resolved;
        const slice = full.bytes.subarray(start, end + 1);
        headers.set('content-length', String(slice.byteLength));
        headers.set('content-range', `bytes ${start}-${end}/${total}`);
        return this._object(new Response(slice).body, 206, etag, headers, tag);
    }

    /**
     * 回源，顺带在可以缓存时写入两层
     * @param {string} key 存储键
     * @param {Object} options 透传给内层，可能带 range
     * @param {boolean} [knownOversize] 墓碑已经说过它超限，别再白读一遍
     * @returns {Promise<Object|null>}
     */
    async _fetchAndStore(key, options, knownOversize = false) {
        const object = await this.storage.get(key, options);
        if (object === null) return null;

        const headers = new Headers();
        object.writeHttpMetadata(headers);

        // Content-Length 只是提前拒绝大文件的快捷方式，**不是**缓存的前提。后端
        // （teracloud 的 Apache 开了 mod_deflate）会 gzip 响应，workerd 透明解压后
        // 这个头就没了 —— 实测生产环境每个文件都缺它，ETag 尾部的 -gzip 是证据。
        // 真正的体积约束是 drain() 里边读边数的那个计数器，头缺失或撒谎都照样兜住。
        // 声明的 Content-Length 只是一条快捷路，生产环境压根没有这个头（见下），
        // 所以真正让超限文件被认出来的是墓碑：第一次读到一半发现超了就记一笔，
        // 之后每次请求都能立刻走 BYPASS，既不白读 10 MB 也不谎称支持 Range。
        const declared = headers.get('content-length');
        const oversize = knownOversize || (declared !== null && Number(declared) > MAX_CACHE_BYTES);

        // 206 是部分内容，绝不能进按 URL 索引的缓存。200 则无论请求有没有带 Range，
        // 按定义都是完整表示，照常缓存 —— 生产环境的后端忽略 Range 就走这一路，
        // 这也是只被 Range 访问过的视频唯一的入缓存机会。
        if (object.status !== 200 || !object.body || oversize) {
            // 进不了缓存就意味着分片只能靠后端，而后端并不认 Range，别谎称支持。
            if (oversize) headers.delete('accept-ranges');
            return this._object(object.body, object.status || 200, object.httpEtag, headers, 'BYPASS');
        }

        // 这里**不**声明 accept-ranges：此刻还不知道它能不能装进缓存（后端不给
        // Content-Length，只有读完才知道），而没进缓存就等于不支持 Range。
        // 只有真正命中缓存的响应才声明，见 get() 与 _rangeObject()。

        // tee 而不是先读完再返回：客户端首字节延迟不受写缓存影响。
        const [toCaller, toCache] = object.body.tee();
        defer(this.ctx, this._store(key, toCache, headers, object.httpEtag));
        return this._object(toCaller, 200, object.httpEtag, headers, 'MISS');
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
        if (!bytes) {
            // 读到一半才发现超限。这一次的响应头已经发出去了改不了，但可以记一笔，
            // 让后续请求直接走 BYPASS —— 否则每个请求都要白读满 MAX_CACHE_BYTES。
            await this._markOversize(key);
            return;
        }

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
     * 记下「这个对象超过缓存上限」
     *
     * 值是 0 字节，全部信息在 metadata.big 里；KV 是唯一能放它的地方，因为这条
     * 判断必须全球生效，L1 按 colo 分片起不到作用。
     * @param {string} key 存储键
     * @returns {Promise<void>}
     */
    async _markOversize(key) {
        if (!this.kv) return;
        await this.kv.put(key, new Uint8Array(0), {
            metadata: { big: 1 },
            expirationTtl: OVERSIZE_TTL_SECONDS,
        });
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
