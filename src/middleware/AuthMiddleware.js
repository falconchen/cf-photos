/**
 * 授权中间件
 * 负责校验请求头中的 Token
 */
export class AuthMiddleware {
    /**
     * 校验 Token
     * @param {Request} request 
     * @param {Object} env 
     * @returns {boolean} 是否校验通过
     */
    static verify(request, env) {
        // 如果没有配置 AUTH_TOKEN，则默认不进行校验
        if (!env.AUTH_TOKEN) return true;

        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            return this.verifyToken(token, env);
        }

        return false;
    }

    /**
     * 请求是否带了 Authorization 头
     * 用于区分「没带头、需要回落到请求体里的 token」与「带了头但不对、可以立即拒绝」，
     * 后者不必为一个注定失败的请求把整个请求体读进内存。
     * @param {Request} request
     * @returns {boolean}
     */
    static hasHeader(request) {
        return request.headers.has('Authorization');
    }

    /**
     * 直接校验 Token 字符串
     * @param {string} token 
     * @param {Object} env 
     * @returns {boolean}
     */
    static verifyToken(token, env) {
        if (!env.AUTH_TOKEN) return true;
        return token === env.AUTH_TOKEN;
    }

    /**
     * 返回未授权响应
     * @returns {Response}
     */
    static unauthorizedResponse() {
        return new Response('Unauthorized: 鉴权失败，请提供正确的 Token', {
            status: 401,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                // RFC 6750 要求 401 声明所用的鉴权方案；MCP 客户端也依赖它判断该带什么凭据。
                // 浏览器只对 Basic / Digest 弹原生凭据框，Bearer 不弹，后台页面无 UX 影响。
                'WWW-Authenticate': 'Bearer realm="cf-photos"'
            }
        });
    }
}
