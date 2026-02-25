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
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}
