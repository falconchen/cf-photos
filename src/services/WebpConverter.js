/**
 * 上传时把图片转成 WebP
 *
 * 转码交给一个自托管的 imaginary 服务（h2non/imaginary，Go + libvips）完成：Worker 里没有
 * 编解码能力，WASM 编码器在 Free 套餐的 CPU 时间和 128 MB 内存下都跑不动大图，
 * Cloudflare Images 又需要单独开通。Worker 把原图字节 POST 过去，拿回 WebP。
 *
 * 这是尽力而为的优化，不是上传的一部分：未配置、类型不在白名单、转换服务超时或报错、
 * 回来的不是 WebP、转出来反而更大——一律返回 null，调用方照存原图。
 * 任何情况下都不能因为转码让一次上传失败。
 */

// 送去转换的原图上限。与 index.js 的 MAX_BUFFERED_UPLOAD 相同（同样是按 isolate 内存反推的），
// 但不从 index.js 导入以免 index → ImageService → index 成环。
export const WEBP_MAX_INPUT_BYTES = 20 * 1024 * 1024;

// 等转换服务的时间。实测 24 MP 的 JPEG 在仿真环境下要 6~13 秒，等待网络不计 CPU 时间，
// 所以给得宽一些；超时就存原图。
const WEBP_CONVERT_TIMEOUT = 20000;

// 转换服务挂掉时的退避时长。服务进程停了会立刻被拒绝，但整台主机失联（不回 RST）时每次上传
// 都要白等满 WEBP_CONVERT_TIMEOUT。所以连不上、超时或 5xx 之后，本 isolate 在这段时间内
// 直接跳过转换、存原图，只有第一个上传付这个代价。
const WEBP_BACKOFF_MS = 60000;

// 超时是否说明服务挂了，要看图多大。小图 20 秒都转不完，基本可以断定服务有问题；
// 大图超时可能只是这一张太重、或者上传链路慢（实测本地 wrangler dev 传 5 MB 就要 17 秒以上），
// 只让这一张存原图，不连累后面的上传。连不上和 5xx 不看大小，照常退避。
const WEBP_HEAVY_INPUT_BYTES = 1024 * 1024;

// 转换服务地址 → 恢复尝试的时间戳。模块级：ImageService 按请求构造，状态要跨请求留在 isolate 里。
const backoffUntil = new Map();

/**
 * 清空退避状态（仅供测试：模块级状态会在测试用例之间残留）
 */
export function resetWebpBackoff() {
    backoffUntil.clear();
}

// 只转这几种（按文件头判定，不信声明的 MIME）：
// - webp 已经是目标格式；gif 刻意跳过（动图转换收益小、风险大，库里也没几个）；
// - svg 是矢量，光栅化就坏了；avif 本来就比 webp 小；bmp/tiff 用得少，不值得多一次往返。
// heic 在白名单里是因为多数浏览器根本显示不了它，转了收益最大（imaginary 自带 libheif，实测能转）。
const WEBP_CONVERTIBLE = new Set(['image/jpeg', 'image/png', 'image/heic']);

// 按声明值做预判时认的后缀，与上面的 MIME 一一对应
const WEBP_CONVERTIBLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);

// 允许走明文 http 的主机：只有本机调试时的 imaginary 容器
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// 配置错误每个 isolate 只告警一次：ImageService 是按请求构造的，否则每次上传都刷一条
const warned = new Set();
function warnOnce(message) {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
}

/**
 * 按文件头识别常见图片格式
 * @param {Uint8Array} bytes 图片字节
 * @returns {string} MIME 类型，识别不出时为空串
 */
export function sniffImageMime(bytes) {
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
 * 校验并规范化转换服务地址，返回 /convert 接口的完整 URL
 * 生产必须 HTTPS：请求里带着 API Key 和用户上传的原图，不能明文过公网。
 * 只有回环地址放行 http，方便本机 wrangler dev 连 docker 里的 imaginary。
 * @param {string|undefined} value 环境变量 WEBP_CONVERTER_URL，如 https://webp.example.com
 * @returns {URL|null} 非法时返回 null
 */
export function parseConverterEndpoint(value) {
    if (!value) return null;

    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        return null;
    }

    const secure = url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    if (!secure || url.username || url.password || url.search || url.hash) {
        return null;
    }

    url.pathname = `${url.pathname.replace(/\/+$/, '')}/convert`;
    return url;
}

export class WebpConverter {
    /**
     * @param {Object} [options]
     * @param {boolean} [options.enabled] 来自 AUTO_WEBP
     * @param {number} [options.quality] 来自 WEBP_QUALITY
     * @param {string} [options.endpoint] 来自 WEBP_CONVERTER_URL，imaginary 服务的根地址
     * @param {string} [options.token] 来自 WEBP_CONVERTER_TOKEN，imaginary 的 API Key
     * @param {Function} [options.request] 注入的 fetch，供测试替换。默认值必须包一层箭头函数：
     *        把裸 fetch 存成实例属性再以 this.request(...) 调用，workerd 会抛 Illegal invocation
     * @param {Function} [options.now] 注入的时钟，供测试退避过期
     */
    constructor({
        enabled = false, quality = 85, endpoint, token,
        request = (...args) => fetch(...args), now = () => Date.now()
    } = {}) {
        this.quality = quality;
        this.token = token || '';
        this.request = request;
        this.now = now;
        this.endpoint = parseConverterEndpoint(endpoint);
        this._enabled = false;

        if (!enabled) return;

        if (!endpoint || !this.token) {
            warnOnce('[Config] AUTO_WEBP 已开启但缺少 WEBP_CONVERTER_URL 或 WEBP_CONVERTER_TOKEN，自动转 WebP 不生效');
        } else if (!this.endpoint) {
            warnOnce('[Config] WEBP_CONVERTER_URL 非法：须为不带凭据与查询串的 https 地址（仅本机回环允许 http），自动转 WebP 不生效');
        } else {
            this._enabled = true;
        }
    }

