import test from 'node:test';
import assert from 'node:assert/strict';
import { WebDAVStorage } from '../src/services/WebDAVStorage.js';

const env = { WEBDAV_URL: 'https://example.com/dav', WEBDAV_USERNAME: 'user', WEBDAV_PASSWORD: 'secret' };
const item = (key, directory = false) => `<D:response><D:href>/dav/${key}</D:href><D:propstat><D:prop><D:resourcetype>${directory ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>3</D:getcontentlength><D:getcontenttype>image/png</D:getcontenttype><D:getlastmodified>Tue, 08 Sep 2026 00:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const xml = entries => new Response(`<D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`, { status: 207 });

test('上传逐级建目录；验证已存在目录并传递认证和 MIME', async () => {
    const calls = [];
    const storage = new WebDAVStorage(env, async (url, options) => {
        calls.push([url.pathname, options.method]);
        assert.equal(options.headers.get('Authorization'), `Basic ${btoa('user:secret')}`);
        assert.equal(options.redirect, 'manual');
        if (options.method === 'MKCOL') return new Response(null, { status: url.pathname === '/dav/i/' ? 405 : 201 });
        if (options.method === 'PROPFIND') return xml([item('i/', true)]);
        assert.equal(options.headers.get('content-type'), 'image/png');
        return new Response(null, { status: 201 });
    });
    await storage.put('i/2026/a b.png', new Uint8Array([1]), { httpMetadata: { contentType: 'image/png' } });
    assert.deepEqual(calls, [['/dav/i/', 'MKCOL'], ['/dav/i/', 'PROPFIND'], ['/dav/i/2026/', 'MKCOL'], ['/dav/i/2026/a%20b.png', 'PUT']]);
});

test('下载保留元数据；404 返回空；认证错误和重定向不伪装为不存在', async () => {
    const storage = new WebDAVStorage(env, async () => new Response('png', { headers: { 'Content-Type': 'image/png', ETag: '"tag"' } }));
    const object = await storage.get('i/a.png');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    assert.equal(headers.get('content-type'), 'image/png');
    assert.equal(object.httpEtag, '"tag"');
    assert.equal(await new Response(object.body).text(), 'png');
    for (const status of [301, 401, 403, 500]) {
        await assert.rejects(new WebDAVStorage(env, async () => new Response(null, { status })).get('i/a.png'), new RegExp(`${status}`));
    }
    assert.equal(await new WebDAVStorage(env, async () => new Response(null, { status: 404 })).get('i/a.png'), null);
});

test('拒绝目录穿越和删除目录，不发送危险 DELETE', async () => {
    const storage = new WebDAVStorage(env, async (_url, options) => {
        assert.equal(options.method, 'PROPFIND');
        return xml([item('i/2026/', true)]);
    });
    for (const key of ['other/a', 'i/../secret', 'i/a/../../x', 'i//a', 'i/\\a', 'i/']) {
        await assert.rejects(storage.get(key));
    }
    await assert.rejects(storage.delete('i/2026'), /不允许删除目录/);
});

test('多级目录分页没有重复遗漏，保留 XML 实体和编码文件名', async () => {
    const tree = {
        'i/': [item('i/', true), item('i/2026/', true)],
        'i/2026/': [item('i/2026/', true), item('i/2026/09/', true)],
        'i/2026/09/': [item('i/2026/09/', true), item('i/2026/09/a.png'), item('i/2026/09/b%20%E4%B8%AD.png'), item('i/2026/09/c&amp;d.png')],
    };
    const storage = new WebDAVStorage(env, async (url, options) => {
        assert.equal(options.headers.get('Depth'), '1');
        return xml(tree[url.pathname.slice('/dav/'.length)]);
    });
    const keys = [];
    let cursor;
    do {
        const result = await storage.list({ limit: 1, cursor });
        keys.push(...result.objects.map(o => o.key));
        cursor = result.cursor;
    } while (cursor);
    assert.deepEqual(keys, ['i/2026/09/a.png', 'i/2026/09/b 中.png', 'i/2026/09/c&d.png']);
    assert.deepEqual((await storage.list({ delimiter: '/' })).delimitedPrefixes, ['i/2026/']);
    await assert.rejects(storage.list({ cursor: 'invalid' }), /分页游标/);
    await assert.rejects(storage.list({ prefix: 'i/../' }));
});

test('默认请求函数以全局身份调用 fetch，而不是以存储实例', async () => {
    // 直接把 fetch 存成实例属性会让 this 指向 WebDAVStorage，workerd 抛 Illegal invocation。
    const original = globalThis.fetch;
    let receiver = 'unset';
    globalThis.fetch = function () {
        receiver = this;
        return new Response(null, { status: 404 });
    };
    try {
        const storage = new WebDAVStorage(env);
        assert.equal(await storage.get('i/a.png'), null);
        assert.ok(receiver === undefined || receiver === globalThis, 'fetch 的 this 不能是存储实例');
    } finally {
        globalThis.fetch = original;
    }
});

test('缺失目录为空列表，非法 XML 被拒绝', async () => {
    assert.deepEqual((await new WebDAVStorage(env, async () => new Response(null, { status: 404 })).list()).objects, []);
    await assert.rejects(new WebDAVStorage(env, async () => new Response('<html/>', { status: 207 })).list(), /无效/);
});
