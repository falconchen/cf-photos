/**
 * 一次性上传地址（upload ticket）
 *
 * 为「文件在模型能执行命令的环境里」这种场景存在：claude.ai 的代码执行沙箱里有用户
 * 上传的原始文件（/mnt/user-data/uploads/），而且可以联网，但模型本身交不出字节——
 * 走 image_base64 要逐字输出几十万字符。ChatGPT 有 openai/fileParams 可以把对话文件
 * 换成下载地址，Claude 没有对应机制，于是反过来：MCP 工具 create_upload_url 签发一个
 * 地址，模型在沙箱里 curl -T 把文件推过来，字节完全不经过对话。
 *
 * 不能直接让沙箱带 AUTH_TOKEN 调 /upload：那得把 token 贴进对话。这里的地址本身就是
 * 凭据，而且被收得很窄：
 * - 用 OAuthService 的 HMAC 签名（类型 up，与 OAuth 令牌互不通用），无状态，无需存储；
 * - 存储路径在签发时就分配好并签进去，上传方改不了路径、也改不了后缀；
 * - 10 分钟过期；
 * - 一次性：写入前发现该路径已存在就拒绝。路径是签发时新生成的，所以「已存在」只可能
 *   是这张票用过了。这一步不是原子的，两个请求在毫秒级窗口内同时到达仍可能都写入同一
 *   路径（后者覆盖前者）——持有地址的人本来就能写这一个路径，代价可以接受。
 * 类型由签发时绑定的后缀决定，不看上传请求的 Content-Type（curl -T 不会发对的类型），
 * 这与「后端按后缀推导类型」的事实一致，见 CLAUDE.md。
 */

import { OAuthService } from './OAuthService.js';

// 令牌载荷类型，必须与 OAuth 的 client / code / at / rt 都不同
const TICKET_TYPE = 'up';

// 有效期：够模型调完工具再跑一条 curl，又不至于让泄漏的地址长期可用
const TICKET_TTL = 10 * 60;

// 本服务接管的路径前缀
const TICKET_PREFIX = '/u/';

// 允许签发的媒体大类。SVG 单独拒绝：与 upload_image 的立场一致，MCP 路径不收 SVG
const ALLOWED_PREFIXES = ['image/', 'video/', 'audio/'];

export class UploadTicketService {
    /**
     * 构造函数
     * @param {ImageService} imageService 图片服务，用它的路径生成、类型表与存储
     * @param {Object} env 环境变量，需要 AUTH_TOKEN 作为签名密钥
     * @param {Object} [options={}] 透传给 OAuthService，测试里注入 now 伪造过期
     */
    constructor(imageService, env, options = {}) {
        this.imageService = imageService;
        this.env = env;
        this.signer = new OAuthService(env, options);
        this.now = options.now || (() => Date.now());
        // 上限取 MAX_UPLOAD_MB：这是流式路径，不占 isolate 内存，真正的天花板是
        // Cloudflare 套餐的请求体上限，MAX_UPLOAD_MB 本来就按它配置
        this.maxBytes = imageService.maxUploadMB * 1024 * 1024;
    }

    /**
     * 该路径是否由本服务接管
     * @param {string} path
     * @returns {boolean}
     */
    static owns(path) {
        return path.startsWith(TICKET_PREFIX);
    }

