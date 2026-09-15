/**
 * 后台 service worker：负责取图、上传、复制、通知与历史记录。
 * 取图放在这里而不是页面里，是因为扩展持有 host 权限，跨域 fetch 不受 CORS 限制。
 */

import {
    DEFAULT_SETTINGS,
    deriveFilename,
    formatLink,
    mimeFromFilename,
    normalizeEndpoint,
    parseUploadResponse,
    sniffImageMime
} from './lib/shared.js';

const MENU_IMAGE = 'cf-photos-upload-image';
const MENU_LINK = 'cf-photos-upload-link';
const HISTORY_LIMIT = 50;
const BATCH_CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 30000;

// 每次 worker 启动都重建菜单并清理残留规则，而不只在 onInstalled 里做：
// 部分加载方式（如通过 DevTools 协议加载）不会触发 onInstalled，菜单就会缺失
setupMenus();
// 取图前要等它完成，否则可能把刚加上的规则当残留删掉
const staleRulesCleared = clearStaleRules().catch(() => {});

chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') chrome.runtime.openOptionsPage();
});

/**
 * 创建右键菜单：图片上直接上传，指向图片文件的链接上传链接目标
 */
function setupMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: MENU_IMAGE,
            title: '上传到图床',
            contexts: ['image']
        });
        chrome.contextMenus.create({
            id: MENU_LINK,
            title: '上传链接指向的图片',
            contexts: ['link'],
            targetUrlPatterns: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']
                .flatMap(ext => [`*://*/*.${ext}`, `*://*/*.${ext}?*`])
        });
    });
}

/**
 * 删掉上次 worker 被杀时没来得及移除的 Referer 会话规则
 */
async function clearStaleRules() {
    const stale = await chrome.declarativeNetRequest.getSessionRules();
    if (stale.length) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale.map(r => r.id) });
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    const srcUrl = info.menuItemId === MENU_LINK ? info.linkUrl : info.srcUrl;
    if (!srcUrl) return;

    uploadOne({
        srcUrl,
        pageUrl: info.frameUrl || info.pageUrl || tab?.url || '',
        tabId: tab?.id,
        frameId: info.frameId ?? 0,
        alt: ''
    }).catch(() => {
        // 错误已在 uploadOne 内部通知，这里只防止未处理的 rejection
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'upload-batch') {
        runBatch(message.items || []);
        sendResponse({ ok: true });
    }
    return false;
});

/**
 * 读取设置并补全默认值
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
async function getSettings() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * 右键单张上传：页面内先显示进度，成功后按设置复制并更新为成功，失败时显示原因
 * @param {{srcUrl: string, pageUrl: string, tabId?: number, frameId?: number, alt?: string}} item
 * @returns {Promise<string>} 格式化后的链接
 */
