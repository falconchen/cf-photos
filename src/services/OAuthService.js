/**
 * OAuth 2.1 授权服务端（无状态）
 *
 * 存在的唯一理由：claude.ai 网页版 / 手机端的自定义连接器不支持静态 Authorization
 * 头（那是 static_headers，尚在 beta 白名单里），只认 OAuth。Claude Code 与桌面端
 * 仍可继续用 AUTH_TOKEN 直连，/mcp 两种凭据都收。
 *
 * 无状态是硬约束：本项目没有 KV、没有 D1、没有 Durable Object，也不打算为此新增
 * 绑定。因此所有「服务端状态」（注册的客户端、授权码、访问令牌、刷新令牌）都不落
 * 盘，而是把内容塞进令牌本身，用 AUTH_TOKEN 派生的 HMAC-SHA256 密钥签名。由此带来
 * 三个必须知道的后果：
 * 1. 无法单独吊销某一个令牌。要全部作废就换 AUTH_TOKEN —— 密钥变了，此前签发的
 *    一切（含 client_id）同时失效，各端重新授权即可。
 * 2. 刷新令牌做了轮换（每次刷新签发新的一对），但旧的那个在过期前仍可用，因为没有
 *    地方记录「已用过」。这是无状态的固有代价，不是遗漏。
 * 3. 授权码同理不能防重放，只能靠 10 分钟短有效期 + PKCE 绑定收窄窗口。
 *
 * 同意页要求手动粘贴 AUTH_TOKEN —— 这就是本服务端的「登录」。图床只有一个主人，
 * 引入用户表毫无意义；能拿到 AUTH_TOKEN 的人本来就能直接调 /mcp。
 *
 * 关键契约（改之前先读 CLAUDE.md 里对应章节，都是 Anthropic 侧的硬要求）：
 * - 回调地址白名单只放行 claude.ai / claude.com 与本机回环，注册阶段就挡掉。开放
 *   注册 + 任意 redirect_uri = 钓鱼页可以骗走授权码，而 PKCE 保护不了这一步（发起
 *   方就是攻击者，verifier 在他手里）。
 * - 只声明 DCR，不声明 client_id_metadata_document_supported —— Claude 只有在
 *   AS 元数据同时写了它和 token_endpoint_auth_methods_supported: ["none"] 时才走
 *   CIMD，否则回落 DCR。这里有意只走 DCR，逻辑少一条出站请求。
 * - code_challenge_methods_supported 必须写 ["S256"]，Claude 每次授权都带 PKCE。
 * - /token 必须收 application/x-www-form-urlencoded；/register 是 application/json。
 * - 各端点响应要快：发现 / 注册 / 换 token 超时 10 秒，刷新 30 秒。本实现全是纯
 *   计算，无出站请求。
 */

// 授权码 10 分钟；访问令牌 30 天；刷新令牌 90 天
const CODE_TTL = 600;
const ACCESS_TTL = 30 * 24 * 3600;
const REFRESH_TTL = 90 * 24 * 3600;

// 单一权限范围。offline_access 一并声明，Claude 见到它才会去要刷新令牌
const SCOPE = 'photos:write';
const SCOPES_SUPPORTED = [SCOPE, 'offline_access'];

// 受本服务端保护的资源，即 MCP 端点路径
const RESOURCE_PATH = '/mcp';

// 本服务端接管的路径。index.js 用 OAuthService.owns(path) 判断是否分派过来
const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource';
const WELL_KNOWN_AS = '/.well-known/oauth-authorization-server';
const OWNED_PATHS = new Set([
    WELL_KNOWN_PRM, `${WELL_KNOWN_PRM}${RESOURCE_PATH}`,
    WELL_KNOWN_AS, `${WELL_KNOWN_AS}${RESOURCE_PATH}`,
    '/oauth/register', '/oauth/authorize', '/oauth/token'
]);

// 浏览器内的 MCP 客户端（Inspector 网页版等）会跨域读元数据、跨域换 token
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    // 浏览器内的 MCP 客户端要读 401 上的挑战头才能发现授权服务器，跨域下不 expose 就读不到
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
    'Access-Control-Max-Age': '86400'
};

