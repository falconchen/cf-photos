import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = {
    WEBDAV_URL: 'https://example.com/dav',
    WEBDAV_USERNAME: 'user',
    WEBDAV_PASSWORD: 'secret',
    AUTH_TOKEN: 'secret-token',
    TIMEZONE_OFFSET: '8'
};

// 1x1 PNG，用来喂 base64 与远程抓取两条路径
const PNG = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82
]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

/**
 * 发一次 MCP 请求
 * 必须显式设 Content-Length：undici 的 new Request 不会把它写进 Request 自身的
 * headers，而路由里按它判断请求体是否超限。
 */
const post = (body, { token = 'secret-token', overrides = {} } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(text).length),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    return worker.fetch(new Request('https://photos.example.com/mcp', {
        method: 'POST', headers, body: text
    }), { ...env, ...overrides }, {});
};

/**
 * 装上按 hostname 分派的假 fetch，跑完还原
 * 一个 stub 同时服务 WebDAV 动词与工具的 source_url 抓取，未知 host 一律抛错，
 * 让误发的真实网络请求响亮地失败而不是挂住。
 */
async function withFetch(handler, fn) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        // WebDAVStorage.send 传的是 URL 对象，McpService 传的是字符串
        const parsed = url instanceof URL ? url : new URL(String(url));
        calls.push({ url: parsed, options });
        if (parsed.hostname === 'example.com') {
            // WebDAV：MKCOL / PROPFIND / PUT 都当成功
            if (options.method === 'PROPFIND') {
                return new Response(
                    `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${parsed.pathname}</D:href>` +
                    `<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>` +
                    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
                    { status: 207 }
                );
            }
            return new Response(null, { status: 201 });
        }
        const response = handler ? await handler(parsed, options) : null;
        if (!response) throw new Error(`未预期的出站请求：${parsed.href}`);
        return response;
    };
    try {
        return await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

test('initialize 回显客户端支持的协议版本并声明 tools 能力', async () => {
    const response = await post({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    // 无状态服务端绝不下发会话 id
    assert.equal(response.headers.get('Mcp-Session-Id'), null);

    const body = await response.json();
    assert.equal(body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(body.result.capabilities.tools, {});
    assert.equal(body.result.serverInfo.name, 'cf-photos');
});

test('initialize 收到未知协议版本时回落到服务端最新版本而不报错', async () => {
    const body = await (await post({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' }
    })).json();
    assert.equal(body.error, undefined);
    assert.equal(body.result.protocolVersion, '2025-11-25');
});

test('notifications/initialized 返回 202 且响应体为空', async () => {
    const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
});

test('tools/list 只暴露 upload_image，inputSchema 是合法的 object schema', async () => {
    const body = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.equal(body.result.tools.length, 1);

    const tool = body.result.tools[0];
    assert.equal(tool.name, 'upload_image');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['image_base64', 'source_url']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    // 顶层不放 oneOf/anyOf：二选一由服务端手写校验，见 McpService._uploadImage
    assert.equal(tool.inputSchema.oneOf, undefined);
});

test('tools/call 用 image_base64 上传成功，返回请求域名下的绝对 URL', async () => {
    await withFetch(null, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'upload_image', arguments: { image_base64: `data:image/png;base64,${PNG_BASE64}` } }
        })).json();

        assert.equal(body.result.isError, false);
        assert.match(body.result.structuredContent.url, /^https:\/\/photos\.example\.com\/i\/\d{4}\/\d{2}\/\d{2}\/.{8}\.png$/);
        assert.equal(body.result.structuredContent.content_type, 'image/png');
        assert.equal(body.result.structuredContent.size_bytes, PNG.length);
        // URL 放在文案第一行，模型抄的就是它
        assert.ok(body.result.content[0].text.startsWith(`上传成功：${body.result.structuredContent.url}`));

        const put = calls.find(call => call.options.method === 'PUT');
        assert.equal(put.options.headers.get('content-type'), 'image/png');
    });
});

