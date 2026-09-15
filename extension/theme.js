/**
 * 在首帧前给扩展页面套上主题（深色 / 浅色）。
 *
 * 以普通脚本放在 <head> 里同步执行：chrome.storage 只有异步接口，等它回来再设就会先闪一下深色。
 * 所以先读 localStorage 里的缓存（扩展各页面同源，共用一份），再用 chrome.storage 里的真值校正并回写缓存。
 * MV3 的扩展页 CSP 不允许内联脚本，只能是单独文件；也不能 import shared.js，合法值判断在这里重复一次。
 */
(() => {
    const CACHE_KEY = 'pf_theme';
    const root = document.documentElement;

    /**
     * 套用主题，非 light 一律按默认深色处理
     * @param {unknown} theme
     * @returns {'dark'|'light'}
     */
    const apply = theme => {
        const value = theme === 'light' ? 'light' : 'dark';
        root.dataset.theme = value;
        return value;
    };

    /**
     * 回写缓存，localStorage 不可用时忽略
     * @param {string} value
     */
    const remember = value => {
        try {
            localStorage.setItem(CACHE_KEY, value);
        } catch {
            // 缓存只为避免闪烁，写不进去不影响功能
        }
    };

    try {
        apply(localStorage.getItem(CACHE_KEY));
    } catch {
        apply('');
    }

    chrome.storage.local.get('theme').then(({ theme }) => remember(apply(theme)));
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.theme) remember(apply(changes.theme.newValue));
    });
})();
