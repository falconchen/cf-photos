/**
 * 图片服务类
 * 封装与 R2 存储交互的逻辑，遵循单一职责原则
 */
export class ImageService {
    /**
     * 构造函数
     * @param {R2Bucket} bucket Cloudflare R2 Bucket 绑定对象
     */
    constructor(bucket) {
        this.bucket = bucket;
    }

    /**
     * 根据路径从 R2 中获取图片并构造响应
     * @param {string} path 请求的 URL 路径
     * @returns {Promise<Response>} 响应对象
     */
    async fetchImage(path) {
        try {
            // R2 的 Key 通常不带开头的斜杠
            const key = path.startsWith('/') ? path.slice(1) : path;

            // 调用 R2 SDK 获取对象
            const object = await this.bucket.get(key);

            // 如果对象不存在，返回 404
            if (object === null) {
                return new Response('图片不存在', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }

            // 构造响应头，保留 R2 对象的元数据（如 Content-Type, ETag 等）
            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);

            // 添加缓存控制（可选，此处暂设为 1 天）
            headers.set('Cache-Control', 'public, max-age=86400');

            // 返回图片内容
            return new Response(object.body, {
                headers,
            });
        } catch (error) {
            console.error(`ImageService.fetchImage 运行出错: ${error.message}`);
            return new Response('服务器内部错误', {
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
    }

    /**
     * 处理 multipart/form-data 上传，兼容 uPic
     * @param {Request} request 原始请求对象
     * @returns {Promise<Response>} 响应对象
     */
    /**
     * 处理 multipart/form-data 上传，兼容 uPic
     * @param {Request} request 原始请求对象
     * @param {FormData} [preParsedFormData] 预先解析好的表单数据
     * @returns {Promise<Response>} 响应对象
     */
    async uploadFormData(request, preParsedFormData) {
        try {
            const formData = preParsedFormData || await request.formData();
            // 兼容 uPic: 优先寻找 'image' 字段，其次是 'file'
            let fileField = formData.get('image') || formData.get('file');

            if (!fileField) {
                return new Response(JSON.stringify({
                    result: 'error',
                    code: 400,
                    message: '未找到文件字段 (需为 image 或 file)'
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            let contentType = '';
            let originalFilename = '';
            let fileBuffer;

            console.log(`[Debug] 开始解析表单数据, 字段类型: ${typeof fileField}`);

            // 处理真正的 File 对象 (multipart 标准)
            if (fileField instanceof File || (typeof fileField === 'object' && fileField.type)) {
                contentType = fileField.type; // 直接获取 multipart 里的 Content-Type
                originalFilename = fileField.name || '';
                fileBuffer = await fileField.arrayBuffer();
                console.log(`[Debug] Multipart模式: name="${originalFilename}", type="${contentType}", size=${fileBuffer.byteLength}`);
            }
            // 处理 uPic "使用 Base64" 勾选的情况 (字符串)
            else if (typeof fileField === 'string') {
                console.log(`[Debug] Base64模式: 字符串长度=${fileField.length}`);
                let base64Data = fileField;
                if (fileField.startsWith('data:')) {
                    const parts = fileField.split(',');
                    const mimeMatch = parts[0].match(/:(.*?);/);
                    if (mimeMatch) contentType = mimeMatch[1];
                    base64Data = parts[1];
                    console.log(`[Debug] 从 DataURL 提取 MIME: "${contentType}"`);
                }

                const binary = atob(base64Data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                fileBuffer = bytes.buffer;
            }

            // 确定后缀名：优先取原始文件名的后缀
            let extension = '';
            if (originalFilename && originalFilename.includes('.')) {
                extension = originalFilename.substring(originalFilename.lastIndexOf('.')).toLowerCase();
                console.log(`[Debug] 从文件名识别后缀: "${extension}"`);
            } else if (contentType) {
                extension = this._getExtension(contentType);
                console.log(`[Debug] 从 MIME 类型转换后缀: "${extension}"`);
            }

            console.log(`[Debug] 最终确定的后缀名: "${extension}", 存储使用的 Content-Type: "${contentType || 'application/octet-stream'}"`);

            const path = this._generateRandomPath(extension);
            const key = path.slice(1);

            // 保存到 R2，直接使用从 multipart 中解析出来的 contentType
            await this.bucket.put(key, fileBuffer, {
                httpMetadata: {
                    contentType: contentType || 'application/octet-stream',
                },
            });

            // 获取请求域名以拼接完整 URL
            const urlObj = new URL(request.url);
            const domain = `${urlObj.protocol}//${urlObj.host}`;

            // 按照用户要求的格式返回
            return new Response(JSON.stringify({
                result: 'success',
                code: 200,
                srcName: originalFilename || 'image',
                path: path,
                url: `${domain}${path}`,
                del: '',   // 暂不支持删除
                thumb: ''  // 暂不支持缩略图
            }), {
                status: 201,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (error) {
            console.error(`ImageService.uploadFormData 运行出错: ${error.message}`);
            return new Response(JSON.stringify({
                result: 'error',
                code: 500,
                message: error.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    /**
     * 处理 Base64 字符串上传 (供 JSON 接口使用)
     * @param {Request} request 原始请求对象
     * @param {string} base64String Base64 编码的图片数据
     * @returns {Promise<Response>} 响应对象
     */
    async uploadWithBase64(request, base64String) {
        try {
            let contentType = '';
            let base64Data = base64String;

            console.log(`[Debug] 开始解析 Base64 数据, 长度: ${base64String.length}`);

            // 如果带有 data:image/xxx;base64, 前缀
            if (base64String.startsWith('data:')) {
                const parts = base64String.split(',');
                const mimeMatch = parts[0].match(/:(.*?);/);
                if (mimeMatch) contentType = mimeMatch[1];
                base64Data = parts[1];
                console.log(`[Debug] 从 DataURL 提取 MIME: "${contentType}"`);
            }

            // 解码 Base64
            const binary = atob(base64Data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            const fileBuffer = bytes.buffer;

            // 确定后缀名
            let extension = '';
            if (contentType) {
                extension = this._getExtension(contentType);
                console.log(`[Debug] 从 MIME 类型转换后缀: "${extension}"`);
            }

            // 兜底：如果没拿到 MIME，尝试通过二进制特征识别（简单处理）
            if (!contentType && binary.startsWith('\x89PNG')) {
                contentType = 'image/png';
                extension = '.png';
            } else if (!contentType && binary.startsWith('\xFF\xD8')) {
                contentType = 'image/jpeg';
                extension = '.jpg';
            }

            console.log(`[Debug] 最终确定的后缀名: "${extension}", Content-Type: "${contentType || 'image/jpeg'}"`);

            const path = this._generateRandomPath(extension);
            const key = path.slice(1);

            await this.bucket.put(key, fileBuffer, {
                httpMetadata: {
                    contentType: contentType || 'image/jpeg',
                },
            });

            const urlObj = new URL(request.url);
            const domain = `${urlObj.protocol}//${urlObj.host}`;

            return new Response(JSON.stringify({
                result: 'success',
                code: 200,
                srcName: 'base64_image',
                path: path,
                url: `${domain}${path}`,
                del: '',
                thumb: ''
            }), {
                status: 201,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (error) {
            console.error(`ImageService.uploadWithBase64 运行出错: ${error.message}`);
            return new Response(JSON.stringify({
                result: 'error',
                code: 500,
                message: error.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    /**
     * 上传图片到 R2，使用自动生成的路径
     * @param {Request} request 原始请求对象（用于获取域名）
     * @param {ReadableStream} body 图片二进制流
     * @param {string} contentType 图片 MIME 类型
     * @returns {Promise<Response>} 响应对象，包含生成的路径
     */
    async uploadWithAutoPath(request, body, contentType) {
        try {
            const extension = this._getExtension(contentType);
            const path = this._generateRandomPath(extension);
            const key = path.slice(1);

            await this.bucket.put(key, body, {
                httpMetadata: {
                    contentType: contentType || 'application/octet-stream',
                },
            });

            const urlObj = new URL(request.url);
            const domain = `${urlObj.protocol}//${urlObj.host}`;

            return new Response(JSON.stringify({
                result: 'success',
                code: 200,
                path: path,
                url: `${domain}${path}`
            }), {
                status: 201,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (error) {
            console.error(`ImageService.uploadWithAutoPath 运行出错: ${error.message}`);
            return new Response(JSON.stringify({
                result: 'error',
                code: 500,
                message: error.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    /**
     * 生成随机存储路径 /i/YYYY/MM/DD/random7.ext
     * @param {string} extension 扩展名
     * @private
     */
    _generateRandomPath(extension) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let randomBase = '';
        for (let i = 0; i < 7; i++) {
            randomBase += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        return `/i/${year}/${month}/${day}/${randomBase}${extension}`;
    }

    /**
     * 删除 R2 中的图片
     * @param {string} key 图片在 R2 中的键值
     * @returns {Promise<Response>}
     */
    async deleteImage(key) {
        try {
            await this.bucket.delete(key);
            return new Response(JSON.stringify({
                result: 'success',
                code: 200,
                message: '图片已成功删除'
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (error) {
            console.error(`ImageService.deleteImage 运行出错: ${error.message}`);
            return new Response(JSON.stringify({
                result: 'error',
                code: 500,
                message: error.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    /**
     * 渲染管理后台 HTML 界面
     * @returns {Promise<Response>}
     */
    /**
     * 渲染管理后台 HTML 界面
     * @returns {Promise<Response>}
     */
    async renderDashboard() {
        const yearOptions = await this._generateYearOptions();

        const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CF-Photos 管理后台</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #3b82f6;
            --bg: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --text: #f8fafc;
            --text-dim: #94a3b8;
            --danger: #ef4444;
            --success: #10b981;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            line-height: 1.5;
            min-height: 100vh;
            background-image: radial-gradient(circle at 50% -20%, #1e293b, #0f172a);
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 3rem;
        }

        h1 {
            font-size: 1.875rem;
            font-weight: 600;
            background: linear-gradient(to right, #60a5fa, #a855f7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        /* Login Screen */
        #login-screen {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 70vh;
        }

        .login-card {
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            padding: 2.5rem;
            border-radius: 1.5rem;
            border: 1px solid rgba(255, 255, 255, 0.1);
            width: 100%;
            max-width: 400px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }

        .login-card h2 {
            margin-bottom: 1.5rem;
            text-align: center;
        }

        input {
            width: 100%;
            padding: 0.75rem 1rem;
            background: rgba(15, 23, 42, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 0.75rem;
            color: white;
            margin-bottom: 1rem;
            outline: none;
            transition: border-color 0.2s;
        }

        input:focus {
            border-color: var(--primary);
        }

        button {
            width: 100%;
            padding: 0.75rem;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 0.75rem;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        button:hover {
            opacity: 0.9;
        }

        /* Dashboard */
        #dashboard {
            display: none;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 1.5rem;
        }

        .image-card {
            background: var(--card-bg);
            border-radius: 1rem;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.05);
            transition: transform 0.2s, box-shadow 0.2s;
            position: relative;
        }

        .image-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
        }

        .image-preview {
            aspect-ratio: 16/10;
            background-color: #1e293b;
            cursor: pointer;
            position: relative;
            overflow: hidden;
        }

        .real-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-size: cover;
            background-position: center;
            opacity: 0;
            transition: opacity 0.6s ease-in-out;
            z-index: 1;
        }

        .real-image.loaded {
            opacity: 1;
        }

        .pulse {
            background: linear-gradient(-45deg, #1e293b, #334155, #1e293b);
            background-size: 400% 400%;
            animation: pulse 1.5s ease infinite;
        }

        @keyframes pulse {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }

        .image-info {
            padding: 1rem;
        }

        .image-path {
            font-size: 0.875rem;
            color: var(--text-dim);
            word-break: break-all;
            margin-bottom: 0.5rem;
            display: -webkit-box;
            -webkit-line-clamp: 1;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .image-meta {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            color: var(--text-dim);
        }

        .card-actions {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
        }

        .logout-btn {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.2);
            color: var(--danger);
            width: auto;
            padding: 0.4rem 1rem;
            font-size: 0.875rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            border-radius: 0.5rem;
        }

        .btn-sm {
            flex: 1;
            padding: 0.4rem;
            font-size: 0.75rem;
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.3rem;
            cursor: pointer;
            transition: all 0.2s;
            border: 1px solid transparent;
            color: var(--text);
        }

        .btn-copy {
            background: rgba(255, 255, 255, 0.1);
        }

        .btn-delete {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            border: 1px solid rgba(239, 68, 68, 0.2);
        }

        .btn-delete:hover {
            background: var(--danger);
            color: white;
        }

        .btn-primary {
            background: var(--primary);
            color: white;
            width: auto;
            padding: 0.4rem 1.2rem;
            font-size: 0.875rem;
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        /* Modal Styles */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(8px);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 2000;
        }

        .modal {
            background: #1e293b;
            width: 100%;
            max-width: 600px;
            border-radius: 1.5rem;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            overflow: hidden;
        }

        .modal-header {
            padding: 1.5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-header h3 {
            font-size: 1.25rem;
            font-weight: 600;
        }

        .close-modal {
            background: transparent;
            border: none;
            color: var(--text-dim);
            font-size: 1.5rem;
            cursor: pointer;
            width: auto;
            padding: 0;
        }

        .modal-content {
            padding: 2rem;
        }

        /* Upload Area */
        .upload-dropzone {
            border: 2px dashed rgba(255, 255, 255, 0.1);
            border-radius: 1rem;
            padding: 3rem 2rem;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            background: rgba(15, 23, 42, 0.3);
        }

        .upload-dropzone.active {
            border-color: var(--primary);
            background: rgba(59, 130, 246, 0.1);
        }

        .upload-dropzone svg {
            width: 48px;
            height: 48px;
            color: var(--text-dim);
            margin-bottom: 1rem;
        }

        .upload-dropzone p {
            color: var(--text-dim);
            font-size: 0.875rem;
        }

        .upload-list {
            margin-top: 1.5rem;
            max-height: 200px;
            overflow-y: auto;
        }

        .upload-item {
            display: flex;
            align-items: center;
            gap: 1rem;
            background: rgba(15, 23, 42, 0.4);
            padding: 0.6rem 0.75rem;
            border-radius: 0.75rem;
            margin-bottom: 0.5rem;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .upload-item-thumb {
            width: 40px;
            height: 40px;
            border-radius: 0.4rem;
            object-fit: cover;
            background: rgba(0, 0, 0, 0.2);
            flex-shrink: 0;
        }

        .upload-item-info {
            flex: 1;
            min-width: 0;
        }

        .upload-item-name {
            font-size: 0.875rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .upload-item-progress {
            height: 4px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
            margin-top: 0.4rem;
            overflow: hidden;
        }

        .progress-bar {
            height: 100%;
            background: var(--primary);
            width: 0%;
            transition: width 0.3s;
        }

        .upload-item-status {
            font-size: 0.75rem;
            white-space: nowrap;
        }

        .upload-item-actions {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .btn-copy-link {
            padding: 0.3rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(59, 130, 246, 0.1);
            color: var(--primary);
            border: 1px solid rgba(59, 130, 246, 0.2);
            border-radius: 0.4rem;
            cursor: pointer;
            width: 28px;
            height: 28px;
            flex-shrink: 0;
        }

        .btn-copy-link:hover {
            background: var(--primary);
            color: white;
        }

        .status-success { color: var(--success); }
        .status-error { color: var(--danger); }

        #loading {
            text-align: center;
            padding: 4rem;
            color: var(--text-dim);
        }

        .toast {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            background: var(--primary);
            color: white;
            padding: 0.75rem 1.5rem;
            border-radius: 0.5rem;
            display: none;
            animation: slideUp 0.3s ease-out;
            z-index: 3000;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        }

        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .spin {
            animation: spin 1s linear infinite;
        }

        /* Filter Bar */
        .filter-bar {
            background: var(--card-bg);
            padding: 1rem 1.5rem;
            border-radius: 1rem;
            margin-bottom: 2rem;
            display: flex;
            gap: 1.5rem;
            align-items: center;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .select-group {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .select-group label {
            font-size: 0.875rem;
            color: var(--text-dim);
            white-space: nowrap;
        }

        .select-group select {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: white;
            padding: 0.4rem 1rem;
            border-radius: 0.5rem;
            outline: none;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Photo Cloud</h1>
            <div id="header-actions" style="display: none; display: flex; gap: 0.75rem;">
                <button class="btn-primary" onclick="showUploadModal()">
                    <svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                    上传图片
                </button>
                <button class="logout-btn" onclick="logout()">
                    <svg style="width: 16px; height: 16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
                    退出登录
                </button>
            </div>
        </header>

        <main>
            <!-- Login -->
            <div id="login-screen">
                <div class="login-card">
                    <h2>管理鉴权</h2>
                    <input type="password" id="token-input" placeholder="输入 AUTH_TOKEN">
                    <button onclick="login()">进入管理后台</button>
                    <p id="login-error" style="color: var(--danger); font-size: 0.875rem; margin-top: 1rem; display: none;"></p>
                </div>
            </div>

            <!-- Dashboard -->
            <div id="dashboard">
                <div class="filter-bar">
                    <div class="select-group">
                        <svg style="width: 16px; height: 16px; color: var(--text-dim);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        <label for="year-select">年份筛选:</label>
                        <select id="year-select" onchange="resetAndLoad()">
                            <option value="">全部</option>
                            ${yearOptions}
                        </select>
                    </div>
                </div>
                <div id="loading">正在加载图片...</div>
                <div id="image-grid" class="grid"></div>
                <div id="load-more" style="text-align: center; margin-top: 3rem; display: none;">
                    <button onclick="loadImages(true)" style="width: auto; padding: 0.75rem 2rem;">加载更多</button>
                </div>
            </div>
        </main>
    </div>

    <!-- Upload Modal -->
    <div id="upload-modal" class="modal-overlay" onclick="handleOverlayClick(event)">
        <div class="modal">
            <div class="modal-header">
                <h3>上传文件</h3>
                <button class="close-modal" onclick="hideUploadModal()">&times;</button>
            </div>
            <div class="modal-content">
                <div id="dropzone" class="upload-dropzone" onclick="document.getElementById('file-input').click()">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                    <p>拖拽文件到这里 或 点击上传</p>
                    <input type="file" id="file-input" multiple hidden accept="image/*" onchange="handleFileSelect(event)">
                </div>
                <div id="upload-list" class="upload-list"></div>
            </div>
        </div>
    </div>

    <div id="toast" class="toast">复制成功!</div>

    <script>
        let currentCursor = null;

        document.addEventListener('DOMContentLoaded', () => {
            const token = localStorage.getItem('cf_photo_token');
            if (token) {
                showDashboard();
            }
            // 页面加载时初始化一次拖拽事件即可
            initDragAndDrop();
        });

        function login() {
            const token = document.getElementById('token-input').value;
            if (!token) return;
            localStorage.setItem('cf_photo_token', token);
            showDashboard();
        }

        function logout() {
            localStorage.removeItem('cf_photo_token');
            location.reload();
        }

        function showDashboard() {
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('dashboard').style.display = 'block';
            document.getElementById('header-actions').style.display = 'flex'; // 修正为 flex 以配合新增按钮
            loadImages();
        }

        /* Upload Logic */
        function showUploadModal() {
            document.getElementById('upload-modal').style.display = 'flex';
        }

        function hideUploadModal() {
            document.getElementById('upload-modal').style.display = 'none';
            // 清理上传列表
            document.getElementById('upload-list').innerHTML = '';
        }

        function handleOverlayClick(e) {
            if (e.target.classList.contains('modal-overlay')) {
                hideUploadModal();
            }
        }

        function initDragAndDrop() {
            const dropzone = document.getElementById('dropzone');
            if (!dropzone) return;

            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                // 在 window 上也禁用默认行为以免浏览器直接打开图片
                window.addEventListener(eventName, e => {
                    e.preventDefault();
                    e.stopPropagation();
                }, false);
                
                dropzone.addEventListener(eventName, e => {
                    e.preventDefault();
                    e.stopPropagation();
                }, false);
            });

            ['dragenter', 'dragover'].forEach(eventName => {
                dropzone.addEventListener(eventName, () => dropzone.classList.add('active'), false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                dropzone.addEventListener(eventName, () => dropzone.classList.remove('active'), false);
            });

            dropzone.addEventListener('drop', e => {
                const files = e.dataTransfer.files;
                if (files && files.length > 0) {
                    handleFiles(files);
                }
            }, false);
        }

        function handleFileSelect(e) {
            const files = e.target.files;
            handleFiles(files);
        }

        function handleFiles(files) {
            ([...files]).forEach(uploadFile);
        }

        async function uploadFile(file) {
            if (!file.type.startsWith('image/')) {
                showToast('只允许上传图片文件', 'var(--danger)');
                return;
            }

            const id = 'upload-' + Math.random().toString(36).substr(2, 9);
            const uploadList = document.getElementById('upload-list');

            // 生成本地预览图
            const previewUrl = URL.createObjectURL(file);

            const item = document.createElement('div');
            item.className = 'upload-item';
            item.id = id;
            item.innerHTML = '<img class="upload-item-thumb" src="' + previewUrl + '">' +
                '<div class="upload-item-info">' +
                    '<div class="upload-item-name">' + file.name + '</div>' +
                    '<div class="upload-item-progress"><div class="progress-bar"></div></div>' +
                '</div>' +
                '<div class="upload-item-actions">' +
                    '<div class="upload-item-status">' +
                        '<svg class="spin" style="width:16px;height:16px;opacity:0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>' +
                    '</div>' +
                '</div>';
            uploadList.prepend(item);

            const formData = new FormData();
            formData.append('file', file);

            const token = localStorage.getItem('cf_photo_token');
            const progressBar = item.querySelector('.progress-bar');
            const actionArea = item.querySelector('.upload-item-actions');
            const statusText = item.querySelector('.upload-item-status');

            try {
                statusText.innerHTML = '<svg class="spin" style="width:16px;height:16px;opacity:0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>';
                progressBar.style.width = '30%';

                const res = await fetch('/upload', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: formData
                });

                progressBar.style.width = '100%';

                const data = await res.json();
                if (data.result === 'success') {
                    statusText.innerHTML = '<svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
                    statusText.className = 'upload-item-status status-success';

                    // 添加复制按钮
                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'btn-copy-link';
                    copyBtn.title = '复制链接';
                    copyBtn.innerHTML = '<svg style="width:14px;height:14px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>';
                    copyBtn.onclick = () => copyUrl(data.url);
                    actionArea.appendChild(copyBtn);

                    showToast('上传成功: ' + file.name);

                    // 直接将新上传的图片插入到列表最前面
                    const newImage = {
                        key: data.path.startsWith('/') ? data.path.slice(1) : data.path,
                        url: data.url,
                        size: file.size,
                        uploaded: new Date().toISOString()
                    };
                    renderImages([newImage], true, true);
                } else {
                    statusText.innerHTML = '<svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
                    statusText.className = 'upload-item-status status-error';
                    alert('上传失败: ' + data.message);
                }
            } catch (e) {
                statusText.innerHTML = '<svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
                statusText.className = 'upload-item-status status-error';
                console.error(e);
            } finally {
                // 上传完毕后一段时间清理 URL 对象释放内存（可选，但通常推荐）
                // setTimeout(() => URL.revokeObjectURL(previewUrl), 10000);
            }
        }

        function resetAndLoad() {
            currentCursor = null;
            document.getElementById('loading').style.display = 'block';
            document.getElementById('image-grid').innerHTML = '';
            loadImages();
        }

        async function loadImages(append = false) {
            const token = localStorage.getItem('cf_photo_token');
            const url = new URL('/admin/list', location.origin);
            url.searchParams.set('limit', 12);
            
            const year = document.getElementById('year-select').value;
            if (year) url.searchParams.set('year', year);

            if (append && currentCursor) {
                url.searchParams.set('cursor', currentCursor);
            }

            try {
                const res = await fetch(url, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });

                if (res.status === 401) {
                    localStorage.removeItem('cf_photo_token');
                    location.reload();
                    return;
                }

                const data = await res.json();
                if (data.result === 'success') {
                    renderImages(data.data.images, append);
                    currentCursor = data.data.cursor;
                    document.getElementById('load-more').style.display = currentCursor ? 'block' : 'none';
                    document.getElementById('loading').style.display = 'none';
                } else {
                    alert('获取失败: ' + data.message);
                }
            } catch (e) {
                console.error(e);
                alert('网络请求出错');
            }
        }

        function renderImages(images, append, prepend = false) {
            const grid = document.getElementById('image-grid');
            if (!append && !prepend) grid.innerHTML = '';

            images.forEach(img => {
                const card = document.createElement('div');
                card.className = 'image-card';
                
                // 唯一的 ID 用于在该卡片内操作图片
                const imageId = 'img-' + Math.random().toString(36).substr(2, 9);
                
                card.innerHTML = \`
                    <div class="image-preview pulse" onclick="window.open('\${img.url}')">
                        <div id="\${imageId}" class="real-image"></div>
                    </div>
                    <div class="image-info">
                        <div class="image-path" title="\${img.key}">\${img.key}</div>
                        <div class="image-meta">
                            <span>\${formatSize(img.size)}</span>
                            <span>\${new Date(img.uploaded).toLocaleDateString()}</span>
                        </div>
                        <div class="card-actions">
                            <button class="btn-sm btn-copy" onclick="copyUrl('\${img.url}')">
                                <svg style="width: 14px; height: 14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
                                复制
                            </button>
                            <button class="btn-sm btn-delete" onclick="deleteImage('\${img.key}', this)">
                                <svg style="width: 14px; height: 14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                删除
                            </button>
                        </div>
                    </div>
                \`;
                
                if (prepend) {
                    grid.insertBefore(card, grid.firstChild);
                } else {
                    grid.appendChild(card);
                }

                // 异步预加载图片
                const loader = new Image();
                loader.src = img.url;
                loader.onload = () => {
                    const el = document.getElementById(imageId);
                    if (el) {
                        el.style.backgroundImage = \`url('\${img.url}')\`;
                        el.classList.add('loaded');
                        // 加载完成后移除外层 pulse 效果
                        setTimeout(() => {
                            el.parentElement.classList.remove('pulse');
                        }, 600);
                    }
                };
            });
        }

        async function deleteImage(key, btn) {
            if (!confirm('确定要永久删除这张图片吗？此操作不可撤销。')) return;
            
            const originalText = btn.textContent;
            btn.textContent = '删除中...';
            btn.disabled = true;

            const token = localStorage.getItem('cf_photo_token');
            try {
                const res = await fetch('/admin/delete/' + key, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });

                const data = await res.json();
                if (data.result === 'success') {
                    showToast('删除成功', 'var(--success)');
                    // 动态移除卡片
                    const card = btn.closest('.image-card');
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.9)';
                    setTimeout(() => card.remove(), 300);
                } else {
                    alert('删除失败: ' + data.message);
                    btn.textContent = originalText;
                    btn.disabled = false;
                }
            } catch (e) {
                alert('请求出错');
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }

        function formatSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function copyUrl(url) {
            navigator.clipboard.writeText(url).then(() => {
                showToast('复制成功!');
            });
        }

        function showToast(text, color) {
            const toast = document.getElementById('toast');
            toast.textContent = text;
            toast.style.background = color || 'var(--primary)';
            toast.style.display = 'block';
            setTimeout(() => { toast.style.display = 'none'; }, 2000);
        }
    </script>
</body>
</html>
        `;

        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    /**
     * 生成年份下拉选项 (从 R2 动态查询)
     * @private
     */
    async _generateYearOptions() {
        const foundYears = new Set();
        const currentYear = new Date().getFullYear();

        try {
            // 使用 delimiter 尝试列出一级目录 (最快)
            const listed = await this.bucket.list({
                prefix: 'i/',
                delimiter: '/'
            });

            if (listed.delimitedPrefixes) {
                listed.delimitedPrefixes.forEach(p => {
                    const match = p.match(/i\/(\d{4})\//);
                    if (match) foundYears.add(match[1]);
                });
            }
        } catch (error) {
            console.error('动态发现年份失败:', error);
        }

        // 转换为排序后的数组
        const sortedYears = Array.from(foundYears).sort((a, b) => b - a);

        // 兜底: 如果没有发现年份，至少显示当前年份
        if (sortedYears.length === 0) {
            sortedYears.push(currentYear.toString());
        }

        return sortedYears.map(y => `<option value="${y}">${y}年</option>`).join('');
    }


    /**
     * 获取 R2 中的图片列表
     * @param {Request} request 原始请求对象 (用于拼接完整 URL)
     * @param {number} limit 每次获取的数量限制
     * @param {string} cursor 分页游标
     * @param {string} year 年份 (可选)
     * @param {string} month 月份 (可选)
     * @param {string} day 日期 (可选)
     * @returns {Promise<Response>} 响应对象，包含图片列表和分页信息
     */
    async listImages(request, limit = 50, cursor = null, year = null, month = null, day = null) {
        try {
            // 根据年份、月份和日期构造前缀
            let prefix = 'i/';
            if (year) {
                prefix += `${year}/`;
                if (month) {
                    prefix += `${month.padStart(2, '0')}/`;
                    if (day) {
                        prefix += `${day.padStart(2, '0')}/`;
                    }
                }
            }

            const options = {
                limit: Math.min(limit, 100), // 最大限制 100
                prefix: prefix, // 按目录前缀进行筛选
            };

            // 仅在 cursor 存在且不为 null/undefined 时添加该属性
            if (cursor) {
                options.cursor = cursor;
            }

            const listed = await this.bucket.list(options);
            const urlObj = new URL(request.url);
            const domain = `${urlObj.protocol}//${urlObj.host}`;

            const images = listed.objects.map(obj => ({
                key: obj.key,
                url: `${domain}/${obj.key}`,
                size: obj.size,
                uploaded: obj.uploaded,
                httpMetadata: obj.httpMetadata
            }));

            return new Response(JSON.stringify({
                result: 'success',
                code: 200,
                data: {
                    images: images,
                    cursor: listed.truncated ? listed.cursor : null,
                    count: images.length
                }
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (error) {
            console.error(`ImageService.listImages 运行出错: ${error.message}`);
            return new Response(JSON.stringify({
                result: 'error',
                code: 500,
                message: error.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    /**
     * 根据 Content-Type 获取文件扩展名
     * @param {string} contentType 
     * @private
     */
    _getExtension(contentType) {
        if (!contentType) return '';

        const mimeMap = {
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
            'image/x-icon': '.ico',
            'image/heic': '.heic',
            'image/avif': '.avif',
            'image/bmp': '.bmp',
            'image/tiff': '.tiff'
        };

        return mimeMap[contentType.toLowerCase()] || '';
    }

    /**
     * 上传图片到 R2 (保持原有的手动路径上传)
     * @param {string} path 图片存储路径
     * @param {ReadableStream} body 图片二进制流
     * @param {string} contentType 图片 MIME 类型
     * @returns {Promise<Response>} 响应对象
     */
    async uploadImage(path, body, contentType) {
        try {
            const key = path.startsWith('/') ? path.slice(1) : path;

            // 执行上传
            await this.bucket.put(key, body, {
                httpMetadata: {
                    contentType: contentType || 'application/octet-stream',
                },
            });

            return new Response('上传成功', {
                status: 201,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        } catch (error) {
            console.error(`ImageService.uploadImage 运行出错: ${error.message}`);
            return new Response(`上传失败: ${error.message}`, {
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
    }
}
