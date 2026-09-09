import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { OAuthService } from '../src/services/OAuthService.js';

const env = {
    WEBDAV_URL: 'https://example.com/dav',
    WEBDAV_USERNAME: 'user',
    WEBDAV_PASSWORD: 'secret',
    AUTH_TOKEN: 'secret-token',
    TIMEZONE_OFFSET: '8'
};

const ORIGIN = 'https://photos.example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/**
 * 发一次请求给 Worker
 * @param {string} path 路径（含查询串）
 * @param {Object} [init] fetch init
 * @param {Object} [overrides] 覆盖环境变量
 */
const call = (path, init = {}, overrides = {}) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, init), { ...env, ...overrides }, {});

/**
 * 提交表单（application/x-www-form-urlencoded）
 * @param {string} path
 * @param {Object} fields
 */
const postForm = (path, fields, overrides = {}) => call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
}, overrides);

/**
 * 生成一对 PKCE 参数
 * @returns {Promise<{verifier: string, challenge: string}>}
 */
async function pkce() {
    const verifier = 'v'.repeat(43) + Math.random().toString(36).slice(2);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { verifier, challenge };
}

/**
 * 注册一个客户端，返回 client_id
 * @param {string[]} [redirectUris]
 */
async function register(redirectUris = [CALLBACK]) {
    const response = await call('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Claude' })
    });
    assert.equal(response.status, 201);
    return (await response.json()).client_id;
}

/**
 * 跑完整的授权码流程，返回 /oauth/token 的响应体
 * @param {Object} [options]
 */
async function authorize({ token = 'secret-token', clientId = null, verifierOverride = null } = {}) {
    const id = clientId || await register();
    const { verifier, challenge } = await pkce();

    const consent = await postForm('/oauth/authorize', {
        client_id: id,
        redirect_uri: CALLBACK,
        state: 'xyz',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token
    });
    assert.equal(consent.status, 302, '同意页提交后应 302 回调');

    const location = new URL(consent.headers.get('Location'));
    assert.equal(location.searchParams.get('state'), 'xyz');
    assert.equal(location.searchParams.get('iss'), ORIGIN, 'RFC 9207：成功响应必须带 iss');
    const code = location.searchParams.get('code');

    const tokenResponse = await postForm('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: id,
        code_verifier: verifierOverride || verifier
    });
    return { clientId: id, code, tokenResponse };
}

/**
 * 用给定的凭据调一次 MCP tools/list
 * @param {string} bearer
 */
const toolsList = (bearer, overrides = {}) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    return call('/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(new TextEncoder().encode(body).length),
            Authorization: `Bearer ${bearer}`
        },
        body
    }, overrides);
};

test('受保护资源元数据的 resource 与 MCP 端点逐字一致', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const response = await call(path);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.resource, `${ORIGIN}/mcp`);
        assert.deepEqual(body.authorization_servers, [ORIGIN]);
        assert.ok(body.scopes_supported.includes('offline_access'), '需声明 offline_access 才会拿到刷新令牌');
    }
});

test('授权服务器元数据声明 S256 与 DCR，且不声明 CIMD', async () => {
    const response = await call('/.well-known/oauth-authorization-server');
    const body = await response.json();
    assert.equal(body.issuer, ORIGIN);
    // 声明了才有 ChatGPT 的稳定回调地址，声明了就必须每次真的带 iss
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    assert.equal(body.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ['none']);
    // 声明了 CIMD 才会走 CIMD，这里有意只走 DCR
    assert.equal(body.client_id_metadata_document_supported, undefined);
});

test('未配置 AUTH_TOKEN 时 OAuth 端点 fail-closed', async () => {
    const response = await call('/.well-known/oauth-authorization-server', {}, { AUTH_TOKEN: '' });
    assert.equal(response.status, 503);
});

