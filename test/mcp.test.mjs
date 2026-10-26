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

// 1x1 PNG，用来喂远程抓取与文件参数两条路径；PNG_BASE64 只用来验证 base64 已被拒
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
    // 图标地址按请求源拼出，且该地址本身匿名可取
    assert.deepEqual(body.result.serverInfo.icons, [
        { src: 'https://photos.example.com/icon.png', mimeType: 'image/png', sizes: ['512x512'] }
    ]);
    assert.equal(body.result.serverInfo.websiteUrl, 'https://photos.example.com');
});

test('/icon.png 与 /favicon.ico 匿名返回 PNG', async () => {
    for (const path of ['/icon.png', '/favicon.ico']) {
        const response = await worker.fetch(new Request('https://photos.example.com' + path), env, {});
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'image/png');
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }
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

test('tools/list 暴露 upload_image 与 create_upload_url，inputSchema 是合法的 object schema', async () => {
    const body = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.deepEqual(body.result.tools.map(tool => tool.name), ['upload_image', 'create_upload_url']);

    const ticket = body.result.tools[1];
    assert.equal(ticket.inputSchema.type, 'object');
    assert.deepEqual(ticket.inputSchema.required, ['file_name']);
    assert.equal(ticket.inputSchema.additionalProperties, false);

    const tool = body.result.tools[0];
    assert.equal(tool.name, 'upload_image');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['file', 'source_url']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    // 顶层不放 oneOf/anyOf：三选一由服务端手写校验，见 McpService._uploadImage
    assert.equal(tool.inputSchema.oneOf, undefined);
});

test('tools/list 按 ChatGPT 文件参数规范声明 file，_meta 挂在工具描述符上', async () => {
    const body = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const tool = body.result.tools[0];

    assert.deepEqual(tool._meta['openai/fileParams'], ['file']);
    assert.equal(tool.inputSchema._meta, undefined, '_meta 放错到 inputSchema 里 ChatGPT 不认');

    // Scan Tools 的硬性要求：四个属性都要声明，required 恰好是 download_url 与 file_id
    const file = tool.inputSchema.properties.file;
    assert.equal(file.type, 'object');
    assert.deepEqual(Object.keys(file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
    for (const property of Object.values(file.properties)) {
        assert.equal(property.type, 'string');
    }
    assert.deepEqual([...file.required].sort(), ['download_url', 'file_id']);
});

test('file 参数：下载临时地址、按文件头定类型，响应头是 octet-stream 也照样落库', async () => {
    const handler = (url) => url.hostname === 'files.oai.test'
        ? new Response(PNG, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
        : null;

    await withFetch(handler, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 13, method: 'tools/call',
            params: {
                name: 'upload_image',
                arguments: {
                    file: {
                        download_url: 'https://files.oai.test/download/file_abc?sig=xyz',
                        file_id: 'file_abc',
                        // 声明故意写错：类型以文件头为准
                        mime_type: 'image/jpeg',
                        file_name: 'chart.png'
                    }
                }
            }
        })).json();

        assert.equal(body.result.isError, false);
        assert.match(body.result.structuredContent.url, /\.png$/);
        assert.equal(body.result.structuredContent.content_type, 'image/png');
        assert.equal(body.result.structuredContent.size_bytes, PNG.length);

        const outbound = calls.find(call => call.url.hostname === 'files.oai.test');
        assert.equal(outbound.url.search, '?sig=xyz', '签名参数必须原样带上');
        assert.equal(outbound.options.redirect, 'manual');
        assert.equal(outbound.options.headers.Authorization, undefined);

        const put = calls.find(call => call.options.method === 'PUT');
        assert.equal(put.options.headers.get('content-type'), 'image/png');
    });
});

