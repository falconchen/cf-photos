/**
 * 图片服务类
 * 封装与 WebDAV 存储交互的逻辑，遵循单一职责原则
 */

// Base60 字符表：0-9、A-Z、a-x（去掉 y、z 以凑满 60 个字符）
const BASE60 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx';

// 未配置 TIMEZONE_OFFSET 时使用的默认时区偏移（东八区）
const DEFAULT_TIMEZONE_OFFSET = 8;

/**
 * 解析环境变量中的时区偏移，非法值回退到默认值
 * Workers 运行时恒为 UTC，故所有本地时间都由该偏移换算得出
 * @param {string|number|undefined} value 环境变量 TIMEZONE_OFFSET 的原始值
 * @returns {number} 合法的时区偏移（小时，允许 0.5/0.75 等半时区）
 */
function parseTimezoneOffset(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_TIMEZONE_OFFSET;
    }

    const offset = Number(value);
    if (!Number.isFinite(offset) || offset < -12 || offset > 14) {
        console.warn(`[Config] TIMEZONE_OFFSET 非法："${value}"，回退到 ${DEFAULT_TIMEZONE_OFFSET}`);
        return DEFAULT_TIMEZONE_OFFSET;
    }

    return offset;
}

/**
 * 将数值编码为定长 Base60 字符串（高位在前，不足补 '0'）
 * @param {number} value 待编码的非负整数
 * @param {number} length 输出长度
 * @returns {string} 定长 Base60 字符串
 */
function encodeBase60Fixed(value, length) {
    let result = '';

    for (let i = 0; i < length; i++) {
        result = BASE60[value % 60] + result;
        value = Math.floor(value / 60);
    }

    return result;
}

/**
 * 生成指定长度的 Base60 随机串（使用 crypto 强随机）
 * @param {number} [length=3] 随机串长度
 * @returns {string} Base60 随机串
 */
function randomBase60(length = 3) {
    let result = '';

    while (result.length < length) {
        const bytes = new Uint8Array(length - result.length);
        crypto.getRandomValues(bytes);

        for (const byte of bytes) {
            // 240 = 60 × 4，避免取模偏差
            if (byte < 240) {
                result += BASE60[byte % 60];

                if (result.length === length) {
                    break;
                }
            }
        }
    }

    return result;
}

/**
 * 生成基于时间的 8 位 Base60 ID：时分秒(3) + 毫秒(2) + 随机(3)
 * @param {Date} [date=new Date()] 基准时间
 * @param {number} [timezoneOffset=DEFAULT_TIMEZONE_OFFSET] 时区偏移（小时）
 * @returns {string} 8 位 Base60 ID
 */
function generateTimeId(date = new Date(), timezoneOffset = DEFAULT_TIMEZONE_OFFSET) {
    const local = new Date(
        date.getTime() + timezoneOffset * 60 * 60 * 1000
    );

    return (
        BASE60[local.getUTCHours()] +
        BASE60[local.getUTCMinutes()] +
        BASE60[local.getUTCSeconds()] +
        encodeBase60Fixed(local.getUTCMilliseconds(), 2) +
        randomBase60(3)
    );
}

export class ImageService {
    /**
     * 构造函数
     * @param {WebDAVStorage} storage WebDAV 存储对象
     * @param {Object} [env={}] 环境变量，用于读取 TIMEZONE_OFFSET
     */
    constructor(storage, env = {}) {
        this.storage = storage;
        this.timezoneOffset = parseTimezoneOffset(env?.TIMEZONE_OFFSET);
    }

    /**
     * 按配置的时区偏移换算出的"当前本地时间"
     * 返回的 Date 需用 getUTC* 系列方法读取，避免二次时区换算
     * @returns {Date} 偏移后的时间对象
     * @private
     */
    _localNow() {
        return new Date(Date.now() + this.timezoneOffset * 60 * 60 * 1000);
    }

