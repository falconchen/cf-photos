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
     * @returns {Response}
     */
    renderDashboard() {
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
            background-size: cover;
            background-position: center;
            background-color: #1e293b;
            cursor: pointer;
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

        .btn-sm {
            flex: 1;
            padding: 0.4rem;
            font-size: 0.75rem;
            border-radius: 0.5rem;
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

        .logout-btn {
            background: transparent;
            border: 1px solid var(--danger);
            color: var(--danger);
            width: auto;
            padding: 0.4rem 1rem;
            font-size: 0.875rem;
        }

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
            z-index: 1000;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        }

        @keyframes slideUp {
            from { transform: translateY(100%); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
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
            <div id="header-actions" style="display: none;">
                <button class="logout-btn" onclick="logout()">退出登录</button>
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
                        <label for="year-select">年份筛选:</label>
                        <select id="year-select" onchange="resetAndLoad()">
                            <option value="">全部</option>
                            ${this._generateYearOptions()}
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

    <div id="toast" class="toast">复制成功!</div>

    <script>
        let currentCursor = null;

        document.addEventListener('DOMContentLoaded', () => {
            const token = localStorage.getItem('cf_photo_token');
            if (token) {
                showDashboard();
            }
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
            document.getElementById('header-actions').style.display = 'block';
            loadImages();
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

        function renderImages(images, append) {
            const grid = document.getElementById('image-grid');
            if (!append) grid.innerHTML = '';

            images.forEach(img => {
                const card = document.createElement('div');
                card.className = 'image-card';
                card.innerHTML = \`
                    <div class="image-preview" style="background-image: url('\${img.url}')" onclick="window.open('\${img.url}')"></div>
                    <div class="image-info">
                        <div class="image-path" title="\${img.key}">\${img.key}</div>
                        <div class="image-meta">
                            <span>\${formatSize(img.size)}</span>
                            <span>\${new Date(img.uploaded).toLocaleDateString()}</span>
                        </div>
                        <div class="card-actions">
                            <button class="btn-sm btn-copy" onclick="copyUrl('\${img.url}')">复制</button>
                            <button class="btn-sm btn-delete" onclick="deleteImage('\${img.key}', this)">删除</button>
                        </div>
                    </div>
                \`;
                grid.appendChild(card);
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
     * 生成年份下拉选项
     * @private
     */
    _generateYearOptions() {
        const currentYear = new Date().getFullYear();
        let options = '';
        // 生成从今年开始往回数 5 年的选项
        for (let i = 0; i < 5; i++) {
            const year = currentYear - i;
            options += `<option value="${year}">${year}年</option>`;
        }
        return options;
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