test('OPTIONS 预检返回 204 与 CORS 头', async () => {
    const response = await call('/oauth/token', { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('GET /oauth/token 返回 405', async () => {
    const response = await call('/oauth/token');
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
});

test('未授权的 /mcp 401 带 resource_metadata 指针', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const response = await call('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        body
    });
    assert.equal(response.status, 401);
    const challenge = response.headers.get('WWW-Authenticate');
    assert.match(challenge, /^Bearer /);
    assert.ok(
        challenge.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`),
        `WWW-Authenticate 缺少 resource_metadata：${challenge}`
    );
});

test('注册接受 ChatGPT 的两种回调形态', async () => {
    for (const uri of [
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com/connector/oauth/abc123'
    ]) {
        assert.ok(await register([uri]), `应接受 ${uri}`);
    }
});

test('注册拒绝白名单外的回调地址', async () => {
    for (const uris of [['https://evil.example.com/cb'], ['http://claude.ai/cb'], ['https://chatgpt.com.evil.net/cb'], [], ['not a url']]) {
        const response = await call('/oauth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ redirect_uris: uris })
        });
        assert.equal(response.status, 400, `不该接受 ${JSON.stringify(uris)}`);
        assert.equal((await response.json()).error, 'invalid_redirect_uri');
    }
});

test('注册接受 Claude 回调与本机回环地址，且对同样的元数据幂等', async () => {
    const uris = [CALLBACK, 'http://127.0.0.1:3118/callback', 'http://localhost:6274/oauth/callback'];
    const clientId = await register(uris);
    assert.match(clientId, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // 无状态注册：client_id 就是注册元数据的签名，重复注册不会积累新客户端
    assert.equal(await register(uris), clientId);
});

test('授权页在 client_id 或 redirect_uri 不可信时就地报错，绝不跳转', async () => {
    const bad = await call('/oauth/authorize?response_type=code&client_id=forged.sig&redirect_uri=' + encodeURIComponent(CALLBACK));
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('Location'), null);

    const clientId = await register();
    const mismatched = await call(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('https://claude.ai/other')}`
    );
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.headers.get('Location'), null);
});

test('缺少 PKCE 时按规范把错误跳回 redirect_uri', async () => {
    const clientId = await register();
    const response = await call(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CALLBACK)}&state=s1`
    );
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('Location'));
    assert.equal(location.origin + location.pathname, CALLBACK);
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    assert.equal(location.searchParams.get('state'), 's1');
    assert.equal(location.searchParams.get('iss'), ORIGIN, '错误响应同样要带 iss');
});

test('resource 指向别的受众时拒绝授权', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const response = await call(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=${challenge}&code_challenge_method=S256` +
        `&resource=${encodeURIComponent('https://elsewhere.example.com/mcp')}`
    );
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('Location')).searchParams.get('error'), 'invalid_target');
});

test('resource 指向本站 MCP 时放行（含尾斜杠）', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    for (const resource of [`${ORIGIN}/mcp`, `${ORIGIN}/mcp/`]) {
        const response = await call(
            `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
            `&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=${challenge}&code_challenge_method=S256` +
            `&resource=${encodeURIComponent(resource)}`
        );
        assert.equal(response.status, 200, `应接受 ${resource}`);
    }
});

test('畸形的 code_challenge 同样被拒', async () => {
    const clientId = await register();
    const response = await call(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=short&code_challenge_method=S256`
    );
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('Location')).searchParams.get('error'), 'invalid_request');
});

test('同意页正常渲染并回填隐藏域', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const response = await call(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('name="token"'), '同意页应有口令输入框');
    assert.ok(html.includes(`value="${challenge}"`), '应回填 code_challenge');
    assert.ok(html.includes('claude.ai'), '应展示回调地址主机名');
});