async function uploadOne(item) {
    const settings = await getSettings();
    const toast = { id: `one-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, thumb: item.srcUrl };
    if (settings.notify) {
        showToast(item.tabId, { ...toast, kind: 'progress', title: '正在上传…', message: describeSource(item.srcUrl) });
    }

    try {
        const url = await uploadImage(item, settings);
        const link = formatLink(url, settings.format, item.alt);
        let copied = false;
        if (settings.autoCopy) copied = await copyText(link).then(() => true, () => false);
        if (settings.notify) {
            showToast(item.tabId, {
                ...toast,
                kind: 'success',
                title: copied ? '上传成功，链接已复制' : '上传成功',
                message: url,
                mono: true,
                url,
                copyText: link,
                duration: 6000
            });
        }
        return link;
    } catch (error) {
        // 失败不受通知开关控制，否则用户根本不知道没传上去
        showToast(item.tabId, { ...toast, kind: 'error', title: '上传失败', message: error.message, duration: 10000 });
        throw error;
    }
}

/**
 * 弹窗发起的批量上传。进度写入 storage.session，弹窗关掉再打开也能看到。
 * @param {Array<{id: string, srcUrl: string, pageUrl: string, tabId?: number, frameId?: number, alt?: string}>} items
 */
async function runBatch(items) {
    const settings = await getSettings();
    const jobs = Object.fromEntries(items.map(item => [item.id, { status: 'pending', srcUrl: item.srcUrl }]));
    await chrome.storage.session.set({ batch: { running: true, jobs } });

    const tabId = items[0]?.tabId;
    const toast = { id: `batch-${Date.now()}`, thumb: items[0]?.srcUrl };
    let finished = 0;
    const reportProgress = () => {
        if (!settings.notify) return;
        showToast(tabId, {
            ...toast,
            kind: 'progress',
            title: items.length === 1 ? '正在上传…' : `正在上传 ${finished}/${items.length} 张`,
            message: items.length === 1 ? describeSource(items[0].srcUrl) : '',
            progress: items.length === 1 ? undefined : finished / items.length
        });
    };
    reportProgress();

    // 进度写入串行化，避免并发的 get/set 互相覆盖
    let writing = Promise.resolve();
    const update = (id, patch) => {
        Object.assign(jobs[id], patch);
        writing = writing.then(() => chrome.storage.session.set({ batch: { running: true, jobs } }));
        return writing;
    };

    const queue = [...items];
    const results = new Map();
    const worker = async () => {
        while (queue.length) {
            const item = queue.shift();
            await update(item.id, { status: 'uploading' });
            try {
                const url = await uploadImage(item, settings);
                results.set(item.id, formatLink(url, settings.format, item.alt));
                await update(item.id, { status: 'done', url });
            } catch (error) {
                await update(item.id, { status: 'error', error: error.message });
            }
            finished++;
            reportProgress();
        }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker));
    await writing;

    // 按用户勾选顺序拼接，而不是完成顺序
    const links = items.map(item => results.get(item.id)).filter(Boolean);
    const failed = items.length - links.length;
    let copied = false;
    if (links.length && settings.autoCopy) {
        copied = await copyText(links.join('\n')).then(() => true, () => false);
    }
    await chrome.storage.session.set({ batch: { running: false, jobs, copied } });

    const firstError = items.map(item => jobs[item.id].error).find(Boolean);
    if (settings.notify || failed) {
        const title = links.length === 0 ? `上传失败 ${failed} 张`
            : failed ? `成功 ${links.length} 张，失败 ${failed} 张`
                : `成功上传 ${links.length} 张`;
        const singleUrl = links.length === 1 ? items.map(item => jobs[item.id].url).find(Boolean) : undefined;
        const lines = [];
        if (copied) lines.push(`${links.length} 条链接已复制`);
        else if (singleUrl) lines.push(singleUrl);
        if (firstError) lines.push(firstError);
        showToast(tabId, {
            ...toast,
            kind: links.length ? 'success' : 'error',
            title,
            message: lines.join('；'),
            mono: Boolean(singleUrl && !copied && !firstError),
            url: singleUrl,
            copyText: links.join('\n'),
            duration: failed ? 10000 : 8000
        });
    }
}

/**
 * 取图并上传，返回图床 URL。不做复制与通知。
 * @param {{srcUrl: string, pageUrl: string, tabId?: number, frameId?: number, alt?: string}} item
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Promise<string>}
 */
async function uploadImage(item, settings) {
    const endpoint = normalizeEndpoint(settings.endpoint);
    if (!endpoint) {
        chrome.runtime.openOptionsPage();
        throw new Error('还没有配置图床地址，请先在设置页填写');
    }

    const blob = await fetchImageBlob(item);
    if (!blob.size) throw new Error('取到的图片是空文件');

    const mime = await resolveMime(blob, item.srcUrl);
    if (!mime) throw new Error(`这不是图片（服务器返回 ${blob.type || '未知类型'}）`);

    const filename = deriveFilename(item.srcUrl, mime);
    const headers = {
        'Content-Type': mime,
        // 头部只能放 ASCII；服务端仅取其后缀
        'X-Upload-Filename': encodeURIComponent(filename)
    };
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;

    let res;
    try {
        res = await fetch(`${endpoint}/upload`, {
            method: 'POST',
            headers,
            body: blob,
            credentials: 'omit',
            redirect: 'error'
        });
    } catch (error) {
        throw new Error(`连不上图床：${error.message}`);
    }

    const url = parseUploadResponse(res.status, await res.text());
    await addHistory({ url, srcUrl: item.srcUrl, pageUrl: item.pageUrl, time: Date.now() });
    return url;
}

/**
 * 按地址类型取回图片字节。
 * http(s)：先在后台带页面 Referer 取（绕过防盗链），失败再退回页面上下文取；
 * blob:：只在创建它的页面里有效，必须进页面取；data:：后台直接解。
 * @param {{srcUrl: string, pageUrl: string, tabId?: number, frameId?: number}} item
 * @returns {Promise<Blob>}
 */
async function fetchImageBlob(item) {
    const { srcUrl, pageUrl, tabId, frameId } = item;
    const protocol = safeProtocol(srcUrl);

    if (protocol === 'data:') {
        return (await fetch(srcUrl)).blob();
    }

    if (protocol === 'blob:') {
        if (tabId === undefined) throw new Error('blob: 图片只能在原页面里读取');
        return fetchInPage(tabId, frameId, srcUrl);
    }

    if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error(`不支持的图片地址：${srcUrl.slice(0, 60)}`);
    }

    try {
        return await fetchWithReferer(srcUrl, pageUrl);
    } catch (backgroundError) {
        if (tabId === undefined) throw backgroundError;
        try {
            return await fetchInPage(tabId, frameId, srcUrl);
        } catch {
            throw backgroundError;
        }
    }
}

/**
 * 在后台 fetch 图片，并用一条临时会话规则把 Referer 设成来源页面，
 * 应对按 Referer 防盗链的站点（微博、知乎、各类 CDN）。
 * @param {string} srcUrl
 * @param {string} pageUrl
 * @returns {Promise<Blob>}
 */
async function fetchWithReferer(srcUrl, pageUrl) {
    const host = new URL(srcUrl).hostname;
    const referer = /^https?:/i.test(pageUrl) ? pageUrl : '';
    const ruleId = referer ? nextRuleId() : 0;

    if (ruleId) {
        await staleRulesCleared;
        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [{
                id: ruleId,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }]
                },
                condition: {
                    requestDomains: [host],
                    // -1 即 TAB_ID_NONE：只作用于扩展自己发出的请求，不碰用户正常浏览
                    tabIds: [-1],
                    resourceTypes: ['xmlhttprequest']
                }
            }]
        });
    }

    try {
        const res = await fetch(srcUrl, {
            credentials: 'include',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!res.ok) throw new Error(`取图失败：源站返回 HTTP ${res.status}`);
        return await res.blob();
    } catch (error) {
        if (error.name === 'TimeoutError') throw new Error('取图超时');
        throw error;
    } finally {
        if (ruleId) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
        }
    }
}

let ruleSeq = Math.floor(Math.random() * 1e6);

/**
 * 生成会话规则 id，并发上传时各自独立
 * @returns {number}
 */
function nextRuleId() {
    ruleSeq = (ruleSeq % 2_000_000_000) + 1;
    return ruleSeq;
}

/**
 * 在图片所在的页面（frame）里 fetch，转成 data URL 带回后台。
 * 用于 blob: 地址，以及后台取图失败但页面自己能取到的情况。
 * @param {number} tabId
 * @param {number} frameId
 * @param {string} srcUrl
 * @returns {Promise<Blob>}
 */
async function fetchInPage(tabId, frameId, srcUrl) {
    const [injection] = await withTimeout(chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId || 0] },
        // 页面仍在 loading 时默认会等到 document_idle 才注入，可能一直挂起
        injectImmediately: true,
        args: [srcUrl],
        func: async (url) => {
            try {
                const res = await fetch(url);
                if (!res.ok) return { error: `HTTP ${res.status}` };
                const blob = await res.blob();
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(blob);
                });
                return { dataUrl };
            } catch (error) {
                return { error: error.message };
            }
        }
    }), FETCH_TIMEOUT_MS);

    const result = injection?.result;
    if (!result?.dataUrl) throw new Error(`页面内取图失败：${result?.error || '无结果'}`);
    return (await fetch(result.dataUrl)).blob();
}

/**
 * 确定图片的真实 MIME：优先嗅探文件头，其次信任响应类型，最后按后缀猜。
 * 非图片返回空串。
 * @param {Blob} blob
 * @param {string} srcUrl
 * @returns {Promise<string>}
 */
async function resolveMime(blob, srcUrl) {
    const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
    const sniffed = sniffImageMime(head);
    if (sniffed) return sniffed;

    const declared = (blob.type || '').split(';')[0].trim().toLowerCase();
    if (declared.startsWith('image/')) return declared;

    // 类型不明时才看后缀；明确声明为 text/html 之类的一律不收
    if (!declared || declared === 'application/octet-stream') {
        return mimeFromFilename(safePathname(srcUrl));
    }
    return '';
}

/**
 * 通过 offscreen 文档写剪贴板。service worker 没有 DOM，拿不到 clipboard API。
 * @param {string} text
 */
async function copyText(text) {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing.length) {
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['CLIPBOARD'],
                justification: '把上传后的图片链接写入剪贴板'
            });
        } catch (error) {
            // 并发创建时第二次会报「只允许一个 offscreen 文档」，可以忽略
            if (!/single offscreen/i.test(error.message)) throw error;
        }
    }
    const response = await chrome.runtime.sendMessage({ type: 'offscreen-copy', text });
    if (!response?.ok) throw new Error('写入剪贴板失败');
}

/**
 * 追加一条上传历史，保留最近 HISTORY_LIMIT 条
 * @param {{url: string, srcUrl: string, pageUrl: string, time: number}} entry
 */
let historyWriting = Promise.resolve();
function addHistory(entry) {
    historyWriting = historyWriting.then(async () => {
        const { history = [] } = await chrome.storage.local.get('history');
        history.unshift(entry);
        await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
    });
    return historyWriting;
}

let toastSeq = 0;

/**
 * 在页面右上角显示通知（见 content/toast.js）。只注入顶层 frame，iframe 里的会被裁切。
 * 浏览器内置页、扩展商店等不允许注入的页面，退回到工具栏图标角标。
 *
 * 各次注入互不等待，每条带递增的 seq，由页面侧丢弃比已显示状态更旧的更新。
 * 不能靠后台排队保序：注入超时并不会取消注入，迟到的「进度」照样可能落在「成功」之后。
 * @param {number|undefined} tabId
 * @param {Object} options 传给 __cfPhotosToast.show 的参数
 */
function showToast(tabId, options) {
    injectToast(tabId, { ...options, seq: ++toastSeq });
}

/**
 * 在顶层 frame 调用 __cfPhotosToast.show；页面里还没有就先注入 toast.js 再调一次。
 * 不允许注入的页面退回到角标。
 * @param {number|undefined} tabId
 * @param {Object} options
 */
async function injectToast(tabId, options) {
    const call = target => withTimeout(chrome.scripting.executeScript({
        target,
        // 不等 document_idle：GitHub 这类页面长时间处于 loading，默认时机会让注入一直挂起
        injectImmediately: true,
        args: [options],
        func: payload => {
            if (!window.__cfPhotosToast) return false;
            window.__cfPhotosToast.show(payload);
            return true;
        }
    })).then(([injection]) => injection?.result === true);

    try {
        if (tabId === undefined) throw new Error('没有可用的标签页');
        const target = { tabId, frameIds: [0] };
        if (await call(target)) return;
        await withTimeout(chrome.scripting.executeScript({ target, files: ['content/toast.js'], injectImmediately: true }));
        if (!await call(target)) throw new Error('通知脚本未就绪');
    } catch (error) {
        console.warn(`页面内通知失败（${options.kind}），改用图标角标：${error.message}`);
        if (options.kind !== 'progress') flashBadge(tabId, options.kind === 'error');
    }
}

/**
 * 给注入加超时，避免页面卡住时通知队列永远等下去
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms = 10000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('注入超时')), ms))
    ]);
}

/**
 * 工具栏图标上闪一下 ✓ / ! 角标，几秒后清掉
 * @param {number|undefined} tabId
 * @param {boolean} isError
 */
async function flashBadge(tabId, isError) {
    const scope = tabId === undefined ? {} : { tabId };
    try {
        await chrome.action.setBadgeBackgroundColor({ ...scope, color: isError ? '#ef4444' : '#10b981' });
        await chrome.action.setBadgeText({ ...scope, text: isError ? '!' : '✓' });
        setTimeout(() => chrome.action.setBadgeText({ ...scope, text: '' }).catch(() => {}), 4000);
    } catch {
        // 标签页已关闭，忽略
    }
}

/**
 * 通知里展示的来源说明：http(s) 显示主机与文件名，内嵌图片给个类型说明
 * @param {string} srcUrl
 * @returns {string}
 */
function describeSource(srcUrl) {
    if (srcUrl.startsWith('data:')) return '页面内嵌图片';
    if (srcUrl.startsWith('blob:')) return '页面生成的图片';
    try {
        const url = new URL(srcUrl);
        const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
        return name ? `${url.hostname} · ${name}` : url.hostname;
    } catch {
        return '';
    }
}

/**
 * 取 URL 协议，解析失败返回空串
 * @param {string} value
 * @returns {string}
 */
function safeProtocol(value) {
    try {
        return new URL(value).protocol;
    } catch {
        return '';
    }
}

/**
 * 取 URL 路径，解析失败返回空串
 * @param {string} value
 * @returns {string}
 */
function safePathname(value) {
    try {
        return new URL(value).pathname;
    } catch {
        return '';
    }
}