test('裸 base64 认不出类型时直接拒绝，而不是静默存成无后缀文件', async () => {
    await withFetch(null, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'upload_image', arguments: { image_base64: btoa('not an image at all') } }
        })).json();

        assert.equal(body.result.isError, true);
        assert.match(body.result.content[0].text, /无法识别图片类型/);
        assert.equal(calls.length, 0, '被拒的内容不该写进存储');
    });
});

test('tools/call 用 source_url 拉取远程图片并落库，出站请求不携带任何客户端请求头', async () => {
    const handler = (url) => url.hostname === 'cdn.test.example'
        ? new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
        : null;

    await withFetch(handler, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'upload_image', arguments: { source_url: 'https://cdn.test.example/a.png' } }
        })).json();

        assert.equal(body.result.isError, false);
        assert.match(body.result.structuredContent.url, /\.png$/);

        const outbound = calls.find(call => call.url.hostname === 'cdn.test.example');
        assert.equal(outbound.options.redirect, 'manual', '绝不能跟随跳转');
        assert.equal(outbound.options.headers.Authorization, undefined);
        assert.equal(outbound.options.headers.Cookie, undefined);
        assert.equal(outbound.options.headers.Accept, 'image/*');
    });
});

test('source_url 拒绝非 HTTPS、IP 直连、localhost 与本站域名，且不发起任何出站请求', async () => {
    const blocked = [
        'http://cdn.test.example/a.png',      // 明文
        'https://127.0.0.1/a.png',            // 点分十进制
        'https://2130706433/a.png',           // 十进制变形
        'https://[::1]/a.png',                // IPv6 字面量
        'https://localhost/a.png',
        'https://nas.local/a.png',
        'https://intranet/a.png',             // 不带域名后缀的裸主机名
        'https://user:pw@cdn.test.example/a.png',
        'https://photos.example.com/i/x.png', // 本站
        'file:///etc/passwd',
        '不是一个 URL'
    ];

    await withFetch(null, async (calls) => {
        for (const source_url of blocked) {
            const response = await post({
                jsonrpc: '2.0', id: 5, method: 'tools/call',
                params: { name: 'upload_image', arguments: { source_url } }
            });
            const body = await response.json();
            // 工具执行失败必须是 200 + isError，而不是 JSON-RPC error
            assert.equal(response.status, 200, source_url);
            assert.equal(body.error, undefined, source_url);
            assert.equal(body.result.isError, true, source_url);
        }
        assert.equal(calls.length, 0, '被拦的地址不该发出任何请求');
    });
});

test('参数二选一：同时提供或都不提供时返回 isError 而不是 JSON-RPC 错误', async () => {
    const cases = [
        {},
        { source_url: 'https://cdn.test.example/a.png', image_base64: PNG_BASE64 },
        { source_url: '   ' }
    ];

    for (const args of cases) {
        const response = await post({
            jsonrpc: '2.0', id: 6, method: 'tools/call',
            params: { name: 'upload_image', arguments: args }
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.error, undefined);
        assert.equal(body.result.isError, true);
        assert.match(body.result.content[0].text, /必须且只能提供/);
    }
});

test('未知方法返回 -32601，未知工具返回 -32602，非法 JSON 返回 -32700', async () => {
    // server/discover 的 404 + -32601 是让双纪元客户端回落到 initialize 的信号
    const unknown = await post({ jsonrpc: '2.0', id: 7, method: 'server/discover', params: {} });
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.error.code, -32601);
    assert.equal(unknownBody.id, 7, '错误响应必须回显 id');

    const badTool = await post({
        jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delete_everything' }
    });
    assert.equal(badTool.status, 200);
    assert.equal((await badTool.json()).error.code, -32602);

    const parseError = await post('not json at all');
    assert.equal(parseError.status, 400);
    const parseBody = await parseError.json();
    assert.equal(parseBody.error.code, -32700);
    assert.equal(parseBody.id, null);

    // 2025-06-18 起已移除批量请求
    const batch = await post([{ jsonrpc: '2.0', id: 9, method: 'ping' }]);
    assert.equal(batch.status, 400);
    assert.equal((await batch.json()).error.code, -32600);

    const pong = await post({ jsonrpc: '2.0', id: 10, method: 'ping' });
    assert.deepEqual((await pong.json()).result, {});
});