test('file 参数：认不出的内容、SVG、坏对象与被拦地址都返回 isError 且不落库', async () => {
    const call = async (handler, file) => withFetch(handler, async (calls) => {
        const body = await (await post({
            jsonrpc: '2.0', id: 14, method: 'tools/call',
            params: { name: 'upload_image', arguments: { file } }
        })).json();
        assert.equal(body.error, undefined);
        assert.equal(calls.some(c => c.options.method === 'PUT'), false);
        return { result: body.result, calls };
    });
    const serve = (bytes, type) => () => new Response(bytes, { status: 200, headers: { 'Content-Type': type } });
    const file = (download_url, extra = {}) => ({ download_url, file_id: 'file_abc', ...extra });

    // 响应头谎称 image/png，字节其实是 HTML：sniff 模式不信响应头
    const html = await call(serve('<html><script>alert(1)</script></html>', 'image/png'),
        file('https://files.oai.test/a', { mime_type: 'image/png' }));
    assert.equal(html.result.isError, true);
    assert.match(html.result.content[0].text, /无法从文件内容识别/);
    assert.match(html.result.content[0].text, /image\/png/);

    // SVG 是文本，文件头认不出，不管声明成什么都进不来
    const svg = await call(serve('<svg xmlns="http://www.w3.org/2000/svg"/>', 'application/octet-stream'),
        file('https://files.oai.test/a.svg', { mime_type: 'image/svg+xml' }));
    assert.equal(svg.result.isError, true);

    const redirected = await call(
        () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/a.png' } }),
        file('https://files.oai.test/a')
    );
    assert.equal(redirected.result.isError, true);
    assert.match(redirected.result.content[0].text, /跳转/);

    // 与 source_url 同一套 SSRF 检查，且不发起任何出站请求
    for (const blocked of ['http://files.oai.test/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://photos.example.com/i/x.png']) {
        const { result, calls } = await call(null, file(blocked));
        assert.equal(result.isError, true, blocked);
        assert.equal(calls.length, 0, blocked);
    }
    const credentials = await call(null, file('https://u:p@files.oai.test/a'));
    assert.match(credentials.result.content[0].text, /file\.download_url/);

    for (const bad of ['https://files.oai.test/a', { file_id: 'file_abc' }, { download_url: 'https://files.oai.test/a' }, [], { download_url: '', file_id: 'x' }]) {
        const { result, calls } = await call(null, bad);
        assert.equal(result.isError, true, JSON.stringify(bad));
        assert.match(result.content[0].text, /download_url 与 file_id/);
        assert.equal(calls.length, 0);
    }
});

test('image_base64 已下线：无论单独传还是混着传，都返回指路的 isError 且不落库', async () => {
    const cases = [
        { image_base64: `data:image/png;base64,${PNG_BASE64}` },
        { image_base64: PNG_BASE64, source_url: 'https://cdn.test.example/a.png' },
        { image_base64: '' }
    ];

    for (const args of cases) {
        await withFetch(null, async (calls) => {
            const response = await post({
                jsonrpc: '2.0', id: 3, method: 'tools/call',
                params: { name: 'upload_image', arguments: args }
            });
            const body = await response.json();
            assert.equal(response.status, 200);
            assert.equal(body.error, undefined);
            assert.equal(body.result.isError, true);
            assert.match(body.result.content[0].text, /不再接受 image_base64/);
            assert.match(body.result.content[0].text, /create_upload_url/);
            assert.equal(calls.length, 0, '被拒的请求不该发出任何出站请求');
        });
    }
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
        assert.match(body.result.structuredContent.url, /^https:\/\/photos\.example\.com\/i\/\d{4}\/\d{2}\/\d{2}\/.{8}\.png$/);
        assert.equal(body.result.structuredContent.size_bytes, PNG.length);
        // URL 放在文案第一行，模型抄的就是它
        assert.ok(body.result.content[0].text.startsWith(`上传成功：${body.result.structuredContent.url}`));

        const put = calls.find(call => call.options.method === 'PUT');
        assert.equal(put.options.headers.get('content-type'), 'image/png');

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
    const file = { download_url: 'https://files.oai.test/a', file_id: 'file_abc' };
    const cases = [
        {},
        { file, source_url: 'https://cdn.test.example/a.png' },
        // 坏 file 也占名额：不能悄悄退回去用 source_url
        { file: 'oops', source_url: 'https://cdn.test.example/a.png' },
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

test('管理后台提供可持久化的浅色主题切换', async () => {
    const response = await worker.fetch(
        new Request('https://photos.example.com/'), env, {}
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /:root\[data-theme="light"\]/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /localStorage\.getItem\('cf_photo_theme'\)/);
    assert.match(html, /matchMedia\?\.\('\(prefers-color-scheme: light\)'\)/);
    assert.match(html, /hasSavedTheme \? savedTheme : systemTheme/);
    assert.match(html, /localStorage\.setItem\('cf_photo_theme', nextTheme\)/);
    assert.match(html, /grid-template-columns: minmax\(0, 1fr\) auto/);
    assert.match(html, /\.theme-toggle \{\s+grid-column: 2;\s+grid-row: 1;/);
    assert.match(html, /#header-actions \{\s+grid-column: 1 \/ -1;\s+grid-row: 2;/);
});