test('口令错误时留在同意页且不下发授权码', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const response = await postForm('/oauth/authorize', {
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token: 'wrong-token'
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Location'), null);
    assert.ok((await response.text()).includes('Token 不正确'));
});

test('完整授权码流程换到的访问令牌可以调用 MCP', async () => {
    const { tokenResponse } = await authorize();
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokenResponse.headers.get('Cache-Control'), 'no-store');

    const grant = await tokenResponse.json();
    assert.equal(grant.token_type, 'Bearer');
    assert.ok(grant.access_token && grant.refresh_token);
    assert.equal(grant.expires_in, 30 * 24 * 3600);

    const response = await toolsList(grant.access_token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.tools.map((tool) => tool.name), ['upload_image']);
});

test('静态 AUTH_TOKEN 仍然可用（Claude Code 直连不受影响）', async () => {
    const response = await toolsList('secret-token');
    assert.equal(response.status, 200);
});

test('PKCE verifier 不匹配时拒绝换取令牌', async () => {
    const { tokenResponse } = await authorize({ verifierOverride: 'wrong-verifier' });
    assert.equal(tokenResponse.status, 400);
    assert.equal((await tokenResponse.json()).error, 'invalid_grant');
});

test('授权码不能被别的 client_id 兑换', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const consent = await postForm('/oauth/authorize', {
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token: 'secret-token'
    });
    const code = new URL(consent.headers.get('Location')).searchParams.get('code');

    // client_id 是注册元数据的确定性签名，同样的元数据会得到同一个 id，
    // 所以这里必须换一组回调地址才算「另一个客户端」
    const other = await register(['http://127.0.0.1:3118/callback']);
    assert.notEqual(other, clientId);
    const response = await postForm('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: other,
        code_verifier: verifier
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
});

test('授权码不能当访问令牌直接打 MCP（类型混淆）', async () => {
    const { code } = await authorize();
    const response = await toolsList(code);
    assert.equal(response.status, 401);
});

test('过期的授权码被拒', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    // 直接用服务实例签一枚一小时前的码：路由里没法注入时钟
    const past = new OAuthService(env, { now: () => Date.now() - 3600 * 1000 });
    const fingerprint = await past._fingerprint(clientId);
    const code = await past._sign('code', {
        cid: fingerprint, ru: CALLBACK, cc: challenge, aud: `${ORIGIN}/mcp`
    }, 600);

    const response = await postForm('/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
});

test('伪造签名的令牌一律不认', async () => {
    const { tokenResponse } = await authorize();
    const grant = await tokenResponse.json();
    const [payload] = grant.access_token.split('.');

    for (const forged of [`${payload}.AAAA`, payload, 'x.y', '']) {
        assert.equal((await toolsList(forged)).status, 401, `不该接受 ${forged}`);
    }
});

test('刷新令牌可换新令牌，换 AUTH_TOKEN 后全部失效', async () => {
    const { clientId, tokenResponse } = await authorize();
    const grant = await tokenResponse.json();

    const refreshed = await postForm('/oauth/token', {
        grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: clientId
    });
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.ok(next.access_token && next.refresh_token);
    assert.equal((await toolsList(next.access_token)).status, 200);

    // 密钥来自 AUTH_TOKEN：换了口令等于吊销此前签发的一切
    assert.equal((await toolsList(next.access_token, { AUTH_TOKEN: 'rotated' })).status, 401);
    const dead = await postForm('/oauth/token', {
        grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId
    }, { AUTH_TOKEN: 'rotated' });
    assert.equal(dead.status, 401);
});

test('访问令牌绑定受众，换个 origin 不认', async () => {
    const { tokenResponse } = await authorize();
    const grant = await tokenResponse.json();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const response = await worker.fetch(new Request('https://other.example.com/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
            Authorization: `Bearer ${grant.access_token}`
        },
        body
    }), env, {});
    assert.equal(response.status, 401);
});

test('不支持的 grant_type 返回 unsupported_grant_type', async () => {
    const clientId = await register();
    const response = await postForm('/oauth/token', { grant_type: 'client_credentials', client_id: clientId });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'unsupported_grant_type');
});
