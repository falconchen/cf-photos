/**
 * Cloudflare Worker 入口文件
 * 负责路由请求并分发到对应的处理器
 */

import { WebDAVStorage } from './services/WebDAVStorage.js';
import { ImageService } from './services/ImageService.js';
import { McpService } from './services/McpService.js';
import { OAuthService } from './services/OAuthService.js';
import { AuthMiddleware } from './middleware/AuthMiddleware.js';

/**
 * 缓冲式上传（multipart / JSON base64）的请求体上限。
 *
 * 这两条路径会把整个文件读进内存：multipart 峰值约 2~3 倍文件大小，base64 约
 * 4~5 倍（base64 字符串 + atob 的 binary string + Uint8Array 同时存活）。而
 * 128 MB 的 isolate 内存是并发请求共享的，按单请求峰值 ≤64 MB 反推，上限落在
 * 20 MB 左右。它覆盖除 ProRAW 外的全部 iPhone 原图（12MP HEIC 2~4 MB、48MP
 * HEIF Max 约 6~8 MB、全景图 10~25 MB）。
 *
 * 再往上调挡住的不是攻击者而是 Worker 自己 —— 413 会变成 OOM。更大的文件必须
 * 走流式路径（PUT /i/... 或裸二进制 POST），那条路 body 直接透传给 WebDAV，
 * 不占内存，只受 Cloudflare 套餐的请求体上限约束。
 */
const MAX_BUFFERED_UPLOAD = 20 * 1024 * 1024;

/**
 * 构造上传相关的 JSON 错误响应
 * @param {number} code HTTP 状态码
 * @param {string} message 错误说明
 * @returns {Response}
 */
