/**
 * MCP (Model Context Protocol) 服务端
 *
 * 无状态 Streamable HTTP：只接受 POST，永远返回单个 JSON-RPC 响应，从不使用 SSE，
 * 也从不下发 Mcp-Session-Id（下发了客户端会在关闭时 DELETE /mcp 然后吃 405）。
 *
 * 协议纪元说明：MCP 自 2026-07-28 起进入「现代纪元」（取消 initialize、改用每请求
 * _meta 信封 + server/discover）。本服务端有意停留在 legacy 纪元并声明 2025-11-25，
 * 双纪元客户端会先探测 server/discover、拿到 404 + -32601 后回落到 initialize。
 * 等现代纪元客户端普及后再补，不要因为看到新版规范就以为这里写错了。
 */

// 对外声明的协议版本，以及能原样回显的版本
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

// 抓取远程图片的超时。刻意短于 WebDAVStorage 的 30s：抓完还要跑 storage.put()
// 的 MKCOL + PROPFIND + PUT，两段加起来才是一次工具调用的总耗时。
const REMOTE_FETCH_TIMEOUT = 15000;

// CORS：浏览器内的 MCP 客户端（Inspector 网页版等）发的每个头都会触发预检。
// MCP-Protocol-Version 必须显式列出，漏了会表现为「握手成功、第一次 tools/list 预检失败」；
// Authorization 也必须显式列出——按 Fetch 规范通配符 * 不覆盖它。
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Mcp-Method, Mcp-Name',
    'Access-Control-Max-Age': '86400'
};

// 工具定义。description 是真正驱动模型行为的东西，写给模型看，不是写给人看的文档。
const UPLOAD_IMAGE_TOOL = {
    name: 'upload_image',
    title: '上传图片到图床',
    description: [
        '把一张图片上传到本图床，返回可以直接公开访问的图片 URL。',
        '',
        '必须且只能提供下面两个参数中的一个：',
        '- source_url：图片的公网 HTTPS 地址，由服务端自行下载。当用户给出的是一个网址时用它。',
        '- image_base64：图片的 base64 内容，支持 "data:image/png;base64,xxx" 形式的 data URL，也支持纯 base64 字符串。当你手上已经有图片字节时用它。',
        '',
        '支持 JPEG / PNG / GIF / WebP / AVIF / HEIC / BMP / TIFF / ICO，单张不超过 20 MB。出于安全考虑不接受 SVG。',
        'source_url 只接受公网 HTTPS 域名地址，不接受 IP 直连、内网地址、localhost，也不跟随重定向。',
        '上传成功后返回的 URL 是永久公开的，可以直接写进 Markdown 或 HTML；请不要上传含有隐私内容的图片。'
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            source_url: {
                type: 'string',
                description: '图片的公网 HTTPS 地址；与 image_base64 二选一'
            },
            image_base64: {
                type: 'string',
                description: '图片的 base64 或 data URL 字符串；与 source_url 二选一'
            }
        },
        additionalProperties: false
    }
};

const TOOLS = [UPLOAD_IMAGE_TOOL];

export class McpService {
    /**
     * 构造函数
     * @param {ImageService} imageService 图片服务，工具最终落到它的 uploadBuffer 上
     * @param {Object} [options={}] 可选项
     * @param {Function} [options.request] 出站请求函数，测试时注入假 fetch
     * @param {number} [options.maxBytes] 单张图片字节上限
     * @param {string} [options.version] serverInfo.version
     */
    constructor(imageService, options = {}) {
        this.imageService = imageService;
        // 默认请求函数必须包一层：直接把 fetch 存成实例属性，调用时 this 会变成本实例，
        // workerd 抛 TypeError: Illegal invocation。同 WebDAVStorage 的坑，那边有专门的回归测试。
        this.request = options.request || ((...args) => fetch(...args));
        this.maxBytes = options.maxBytes || 20 * 1024 * 1024;
        this.version = options.version || '1.0.0';
    }

