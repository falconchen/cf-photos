import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ImageService } from '../src/services/ImageService.js';
import {
    WebpConverter, sniffImageMime, parseConverterEndpoint, resetWebpBackoff, WEBP_MAX_INPUT_BYTES
} from '../src/services/WebpConverter.js';

// 退避状态是模块级的，一个用例触发的退避不能漏到下一个用例
beforeEach(resetWebpBackoff);

const bytes = (...values) => Uint8Array.from(values);
const text = (value) => new TextEncoder().encode(value);

/** 把文件头补到指定长度，转码只看头，后面填什么无所谓 */
function padded(head, length) {
    const out = new Uint8Array(length);
    out.set(head);
    return out;
}

const PNG = padded(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), 200);
const JPEG = padded(bytes(0xFF, 0xD8, 0xFF, 0xE0), 200);
const GIF = padded(text('GIF89a'), 200);
const WEBP = padded(text('RIFF\0\0\0\0WEBPVP8 '), 200);
const AVIF = padded(text('\0\0\0\x1cftypavif'), 200);
const HEIC = padded(text('\0\0\0\x18ftypheic'), 200);
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const CONVERTED = padded(text('RIFF\0\0\0\0WEBPVP8 '), 50);

const ENDPOINT = 'https://webp.example.com';
const TOKEN = 'converter-key';

/**
 * 假的 imaginary：记录每次请求，按 behaviour 回转换结果、错误状态或直接抛错。
 * 签名对齐 fetch(url, options)。
 */
function fakeConverter({ status = 200, body = CONVERTED, error = null } = {}) {
    const calls = [];
    const request = async (url, options) => {
        calls.push({ url: new URL(url), options, body: new Uint8Array(options.body) });
        if (error) throw error;
        return new Response(body, { status });
    };
    return { calls, request };
}

function converterWith(fake, options = {}) {
    return new WebpConverter({ enabled: true, endpoint: ENDPOINT, token: TOKEN, request: fake.request, ...options });
}

/** 记录 put 的假存储 */
function fakeStorage() {
    const puts = [];
    return {
        puts,
        async put(key, body, options) {
            puts.push({ key, body, options });
        }
    };
}

async function bodyBytes(body) {
    return new Uint8Array(await new Response(body).arrayBuffer());
}

/** 构造一次裸二进制上传需要的 Request */
function rawRequest(length) {
    const headers = new Headers();
    if (length !== undefined) headers.set('Content-Length', String(length));
    return new Request('https://photos.example.com/upload', { method: 'POST', headers });
}

/**
 * ImageService 按 env 自己构造转换器，走的是全局 fetch，所以在这里替换掉，
 * 结束后恢复（与 mcp.test.mjs 的 withFetch 同一做法）。
 */
async function withConverter(behaviour, fn) {
    const fake = fakeConverter(behaviour);
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => fake.request(url, options);
    try {
        return await fn(fake);
    } finally {
        globalThis.fetch = original;
    }
}

function serviceWith(env = {}) {
    const storage = fakeStorage();
    const service = new ImageService(storage, {
        AUTO_WEBP: 'true', WEBP_CONVERTER_URL: ENDPOINT, WEBP_CONVERTER_TOKEN: TOKEN, ...env
    });
    return { service, storage };
}

test('sniffImageMime 按文件头识别格式', () => {
    assert.equal(sniffImageMime(PNG), 'image/png');
    assert.equal(sniffImageMime(JPEG), 'image/jpeg');
    assert.equal(sniffImageMime(GIF), 'image/gif');
    assert.equal(sniffImageMime(WEBP), 'image/webp');
    assert.equal(sniffImageMime(AVIF), 'image/avif');
    assert.equal(sniffImageMime(HEIC), 'image/heic');
    assert.equal(sniffImageMime(SVG), '');
});