function uploadError(code, message) {
    return new Response(JSON.stringify({ result: 'error', code, message }), {
        status: code,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

/**
 * 在解析请求体之前按 Content-Length 拦掉过大的缓冲式上传。
 * 缺少 Content-Length（分块传输）时无法预判大小，直接要求补上，否则本限制可被绕过。
 * @param {Request} request
 * @returns {Response|null} 需要拒绝时返回响应，放行时返回 null
 */
function checkBufferedSize(request) {
    const declared = request.headers.get('Content-Length');
    if (declared === null) {
        return uploadError(411, '表单与 Base64 上传需要 Content-Length 请求头；如需分块传输请改用 PUT /i/... 流式上传');
    }

    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) {
        return uploadError(400, 'Content-Length 不合法');
    }

    if (size > MAX_BUFFERED_UPLOAD) {
        const limit = Math.floor(MAX_BUFFERED_UPLOAD / 1024 / 1024);
        return uploadError(413, `文件过大：表单与 Base64 上传上限 ${limit} MB，更大的文件请改用 PUT /i/... 或裸二进制 POST 流式上传`);
    }

    return null;
}

export default {
    /**
     * 接管 HTTP 请求并返回响应
     * @param {Request} request 原始请求对象
     * @param {Object} env 环境变量，包含 WebDAV 连接配置等
     * @param {Context} ctx 上下文对象
     * @returns {Promise<Response>} 响应对象
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const imageService = new ImageService(new WebDAVStorage(env), env);

        // OAuth 与它的发现文档：claude.ai 网页版 / 手机端的自定义连接器不支持静态
        // Authorization 头，只认 OAuth，这套端点专门为它们存在。放在最前面是因为
        // /.well-known/* 必须在任何鉴权之前可匿名读取。
        if (OAuthService.owns(path)) {
            return await new OAuthService(env).handle(request, url);
        }

        // 首页：展示管理后台界面
        if (path === '/' && request.method === 'GET') {
            return await imageService.renderDashboard();
        }

        // 处理自动上传路由
        if (path === '/upload' && request.method === 'POST') {
            const contentType = request.headers.get('Content-Type') || '';
            console.log(`[Debug] 上传请求 Content-Type: "${contentType}"`);

            // multipart 与 JSON 两条路径都会把整个请求体读进内存，因此鉴权尽量前置：
            // 带了 Authorization 就以它为准，无效则立刻拒绝，不为一个注定失败的
            // 请求缓冲文件。只有完全没带 Authorization 时才回落到请求体里的 token
            // 字段（uPic 等客户端只能这么传），那条路径必须先解析才能拿到 token。
            const hasHeaderAuth = AuthMiddleware.verify(request, env);
            if (!hasHeaderAuth && AuthMiddleware.hasHeader(request)) {
                return AuthMiddleware.unauthorizedResponse();
            }

            // 1. 兼容 uPic 的 multipart/form-data 上传
            if (contentType.includes('multipart/form-data')) {
                const tooLarge = checkBufferedSize(request);
                if (tooLarge) return tooLarge;

                const formData = await request.formData();

                if (!hasHeaderAuth && !AuthMiddleware.verifyToken(formData.get('token'), env)) {
                    return AuthMiddleware.unauthorizedResponse();
                }

                return await imageService.uploadFormData(request, formData);
            }

            // 2. 兼容 uPic 的 application/json (Base64) 上传
            if (contentType.includes('application/json')) {
                const tooLarge = checkBufferedSize(request);
                if (tooLarge) return tooLarge;

                const body = await request.json();

                if (!hasHeaderAuth && !AuthMiddleware.verifyToken(body.token, env)) {
                    return AuthMiddleware.unauthorizedResponse();
                }

                if (!body.image) {
                    return new Response(JSON.stringify({ result: 'error', code: 400, message: '缺少 image 字段' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                return await imageService.uploadWithBase64(request, body.image);
            }

            // 3. 传统的二进制流上传：body 以流的形式透传，不经过内存
            if (!hasHeaderAuth) {
                return AuthMiddleware.unauthorizedResponse();
            }
            return await imageService.uploadWithAutoPath(
                request, request.body, contentType,
                // 裸二进制没有文件名，后台与脚本可用该头保留原始后缀
                request.headers.get('X-Upload-Filename') || ''
            );
        }

        // 处理图片获取和手动路径上传
        if (path.startsWith('/i/')) {
            if (request.method === 'PUT') {
                if (!AuthMiddleware.verify(request, env)) {
                    return AuthMiddleware.unauthorizedResponse();
                }
                const contentType = request.headers.get('Content-Type');
                return await imageService.uploadImage(path, request.body, contentType);
            }

            return await imageService.fetchImage(path, request);
        }

        // 管理接口：列出图片
        if (path === '/admin/list' && request.method === 'GET') {
            if (!AuthMiddleware.verify(request, env)) {
                return AuthMiddleware.unauthorizedResponse();
            }

            const limit = parseInt(url.searchParams.get('limit')) || 50;
            const cursor = url.searchParams.get('cursor');
            const year = url.searchParams.get('year');
            const month = url.searchParams.get('month');
            const day = url.searchParams.get('day');
            const order = url.searchParams.get('order');

            return await imageService.listImages(request, limit, cursor, year, month, day, order);
        }

        // 管理接口：列出可筛选的年 / 月 / 日目录
        if (path === '/admin/dirs' && request.method === 'GET') {
            if (!AuthMiddleware.verify(request, env)) {
                return AuthMiddleware.unauthorizedResponse();
            }

            return await imageService.listDirs(
                url.searchParams.get('year'),
                url.searchParams.get('month')
            );
        }

        // 管理接口：删除图片
        if (path.startsWith('/admin/delete/') && request.method === 'DELETE') {
            if (!AuthMiddleware.verify(request, env)) {
                return AuthMiddleware.unauthorizedResponse();
            }
            const key = path.replace('/admin/delete/', '');
            return await imageService.deleteImage(key);
        }

        // MCP 服务端：无状态 Streamable HTTP，只接受 POST，永远返回单个 JSON-RPC 响应
        if (path === '/mcp') {
            if (request.method === 'OPTIONS') return McpService.preflightResponse();
            if (request.method !== 'POST') return McpService.methodNotAllowedResponse();

            // 这里独自 fail-closed，与其余端点相反：AuthMiddleware 在未配置 AUTH_TOKEN 时
            // 放行，而一个无鉴权的 MCP 端点等于把「由模型远程驱动的服务端抓取器 + 公开写入
            // 原语」暴露给任何试探 POST /mcp 的人，比开放图床严重得多。
            if (!env.AUTH_TOKEN) {
                return new Response('MCP 端点要求配置 AUTH_TOKEN', {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }

            // 鉴权前置到读 body 之前，与 /upload 的做法一致；MCP 客户端都用请求头，
            // 不提供请求体里的 token 回落。
            // 两种凭据都收：静态 AUTH_TOKEN（Claude Code / 桌面端 / 脚本）与 OAuth
            // 访问令牌（claude.ai 网页版与手机端）。401 必须带 resource_metadata，
            // 那是 Claude 找到授权服务器的唯一可靠入口。
            if (!AuthMiddleware.verify(request, env) && !await OAuthService.verifyAccessToken(request, env, url)) {
                return OAuthService.unauthorizedResponse(url);
            }

            // 不复用 checkBufferedSize：那里缺 Content-Length 就 411，而 MCP 客户端
            // 完全可能用分块传输；这里只在客户端自己声明了超限体积时才拒绝。
            const declared = Number(request.headers.get('Content-Length'));
            if (Number.isFinite(declared) && declared > MAX_BUFFERED_UPLOAD) {
                const limit = Math.floor(MAX_BUFFERED_UPLOAD / 1024 / 1024);
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32600, message: `请求体过大：MCP 请求上限 ${limit} MB，更大的图片请改用 source_url 参数` }
                }), {
                    status: 413,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return await new McpService(imageService, {
                maxBytes: MAX_BUFFERED_UPLOAD
            }).handle(request);
        }

        // 默认返回 404
        return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
};
