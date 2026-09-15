/**
 * 统一 Chrome 与 Firefox 的扩展 API 全局对象。
 * Firefox 推荐使用 browser，Chrome 使用 chrome；两者的方法在本扩展使用的范围内都返回 Promise。
 */
if (!globalThis.chrome && globalThis.browser) {
    globalThis.chrome = globalThis.browser;
}