test('parseConverterEndpoint 只认 https，回环地址才放行 http', () => {
    assert.equal(parseConverterEndpoint('https://webp.example.com').href, 'https://webp.example.com/convert');
    assert.equal(parseConverterEndpoint('https://example.com/imaginary/').href, 'https://example.com/imaginary/convert');
    assert.equal(parseConverterEndpoint('http://127.0.0.1:8088').href, 'http://127.0.0.1:8088/convert');
    assert.equal(parseConverterEndpoint('http://localhost:8088').href, 'http://localhost:8088/convert');

    for (const bad of [
        undefined, '', 'not a url', 'http://webp.example.com', 'ftp://webp.example.com',
        'https://user:pass@webp.example.com', 'https://webp.example.com/?key=x', 'https://webp.example.com/#x'
    ]) {
        assert.equal(parseConverterEndpoint(bad), null, String(bad));
    }
});

test('把 PNG 送去 /convert，带上 API Key、质量与 stripmeta', async () => {
    const fake = fakeConverter();
    const result = await converterWith(fake, { quality: 70 }).convert(PNG);

    assert.equal(result.contentType, 'image/webp');
    assert.equal(result.extension, '.webp');
    assert.deepEqual(new Uint8Array(result.buffer), CONVERTED);

    const { url, options, body } = fake.calls[0];
    assert.equal(url.origin + url.pathname, 'https://webp.example.com/convert');
    assert.equal(url.searchParams.get('type'), 'webp');
    assert.equal(url.searchParams.get('quality'), '70');
    // 不带 stripmeta 会泄露 GPS，并让 EXIF 方向被应用两次
    assert.equal(url.searchParams.get('stripmeta'), 'true');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['API-Key'], TOKEN);
    assert.equal(options.headers['Content-Type'], 'image/png');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(body, PNG);
});

test('JPEG 与 HEIC 也转，Content-Type 按文件头而不是声明值', async () => {
    const fake = fakeConverter();
    const converter = converterWith(fake);

    assert.equal((await converter.convert(JPEG)).contentType, 'image/webp');
    assert.equal((await converter.convert(HEIC)).contentType, 'image/webp');
    assert.deepEqual(fake.calls.map(call => call.options.headers['Content-Type']), ['image/jpeg', 'image/heic']);
});

test('不碰 webp / gif / svg / avif，也不发请求', async () => {
    const fake = fakeConverter();
    const converter = converterWith(fake);

    for (const input of [WEBP, GIF, SVG, AVIF]) {
        assert.equal(await converter.convert(input), null);
    }
    assert.equal(fake.calls.length, 0);
});

test('转换服务出错、超时、重定向时返回 null，不抛出', async () => {
    const cases = [
        { status: 401, body: '{"message":"Invalid or missing API key","status":401}' },
        { status: 406, body: '{"message":"Unsupported media type","status":406}' },
        { status: 302, body: null },
        { error: new DOMException('The operation was aborted due to timeout', 'TimeoutError') },
        { error: new TypeError('fetch failed') }
    ];
    for (const behaviour of cases) {
        resetWebpBackoff();
        const fake = fakeConverter(behaviour);
        assert.equal(await converterWith(fake).convert(PNG), null, JSON.stringify(behaviour));
        assert.equal(fake.calls.length, 1);
    }
});

test('连不上或 5xx 之后退避 60 秒，期间不再发请求', async () => {
    for (const behaviour of [{ error: new TypeError('fetch failed') }, { status: 502, body: 'Bad Gateway' }]) {
        resetWebpBackoff();
        let clock = 1000;
        const broken = fakeConverter(behaviour);
        assert.equal(await converterWith(broken, { now: () => clock }).convert(PNG), null);

        // 服务恢复了，但还在退避期内：跳过，不发请求
        const healthy = fakeConverter();
        const converter = converterWith(healthy, { now: () => clock });
        clock += 59_999;
        assert.equal(await converter.convert(PNG), null, JSON.stringify(behaviour));
        assert.equal(healthy.calls.length, 0);

        // 退避到期后恢复转换
        clock += 1;
        assert.equal((await converter.convert(PNG)).contentType, 'image/webp');
        assert.equal(healthy.calls.length, 1);
    }
});

