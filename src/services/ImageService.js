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
