import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageService } from '../src/services/ImageService.js';

/** 只回一份字节和一个 Content-Type 的假存储，形状对齐 WebDAVStorage。 */
function storageOf(contentType) {
    return {
        async get() {
            return {
                body: new Response(new Uint8Array([0, 1, 2])).body,
                status: 200,
                httpEtag: '"abc"',
                writeHttpMetadata(headers) {
                    if (contentType) headers.set('content-type', contentType);
                },
            };
        },
    };
}

/** 取某个 key 的响应头，路径按 /i/... 传入。 */
async function headersOf(contentType, path) {
    const service = new ImageService(storageOf(contentType), {});
    const response = await service.fetchImage(path);
    return response.headers;
}

test('图片沿用 sandbox，直接打开的图片文档不受影响', async () => {
    const headers = await headersOf('image/png', '/i/2026/09/09/a.png');
    assert.equal(headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'none'; sandbox");
    assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
});

test('SVG 仍然靠 sandbox 兜底，没有被降级', async () => {
    const headers = await headersOf('image/svg+xml', '/i/2026/09/09/a.svg');
    assert.equal(headers.get('content-type'), 'image/svg+xml');
    assert.match(headers.get('Content-Security-Policy'), /sandbox$/);
});

test('视频去掉 sandbox 换成 media-src，否则浏览器直开时媒体子资源被拦', async () => {
    const headers = await headersOf('video/mp4', '/i/2026/09/09/a.mp4');
    assert.equal(headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'none'; media-src 'self'; style-src 'unsafe-inline'");
    assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
});

test('音频与视频同一套策略', async () => {
    const headers = await headersOf('audio/mpeg', '/i/2026/09/09/a.mp3');
    assert.equal(headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'none'; media-src 'self'; style-src 'unsafe-inline'");
});

test('后缀危险的文件先被降级成下载，拿不到 media-src 那条豁免', async () => {
    const headers = await headersOf('video/mp4', '/i/2026/09/09/a.html');
    assert.equal(headers.get('content-type'), 'application/octet-stream');
    assert.equal(headers.get('Content-Disposition'), 'attachment');
    assert.match(headers.get('Content-Security-Policy'), /sandbox$/);
});