// 允许把授权码送达的主机：Claude 各端与 ChatGPT。这是全套流程里最吃紧的一道防线，
// 见下面 isAllowedRedirect 的说明。
const ALLOWED_REDIRECT_HOSTS = new Set(['claude.ai', 'claude.com', 'chatgpt.com']);

const encoder = new TextEncoder();

/**
 * 字节数组转 base64url（无填充）
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url 转字节数组，非法输入返回 null
 * @param {string} text
 * @returns {Uint8Array|null}
 */
function fromBase64Url(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
    try {
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

/**
 * 转义 HTML 文本节点内容，同意页要回显客户端名与回调地址
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

/**
 * code_challenge 是否形如 S256 的输出
 * S256 的结果恒为 43 个 base64url 字符；放宽到 128 是给不规范客户端留余地，
 * 同时挡住超长输入把授权码撑到 URL 长度上限之外。
 * @param {string|null} challenge
 * @returns {boolean}
 */
function isValidCodeChallenge(challenge) {
    return typeof challenge === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(challenge);
}

/**
 * 判断回调地址是否在白名单内
 *
 * 只放行 Claude 各端与本机回环。开放注册端点若允许任意 redirect_uri，攻击者就能
 * 注册一个指向自己的客户端、诱导站长在同意页粘贴 AUTH_TOKEN，然后收走授权码。
 * @param {string} uri
 * @returns {boolean}
 */
function isAllowedRedirect(uri) {
    let parsed;
    try {
        parsed = new URL(uri);
    } catch {
        return false;
    }
    // OAuth 规范要求回调地址不带 fragment
    if (parsed.hash) return false;

    // 各家客户端的回调路径都可能变（ChatGPT 就有 /connector_platform_oauth_redirect
    // 与 /connector/oauth/{callback_id} 两种形态），所以按主机名放行、不锁路径 ——
    // 这些主机本身可信，真要出事得先在它们身上找到一个开放重定向。
    if (parsed.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.has(parsed.hostname)) {
        return true;
    }
    // RFC 8252 回环重定向：Claude Code 与各类本地 Inspector 用的端口每次都不同，
    // 因此不校验端口；主机名限定回环地址，路径不限。
    if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        return true;
    }
    return false;
}

export class OAuthService {
    /**
     * 构造函数
     * @param {Object} env 环境变量，需要 AUTH_TOKEN 作为签名密钥与同意页口令
     * @param {Object} [options={}] 可选项
     * @param {Function} [options.now] 取当前毫秒时间戳，测试里注入以伪造过期
     */
    constructor(env, options = {}) {
        this.env = env;
        this.now = options.now || (() => Date.now());
    }

    /**
     * 该路径是否由本服务端接管
     * @param {string} path
     * @returns {boolean}
     */
    static owns(path) {
        return OWNED_PATHS.has(path);
    }

    /**
     * 分派一次 OAuth 请求
     * @param {Request} request
     * @param {URL} url 已解析的请求 URL
     * @returns {Promise<Response>}
     */
    async handle(request, url) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // 没有 AUTH_TOKEN 就没有签名密钥，整套流程无从谈起。与 /mcp 一样 fail-closed。
        if (!this.env.AUTH_TOKEN) {
            return new Response('OAuth 端点要求配置 AUTH_TOKEN', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        const path = url.pathname;

        if (path === WELL_KNOWN_PRM || path === `${WELL_KNOWN_PRM}${RESOURCE_PATH}`) {
            return this._metadataResponse(this._protectedResourceMetadata(url));
        }

        if (path === WELL_KNOWN_AS || path === `${WELL_KNOWN_AS}${RESOURCE_PATH}`) {
            return this._metadataResponse(this._authorizationServerMetadata(url));
        }

        if (path === '/oauth/register') {
            if (request.method !== 'POST') return this._methodNotAllowed('POST');
            return await this._register(request);
        }

        if (path === '/oauth/authorize') {
            if (request.method === 'GET') return await this._authorizeForm(url);
            if (request.method === 'POST') return await this._authorizeSubmit(request, url);
            return this._methodNotAllowed('GET, POST');
        }

        if (path === '/oauth/token') {
            if (request.method !== 'POST') return this._methodNotAllowed('POST');
            return await this._token(request, url);
        }

        // owns() 与本方法必须同步维护，走到这里说明漏了一条分支
        return new Response('Not Found', { status: 404 });
    }

    /**
     * 校验 Authorization 头里的 OAuth 访问令牌
     *
     * 供 /mcp 在静态 AUTH_TOKEN 校验失败后兜底调用。令牌绑定受众（aud），拿去打
     * 别的 origin 不认。
     * @param {Request} request
     * @param {Object} env
     * @param {URL} url 当前请求 URL，用于比对受众
     * @returns {Promise<boolean>}
     */
    static async verifyAccessToken(request, env, url) {
        if (!env.AUTH_TOKEN) return false;

        const header = request.headers.get('Authorization');
        if (!header || !header.startsWith('Bearer ')) return false;

        const payload = await new OAuthService(env)._verify(header.substring(7), 'at');
        return Boolean(payload) && payload.aud === `${url.origin}${RESOURCE_PATH}`;
    }

    /**
     * 401 响应，带 resource_metadata 指针
     *
     * Claude 靠这个头找到受保护资源元数据，进而找到授权服务器；缺了它就只能去探测
     * /.well-known/*，多两跳且依赖路由恰好命中。规范要求它必须挂在 401 上，挂在
     * 200 上 Claude 不认。
     * @param {URL} url 当前请求 URL
     * @returns {Response}
     */
    static unauthorizedResponse(url) {
        const metadata = `${url.origin}${WELL_KNOWN_PRM}${RESOURCE_PATH}`;
        return new Response('Unauthorized: 鉴权失败，请提供正确的 Token 或完成 OAuth 授权', {
            status: 401,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'WWW-Authenticate': `Bearer realm="cf-photos", resource_metadata="${metadata}", scope="${SCOPE}"`,
                ...CORS_HEADERS
            }
        });
    }

    /**
     * 受保护资源元数据（RFC 9728）
     *
     * resource 字段必须与用户在 Claude 里填写的 URL 逐字一致，含路径。
     * @param {URL} url
     * @returns {Object}
     */
    _protectedResourceMetadata(url) {
        return {
            resource: `${url.origin}${RESOURCE_PATH}`,
            authorization_servers: [url.origin],
            scopes_supported: SCOPES_SUPPORTED,
            bearer_methods_supported: ['header'],
            resource_name: 'cf-photos 图床 MCP'
        };
    }

    /**
     * 授权服务器元数据（RFC 8414）
     * @param {URL} url
     * @returns {Object}
     */
    _authorizationServerMetadata(url) {
        return {
            issuer: url.origin,
            authorization_endpoint: `${url.origin}/oauth/authorize`,
            token_endpoint: `${url.origin}/oauth/token`,
            registration_endpoint: `${url.origin}/oauth/register`,
            scopes_supported: SCOPES_SUPPORTED,
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            // 公开客户端：不发 client_secret，也就不做客户端认证
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
            // RFC 9207：授权响应回带 iss。ChatGPT 拿它决定用哪种回调地址 —— 声明了
            // 才给稳定的 /connector_platform_oauth_redirect，否则退回每连接一个的
            // /connector/oauth/{callback_id}。声明了就必须真的带，且与 issuer 逐字一致。
            authorization_response_iss_parameter_supported: true
        };
    }

    /**
     * 元数据响应，带 CORS 与短缓存
     * @param {Object} body
     * @returns {Response}
     */
    _metadataResponse(body) {
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
                ...CORS_HEADERS
            }
        });
    }

    /**
     * 405 响应
     * @param {string} allow
     * @returns {Response}
     */
    _methodNotAllowed(allow) {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': allow, ...CORS_HEADERS }
        });
    }

    /**
     * OAuth 错误响应（RFC 6749 格式）
     * @param {string} error 错误码
     * @param {string} description 中文说明
     * @param {number} [status=400]
     * @returns {Response}
     */
    _oauthError(error, description, status = 400) {
        return new Response(JSON.stringify({ error, error_description: description }), {
            status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                ...CORS_HEADERS
            }
        });
    }

    // ---------- 签名与令牌 ----------

    /**
     * 由 AUTH_TOKEN 派生 HMAC 密钥
     *
     * 不直接拿 AUTH_TOKEN 当密钥：先加固定前缀再 SHA-256，避免密钥材料与用户口令
     * 逐字节相同，也把任意长度的口令规整成 32 字节。
     * @returns {Promise<CryptoKey>}
     */
    async _key() {
        const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`cf-photos-oauth-v1:${this.env.AUTH_TOKEN}`));
        return await crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    }

    /**
     * 签发一枚令牌：base64url(JSON 载荷).base64url(HMAC)
     * @param {string} type 载荷类型：client / code / at / rt
     * @param {Object} claims 载荷字段
     * @param {number|null} [ttl=null] 有效期秒数，null 表示不过期（client_id）
     * @returns {Promise<string>}
     */
    async _sign(type, claims, ttl = null) {
        const payload = { t: type, ...claims };
        if (ttl !== null) payload.exp = Math.floor(this.now() / 1000) + ttl;

        const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
        const signature = await crypto.subtle.sign('HMAC', await this._key(), encoder.encode(body));
        return `${body}.${toBase64Url(new Uint8Array(signature))}`;
    }

    /**
     * 校验令牌并返回载荷，签名不符 / 类型不符 / 已过期一律返回 null
     * @param {string} token
     * @param {string} type 期望的载荷类型
     * @returns {Promise<Object|null>}
     */
    async _verify(token, type) {
        if (typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 2) return null;

        const signature = fromBase64Url(parts[1]);
        if (!signature) return null;

        const ok = await crypto.subtle.verify('HMAC', await this._key(), signature, encoder.encode(parts[0]));
        if (!ok) return null;

        const raw = fromBase64Url(parts[0]);
        if (!raw) return null;

        let payload;
        try {
            payload = JSON.parse(new TextDecoder().decode(raw));
        } catch {
            return null;
        }

        // 类型必须对上，否则授权码可以拿去当访问令牌用
        if (!payload || payload.t !== type) return null;
        if (payload.exp !== undefined && payload.exp * 1000 <= this.now()) return null;
        return payload;
    }

    /**
     * client_id 的短指纹，塞进授权码 / 刷新令牌里做绑定，避免整串 client_id 重复携带
     * @param {string} clientId
     * @returns {Promise<string>}
     */
    async _fingerprint(clientId) {
        const digest = await crypto.subtle.digest('SHA-256', encoder.encode(clientId));
        return toBase64Url(new Uint8Array(digest).slice(0, 16));
    }

    /**
     * 恒定时间比较口令，避免逐字符比较泄露前缀
     * 比较的是两侧的 HMAC 摘要，因此长度也不泄露。
     * @param {string} input
     * @returns {Promise<boolean>}
     */
    async _tokenMatches(input) {
        if (typeof input !== 'string') return false;
        const key = await this._key();
        const [a, b] = await Promise.all([
            crypto.subtle.sign('HMAC', key, encoder.encode(input)),
            crypto.subtle.sign('HMAC', key, encoder.encode(this.env.AUTH_TOKEN))
        ]);
        const left = new Uint8Array(a);
        const right = new Uint8Array(b);
        let diff = 0;
        for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
        return diff === 0;
    }

    // ---------- 动态客户端注册 ----------

    /**
     * 动态客户端注册（RFC 7591）
     *
     * 无处存储客户端，于是把注册信息本身签进 client_id：回调地址白名单在注册时校验
     * 一次，之后每次授权都从 client_id 里读回来再比一次。
     * @param {Request} request
     * @returns {Promise<Response>}
     */
    async _register(request) {
        let body;
        try {
            body = await request.json();
        } catch {
            return this._oauthError('invalid_client_metadata', '注册请求体不是合法的 JSON');
        }

        const redirectUris = body && body.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 8) {
            return this._oauthError('invalid_redirect_uri', 'redirect_uris 必须是 1~8 个回调地址组成的数组');
        }

        for (const uri of redirectUris) {
            if (typeof uri !== 'string' || !isAllowedRedirect(uri)) {
                return this._oauthError(
                    'invalid_redirect_uri',
                    `回调地址不在白名单内：${uri}。只接受 https://claude.ai、https://claude.com 与本机回环地址`
                );
            }
        }

        const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 64) : 'MCP Client';
        const clientId = await this._sign('client', { ru: redirectUris, n: name });

        return new Response(JSON.stringify({
            client_id: clientId,
            client_id_issued_at: Math.floor(this.now() / 1000),
            redirect_uris: redirectUris,
            client_name: name,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: SCOPES_SUPPORTED.join(' ')
        }), {
            status: 201,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                ...CORS_HEADERS
            }
        });
    }

    // ---------- 授权 ----------

    /**
     * 校验授权请求的公共部分
     * @param {URLSearchParams} params
     * @returns {Promise<{client: Object, redirectUri: string}|{error: string}>}
     */
    async _checkAuthorizeParams(params) {
        const clientId = params.get('client_id') || '';
        const client = await this._verify(clientId, 'client');
        if (!client) return { error: 'client_id 无效或已失效，请在 Claude 里删除连接器后重新添加' };

        const redirectUri = params.get('redirect_uri') || '';
        // 回调地址必须是注册时登记过的那一个；白名单再查一遍，防止规则收紧后旧
        // client_id 仍能把授权码送去已被移出白名单的地址。
        if (!client.ru.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
            return { error: 'redirect_uri 与注册时登记的回调地址不一致' };
        }

        return { client, redirectUri };
    }

    /**
     * GET /oauth/authorize：渲染同意页
     * @param {URL} url
     * @returns {Promise<Response>}
     */
    async _authorizeForm(url) {
        const params = url.searchParams;
        const checked = await this._checkAuthorizeParams(params);
        // client_id / redirect_uri 本身不可信时绝不能跳转过去，只能就地报错
        if (checked.error) return this._errorPage(checked.error);

        const { client, redirectUri } = checked;

        if (params.get('response_type') !== 'code') {
            return this._redirectError(url, redirectUri, params.get('state'), 'unsupported_response_type', '只支持 response_type=code');
        }
        if (!isValidCodeChallenge(params.get('code_challenge')) || params.get('code_challenge_method') !== 'S256') {
            return this._redirectError(url, redirectUri, params.get('state'), 'invalid_request', '必须提供 S256 的 PKCE code_challenge');
        }
        if (!this._resourceMatches(params.get('resource'), url)) {
            return this._redirectError(url, redirectUri, params.get('state'), 'invalid_target', `resource 只能是 ${url.origin}${RESOURCE_PATH}`);
        }

        return this._consentPage(params, client, redirectUri, null);
    }

    /**
     * POST /oauth/authorize：校验口令并下发授权码
     * @param {Request} request
     * @param {URL} url
     * @returns {Promise<Response>}
     */
    async _authorizeSubmit(request, url) {
        let form;
        try {
            form = await request.formData();
        } catch {
            return this._errorPage('表单解析失败');
        }

        // 隐藏域一律重新校验，不因为「刚才 GET 时验过」就放行
        const params = new URLSearchParams();
        for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']) {
            const value = form.get(key);
            if (typeof value === 'string') params.set(key, value);
        }
        params.set('response_type', 'code');

        const checked = await this._checkAuthorizeParams(params);
        if (checked.error) return this._errorPage(checked.error);

        const { client, redirectUri } = checked;
        const challenge = params.get('code_challenge');
        if (!isValidCodeChallenge(challenge) || params.get('code_challenge_method') !== 'S256') {
            return this._redirectError(url, redirectUri, params.get('state'), 'invalid_request', '必须提供 S256 的 PKCE code_challenge');
        }
        if (!this._resourceMatches(params.get('resource'), url)) {
            return this._redirectError(url, redirectUri, params.get('state'), 'invalid_target', `resource 只能是 ${url.origin}${RESOURCE_PATH}`);
        }

        if (!await this._tokenMatches(form.get('token'))) {
            return this._consentPage(params, client, redirectUri, 'Token 不正确，请重试');
        }

        const code = await this._sign('code', {
            cid: await this._fingerprint(params.get('client_id')),
            ru: redirectUri,
            cc: challenge,
            aud: `${url.origin}${RESOURCE_PATH}`
        }, CODE_TTL);

        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('iss', url.origin);
        const state = params.get('state');
        if (state) target.searchParams.set('state', state);

        return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store' } });
    }

    /**
     * 把错误按 OAuth 规范回送到 redirect_uri
     * @param {URL} url 当前请求 URL，用于取 issuer
     * @param {string} redirectUri
     * @param {string|null} state
     * @param {string} error
     * @param {string} description
     * @returns {Response}
     */
    _redirectError(url, redirectUri, state, error, description) {
        const target = new URL(redirectUri);
        target.searchParams.set('error', error);
        target.searchParams.set('error_description', description);
        // RFC 9207 要求每一个授权响应都带 iss，错误响应也不例外
        target.searchParams.set('iss', url.origin);
        if (state) target.searchParams.set('state', state);
        return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store' } });
    }

    /**
     * 校验 RFC 8707 的 resource 参数
     *
     * ChatGPT 会带上它并要求写进令牌的 aud。我们的 aud 本来就恒为本站 MCP 地址，
     * 所以这里只需拒绝「要一个别的受众」的请求；不带该参数视为默认要本站。
     * @param {string|null} resource
     * @param {URL} url
     * @returns {boolean}
     */
    _resourceMatches(resource, url) {
        if (!resource) return true;
        return resource.replace(/\/$/, '') === `${url.origin}${RESOURCE_PATH}`;
    }

    /**
     * 同意页
     *
     * 规范要求把回调地址的主机名显眼地展示出来，回环地址还要额外提示 —— 本地任何
     * 进程都能占个端口冒充合法客户端。
     * @param {URLSearchParams} params 授权请求参数，原样回填进隐藏域
     * @param {Object} client 已验签的客户端载荷
     * @param {string} redirectUri
     * @param {string|null} error 上一次提交的错误提示
     * @returns {Response}
     */
    _consentPage(params, client, redirectUri, error) {
        const host = new URL(redirectUri).host;
        const loopback = new URL(redirectUri).protocol === 'http:';
        const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
            .filter((key) => params.get(key))
            .map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(params.get(key))}">`)
            .join('');

        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权 · cf-photos 图床</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
       font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
       background: #f5f6f8; color: #1f2328; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e6e6; } }