    /**
     * OPTIONS 预检响应
     * @returns {Response}
     */
    static preflightResponse() {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    /**
     * GET / DELETE 等非 POST 方法的响应
     * 必须显式返回 405 而不是落到通用 404：客户端看到 GET 返回 404，
     * 可能改去尝试已废弃的 2024-11-05 HTTP+SSE 握手。
     * @returns {Response}
     */
    static methodNotAllowedResponse() {
        return new Response('MCP 端点只接受 POST', {
            status: 405,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Allow': 'POST',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }

    /**
     * 处理一次 MCP 请求
     * @param {Request} request 原始请求对象
     * @returns {Promise<Response>} 单个 JSON-RPC 响应，或通知的 202
     */
    async handle(request) {
        let message;
        try {
            message = await request.json();
        } catch (error) {
            return this._errorResponse(null, -32700, 'Parse error: 请求体不是合法的 JSON', 400);
        }

        // 2025-06-18 起规范已移除 JSON-RPC 批量请求
        if (Array.isArray(message)) {
            return this._errorResponse(null, -32600, 'Invalid Request: 不支持 JSON-RPC 批量请求', 400);
        }

        if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return this._errorResponse(null, -32600, 'Invalid Request: 缺少 jsonrpc "2.0" 或 method 字段', 400);
        }

        // 没有 id 字段就是通知：没有可关联的 id，不能构造响应，一律 202 空响应。
        // 这条通用规则同时覆盖 notifications/initialized、notifications/cancelled 及未来的通知。
        if (!('id' in message)) {
            return new Response(null, { status: 202, headers: { ...CORS_HEADERS } });
        }

        const id = message.id;
        const params = message.params || {};

        try {
            switch (message.method) {
                case 'initialize':
                    return this._resultResponse(id, this._initialize(params));

                case 'ping':
                    return this._resultResponse(id, {});

                case 'tools/list':
                    return this._resultResponse(id, { tools: TOOLS });

                case 'tools/call':
                    return await this._toolsCall(id, params, new URL(request.url).origin, new URL(request.url).hostname);

                default:
                    // 404 + -32601 是现代纪元对「未实现的方法」的规定答复，
                    // 同时也是让双纪元客户端从 server/discover 回落到 initialize 的信号。
                    return this._errorResponse(id, -32601, `Method not found: ${message.method}`, 404);
            }
        } catch (error) {
            console.error(`McpService.handle 运行出错: ${error.message}`);
            return this._errorResponse(id, -32603, `Internal error: ${error.message}`, 200);
        }
    }

    /**
     * initialize 的返回结果
     * 版本协商按 lifecycle 规范：客户端请求的版本我们支持就原样回显，否则回自己最新的。
     * 绝不因版本不匹配返回 JSON-RPC error——断不断开由客户端决定。
     * @param {Object} params 客户端传来的 params
     * @returns {Object} initialize 结果
     */
    _initialize(params) {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;

        return {
            protocolVersion: protocolVersion,
            // 省略 listChanged 即为 false，对静态工具表是正确的
            capabilities: { tools: {} },
            serverInfo: {
                name: 'cf-photos',
                title: 'cf-photos 图床',
                version: this.version
            },
            instructions: '本服务器提供一个 upload_image 工具，用于把图片上传到图床并返回公开可访问的 URL。'
        };
    }

    /**
     * 处理 tools/call
     * 注意两条错误通道的区别：参数结构本身不对（没有 name、arguments 不是对象、
     * 工具名不存在）属于协议错误，走 JSON-RPC error；工具执行过程中的任何失败
     * （URL 被拦、类型不支持、超限、存储挂了）都必须是成功的 JSON-RPC 响应加
     * result.isError，这样模型才能读到原因并自我纠正。
     * @param {string|number} id JSON-RPC 请求 id
     * @param {Object} params tools/call 的 params
     * @param {string} origin 本站 origin，用于拼接返回的图片 URL
     * @param {string} selfHost 本站 hostname，用于拒绝 source_url 指向自己
     * @returns {Promise<Response>}
     */
    async _toolsCall(id, params, origin, selfHost) {
        if (typeof params?.name !== 'string') {
            return this._errorResponse(id, -32602, 'Invalid params: 缺少工具名 name', 200);
        }

        if (params.name !== UPLOAD_IMAGE_TOOL.name) {
            return this._errorResponse(id, -32602, `Unknown tool: ${params.name}`, 200);
        }

        const args = params.arguments === undefined ? {} : params.arguments;
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
            return this._errorResponse(id, -32602, 'Invalid params: arguments 必须是对象', 200);
        }

        try {
            return this._resultResponse(id, await this._uploadImage(args, origin, selfHost));
        } catch (error) {
            // 兜底成 isError 而不是 -32603：WebDAV 抖动属于模型可以重试的 API 失败
            console.error(`McpService._uploadImage 运行出错: ${error.message}`);
            return this._resultResponse(id, this._toolError(`上传失败：${error.message}`));
        }
    }

    /**
     * upload_image 工具本体
     * @param {Object} args 工具参数
     * @param {string} origin 本站 origin
     * @param {string} selfHost 本站 hostname
     * @returns {Promise<Object>} tools/call 的 result
     */
    async _uploadImage(args, origin, selfHost) {
        const hasUrl = typeof args.source_url === 'string' && args.source_url.trim() !== '';
        const hasBase64 = typeof args.image_base64 === 'string' && args.image_base64.trim() !== '';

        // 手写二选一校验而不是在 schema 里写 oneOf：规范只说客户端 SHOULD 校验，
        // 不少客户端把 schema 转成模型侧 tool-calling 格式时会丢掉根层组合关键字；
        // 而且手写才能给出模型真正能照着改的中文错误。
        if (hasUrl === hasBase64) {
            return this._toolError('必须且只能提供 source_url 或 image_base64 其中一个参数。');
        }

        const image = hasUrl
            ? await this._fetchRemoteImage(args.source_url.trim(), selfHost)
            : this._decodeBase64Image(args.image_base64.trim());

        if (image.error) return this._toolError(image.error);

        const stored = await this.imageService.uploadBuffer(
            origin,
            image.buffer,
            image.contentType,
            image.extension
        );

        return {
            content: [{
                type: 'text',
                text: `上传成功：${stored.url}\n路径：${stored.path}\n类型：${stored.contentType}，大小：${stored.size} 字节`
            }],
            structuredContent: {
                url: stored.url,
                path: stored.path,
                content_type: stored.contentType,
                size_bytes: stored.size
            },
            isError: false
        };
    }

    /**
     * 校验 source_url 是否可以抓取
     * 威胁模型见 CLAUDE.md：生产环境走 Cloudflare 出口，内网本就不可路由；
     * 但 wrangler dev 下 workerd 用的是本机网络栈，这些检查在开发期是真的在挡 SSRF。
     * @param {string} raw 原始 URL 字符串
     * @param {string} selfHost 本站 hostname
     * @returns {{url: URL}|{error: string}}
     */
    _validateSourceUrl(raw, selfHost) {
        let url;
        try {
            url = new URL(raw);
        } catch (error) {
            return { error: `source_url 不是合法的 URL：${raw}` };
        }

        if (url.protocol !== 'https:') {
            return { error: '只接受 https:// 开头的公网地址。如果图片在本地或只有 http 地址，请改用 image_base64 参数传入。' };
        }

        // URL 里带凭据既是泄漏面，也是经典的解析器混淆手法
        if (url.username || url.password) {
            return { error: 'source_url 不能包含用户名或密码。' };
        }

        const host = url.hostname.toLowerCase();

        // 拒绝 IP 字面量。Worker 无法在 fetch 前解析 DNS，但这一条不用解析就能
        // 一次干掉 loopback / 内网 / link-local / 元数据地址，是性价比最高的检查。
        if (host.startsWith('[')) {
            return { error: '不接受 IPv6 地址直连，请提供域名地址。' };
        }
        // 故意放宽：连带拒掉 2130706433、0x7f.1、0177.0.0.1 这类变形写法。
        // 真实主机名不会只由数字、十六进制字符、点和冒号组成。
        if (/^[0-9a-fx.:]+$/i.test(host)) {
            return { error: '不接受 IP 地址直连，请提供域名地址。' };
        }

        const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
        if (host === 'localhost' || RESERVED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
            return { error: '不接受 localhost 或内网保留域名。' };
        }
        // 不含点的裸名字只可能是内网主机
        if (!host.includes('.')) {
            return { error: '不接受不带域名后缀的内网主机名。' };
        }

        // 拒绝指向本站：防止递归调用 /mcp、自我放大和 Cloudflare 环路
        if (selfHost && host === selfHost.toLowerCase()) {
            return { error: '不能从本站自己的域名抓取图片。' };
        }

        return { url: url };
    }

    /**
     * 抓取远程图片并读成字节
     * @param {string} raw source_url 原始值
     * @param {string} selfHost 本站 hostname
     * @returns {Promise<{buffer: Uint8Array, contentType: string, extension: string}|{error: string}>}
     */
    async _fetchRemoteImage(raw, selfHost) {
        const verdict = this._validateSourceUrl(raw, selfHost);
        if (verdict.error) return verdict;

        let response;
        try {
            response = await this.request(verdict.url.toString(), {
                method: 'GET',
                // 不跟随跳转：跟了就等于让上面所有检查失效
                redirect: 'manual',
                // 只发这两个头，绝不转发客户端请求里的任何东西（尤其是 Authorization / Cookie）
                headers: {
                    'Accept': 'image/*',
                    'User-Agent': 'cf-photos-mcp/1.0'
                },
                signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT)
            });
        } catch (error) {
            return { error: `抓取该地址失败或超时：${error.message}` };
        }

        if (response.status >= 300 && response.status < 400) {
            await this._discard(response);
            return { error: '该地址发生了跳转，请提供跳转后的最终地址。' };
        }

        // 严格等于 200 而不是 res.ok：206 会存进一个被截断的文件
        if (response.status !== 200) {
            await this._discard(response);
            return { error: `该地址返回 HTTP ${response.status}，无法获取图片。` };
        }

        const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

        // SVG 存下来后由本站域名提供服务就是对后台页面的存储型 XSS。
        // 注意现有的 /upload 三条路径同样没挡，那是独立的待修项，这里只堵 MCP。
        if (mime === 'image/svg+xml') {
            await this._discard(response);
            return { error: '出于安全考虑不接受 SVG 图片。' };
        }

        // 白名单与后缀名来源同一张表，两者永不打架。_getExtension 标了 @private，
        // 这里跨类调用是有意为之：另建一份 MIME 表迟早会漂移。
        const extension = mime.startsWith('image/') ? this.imageService._getExtension(mime) : '';
        if (!extension) {
            await this._discard(response);
            return { error: `该地址返回的不是支持的图片类型：${mime || '未知'}` };
        }

        const declared = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(declared) && declared > this.maxBytes) {
            await this._discard(response);
            return { error: `图片体积 ${declared} 字节，超过 ${this._maxMB()} MB 上限。` };
        }

        if (!response.body) {
            return { error: '该地址没有返回任何内容。' };
        }

        // 流式计数才是承重的：Content-Length 可能缺失（chunked）或直接撒谎
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > this.maxBytes) {
                    await reader.cancel();
                    return { error: `图片超过 ${this._maxMB()} MB 上限。` };
                }
                chunks.push(value);
            }
        } catch (error) {
            return { error: `读取图片内容失败：${error.message}` };
        }

        const buffer = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return { buffer: buffer, contentType: mime, extension: extension };
    }

    /**
     * 解码 image_base64 参数
     * 与 ImageService.uploadWithBase64 的区别：那边认不出类型时会静默存成
     * image/jpeg 且没有后缀名（uPic 依赖这个行为，不能改）；这里直接拒绝，
     * 因为模型看得懂错误并且能改用 data URL 重试。
     * @param {string} input data URL 或裸 base64
     * @returns {{buffer: Uint8Array, contentType: string, extension: string}|{error: string}}
     */
    _decodeBase64Image(input) {
        let contentType = '';
        let base64Data = input;

        if (input.startsWith('data:')) {
            const parts = input.split(',');
            const mimeMatch = parts[0].match(/:(.*?);/);
            if (mimeMatch) contentType = mimeMatch[1].trim().toLowerCase();
            base64Data = parts.length > 1 ? parts[1] : '';
        }

        // 去掉换行等空白，某些客户端会按行折断 base64
        base64Data = base64Data.replace(/\s/g, '');
        if (!base64Data) {
            return { error: 'image_base64 为空。' };
        }

        let binary;
        try {
            binary = atob(base64Data);
        } catch (error) {
            return { error: 'image_base64 不是合法的 base64 内容。' };
        }

        if (binary.length > this.maxBytes) {
            return { error: `图片超过 ${this._maxMB()} MB 上限。` };
        }

        const buffer = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            buffer[i] = binary.charCodeAt(i);
        }

        // 没给 MIME 就按文件头识别
        if (!contentType) {
            contentType = this._sniffMime(buffer);
        }

        if (contentType === 'image/svg+xml') {
            return { error: '出于安全考虑不接受 SVG 图片。' };
        }

        const extension = contentType.startsWith('image/') ? this.imageService._getExtension(contentType) : '';
        if (!extension) {
            return {
                error: contentType
                    ? `不支持的图片类型：${contentType}`
                    : '无法识别图片类型，请使用 "data:image/png;base64,..." 形式的 data URL 传入。'
            };
        }

        return { buffer: buffer, contentType: contentType, extension: extension };
    }

    /**
     * 按文件头识别常见图片格式
     * @param {Uint8Array} bytes 图片字节
     * @returns {string} MIME 类型，识别不出时为空串
     */
    _sniffMime(bytes) {
        const startsWith = (...signature) =>
            bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

        if (startsWith(0x89, 0x50, 0x4E, 0x47)) return 'image/png';
        if (startsWith(0xFF, 0xD8, 0xFF)) return 'image/jpeg';
        if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
        if (startsWith(0x42, 0x4D)) return 'image/bmp';
        if (startsWith(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';

        // RIFF....WEBP
        if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12 &&
            bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
            return 'image/webp';
        }

        // ISO-BMFF：....ftyp<brand>，avif / heic 共用这个容器
        if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
            const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
            if (brand === 'avif' || brand === 'avis') return 'image/avif';
            if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic';
        }

        return '';
    }

    /**
     * 丢弃响应体，避免连接悬着
     * @param {Response} response 待丢弃的响应
     */
    async _discard(response) {
        try {
            await response.body?.cancel();
        } catch (error) {
            // 丢弃失败无所谓，不该影响给调用方的错误信息
        }
    }

    /**
     * 体积上限的 MB 表示，用于错误文案
     * @returns {number}
     */
    _maxMB() {
        return Math.round(this.maxBytes / (1024 * 1024));
    }

    /**
     * 构造工具执行失败的结果
     * 必须是成功的 JSON-RPC 响应 + isError，而不是 JSON-RPC error：
     * 规范把工具执行错误定位为「给模型自我纠正用的可执行反馈」。
     * @param {string} message 给模型看的中文错误说明
     * @returns {Object} tools/call 的 result
     */
    _toolError(message) {
        return {
            content: [{ type: 'text', text: message }],
            isError: true
        };
    }

    /**
     * 构造成功的 JSON-RPC 响应
     * @param {string|number} id 请求 id
     * @param {Object} result 结果
     * @returns {Response}
     */
    _resultResponse(id, result) {
        return this._json({ jsonrpc: '2.0', id: id, result: result }, 200);
    }

    /**
     * 构造 JSON-RPC 错误响应
     * @param {string|number|null} id 请求 id，解析失败时为 null
     * @param {number} code JSON-RPC 错误码
     * @param {string} message 错误说明
     * @param {number} status HTTP 状态码
     * @returns {Response}
     */
    _errorResponse(id, code, message, status) {
        return this._json({ jsonrpc: '2.0', id: id ?? null, error: { code: code, message: message } }, status);
    }

    /**
     * 序列化并加上 CORS 头
     * Content-Type 用裸 application/json（不带 charset），与仓库其他地方不同：
     * 规范原文如此，部分客户端做精确比较；JSON 本就是 UTF-8，不会丢信息。
     * @param {Object} payload 响应体
     * @param {number} status HTTP 状态码
     * @returns {Response}
     */
    _json(payload, status) {
        return new Response(JSON.stringify(payload), {
            status: status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version'
            }
        });
    }
}
