/**
 * 设置页：图床地址、Token、复制格式与开关
 */

import { DEFAULT_SETTINGS, LINK_FORMATS, normalizeEndpoint } from './lib/shared.js';

const $ = id => document.getElementById(id);
const statusEl = $('status');

for (const [value, label] of Object.entries(LINK_FORMATS)) {
    $('format').add(new Option(label, value));
}

const settings = { ...DEFAULT_SETTINGS, ...await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)) };
$('endpoint').value = settings.endpoint;
$('token').value = settings.token;
$('format').value = settings.format;
$('autoCopy').checked = settings.autoCopy;
$('notify').checked = settings.notify;

$('toggle-token').addEventListener('click', () => {
    const hidden = $('token').type === 'password';
    $('token').type = hidden ? 'text' : 'password';
    $('toggle-token').textContent = hidden ? '隐藏' : '显示';
});

$('form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = readForm();
    if (!values) return;
    await chrome.storage.local.set(values);
    $('endpoint').value = values.endpoint;
    showStatus('已保存', 'ok');
});

$('test').addEventListener('click', async () => {
    const values = readForm();
    if (!values) return;
    showStatus('正在连接…', '');

    try {
        // /admin/dirs 需要鉴权且不写任何东西，适合拿来验 Token
        const res = await fetch(`${values.endpoint}/admin/dirs`, {
            headers: values.token ? { Authorization: `Bearer ${values.token}` } : {},
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(10000)
        });
        if (res.status === 401) return showStatus('连上了，但 Token 不对', 'error');
        if (!res.ok) return showStatus(`连上了，但返回 HTTP ${res.status}`, 'error');
        const data = await res.json().catch(() => null);
        if (data?.result !== 'success') return showStatus('响应不像 CF-Photos，请检查地址', 'error');
        showStatus('连接正常，Token 有效', 'ok');
    } catch (error) {
        showStatus(`连接失败：${error.message}`, 'error');
    }
});

/**
 * 读取并校验表单，非法时提示并返回 null
 * @returns {typeof DEFAULT_SETTINGS | null}
 */
function readForm() {
    const endpoint = normalizeEndpoint($('endpoint').value);
    if (!endpoint) {
        showStatus('图床地址无效，需要 http(s) 开头', 'error');
        return null;
    }
    return {
        endpoint,
        token: $('token').value.trim(),
        format: $('format').value,
        autoCopy: $('autoCopy').checked,
        notify: $('notify').checked
    };
}

/**
 * 在按钮旁显示状态
 * @param {string} text
 * @param {'ok'|'error'|''} kind
 */
function showStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
}