.card { width: min(420px, calc(100vw - 32px)); padding: 28px; border-radius: 14px; background: #fff;
        box-shadow: 0 6px 28px rgba(0,0,0,.08); }
@media (prefers-color-scheme: dark) { .card { background: #22252a; box-shadow: none; } }
h1 { margin: 0 0 6px; font-size: 19px; }
p { margin: 0 0 14px; color: #6a737d; font-size: 13px; }
.target { padding: 10px 12px; border-radius: 8px; background: #f0f1f3; font-size: 13px; word-break: break-all; }
@media (prefers-color-scheme: dark) { .target { background: #2c3037; } }
.target b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.warn { margin-top: 10px; color: #b26a00; font-size: 12px; }
label { display: block; margin: 18px 0 6px; font-size: 13px; font-weight: 600; }
input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px;
       border: 1px solid #d0d7de; border-radius: 8px; background: transparent; color: inherit; }
button { width: 100%; margin-top: 16px; padding: 11px; font-size: 15px; font-weight: 600; color: #fff;
       background: #2f6feb; border: 0; border-radius: 8px; cursor: pointer; }
button:hover { background: #2a61cf; }
.error { margin-top: 14px; padding: 9px 12px; border-radius: 8px; background: #ffeaea; color: #b42318; font-size: 13px; }
@media (prefers-color-scheme: dark) { .error { background: #3b1f21; color: #ff9a94; } }
</style>
</head>
<body>
<div class="card">
  <h1>授权访问图床</h1>
  <p><b>${escapeHtml(client.n)}</b> 请求以你的身份上传图片。</p>
  <div class="target">授权后，回调地址 <b>${escapeHtml(host)}</b> 将收到一枚授权码。</div>
  ${loopback ? '<div class="warn">这是本机回环地址：本机上的任何程序都可以占用该端口，只有当你正在本机添加连接器时才继续。</div>' : ''}
  <form method="POST" action="/oauth/authorize">
    ${hidden}
    <label for="token">图床 Token（AUTH_TOKEN）</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <button type="submit">确认授权</button>
  </form>
</div>
</body>
</html>`;

        return new Response(html, {
            // 口令错时回 401，既能让浏览器不缓存，也便于脚本判断
            status: error ? 401 : 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
    }

    /**
     * 不能跳转时就地展示的错误页
     * @param {string} message
     * @returns {Response}
     */
    _errorPage(message) {
        const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">` +
            `<meta name="viewport" content="width=device-width, initial-scale=1"><title>授权失败</title></head>` +
            `<body style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;padding:40px;max-width:520px;margin:0 auto">` +
            `<h1 style="font-size:19px">授权失败</h1><p style="color:#b42318">${escapeHtml(message)}</p></body></html>`;
        return new Response(html, {
            status: 400,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
    }

    // ---------- 令牌 ----------

    /**
     * POST /oauth/token：授权码换令牌 / 刷新令牌
     * @param {Request} request
     * @param {URL} url
     * @returns {Promise<Response>}
     */
    async _token(request, url) {
        // 规范规定是 x-www-form-urlencoded；个别客户端发 JSON，一并收下。
        let form;
        const contentType = request.headers.get('Content-Type') || '';
        try {
            if (contentType.includes('application/json')) {
                const body = await request.json();
                form = new URLSearchParams();
                for (const [key, value] of Object.entries(body || {})) {
                    if (typeof value === 'string') form.set(key, value);
                }
            } else {
                form = new URLSearchParams(await request.text());
            }
        } catch {
            return this._oauthError('invalid_request', '请求体解析失败');
        }

        const clientId = form.get('client_id') || '';
        const client = await this._verify(clientId, 'client');
        if (!client) return this._oauthError('invalid_client', 'client_id 无效或已失效', 401);

        const fingerprint = await this._fingerprint(clientId);
        const grantType = form.get('grant_type');

        if (grantType === 'authorization_code') {
            const code = await this._verify(form.get('code'), 'code');
            if (!code) return this._oauthError('invalid_grant', '授权码无效或已过期');
            if (code.cid !== fingerprint) return this._oauthError('invalid_grant', '授权码不属于该 client_id');

            const redirectUri = form.get('redirect_uri');
            if (redirectUri && redirectUri !== code.ru) {
                return this._oauthError('invalid_grant', 'redirect_uri 与申请授权码时不一致');
            }

            const verifier = form.get('code_verifier') || '';
            if (!await this._pkceMatches(verifier, code.cc)) {
                return this._oauthError('invalid_grant', 'PKCE 校验失败');
            }

            return await this._issue(fingerprint, code.aud);
        }

        if (grantType === 'refresh_token') {
            const refresh = await this._verify(form.get('refresh_token'), 'rt');
            // 刷新令牌失效必须回 invalid_grant：Claude 只认这个错误码去重走授权流程
            if (!refresh) return this._oauthError('invalid_grant', '刷新令牌无效或已过期');
            if (refresh.cid !== fingerprint) return this._oauthError('invalid_grant', '刷新令牌不属于该 client_id');

            return await this._issue(fingerprint, refresh.aud);
        }

        return this._oauthError('unsupported_grant_type', '只支持 authorization_code 与 refresh_token');
    }

    /**
     * 校验 PKCE：base64url(SHA-256(code_verifier)) 是否等于 code_challenge
     * @param {string} verifier
     * @param {string} challenge
     * @returns {Promise<boolean>}
     */
    async _pkceMatches(verifier, challenge) {
        if (!verifier || !challenge) return false;
        const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
        return toBase64Url(new Uint8Array(digest)) === challenge;
    }

    /**
     * 签发一对令牌
     * @param {string} fingerprint client_id 指纹
     * @param {string} audience 受众，即 MCP 端点 URL
     * @returns {Promise<Response>}
     */
    async _issue(fingerprint, audience) {
        const [accessToken, refreshToken] = await Promise.all([
            this._sign('at', { cid: fingerprint, aud: audience }, ACCESS_TTL),
            this._sign('rt', { cid: fingerprint, aud: audience }, REFRESH_TTL)
        ]);

        return new Response(JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: ACCESS_TTL,
            refresh_token: refreshToken,
            scope: SCOPE
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                ...CORS_HEADERS
            }
        });
    }
}
