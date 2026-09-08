import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: name => name === 'response' || name === 'propstat',
});
const properties = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';

/** WebDAV 存储；所有键限制在配置根目录的 i/ 下。 */
export class WebDAVStorage {
    // 默认请求函数必须包一层：直接存 fetch 会让 this 变成本实例，workerd 拒绝并抛 Illegal invocation。
    constructor(env, request = (...args) => fetch(...args)) {
        this.env = env;
        this.request = request;
    }

    config() {
        const { WEBDAV_URL, WEBDAV_USERNAME, WEBDAV_PASSWORD } = this.env;
        if (!WEBDAV_URL || !WEBDAV_USERNAME || !WEBDAV_PASSWORD) {
            throw new Error('缺少 WebDAV 配置');
        }
        const base = new URL(WEBDAV_URL);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
            throw new Error('WEBDAV_URL 必须是无凭据、查询参数的 HTTPS URL');
        }
        base.pathname = base.pathname.replace(/\/+$/, '') + '/';
        const bytes = new TextEncoder().encode(`${WEBDAV_USERNAME}:${WEBDAV_PASSWORD}`);
        return { base, authorization: `Basic ${btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))}` };
    }

    validate(key, directory = false) {
        if (typeof key !== 'string' || !key.startsWith('i/') || /[\\\x00-\x1f\x7f]/.test(key)) {
            throw new Error('无效的图片路径');
        }
        const parts = (directory ? key.replace(/\/$/, '') : key).split('/');
        if (parts.some(p => !p || p === '.' || p === '..') || (!directory && parts.length < 2)) {
            throw new Error('无效的图片路径');
        }
        return key;
    }

    async send(key, method, options = {}) {
        this.validate(key, key.endsWith('/'));
        const { base, authorization } = this.config();
        const target = new URL(key.split('/').map(encodeURIComponent).join('/'), base);
        const headers = new Headers(options.headers);
        headers.set('Authorization', authorization);
        try {
            return await this.request(target, {
                ...options, method, headers, redirect: 'manual',
                signal: AbortSignal.timeout(30000),
                ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
            });
        } catch (error) {
            // 消息会回传给客户端，细节只挂在 cause 上供日志排查。
            throw new Error('WebDAV 请求失败或超时', { cause: error });
        }
    }

    async check(response, allowed) {
        if (!allowed.includes(response.status)) {
            await response.body?.cancel();
            throw new Error(`WebDAV 返回 HTTP ${response.status}`);
        }
    }

    async get(key) {
        this.validate(key);
        const response = await this.send(key, 'GET');
        if (response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        await this.check(response, [200]);
        return {
            body: response.body,
            httpEtag: response.headers.get('etag'),
            writeHttpMetadata(headers) {
                for (const name of ['content-type', 'content-length', 'last-modified']) {
                    if (response.headers.has(name)) headers.set(name, response.headers.get(name));
                }
            },
        };
    }

    async put(key, body, options = {}) {
        this.validate(key);
        const parts = key.split('/');
        for (let i = 1; i < parts.length; i++) {
            const directory = parts.slice(0, i).join('/') + '/';
            const response = await this.send(directory, 'MKCOL');
            await this.check(response, [201, 405]);
            await response.body?.cancel();
            // 405 也可能表示同名文件，必须确认已存在的是目录。
            if (response.status === 405) await this.entries(directory, '0');
        }
        const response = await this.send(key, 'PUT', {
            body, headers: { 'Content-Type': options.httpMetadata?.contentType || 'application/octet-stream' },
        });
        await this.check(response, [200, 201, 204]);
        await response.body?.cancel();
    }

    async delete(key) {
        this.validate(key);
        // 防止管理接口误删整个目录。
        const entries = await this.entries(key, '0');
        if (entries.some(entry => entry.directory)) throw new Error('不允许删除目录');
        const response = await this.send(key, 'DELETE');
        await this.check(response, [200, 204, 404]);
        await response.body?.cancel();
    }

    async entries(key, depth = '1') {
        const response = await this.send(key, 'PROPFIND', {
            headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body: properties,
        });
        if (response.status === 404) {
            await response.body?.cancel();
            if (depth === '0' && key.endsWith('/')) throw new Error('WebDAV 目录不存在');
            return [];
        }
        await this.check(response, [207]);
        const xml = await response.text();
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持的 WebDAV XML');
        const result = parser.parse(xml);
        if (!result.multistatus) throw new Error('无效的 WebDAV 目录响应');
        const { base } = this.config();
        const root = decodeURIComponent(base.pathname);
        const entries = [];
        for (const item of result.multistatus.response || []) {
            const prop = (item.propstat || []).find(p => /\s200\s/.test(p.status))?.prop;
            if (!prop || typeof item.href !== 'string') continue;
            const href = new URL(item.href, base);
            const pathname = decodeURIComponent(href.pathname);
            if (href.origin !== base.origin || !pathname.startsWith(root)) continue;
            let entryKey = pathname.slice(root.length);
            const directory = typeof prop.resourcetype === 'object' && prop.resourcetype !== null && 'collection' in prop.resourcetype;
            if (directory && !entryKey.endsWith('/')) entryKey += '/';
            this.validate(entryKey, directory);
            entries.push({ key: entryKey, directory, size: Number(prop.getcontentlength) || 0,
                uploaded: prop.getlastmodified ? new Date(prop.getlastmodified).toISOString() : null,
                httpMetadata: { contentType: prop.getcontenttype || 'application/octet-stream' } });
        }
        if (depth === '0' && key.endsWith('/') && !entries.some(e => e.key === key && e.directory)) {
            throw new Error('WebDAV 路径不是目录');
        }
        return entries;
    }

    /** Depth:1 遍历；游标保存待访问目录和当前目录的最后一个文件。 */
    async list({ prefix = 'i/', delimiter, limit = 50, cursor } = {}) {
        this.validate(prefix, true);
        if (delimiter) {
            const entries = await this.entries(prefix);
            return { objects: [], delimitedPrefixes: entries.filter(e => e.directory && e.key !== prefix && e.key.startsWith(prefix)).map(e => e.key), truncated: false };
        }
        limit = Math.max(1, Math.min(Number(limit) || 50, 100));
        let state = { prefix, dirs: [prefix], after: '' };
        if (cursor) {
            try {
                if (cursor.length > 50000) throw new Error();
                state = JSON.parse(decodeURIComponent(escape(atob(cursor))));
                if (state.prefix !== prefix || !Array.isArray(state.dirs) || state.dirs.length > 1000 || typeof state.after !== 'string') throw new Error();
                for (const dir of state.dirs) {
                    this.validate(dir, true);
                    if (!dir.startsWith(prefix) || !dir.endsWith('/')) throw new Error();
                }
            } catch { throw new Error('无效的分页游标'); }
        }
        const objects = [];
        for (let calls = 0; state.dirs.length && calls < 35 && objects.length < limit; calls++) {
            const dir = state.dirs[0];
            const entries = (await this.entries(dir)).filter(e => e.key !== dir && e.key.startsWith(dir) && !e.key.slice(dir.length).replace(/\/$/, '').includes('/'));
            entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
            const files = entries.filter(e => !e.directory && e.key > state.after);
            const selected = files.slice(0, limit - objects.length);
            objects.push(...selected);
            if (selected.length < files.length) {
                state.after = selected.at(-1).key;
            } else {
                state.dirs.shift();
                state.dirs.unshift(...entries.filter(e => e.directory).map(e => e.key));
                state.after = '';
            }
        }
        const truncated = state.dirs.length > 0;
        return { objects, truncated, cursor: truncated ? btoa(unescape(encodeURIComponent(JSON.stringify(state)))) : null };
    }
}