test('4xx 是这一张图的问题，不触发退避', async () => {
    const rejected = fakeConverter({ status: 406, body: '{"message":"Unsupported media type","status":406}' });
    assert.equal(await converterWith(rejected).convert(PNG), null);

    const healthy = fakeConverter();
    assert.equal((await converterWith(healthy).convert(PNG)).contentType, 'image/webp');
});

test('退避按转换服务地址区分', async () => {
    await converterWith(fakeConverter({ error: new TypeError('fetch failed') })).convert(PNG);

    const other = fakeConverter();
    const result = await converterWith(other, { endpoint: 'https://other.example.com' }).convert(PNG);
    assert.equal(result.contentType, 'image/webp');
});

test('返回的不是 WebP 就不用，哪怕状态码是 200', async () => {
    const fake = fakeConverter({ body: padded(bytes(0xFF, 0xD8, 0xFF), 20) });
    assert.equal(await converterWith(fake).convert(PNG), null);
});

test('转出来不比原图小就不换', async () => {
    const fake = fakeConverter({ body: padded(text('RIFF\0\0\0\0WEBPVP8 '), PNG.length) });
    assert.equal(await converterWith(fake).convert(PNG), null);
});

test('开关关闭、缺地址或密钥、地址不安全时一律不转', async () => {
    for (const options of [
        { enabled: false },
        { endpoint: undefined },
        { token: '' },
        { endpoint: 'http://webp.example.com' }
    ]) {
        const fake = fakeConverter();
        const converter = converterWith(fake, options);
        assert.equal(converter.enabled, false, JSON.stringify(options));
        assert.equal(await converter.convert(PNG), null);
        assert.equal(fake.calls.length, 0);
    }
});

test('超过输入上限的字节不送去转换', async () => {
    const fake = fakeConverter();
    assert.equal(await converterWith(fake).convert(padded(PNG.subarray(0, 8), WEBP_MAX_INPUT_BYTES + 1)), null);
    assert.equal(fake.calls.length, 0);
});

test('默认 request 包了一层，不会以 this 调用裸 fetch', () => {
    const converter = new WebpConverter();
    assert.notEqual(converter.request, globalThis.fetch);
});

test('裸二进制上传：带 .jpg 文件名的 PNG 也存成 .webp', async () => {
    await withConverter({}, async () => {
        const { service, storage } = serviceWith();

        const response = await service.uploadWithAutoPath(
            rawRequest(PNG.length), new Response(PNG).body, 'image/png', 'cat.jpg'
        );
        const json = await response.json();

        assert.equal(response.status, 201);
        assert.match(json.url, /^https:\/\/photos\.example\.com\/i\/\d{4}\/\d{2}\/\d{2}\/.{8}\.webp$/);
        const put = storage.puts[0];
        assert.match(put.key, /\.webp$/);
        assert.equal(put.options.httpMetadata.contentType, 'image/webp');
        assert.deepEqual(await bodyBytes(put.body), CONVERTED);
    });
});

test('裸二进制上传：缺 Content-Length 或超过上限时照旧透传原始流', async () => {
    for (const length of [undefined, WEBP_MAX_INPUT_BYTES + 1]) {
        await withConverter({}, async (fake) => {
            const { service, storage } = serviceWith();
            const stream = new Response(PNG).body;

            await service.uploadWithAutoPath(rawRequest(length), stream, 'image/png', 'cat.png');

            assert.equal(fake.calls.length, 0);
            assert.equal(storage.puts[0].body, stream, '应当是同一个流对象，没有被读进内存');
            assert.match(storage.puts[0].key, /\.png$/);
        });
    }
});

test('裸二进制上传：视频不会被读进内存', async () => {
    await withConverter({}, async () => {
        const { service, storage } = serviceWith();
        const stream = new Response(new Uint8Array(100)).body;

        await service.uploadWithAutoPath(rawRequest(100), stream, 'video/mp4', 'clip.mp4');

        assert.equal(storage.puts[0].body, stream);
        assert.match(storage.puts[0].key, /\.mp4$/);
    });
});