test('source_url 遇到 3xx 不跟随重定向，遇到非图片 Content-Type 直接拒绝', async () => {
    const call = async (handler, source_url) => withFetch(handler, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 11, method: 'tools/call',
            params: { name: 'upload_image', arguments: { source_url } }
        })).json();
        // 被拒时不能有 PUT 落库
        assert.equal(calls.some(c => c.options.method === 'PUT'), false);
        return body.result;
    });

    const redirected = await call(
        () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/a.png' } }),
        'https://cdn.test.example/a.png'
    );
    assert.equal(redirected.isError, true);
    assert.match(redirected.content[0].text, /跳转/);

    const html = await call(
        () => new Response('<html/>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
        'https://cdn.test.example/a.html'
    );
    assert.equal(html.isError, true);
    assert.match(html.content[0].text, /text\/html/);

    // SVG 存下来由本站域名提供服务就是存储型 XSS
    const svg = await call(
        () => new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }),
        'https://cdn.test.example/a.svg'
    );
    assert.equal(svg.isError, true);
    assert.match(svg.content[0].text, /SVG/);

    const notFound = await call(
        () => new Response(null, { status: 404 }),
        'https://cdn.test.example/missing.png'
    );
    assert.equal(notFound.isError, true);
    assert.match(notFound.content[0].text, /404/);
});

test('source_url 响应体超过上限时中止读取，不写入存储', async () => {
    // Content-Length 撒谎说只有 10 字节，靠流式计数兜住
    const handler = () => new Response(new Uint8Array(21 * 1024 * 1024), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '10' }
    });

    await withFetch(handler, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 12, method: 'tools/call',
            params: { name: 'upload_image', arguments: { source_url: 'https://cdn.test.example/big.png' } }
        })).json();

        assert.equal(body.result.isError, true);
        assert.match(body.result.content[0].text, /上限/);
        assert.equal(calls.some(c => c.options.method === 'PUT'), false);
    });
});

test('缺少或错误的 Bearer Token 返回 401 且带 WWW-Authenticate: Bearer 头', async () => {
    for (const token of [null, 'wrong-token']) {
        const response = await post({ jsonrpc: '2.0', id: 13, method: 'tools/list' }, { token });
        assert.equal(response.status, 401);
        assert.match(response.headers.get('WWW-Authenticate'), /^Bearer/);
    }
});

test('GET 与 DELETE /mcp 返回 405 并带 Allow: POST，不落到通用 404', async () => {
    for (const method of ['GET', 'DELETE']) {
        const response = await worker.fetch(
            new Request('https://photos.example.com/mcp', { method }), env, {}
        );
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('Allow'), 'POST');
    }
});

test('OPTIONS /mcp 预检允许 Authorization 与 MCP-Protocol-Version 头', async () => {
    const response = await worker.fetch(
        new Request('https://photos.example.com/mcp', { method: 'OPTIONS' }), env, {}
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');

    const allowed = response.headers.get('Access-Control-Allow-Headers');
    // 通配符不覆盖 Authorization，必须显式列出；漏掉 MCP-Protocol-Version
    // 会表现为握手成功、第一次 tools/list 预检失败
    assert.match(allowed, /Authorization/);
    assert.match(allowed, /MCP-Protocol-Version/);
});

test('未配置 AUTH_TOKEN 时 /mcp 返回 503 而不是放行', async () => {
    const response = await post(
        { jsonrpc: '2.0', id: 14, method: 'tools/list' },
        { token: null, overrides: { AUTH_TOKEN: undefined } }
    );
    assert.equal(response.status, 503);

    // 其余端点保持原有的 fail-open 行为，本次改动不动它们
    const dashboard = await worker.fetch(
        new Request('https://photos.example.com/'), { ...env, AUTH_TOKEN: undefined }, {}
    );
    assert.equal(dashboard.status, 200);
});