    /**
     * 转换器是否真的会工作（开关打开且转换服务配置齐全）
     * @returns {boolean}
     */
    get enabled() {
        return this._enabled;
    }

    /**
     * 按声明的 MIME 或后缀做廉价预判，只给流式上传决定值不值得先把请求体读进内存。
     * 真正转不转仍以 convert() 里的文件头判定为准。
     * @param {string} contentType 客户端声明的 MIME
     * @param {string} extension 已推断出的后缀（含点）
     * @returns {boolean}
     */
    accepts(contentType, extension) {
        if (!this._enabled) return false;
        const mime = (contentType || '').split(';')[0].trim().toLowerCase();
        return WEBP_CONVERTIBLE.has(mime) || mime === 'image/jpg' || mime === 'image/heif' ||
            WEBP_CONVERTIBLE_EXTENSIONS.has((extension || '').toLowerCase());
    }

    /**
     * 尝试把图片字节转成 WebP
     * @param {ArrayBuffer|Uint8Array} buffer 原图字节
     * @returns {Promise<{buffer: ArrayBuffer, contentType: string, extension: string}|null>}
     *          转换成功且更小时返回新字节，否则返回 null（调用方存原图）
     */
    async convert(buffer) {
        if (!this._enabled) return null;

        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        if (bytes.byteLength === 0 || bytes.byteLength > WEBP_MAX_INPUT_BYTES) return null;

        const sourceType = sniffImageMime(bytes);
        if (!WEBP_CONVERTIBLE.has(sourceType)) return null;

        if ((backoffUntil.get(this.endpoint.href) || 0) > this.now()) return null;

        const url = new URL(this.endpoint);
        url.searchParams.set('type', 'webp');
        url.searchParams.set('quality', String(this.quality));
        // 必须带：不带时 GPS 会原样保留进 WebP；而且像素已按 EXIF 转正、方向标签却还留着，
        // 认标签的查看器会再转一次。带上之后像素转正、元数据清空，两个问题一起解决（已实测）。
        url.searchParams.set('stripmeta', 'true');

        try {
            const response = await this.request(url.toString(), {
                method: 'POST',
                headers: { 'API-Key': this.token, 'Content-Type': sourceType },
                body: bytes,
                // 重定向一律当失败：跟过去会把 API Key 和原图送到别的主机
                redirect: 'manual',
                signal: AbortSignal.timeout(WEBP_CONVERT_TIMEOUT)
            });

            if (response.status !== 200) {
                // 5xx 是服务本身出了问题，退避；4xx（不是图片、Key 错）是这一张或配置的问题，不退避
                if (response.status >= 500) this._backOff();
                const detail = await response.text().catch(() => '');
                console.warn(`[WebP] 转换服务返回 ${response.status}，保留原图：${detail.slice(0, 200)}`);
                return null;
            }

            const output = new Uint8Array(await response.arrayBuffer());

            // 不信响应头，按文件头确认真的是 WebP，否则会把别的格式存成 .webp
            if (sniffImageMime(output) !== 'image/webp') {
                console.warn('[WebP] 转换服务返回的不是 WebP，保留原图');
                return null;
            }

            // 小 PNG、压过的 JPEG 转出来可能更大，那就没有换的理由
            if (output.byteLength >= bytes.byteLength) {
                return null;
            }

            return { buffer: output.buffer, contentType: 'image/webp', extension: '.webp' };
        } catch (error) {
            // AbortSignal.timeout 触发时抛的是 name 为 TimeoutError 的 DOMException
            const heavyTimeout = error?.name === 'TimeoutError' && bytes.byteLength >= WEBP_HEAVY_INPUT_BYTES;
            if (heavyTimeout) {
                console.warn(`[WebP] ${sourceType} 大图（${(bytes.byteLength / 1048576).toFixed(1)} MB）转换超时，本张保留原图，不退避`);
                return null;
            }

            // 连不上，或者小图也超时：服务大概率整个不可用，退避一段时间
            this._backOff();
            console.warn(`[WebP] ${sourceType} 转换失败，保留原图，${WEBP_BACKOFF_MS / 1000} 秒内不再尝试：${error?.message || error}`);
            return null;
        }
    }

    /**
     * 标记转换服务暂不可用，退避期内的上传直接存原图
     */
    _backOff() {
        backoffUntil.set(this.endpoint.href, this.now() + WEBP_BACKOFF_MS);
    }
}