    /**
     * 签发一张上传票
     * @param {string} origin 本站 origin，用于拼接上传地址与最终 URL
     * @param {string} fileName 本地文件名或路径，只用来确定后缀
     * @returns {Promise<Object>} 成功时为 { uploadUrl, url, path, contentType, expiresAt, maxBytes }，失败时为 { error }
     */
    async create(origin, fileName) {
        const extension = this.imageService._extensionFrom(fileName, '');
        if (!extension) {
            return { error: 'file_name 必须带后缀（如 photo.png），后缀决定存储类型。' };
        }

        const contentType = this.imageService._mimeFromExtension(extension);
        if (contentType === 'image/svg+xml') {
            return { error: '出于安全考虑不接受 SVG 文件。' };
        }
        if (!contentType || !ALLOWED_PREFIXES.some(prefix => contentType.startsWith(prefix))) {
            return { error: `不支持的文件后缀 ${extension}，只接受图片、视频与音频。` };
        }

        // 纵深防御：危险后缀本就不在类型表里，走到这里时这一步应当永远放行
        const risky = this.imageService._rejectRiskyUpload(contentType, extension);
        if (risky) return { error: risky };

        const path = this.imageService._generateRandomPath(extension);
        const token = await this.signer.signToken(TICKET_TYPE, { k: path.slice(1) }, TICKET_TTL);

        return {
            uploadUrl: `${origin}${TICKET_PREFIX}${token}`,
            url: `${origin}${path}`,
            path: path,
            contentType: contentType,
            expiresAt: new Date(this.now() + TICKET_TTL * 1000).toISOString(),
            maxBytes: this.maxBytes
        };
    }

    /**
     * 处理 PUT / POST /u/<token>：凭票流式写入
     * 匿名端点——票本身就是凭据。没有 AUTH_TOKEN 时没有签名密钥，一律 503。
     * @param {Request} request
     * @param {URL} url
     * @returns {Promise<Response>}
     */
    async handle(request, url) {
        if (request.method !== 'PUT' && request.method !== 'POST') {
            return new Response('上传地址只接受 PUT 或 POST', {
                status: 405,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'PUT, POST' }
            });
        }

        if (!this.env.AUTH_TOKEN) {
            return this._json(503, { result: 'error', code: 503, message: '服务端未配置 AUTH_TOKEN，无法校验上传地址' });
        }

        const token = url.pathname.slice(TICKET_PREFIX.length);
        const ticket = await this.signer.verifyToken(token, TICKET_TYPE);
        if (!ticket || typeof ticket.k !== 'string') {
            return this._json(403, { result: 'error', code: 403, message: '上传地址无效或已过期，请重新调用 create_upload_url 获取' });
        }

        // 先看体积再碰存储：缺 Content-Length 无法在边缘之外再做一次把关
        const declared = request.headers.get('Content-Length');
        if (declared === null) {
            return this._json(411, { result: 'error', code: 411, message: '需要 Content-Length 请求头，请用 curl -T <文件> 上传' });
        }
        const size = Number(declared);
        if (!Number.isFinite(size) || size <= 0) {
            return this._json(400, { result: 'error', code: 400, message: '请求体为空或 Content-Length 不合法' });
        }
        if (size > this.maxBytes) {
            return this._json(413, { result: 'error', code: 413, message: `文件过大：上限 ${this.imageService.maxUploadMB} MB` });
        }

        const key = ticket.k;
        const storage = this.imageService.storage;

        // 一次性：路径是签发时新生成的，已存在就只能是这张票用过了
        const existing = await storage.get(key);
        if (existing) {
            await existing.body?.cancel();
            return this._json(409, { result: 'error', code: 409, message: '该上传地址已经用过，请重新调用 create_upload_url 获取' });
        }

        const contentType = this.imageService._mimeFromExtension(key);
        try {
            await storage.put(key, request.body, { httpMetadata: { contentType: contentType } });
        } catch (error) {
            console.error(`UploadTicketService.handle 写入失败: ${error.message}`);
            return this._json(502, { result: 'error', code: 502, message: `写入存储失败：${error.message}` });
        }

        const path = `/${key}`;
        return this._json(201, {
            result: 'success',
            code: 201,
            url: `${url.origin}${path}`,
            path: path,
            content_type: contentType,
            size_bytes: size
        });
    }

    /**
     * 构造 JSON 响应
     * @param {number} status HTTP 状态码
     * @param {Object} body 响应体
     * @returns {Response}
     */
    _json(status, body) {
        return new Response(JSON.stringify(body), {
            status: status,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}