test('裸二进制上传：转换服务挂了时存下原始字节', async () => {
    await withConverter({ error: new TypeError('fetch failed') }, async () => {
        const { service, storage } = serviceWith();

        const response = await service.uploadWithAutoPath(
            rawRequest(PNG.length), new Response(PNG).body, 'image/png', 'cat.png'
        );

        assert.equal(response.status, 201);
        assert.match(storage.puts[0].key, /\.png$/);
        assert.equal(storage.puts[0].options.httpMetadata.contentType, 'image/png');
        assert.deepEqual(await bodyBytes(storage.puts[0].body), PNG);
    });
});

test('multipart 上传转 WebP，srcName 保留原文件名', async () => {
    await withConverter({}, async () => {
        const { service, storage } = serviceWith();
        const form = new FormData();
        form.set('image', new File([JPEG], 'photo.jpeg', { type: 'image/jpeg' }));

        const response = await service.uploadFormData(new Request('https://photos.example.com/upload', { method: 'POST' }), form);
        const json = await response.json();

        assert.equal(json.srcName, 'photo.jpeg');
        assert.match(json.url, /\.webp$/);
        assert.equal(storage.puts[0].options.httpMetadata.contentType, 'image/webp');
    });
});

test('base64 上传经 uploadBuffer 转 WebP', async () => {
    await withConverter({}, async () => {
        const { service, storage } = serviceWith();
        const base64 = btoa(String.fromCharCode(...PNG));

        const response = await service.uploadWithBase64(
            new Request('https://photos.example.com/upload', { method: 'POST' }), `data:image/png;base64,${base64}`
        );
        const json = await response.json();

        assert.match(json.url, /\.webp$/);
        assert.deepEqual(await bodyBytes(storage.puts[0].body), CONVERTED);
    });
});

test('uploadBuffer 返回转换后的类型与大小（MCP 用它回报结果）', async () => {
    await withConverter({}, async () => {
        const { service } = serviceWith();

        const result = await service.uploadBuffer('https://photos.example.com', PNG, 'image/png', '.png');

        assert.equal(result.contentType, 'image/webp');
        assert.equal(result.size, CONVERTED.length);
        assert.match(result.url, /\.webp$/);
    });
});

test('PUT /i/... 指定路径的上传永远不转', async () => {
    await withConverter({}, async (fake) => {
        const { service, storage } = serviceWith();
        const stream = new Response(PNG).body;

        const response = await service.uploadImage('/i/2026/09/23/x.png', stream, 'image/png');

        assert.equal(response.status, 201);
        assert.equal(fake.calls.length, 0);
        assert.equal(storage.puts[0].key, 'i/2026/09/23/x.png');
        assert.equal(storage.puts[0].body, stream);
    });
});

test('AUTO_WEBP 缺省、false 或拼错时都不转', async () => {
    for (const value of [undefined, '', 'false', '0', 'off', 'ture']) {
        await withConverter({}, async (fake) => {
            const { service, storage } = serviceWith({ AUTO_WEBP: value });

            await service.uploadBuffer('https://photos.example.com', PNG, 'image/png', '.png');

            assert.equal(fake.calls.length, 0, `AUTO_WEBP=${value}`);
            assert.match(storage.puts[0].key, /\.png$/);
        });
    }
});

test('AUTO_WEBP 接受 true / 1 / yes / on（不区分大小写）', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'On', true]) {
        const { service } = serviceWith({ AUTO_WEBP: value });
        assert.equal(service.webp.enabled, true, `AUTO_WEBP=${value}`);
    }
});

test('WEBP_QUALITY 非法时回退到 85', () => {
    const quality = (value) => new ImageService(fakeStorage(), { WEBP_QUALITY: value }).webp.quality;

    assert.equal(quality(undefined), 85);
    assert.equal(quality('60'), 60);
    assert.equal(quality('0'), 85);
    assert.equal(quality('101'), 85);
    assert.equal(quality('7.5'), 85);
    assert.equal(quality('abc'), 85);
});
