/**
 * offscreen 文档：唯一职责是替 service worker 写剪贴板。
 * offscreen 页面拿不到焦点，navigator.clipboard 会被拒，只能用 execCommand。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'offscreen-copy') return false;

    const buffer = document.getElementById('buffer');
    buffer.value = message.text;
    buffer.select();
    const ok = document.execCommand('copy');
    buffer.value = '';
    sendResponse({ ok });
    return false;
});
