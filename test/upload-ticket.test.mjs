import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { WebDAVStorage } from '../src/services/WebDAVStorage.js';
import { ImageService } from '../src/services/ImageService.js';
import { OAuthService } from '../src/services/OAuthService.js';
import { UploadTicketService } from '../src/services/UploadTicketService.js';

const env = {
    WEBDAV_URL: 'https://example.com/dav',
    WEBDAV_USERNAME: 'user',
    WEBDAV_PASSWORD: 'secret',
    AUTH_TOKEN: 'secret-token',
    TIMEZONE_OFFSET: '8'
};

const PNG = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82
]);

/**
 * 内存版 WebDAV：PUT 真的存下字节，GET 按是否存过返回 200 / 404，
 * 这样「一次性」靠的存在性检查才测得到。
 */
function memoryDav() {
    const files = new Map();
    const calls = [];
    const fetch = async (url, options = {}) => {
        const parsed = url instanceof URL ? url : new URL(String(url));
        calls.push({ method: options.method, path: parsed.pathname, options });
        if (parsed.hostname !== 'example.com') throw new Error(`未预期的出站请求：${parsed.href}`);
        const path = decodeURIComponent(parsed.pathname);

        if (options.method === 'PROPFIND') {
            return new Response(
                `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${parsed.pathname}</D:href>` +
                `<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>` +
                `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
                { status: 207 }
            );
        }
        if (options.method === 'PUT') {
            const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
            files.set(path, { bytes, type: options.headers.get('content-type') });
            return new Response(null, { status: 201 });
        }
        if (options.method === 'GET') {
            const file = files.get(path);
            return file
                ? new Response(file.bytes, { status: 200, headers: { 'Content-Type': file.type } })
                : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 201 });
    };
    return { files, calls, fetch };
}

/** 装上内存 WebDAV 作为全局 fetch，跑完还原 */
async function withDav(fn) {
    const dav = memoryDav();
    const original = globalThis.fetch;
    globalThis.fetch = dav.fetch;
    try {
        return await fn(dav);
    } finally {
        globalThis.fetch = original;
    }
}

/** 通过 MCP 调 create_upload_url */
async function createTicket(file_name, overrides = {}) {
    const text = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'create_upload_url', arguments: { file_name } }
    });
    const response = await worker.fetch(new Request('https://photos.example.com/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(new TextEncoder().encode(text).length),
            Authorization: 'Bearer secret-token'
        },
        body: text
    }), { ...env, ...overrides }, {});
    return (await response.json()).result;
}

/** 凭票上传，Content-Length 必须显式给出（undici 不会自动写进 Request 的 headers） */
function putTicket(uploadUrl, bytes, { headers = {}, method = 'PUT', overrides = {} } = {}) {
    return worker.fetch(new Request(uploadUrl, {
        method,
        headers: { 'Content-Length': String(bytes.byteLength), ...headers },
        body: bytes
    }), { ...env, ...overrides }, {});
}

test('签发后凭票上传成功：路径与类型以签发时为准，字节原样落库', async () => {
    await withDav(async (dav) => {
        const result = await createTicket('/mnt/user-data/uploads/200.png');
        assert.equal(result.isError, false);

        const ticket = result.structuredContent;
        assert.match(ticket.upload_url, /^https:\/\/photos\.example\.com\/u\/[\w-]+\.[\w-]+$/);
        assert.match(ticket.url, /^https:\/\/photos\.example\.com\/i\/\d{4}\/\d{2}\/\d{2}\/.{8}\.png$/);
        assert.equal(ticket.content_type, 'image/png');
        assert.equal(ticket.method, 'PUT');
        assert.ok(ticket.curl_command.includes(ticket.upload_url));
        // 签发本身不碰存储
        assert.equal(dav.calls.length, 0);

        // 客户端谎报的 Content-Type 不起作用
        const response = await putTicket(ticket.upload_url, PNG, { headers: { 'Content-Type': 'text/html' } });
        assert.equal(response.status, 201);
        const body = await response.json();
        assert.equal(body.result, 'success');
        assert.equal(body.url, ticket.url);
        assert.equal(body.size_bytes, PNG.length);

        const stored = dav.files.get(`/dav${ticket.path}`);
        assert.deepEqual(stored.bytes, PNG);
        assert.equal(stored.type, 'image/png');
    });
});

test('同一张票第二次上传返回 409，已存的文件不被覆盖', async () => {
    await withDav(async (dav) => {
        const ticket = (await createTicket('a.png')).structuredContent;
        assert.equal((await putTicket(ticket.upload_url, PNG)).status, 201);

        const replay = await putTicket(ticket.upload_url, new Uint8Array([1, 2, 3]));
        assert.equal(replay.status, 409);
        assert.match((await replay.json()).message, /已经用过/);
        assert.deepEqual(dav.files.get(`/dav${ticket.path}`).bytes, PNG);
    });
});

test('POST 也能凭票上传，视频后缀可签发', async () => {
    await withDav(async () => {
        const result = await createTicket('clip.mp4');
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.content_type, 'video/mp4');
        const response = await putTicket(result.structuredContent.upload_url, PNG, { method: 'POST' });
        assert.equal(response.status, 201);
    });
});

test('签发拒绝无后缀、SVG、危险与非媒体后缀，缺 file_name 也是 isError', async () => {
    await withDav(async (dav) => {
        for (const name of ['photo', 'x.svg', 'x.html', 'x.js', 'notes.txt', 'a.b/c']) {
            const result = await createTicket(name);
            assert.equal(result.isError, true, name);
        }
        assert.match((await createTicket('photo')).content[0].text, /后缀/);
        assert.match((await createTicket('x.svg')).content[0].text, /SVG/);

        const missing = await createTicket('');
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /file_name/);
        assert.equal(dav.calls.length, 0);
    });
});

test('伪造、篡改或别的类型签出的票一律 403，且不碰存储', async () => {
    await withDav(async (dav) => {
        const ticket = (await createTicket('a.png')).structuredContent;
        const [payload, signature] = ticket.upload_url.split('/u/')[1].split('.');

        // 把载荷换成指向别的路径的内容，签名对不上
        const forgedPayload = Buffer.from(JSON.stringify({ t: 'up', k: 'i/evil.png', exp: 9999999999 })).toString('base64url');
        const signer = new OAuthService(env);
        const otherType = await signer.signToken('xx', { k: 'i/evil.png' }, 600);

        for (const token of [`${forgedPayload}.${signature}`, `${payload}.AAAA`, 'garbage', otherType]) {
            const response = await putTicket(`https://photos.example.com/u/${token}`, PNG);
            assert.equal(response.status, 403, token);
        }
        assert.equal(dav.calls.length, 0);

        // 换了 AUTH_TOKEN，旧票全部作废
        const rotated = await putTicket(ticket.upload_url, PNG, { overrides: { AUTH_TOKEN: 'rotated' } });
        assert.equal(rotated.status, 403);
    });
});