    /**
     * 根据路径从 WebDAV 中获取图片并构造响应
     * @param {string} path 请求的 URL 路径
     * @returns {Promise<Response>} 响应对象
     */
    async fetchImage(path, request = null) {
        try {
            // WebDAV 的 Key 通常不带开头的斜杠
            const key = decodeURIComponent(path.startsWith('/') ? path.slice(1) : path);

            // Range 透传给 WebDAV 由其分片，视频/音频才能拖拽定位，Worker 不缓冲
            const range = request?.headers.get('Range') || null;
            const object = await this.storage.get(key, range ? { range } : {});

            // 如果对象不存在，返回 404
            if (object === null) {
                return new Response('图片不存在', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }

            // 构造响应头，保留 WebDAV 对象的元数据（如 Content-Type, ETag 等）
            const headers = new Headers();
            object.writeHttpMetadata(headers);
            if (object.httpEtag) headers.set('etag', object.httpEtag);

            // 添加缓存控制（可选，此处暂设为 1 天）
            headers.set('Cache-Control', 'public, max-age=86400');

            // 后端接受 Range 时返回 206，忽略 Range 时仍是 200，交由客户端处理
            return new Response(object.body, {
                status: object.status || 200,
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

            // 确定后缀名：优先取原始文件名的后缀，其次由 MIME 类型推断
            const extension = this._extensionFrom(originalFilename, contentType);
            console.log(`[Debug] 推断后缀名: "${extension}"`);

            console.log(`[Debug] 最终确定的后缀名: "${extension}", 存储使用的 Content-Type: "${contentType || 'application/octet-stream'}"`);

            const path = this._generateRandomPath(extension);
            const key = path.slice(1);

            // 保存到 WebDAV，直接使用从 multipart 中解析出来的 contentType
            await this.storage.put(key, fileBuffer, {
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

            await this.storage.put(key, fileBuffer, {
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
     * 上传图片到 WebDAV，使用自动生成的路径
     * @param {Request} request 原始请求对象（用于获取域名）
     * @param {ReadableStream} body 图片二进制流
     * @param {string} contentType 图片 MIME 类型
     * @returns {Promise<Response>} 响应对象，包含生成的路径
     */
    async uploadWithAutoPath(request, body, contentType, filename = '') {
        try {
            const extension = this._extensionFrom(filename, contentType);
            const path = this._generateRandomPath(extension);
            const key = path.slice(1);

            await this.storage.put(key, body, {
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
     * 生成时间序存储路径 /i/YYYY/MM/DD/<8位Base60ID>.ext
     * 日期目录与文件名同用 TIMEZONE_OFFSET 换算，保证两者始终一致
     * @param {string} extension 扩展名
     * @private
     */
    _generateRandomPath(extension) {
        const local = this._localNow();
        const year = local.getUTCFullYear();
        const month = String(local.getUTCMonth() + 1).padStart(2, '0');
        const day = String(local.getUTCDate()).padStart(2, '0');

        return `/i/${year}/${month}/${day}/${generateTimeId(new Date(), this.timezoneOffset)}${extension}`;
    }

    /**
     * 删除 WebDAV 中的图片
     * @param {string} key 图片在 WebDAV 中的键值
     * @returns {Promise<Response>}
     */
    async deleteImage(key) {
        try {
            await this.storage.delete(decodeURIComponent(key));
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
    async renderDashboard() {
        const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PhotoFlare 管理后台</title>
    <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNjBhNWZhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjYTg1NWY3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0idXJsKCNnKSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyLjQiPjxjaXJjbGUgY3g9IjE0IiBjeT0iMTgiIHI9IjguNCIvPjxjaXJjbGUgY3g9IjE0IiBjeT0iMTgiIHI9IjMuNSIvPjwvZz48Y2lyY2xlIGN4PSIxOC4yIiBjeT0iMTMuOCIgcj0iMS4xNSIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0yNC4yIDMuNHExLjEgMy43IDQuOCA0LjgtMy43IDEuMS00LjggNC44LTEuMS0zLjctNC44LTQuOCAzLjctMS4xIDQuOC00LjhaIiBmaWxsPSIjZmZmIi8+PC9zdmc+">
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
            flex-wrap: wrap;
            gap: 1rem;
            margin-bottom: 3rem;
        }

        h1 {
            font-size: 1.875rem;
            font-weight: 600;
            white-space: nowrap;
            background: linear-gradient(to right, #60a5fa, #a855f7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .logo-icon {
            background: linear-gradient(to bottom right, #60a5fa, #a855f7);
            -webkit-background-clip: unset;
            -webkit-text-fill-color: initial;
            fill: white;
            padding: 6px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(96, 165, 250, 0.3);
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

        /* 未鉴权时隐藏；showDashboard() 会改成 flex */
        #header-actions {
            display: none;
            gap: 0.75rem;
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
            justify-content: center;
            gap: 0.5rem;
            border-radius: 0.5rem;
            white-space: nowrap;
            flex-shrink: 0;
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
            justify-content: center;
            gap: 0.5rem;
            white-space: nowrap;
            flex-shrink: 0;
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
            margin: 1rem;
            max-height: calc(100vh - 2rem);
            overflow-y: auto;
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

        /* 音频没有画面，缩略图位置放一个图标占位 */
        .upload-item-thumb-audio,
        .media-audio {
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-dim);
        }

        /* <video> 直接铺满预览框，取代 .real-image 的背景图方案 */
        video.real-image {
            object-fit: cover;
            background: #0f172a;
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
            flex-wrap: wrap;
            gap: 1rem 1.5rem;
            align-items: center;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .filter-bar .spacer {
            flex: 1;
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

        .select-group select:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }

        /* 年/月/日三个下拉始终同处一行 */
        .date-selects {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        /* 窄屏（手机）适配：头部与筛选栏改为纵向堆叠，控件占满一行 */
        @media (max-width: 640px) {
            .container {
                padding: 1.25rem 1rem;
            }

            header {
                flex-direction: column;
                align-items: stretch;
                gap: 1rem;
                margin-bottom: 1.75rem;
            }

            h1 {
                font-size: 1.5rem;
                gap: 0.5rem;
            }

            h1 .logo-icon {
                width: 28px !important;
                height: 28px !important;
            }

            /* showDashboard() 会把 display 改成 flex，这里只调布局 */
            #header-actions {
                width: 100%;
            }

            #header-actions > button {
                flex: 1;
                padding: 0.55rem 0.75rem;
            }

            #login-screen {
                height: auto;
                min-height: 60vh;
            }

            .login-card {
                padding: 1.75rem 1.25rem;
            }

            .filter-bar {
                padding: 1rem;
                gap: 0.75rem;
                margin-bottom: 1.5rem;
            }

            .filter-bar .spacer {
                display: none;
            }

            .select-group {
                width: 100%;
                gap: 0.5rem;
            }

            .select-group select {
                flex: 1;
                min-width: 0;
                padding: 0.5rem 0.5rem;
                font-size: 0.8125rem;
            }

            /* 标签占一整行，下面三个下拉等分一行 */
            .date-group {
                flex-wrap: wrap;
                row-gap: 0.6rem;
            }

            .date-selects {
                width: 100%;
                gap: 0.5rem;
            }

            .grid {
                grid-template-columns: 1fr;
                gap: 1rem;
            }

            .modal-content {
                padding: 1.25rem;
            }

            .modal-header {
                padding: 1.25rem;
            }

            .upload-dropzone {
                padding: 2rem 1rem;
            }

            .toast {
                left: 1rem;
                right: 1rem;
                bottom: 1rem;
                text-align: center;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>
                <svg class="logo-icon" style="width: 32px; height: 32px;" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <!-- 镜头外圈 -->
                    <circle cx="10.5" cy="13.5" r="7" fill="none" stroke="white" stroke-width="1.8"/>
                    <!-- 光圈内核 -->
                    <circle cx="10.5" cy="13.5" r="2.9" fill="none" stroke="white" stroke-width="1.8"/>
                    <!-- 耀斑鬼影 -->
                    <circle cx="13.9" cy="10.1" r="1" fill="white"/>
                    <!-- 星芒耀斑 -->
                    <path d="M19 1.5Q19.9 4.6 23 5.5Q19.9 6.4 19 9.5Q18.1 6.4 15 5.5Q18.1 4.6 19 1.5Z" fill="white"/>
                </svg>
                PhotoFlare
            </h1>
            <div id="header-actions">
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
                    <div class="select-group date-group">
                        <svg style="width: 16px; height: 16px; color: var(--text-dim); flex-shrink: 0;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        <label for="year-select">日期筛选:</label>
                        <div class="date-selects">
                            <select id="year-select" onchange="onYearChange()">
                                <option value="">全部年份</option>
                            </select>
                            <select id="month-select" onchange="onMonthChange()" disabled>
                                <option value="">全部月份</option>
                            </select>
                            <select id="day-select" onchange="resetAndLoad()" disabled>
                                <option value="">全部日期</option>
                            </select>
                        </div>
                    </div>
                    <div class="spacer"></div>
                    <div class="select-group">
                        <svg style="width: 16px; height: 16px; color: var(--text-dim);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9M3 12h5m5 8V8m0 12l-3-3m3 3l3-3"></path></svg>
                        <label for="order-select">排序:</label>
                        <select id="order-select" onchange="resetAndLoad()">
                            <option value="desc">最新在前</option>
                            <option value="asc">最早在前</option>
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
                    <p>拖拽文件、粘贴 或 点击上传</p>
                    <input type="file" id="file-input" multiple hidden accept="image/*,video/*,audio/*" onchange="handleFileSelect(event)">
                </div>
                <div id="upload-list" class="upload-list"></div>
            </div>
        </div>
    </div>

    <div id="toast" class="toast">复制成功!</div>

    <script>
        let currentCursor = null;
        let isLoading = false;

        document.addEventListener('DOMContentLoaded', () => {
            const token = localStorage.getItem('cf_photo_token');
            if (token) {
                showDashboard();
            }
            // 页面加载时初始化一次拖拽事件即可
            initDragAndDrop();
            initPasteSupport();
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
            loadDirOptions('year');
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

        /**
         * 初始化粘贴上传支持
         */
        function initPasteSupport() {
            document.addEventListener('paste', e => {
                const modal = document.getElementById('upload-modal');
                // 仅当上传弹窗处于显示状态时才处理粘贴
                if (modal && modal.style.display === 'flex') {
                    const items = e.clipboardData.items;
                    const files = [];
                    for (let i = 0; i < items.length; i++) {
                        if (MEDIA_PREFIXES.some(prefix => items[i].type.startsWith(prefix))) {
                            const file = items[i].getAsFile();
                            if (file) files.push(file);
                        }
                    }
                    if (files.length > 0) {
                        e.preventDefault(); // 阻止默认粘贴行为（如粘贴文本到搜索框等）
                        handleFiles(files);
                    }
                }
            });
        }

        function handleFileSelect(e) {
            const files = e.target.files;
            handleFiles(files);
        }

        function handleFiles(files) {
            ([...files]).forEach(uploadFile);
        }

        const MEDIA_PREFIXES = ['image/', 'video/', 'audio/'];

        // 判断媒体类别，用于选择预览方式（列表接口不一定带 MIME，按后缀判断更可靠）
        function mediaKind(nameOrKey) {
            const ext = (nameOrKey || '').split('.').pop().toLowerCase();
            if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'mpeg', '3gp', 'm4v'].includes(ext)) return 'video';
            if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'weba'].includes(ext)) return 'audio';
            return 'image';
        }

        const AUDIO_ICON = '<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="width:38%;height:38%;opacity:0.45"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l10-2v13M9 19a2 2 0 11-4 0 2 2 0 014 0zm10-2a2 2 0 11-4 0 2 2 0 014 0z"/></svg>';

        /**
         * 以裸二进制流式上传，body 直接是 File。
         * 服务端该路径不经过内存，因此不受表单上传 20 MB 上限限制；
         * 用 XHR 而非 fetch 是为了拿到真实上传进度，大文件（视频）尤其需要。
         * @param {File} file 待上传文件
         * @param {string} token 鉴权 token
         * @param {(ratio:number)=>void} onProgress 进度回调，参数为 0~1
         */
        function sendFile(file, token, onProgress) {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/upload');
                xhr.setRequestHeader('Authorization', 'Bearer ' + token);
                xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
                // 头部只能放 ASCII；服务端仅取其后缀，无需解码
                xhr.setRequestHeader('X-Upload-Filename', encodeURIComponent(file.name));
                xhr.upload.onprogress = e => {
                    if (e.lengthComputable) onProgress(e.loaded / e.total);
                };
                xhr.onload = () => {
                    // 不能先解析再判状态：401 等错误返回的是纯文本，
                    // 那样会在 status 检查之前就抛出，401 分支永远走不到。
                    let data = null;
                    try { data = JSON.parse(xhr.responseText); } catch { /* 非 JSON 响应 */ }
                    resolve({ status: xhr.status, data, text: xhr.responseText });
                };
                xhr.onerror = () => reject(new Error('网络请求出错'));
                xhr.send(file);
            });
        }

        async function uploadFile(file) {
            if (file.type && !MEDIA_PREFIXES.some(prefix => file.type.startsWith(prefix))) {
                showToast('只允许上传图片、视频或音频文件', 'var(--danger)');
                return;
            }

            const id = 'upload-' + Math.random().toString(36).substr(2, 9);
            const uploadList = document.getElementById('upload-list');

            // 生成本地预览图
            const previewUrl = URL.createObjectURL(file);

            const item = document.createElement('div');
            item.className = 'upload-item';
            item.id = id;
            const kind = mediaKind(file.name);
            const thumb = kind === 'video'
                ? '<video class="upload-item-thumb" src="' + previewUrl + '" muted playsinline preload="metadata"></video>'
                : kind === 'audio'
                    ? '<div class="upload-item-thumb upload-item-thumb-audio">' + AUDIO_ICON + '</div>'
                    : '<img class="upload-item-thumb" src="' + previewUrl + '">';

            item.innerHTML = thumb +
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

            const token = localStorage.getItem('cf_photo_token');
            const progressBar = item.querySelector('.progress-bar');
            const actionArea = item.querySelector('.upload-item-actions');
            const statusText = item.querySelector('.upload-item-status');

            try {
                statusText.innerHTML = '<svg class="spin" style="width:16px;height:16px;opacity:0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>';
                progressBar.style.width = '0%';

                const res = await sendFile(file, token, ratio => {
                    progressBar.style.width = Math.round(ratio * 100) + '%';
                });

                progressBar.style.width = '100%';

                if (res.status === 401) {
                    localStorage.removeItem('cf_photo_token');
                    location.reload();
                    return;
                }

                const data = res.data;
                if (data && data.result === 'success') {
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

                    // 按当前排序方向插入：最新在前放头部，最早在前放尾部
                    const newImage = {
                        key: data.path.startsWith('/') ? data.path.slice(1) : data.path,
                        url: data.url,
                        size: file.size,
                        uploaded: new Date().toISOString()
                    };
                    const newestFirst = document.getElementById('order-select').value !== 'asc';
                    renderImages([newImage], !newestFirst, newestFirst);
                } else {
                    statusText.innerHTML = '<svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
                    statusText.className = 'upload-item-status status-error';
                    // 纯文本错误（如平台层的 413）没有 message 字段，退回原文与状态码
                    alert('上传失败: ' + (data?.message || res.text || ('HTTP ' + res.status)));
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

        /**
         * 填充年 / 月 / 日下拉框，只列出 WebDAV 中真实存在的目录。
         * 上级未选具体值时，下级没有可筛选的范围，直接清空并禁用。
         * @param {'year'|'month'|'day'} level 需要重新填充的层级
         */
        async function loadDirOptions(level) {
            const token = localStorage.getItem('cf_photo_token');
            const yearEl = document.getElementById('year-select');
            const monthEl = document.getElementById('month-select');
            const dayEl = document.getElementById('day-select');

            const target = { year: yearEl, month: monthEl, day: dayEl }[level];
            const placeholder = { year: '全部年份', month: '全部月份', day: '全部日期' }[level];
            const suffix = { year: '年', month: '月', day: '日' }[level];

            target.innerHTML = '<option value="">' + placeholder + '</option>';
            target.value = '';

            const parentChosen = level === 'year' || (level === 'month' ? yearEl.value : monthEl.value);
            if (!parentChosen) {
                target.disabled = true;
                return;
            }

            const url = new URL('/admin/dirs', location.origin);
            if (level !== 'year') url.searchParams.set('year', yearEl.value);
            if (level === 'day') url.searchParams.set('month', monthEl.value);

            let dirs = [];
            try {
                const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401) {
                    localStorage.removeItem('cf_photo_token');
                    location.reload();
                    return;
                }
                const data = await res.json();
                if (data.result === 'success') dirs = data.data.dirs;
            } catch (e) {
                console.error(e);
            }

            dirs.forEach(d => {
                const option = document.createElement('option');
                option.value = d;
                option.textContent = d + suffix;
                target.appendChild(option);
            });
            target.disabled = dirs.length === 0;
        }

        // 年份变化：重填月份、清空日期，再刷新列表
        async function onYearChange() {
            await loadDirOptions('month');
            await loadDirOptions('day');
            resetAndLoad();
        }

        // 月份变化：重填日期，再刷新列表
        async function onMonthChange() {
            await loadDirOptions('day');
            resetAndLoad();
        }

        function resetAndLoad() {
            currentCursor = null;
            const loadingEl = document.getElementById('loading');
            loadingEl.textContent = '正在加载图片...';
            loadingEl.style.display = 'block';
            document.getElementById('image-grid').innerHTML = '';
            document.getElementById('load-more').style.display = 'none';
            loadImages();
        }

        /**
         * 拉取图片列表。
         * WebDAV 按目录逐级扫描，某一页可能没有文件却仍带下一页游标，
         * 因此这里自动继续请求，避免界面误显示为“没有图片”。
         * @param {boolean} append 是否追加到现有列表（“加载更多”）
         */
        async function loadImages(append = false) {
            if (isLoading) return;
            isLoading = true;

            const token = localStorage.getItem('cf_photo_token');
            const year = document.getElementById('year-select').value;
            const month = document.getElementById('month-select').value;
            const day = document.getElementById('day-select').value;
            const order = document.getElementById('order-select').value;
            const loadingEl = document.getElementById('loading');
            const loadMoreBtn = document.querySelector('#load-more button');
            if (loadMoreBtn) loadMoreBtn.disabled = true;
            if (!append) currentCursor = null;
            let received = 0;

            try {
                // 最多自动翻 20 页空结果，防止极端目录结构下无限请求
                for (let page = 0; page < 20; page++) {
                    const url = new URL('/admin/list', location.origin);
                    url.searchParams.set('limit', 12);
                    url.searchParams.set('order', order);
                    if (year) url.searchParams.set('year', year);
                    if (year && month) url.searchParams.set('month', month);
                    if (year && month && day) url.searchParams.set('day', day);
                    if (currentCursor) url.searchParams.set('cursor', currentCursor);

                    const res = await fetch(url, {
                        headers: { 'Authorization': 'Bearer ' + token }
                    });

                    if (res.status === 401) {
                        localStorage.removeItem('cf_photo_token');
                        location.reload();
                        return;
                    }

                    const data = await res.json();
                    if (data.result !== 'success') {
                        alert('获取失败: ' + data.message);
                        return;
                    }

                    renderImages(data.data.images, append || received > 0);
                    received += data.data.images.length;
                    currentCursor = data.data.cursor;

                    // 本页已有结果，或远端确实没有更多目录可扫，就停止
                    if (received > 0 || !currentCursor) break;
                    loadingEl.textContent = '正在扫描目录...';
                    loadingEl.style.display = 'block';
                }

                document.getElementById('load-more').style.display = currentCursor ? 'block' : 'none';
                if (received === 0 && !append) {
                    loadingEl.textContent = currentCursor ? '本次扫描未找到图片，可点击“加载更多”继续' : '暂无图片';
                    loadingEl.style.display = 'block';
                } else {
                    loadingEl.style.display = 'none';
                }
            } catch (e) {
                console.error(e);
                alert('网络请求出错');
            } finally {
                isLoading = false;
                if (loadMoreBtn) loadMoreBtn.disabled = false;
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
                
                const kind = mediaKind(img.key);
                const preview = kind === 'video'
                    ? \`<video id="\${imageId}" class="real-image" src="\${img.url}" muted playsinline preload="metadata"></video>\`
                    : kind === 'audio'
                        ? \`<div id="\${imageId}" class="real-image media-audio">\${AUDIO_ICON}</div>\`
                        : \`<div id="\${imageId}" class="real-image"></div>\`;

                card.innerHTML = \`
                    <div class="image-preview pulse" onclick="window.open('\${img.url}')">
                        \${preview}
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

                // 就位后淡入并撤掉骨架屏的 pulse
                const reveal = el => {
                    el.classList.add('loaded');
                    setTimeout(() => el.parentElement?.classList.remove('pulse'), 600);
                };

                if (kind === 'image') {
                    // 异步预加载图片，避免半张图闪现
                    const loader = new Image();
                    loader.src = img.url;
                    loader.onload = () => {
                        const el = document.getElementById(imageId);
                        if (el) {
                            el.style.backgroundImage = \`url('\${img.url}')\`;
                            reveal(el);
                        }
                    };
                } else {
                    const el = document.getElementById(imageId);
                    // 视频等首帧解出来再淡入（依赖服务端的 Range 支持），音频没有画面直接显示
                    if (el && kind === 'video') {
                        el.addEventListener('loadeddata', () => reveal(el), { once: true });
                        el.addEventListener('error', () => reveal(el), { once: true });
                    } else if (el) {
                        reveal(el);
                    }
                }
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
     * 列出某个前缀下的一级子目录名，降序返回
     * @param {string} prefix 目录前缀，如 'i/' 或 'i/2026/'
     * @param {RegExp} pattern 用于从完整前缀中提取目录名的正则，需含一个捕获组
     * @returns {Promise<string[]>} 降序排列的目录名数组；查询失败时返回空数组
     * @private
     */
    async _listSubdirs(prefix, pattern) {
        const found = new Set();

        try {
            // 使用 delimiter 列出一级目录 (最快)
            const listed = await this.storage.list({ prefix, delimiter: '/' });

            (listed.delimitedPrefixes || []).forEach(p => {
                const match = p.match(pattern);
                if (match) found.add(match[1]);
            });
        } catch (error) {
            console.error(`动态发现目录失败 (${prefix}):`, error.message);
        }

        // 目录名都是等宽零填充的数字，直接字符串降序即可
        return Array.from(found).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    }

    /**
     * 管理接口：列出可用于筛选的年 / 月 / 日目录
     * 不传参数返回年份；传 year 返回该年的月份；传 year + month 返回该月的日期。
     * @param {string} year 年份 (可选)
     * @param {string} month 月份 (可选，需同时提供 year)
     * @returns {Promise<Response>} 响应对象，data.dirs 为降序目录名数组
     */
    async listDirs(year = null, month = null) {
        let prefix = 'i/';
        let pattern = /i\/(\d{4})\/$/;

        if (year) {
            if (!/^\d{4}$/.test(year)) return this._badRequest('年份格式不正确');
            prefix += `${year}/`;
            pattern = new RegExp(`^i/${year}/(\\d{2})/$`);

            if (month) {
                const paddedMonth = month.padStart(2, '0');
                if (!this._validPart(paddedMonth, 1, 12)) return this._badRequest('月份格式不正确');
                prefix += `${paddedMonth}/`;
                pattern = new RegExp(`^i/${year}/${paddedMonth}/(\\d{2})/$`);
            }
        }

        return new Response(JSON.stringify({
            result: 'success',
            code: 200,
            data: { dirs: await this._listSubdirs(prefix, pattern) }
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    /**
     * 校验两位数字的月份 / 日期是否在合法区间内
     * @private
     */
    _validPart(value, min, max) {
        if (!/^\d{2}$/.test(value)) return false;
        const num = Number(value);
        return num >= min && num <= max;
    }

    /**
     * 构造 400 错误响应
     * @private
     */
    _badRequest(message) {
        return new Response(JSON.stringify({ result: 'error', code: 400, message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }


    /**
     * 获取 WebDAV 中的图片列表
     * @param {Request} request 原始请求对象 (用于拼接完整 URL)
     * @param {number} limit 每次获取的数量限制
     * @param {string} cursor 分页游标
     * @param {string} year 年份 (可选)
     * @param {string} month 月份 (可选)
     * @param {string} day 日期 (可选)
     * @param {string} order 排序方向 'desc' 最新在前 (默认) / 'asc' 最早在前
     * @returns {Promise<Response>} 响应对象，包含图片列表和分页信息
     */
    async listImages(request, limit = 50, cursor = null, year = null, month = null, day = null, order = 'desc') {
        try {
            // 根据年份、月份和日期构造前缀；月依赖年、日依赖月
            let prefix = 'i/';
            if (year) {
                if (!/^\d{4}$/.test(year)) return this._badRequest('年份格式不正确');
                prefix += `${year}/`;
                if (month) {
                    const paddedMonth = month.padStart(2, '0');
                    if (!this._validPart(paddedMonth, 1, 12)) return this._badRequest('月份格式不正确');
                    prefix += `${paddedMonth}/`;
                    if (day) {
                        const paddedDay = day.padStart(2, '0');
                        if (!this._validPart(paddedDay, 1, 31)) return this._badRequest('日期格式不正确');
                        prefix += `${paddedDay}/`;
                    }
                }
            }

            const options = {
                limit: Math.min(limit, 100), // 最大限制 100
                prefix: prefix, // 按目录前缀进行筛选
                order: order === 'asc' ? 'asc' : 'desc', // 默认最新在前
            };

            // 仅在 cursor 存在且不为 null/undefined 时添加该属性
            if (cursor) {
                options.cursor = cursor;
            }

            const listed = await this.storage.list(options);
            const urlObj = new URL(request.url);
            const domain = `${urlObj.protocol}//${urlObj.host}`;

            const images = listed.objects.map(obj => ({
                key: obj.key,
                url: `${domain}/${obj.key.split('/').map(encodeURIComponent).join('/')}`,
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
            'image/tiff': '.tiff',

            // 视频
            'video/mp4': '.mp4',
            'video/quicktime': '.mov',
            'video/webm': '.webm',
            'video/x-matroska': '.mkv',
            'video/x-msvideo': '.avi',
            'video/mpeg': '.mpeg',
            'video/3gpp': '.3gp',
            'video/x-m4v': '.m4v',

            // 音频
            'audio/mpeg': '.mp3',
            'audio/mp4': '.m4a',
            'audio/x-m4a': '.m4a',
            'audio/aac': '.aac',
            'audio/wav': '.wav',
            'audio/x-wav': '.wav',
            'audio/ogg': '.ogg',
            'audio/opus': '.opus',
            'audio/flac': '.flac',
            'audio/x-flac': '.flac',
            'audio/webm': '.weba'
        };

        // MIME 可能带参数（如 "video/mp4; codecs=avc1"），只取类型本身
        return mimeMap[contentType.toLowerCase().split(';')[0].trim()] || '';
    }

    /**
     * 推断存储用的扩展名：优先原始文件名，其次 MIME 类型
     * 文件名来自客户端，只接受纯字母数字的后缀，避免把奇怪的字符带进存储路径
     * @param {string} filename 原始文件名，可为空
     * @param {string} contentType MIME 类型，可为空
     * @returns {string} 形如 '.mp4' 的扩展名，无法判断时为空串
     * @private
     */
    _extensionFrom(filename, contentType) {
        if (filename && filename.includes('.')) {
            const candidate = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
            if (/^[a-z0-9]{1,8}$/.test(candidate)) return `.${candidate}`;
        }

        return this._getExtension(contentType);
    }

    /**
     * 上传图片到 WebDAV (保持原有的手动路径上传)
     * @param {string} path 图片存储路径
     * @param {ReadableStream} body 图片二进制流
     * @param {string} contentType 图片 MIME 类型
     * @returns {Promise<Response>} 响应对象
     */
    async uploadImage(path, body, contentType) {
        try {
            const key = decodeURIComponent(path.startsWith('/') ? path.slice(1) : path);

            // 执行上传
            await this.storage.put(key, body, {
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
