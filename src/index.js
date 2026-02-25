/**
 * Cloudflare Worker 入口文件
 * 负责路由请求并分发到对应的处理器
 */

import { ImageService } from './services/ImageService.js';
import { AuthMiddleware } from './middleware/AuthMiddleware.js';

export default {
    /**
     * 接管 HTTP 请求并返回响应
     * @param {Request} request 原始请求对象
     * @param {Object} env 环境变量，包含 R2 存储绑定等
     * @param {Context} ctx 上下文对象
     * @returns {Promise<Response>} 响应对象
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const imageService = new ImageService(env.MY_BUCKET);

        // 首页：展示管理后台界面
        if (path === '/' && request.method === 'GET') {
            return imageService.renderDashboard();
        }

        // 处理自动上传路由
        if (path === '/upload' && request.method === 'POST') {
            const contentType = request.headers.get('Content-Type') || '';
            console.log(`[Debug] 上传请求 Content-Type: "${contentType}"`);

            // 1. 兼容 uPic 的 multipart/form-data 上传
            if (contentType.includes('multipart/form-data')) {
                const formData = await request.formData();

                // 鉴权校验：优先 Header，其次表单字段 "token"
                const hasHeaderAuth = AuthMiddleware.verify(request, env);
                const formToken = formData.get('token');
                const hasFormAuth = formToken ? AuthMiddleware.verifyToken(formToken, env) : false;

                if (!hasHeaderAuth && !hasFormAuth) {
                    return AuthMiddleware.unauthorizedResponse();
                }

                return await imageService.uploadFormData(request, formData);
            }

            // 2. 兼容 uPic 的 application/json (Base64) 上传
            if (contentType.includes('application/json')) {
                const body = await request.json();
                const imageBase64 = body.image;
                const jsonToken = body.token;

                if (!imageBase64) {
                    return new Response(JSON.stringify({ result: 'error', code: 400, message: '缺少 image 字段' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                // 鉴权校验
                const hasHeaderAuth = AuthMiddleware.verify(request, env);
                const hasJsonAuth = jsonToken ? AuthMiddleware.verifyToken(jsonToken, env) : false;

                if (!hasHeaderAuth && !hasJsonAuth) {
                    return AuthMiddleware.unauthorizedResponse();
                }

                return await imageService.uploadWithBase64(request, imageBase64);
            }

            // 3. 传统的二进制流上传
            if (!AuthMiddleware.verify(request, env)) {
                return AuthMiddleware.unauthorizedResponse();
            }
            return await imageService.uploadWithAutoPath(request, request.body, contentType);
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

            return await imageService.fetchImage(path);
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

            return await imageService.listImages(request, limit, cursor, year, month, day);
        }

        // 管理接口：删除图片
        if (path.startsWith('/admin/delete/') && request.method === 'DELETE') {
            if (!AuthMiddleware.verify(request, env)) {
                return AuthMiddleware.unauthorizedResponse();
            }
            const key = path.replace('/admin/delete/', '');
            return await imageService.deleteImage(key);
        }

        // 默认返回 404
        return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
};