test('OAuth 保留类型不能借 signToken 签发，verifyToken 也不认', async () => {
    const signer = new OAuthService(env);
    for (const type of ['client', 'code', 'at', 'rt']) {
        await assert.rejects(signer.signToken(type, {}, 60));
        assert.equal(await signer.verifyToken('x.y', type), null);
    }
});

test('票过期后返回 403', async () => {
    await withDav(async (dav) => {
        let now = Date.UTC(2026, 9, 19, 8, 0, 0);
        const service = new UploadTicketService(
            new ImageService(new WebDAVStorage(env, dav.fetch), env), env, { now: () => now }
        );
        const ticket = await service.create('https://photos.example.com', 'a.png');
        const request = () => new Request(ticket.uploadUrl, {
            method: 'PUT', headers: { 'Content-Length': String(PNG.length) }, body: PNG
        });

        now += 11 * 60 * 1000;
        const response = await service.handle(request(), new URL(ticket.uploadUrl));
        assert.equal(response.status, 403);
        assert.match((await response.json()).message, /过期/);
        assert.equal(dav.calls.length, 0);
    });
});

test('缺 Content-Length 411、超过 MAX_UPLOAD_MB 413、空文件 400，均不写入', async () => {
    await withDav(async (dav) => {
        const ticket = (await createTicket('a.png', { MAX_UPLOAD_MB: '1' })).structuredContent;
        assert.equal(ticket.max_bytes, 1024 * 1024);

        const noLength = await worker.fetch(new Request(ticket.upload_url, { method: 'PUT', body: PNG }), env, {});
        assert.equal(noLength.status, 411);

        const tooBig = await putTicket(ticket.upload_url, PNG, {
            headers: { 'Content-Length': String(2 * 1024 * 1024) },
            overrides: { MAX_UPLOAD_MB: '1' }
        });
        assert.equal(tooBig.status, 413);

        const empty = await putTicket(ticket.upload_url, new Uint8Array(0));
        assert.equal(empty.status, 400);

        assert.equal(dav.calls.some(call => call.method === 'PUT'), false);
    });
});

test('GET /u/... 返回 405，未配置 AUTH_TOKEN 时返回 503', async () => {
    await withDav(async (dav) => {
        const ticket = (await createTicket('a.png')).structuredContent;

        const get = await worker.fetch(new Request(ticket.upload_url), env, {});
        assert.equal(get.status, 405);
        assert.equal(get.headers.get('Allow'), 'PUT, POST');

        const unconfigured = await putTicket(ticket.upload_url, PNG, { overrides: { AUTH_TOKEN: '' } });
        assert.equal(unconfigured.status, 503);
        assert.equal(dav.calls.length, 0);
    });
});
