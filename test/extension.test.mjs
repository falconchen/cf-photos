import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    deriveFilename,
    formatLink,
    mimeFromFilename,
    DEFAULT_SETTINGS,
    normalizeEndpoint,
    normalizeTheme,
    normalizeToastPosition,
    parseUploadResponse,
    sniffImageMime
} from '../extension/lib/shared.js';

const bytes = (...values) => Uint8Array.from(values);
const text = value => new TextEncoder().encode(value);

test('normalizeEndpoint 只保留源，拒绝非 http(s) 与带凭据的地址', () => {
    assert.equal(normalizeEndpoint('https://photos.example.com/'), 'https://photos.example.com');
    assert.equal(normalizeEndpoint('https://photos.example.com/upload?x=1'), 'https://photos.example.com');
    assert.equal(normalizeEndpoint('photos.example.com'), 'https://photos.example.com');
    assert.equal(normalizeEndpoint('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
    assert.equal(normalizeEndpoint('ftp://example.com'), '');
    assert.equal(normalizeEndpoint('https://u:p@example.com'), '');
    assert.equal(normalizeEndpoint('   '), '');
});

test('主题与通知位置默认深色、右上，非法值回落到默认', () => {
    assert.equal(DEFAULT_SETTINGS.theme, 'dark');
    assert.equal(DEFAULT_SETTINGS.toastPosition, 'top-right');
    assert.equal(normalizeTheme('light'), 'light');
    assert.equal(normalizeTheme('dark'), 'dark');
    for (const bad of [undefined, '', 'system', 'toString', {}]) {
        assert.equal(normalizeTheme(bad), 'dark');
    }
    for (const position of ['top-right', 'top-left', 'bottom-left', 'bottom-right']) {
        assert.equal(normalizeToastPosition(position), position);
    }
    for (const bad of [undefined, 'center', 'constructor', null]) {
        assert.equal(normalizeToastPosition(bad), 'top-right');
    }
});

test('sniffImageMime 认出常见图片文件头', () => {
    assert.equal(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
    assert.equal(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
    assert.equal(sniffImageMime(text('GIF89a....')), 'image/gif');
    assert.equal(sniffImageMime(text('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImageMime(text('\0\0\0\x1cftypavif')), 'image/avif');
    assert.equal(sniffImageMime(text('\0\0\0\x18ftypheic')), 'image/heic');
    assert.equal(sniffImageMime(text('﻿  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">')), 'image/svg+xml');
});

test('sniffImageMime 不把网页或视频当成图片', () => {
    assert.equal(sniffImageMime(text('<!doctype html><html>')), '');
    assert.equal(sniffImageMime(text('\0\0\0\x18ftypmp42')), '');
    assert.equal(sniffImageMime(bytes()), '');
});

test('deriveFilename 保留原名，后缀与真实类型不符时纠正', () => {
    assert.equal(deriveFilename('https://a.com/p/cat.png?v=2', 'image/png'), 'cat.png');
    assert.equal(deriveFilename('https://a.com/p/cat.JPEG', 'image/jpeg'), 'cat.JPEG');
    assert.equal(deriveFilename('https://a.com/p/cat.jpg', 'image/webp'), 'cat.webp');
    assert.equal(deriveFilename('https://a.com/img.php', 'image/gif'), 'img.gif');
    assert.equal(deriveFilename('https://a.com/image/12345', 'image/png'), '12345.png');
    assert.equal(deriveFilename('https://a.com/%E7%8C%AB.png', 'image/png'), '猫.png');
    assert.equal(deriveFilename('https://a.com/', 'image/png'), 'image.png');
    assert.equal(deriveFilename('data:image/png;base64,AAAA', 'image/png'), 'image.png');
    assert.equal(deriveFilename('blob:https://a.com/uuid', 'image/jpeg'), 'image.jpg');
});

test('mimeFromFilename 只认图片后缀', () => {
    assert.equal(mimeFromFilename('/a/b.jpeg'), 'image/jpeg');
    assert.equal(mimeFromFilename('/a/b.SVG'), 'image/svg+xml');
    assert.equal(mimeFromFilename('/a/b.html'), '');
    assert.equal(mimeFromFilename('/a/b'), '');
});

test('formatLink 生成四种格式并转义 HTML 属性', () => {
    const url = 'https://p.example.com/i/2026/09/15/abc.png';
    assert.equal(formatLink(url, 'url'), url);
    assert.equal(formatLink(url, 'markdown', '一只[猫]'), `![一只猫](${url})`);
    assert.equal(formatLink(url, 'html', 'a "b" <c>'), `<img src="${url}" alt="a &quot;b&quot; &lt;c&gt;">`);
    assert.equal(formatLink(url, 'bbcode'), `[img]${url}[/img]`);
    assert.equal(formatLink(url, 'unknown'), url);
});

test('parseUploadResponse 成功取 url，失败给出中文原因', () => {
    assert.equal(
        parseUploadResponse(201, JSON.stringify({ result: 'success', code: 200, url: 'https://x/i/a.png' })),
        'https://x/i/a.png'
    );
    assert.throws(() => parseUploadResponse(401, 'Unauthorized'), /Token/);
    assert.throws(() => parseUploadResponse(415, JSON.stringify({ result: 'error', message: '不支持的类型' })), /不支持的类型/);
    assert.throws(() => parseUploadResponse(413, '<html>Payload Too Large</html>'), /请求体上限/);
    assert.throws(() => parseUploadResponse(500, JSON.stringify({ result: 'error', message: 'WebDAV 挂了' })), /HTTP 500.*WebDAV 挂了/);
});

test('manifest 引用的文件都存在', () => {
    const root = new URL('../extension/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
    const files = [
        manifest.background.service_worker,
        manifest.action.default_popup,
        manifest.options_page,
        ...Object.values(manifest.icons),
        ...Object.values(manifest.action.default_icon),
        'offscreen.html',
        'content/toast.js',
        'theme.js'
    ];
    for (const file of files) {
        assert.doesNotThrow(() => readFileSync(new URL(file, root)), `缺少 ${file}`);
    }
});

test('Firefox Manifest V3 使用 background scripts 并声明 Gecko ID', () => {
    const root = new URL('../extension/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.firefox.json', root), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.type, 'module');
    assert.deepEqual(manifest.background.scripts, ['background.js']);
    assert.equal(manifest.browser_specific_settings.gecko.id, 'photoflare@falconchen.dev');
    assert.equal(manifest.permissions.includes('offscreen'), false);
    assert.equal(manifest.permissions.includes('declarativeNetRequest'), true);
});
