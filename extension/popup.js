/**
 * 弹窗：扫描当前页面的图片供勾选批量上传，另附最近上传记录
 */

import { DEFAULT_SETTINGS, formatLink, normalizeEndpoint } from './lib/shared.js';

const MIN_SIZE = 100;
const $ = id => document.getElementById(id);

const state = {
    tab: null,
    images: [],          // { id, srcUrl, pageUrl, frameId, alt, width, height }
    selected: new Set(),
    settings: { ...DEFAULT_SETTINGS }
};

init();

/**
 * 弹窗初始化：读设置、扫描页面、订阅批量进度
 */
async function init() {
    state.settings = { ...DEFAULT_SETTINGS, ...await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)) };
    $('setup').hidden = Boolean(normalizeEndpoint(state.settings.endpoint));

    $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('setup-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('select-all').addEventListener('change', onSelectAll);
    $('hide-small').addEventListener('change', renderGrid);
    $('upload').addEventListener('click', startUpload);
    $('copy-results').addEventListener('click', copyResults);

    for (const button of document.querySelectorAll('[role="tab"]')) {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.batch) renderBatch(changes.batch.newValue);
        if (area === 'local' && changes.history) renderHistory(changes.history.newValue);
    });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab;
    await scanPage();

    const { batch } = await chrome.storage.session.get('batch');
    renderBatch(batch);
}

/**
 * 在当前标签页的所有 frame 里收集图片地址
 */
async function scanPage() {
    const empty = $('empty');
    if (!state.tab?.id || !/^(https?|file):/.test(state.tab.url || '')) {
        empty.textContent = '这个页面不允许扩展读取（浏览器内置页或扩展商店）';
        empty.hidden = false;
        return;
    }

    // 页面还在加载时注入会等到文档就绪，期间给个提示，别让弹窗看起来像没找到图
    empty.textContent = '正在扫描页面图片…';
    empty.hidden = false;

    let injections;
    try {
        injections = await chrome.scripting.executeScript({
            target: { tabId: state.tab.id, allFrames: true },
            // 不等 document_idle：页面迟迟加载不完时弹窗会一直停在「正在扫描」
            injectImmediately: true,
            func: collectImages
        });
    } catch (error) {
        empty.textContent = `读取页面失败：${error.message}`;
        empty.hidden = false;
        return;
    }

    const seen = new Set();
    for (const { frameId, result } of injections) {
        for (const image of result?.images || []) {
            if (seen.has(image.src)) continue;
            seen.add(image.src);
            state.images.push({
                id: String(state.images.length),
                srcUrl: image.src,
                pageUrl: result.pageUrl,
                frameId,
                alt: image.alt,
                width: image.width,
                height: image.height
            });
        }
    }
    renderGrid();
}

/**
 * 注入页面执行：收集 <img>（含 srcset 最大候选）、<picture>、<svg image>、
 * CSS 背景图与 og:image。必须自包含，不能引用外部变量。
 * @returns {{pageUrl: string, images: Array<{src: string, alt: string, width: number, height: number}>}}
 */
function collectImages() {
    const found = new Map();
    const add = (raw, alt = '', width = 0, height = 0) => {
        if (!raw) return;
        let src;
        try {
            src = new URL(raw, document.baseURI).href;
        } catch {
            return;
        }
        if (!/^(https?:|data:image\/|blob:)/i.test(src)) return;
        const prev = found.get(src);
        if (!prev || width * height > prev.width * prev.height) {
            found.set(src, { src, alt: alt || prev?.alt || '', width, height });
        }
    };

    // srcset 里挑宽度或密度最大的候选
    const largestFromSrcset = srcset => {
        let best = null;
        let bestScore = -1;
        for (const part of srcset.split(/,\s+/)) {
            const [url, descriptor = '1x'] = part.trim().split(/\s+/);
            const score = parseFloat(descriptor) || 1;
            if (url && score > bestScore) {
                best = url;
                bestScore = score;
            }
        }
        return best;
    };

    for (const img of document.images) {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        const srcset = img.getAttribute('srcset');
        const large = srcset ? largestFromSrcset(srcset) : null;
        add(large || img.currentSrc || img.src, img.alt, width, height);
        // 懒加载常把真图放在 data-src 里
        for (const attr of ['data-src', 'data-original', 'data-lazy-src']) {
            add(img.getAttribute(attr), img.alt);
        }
    }

    for (const source of document.querySelectorAll('picture source[srcset]')) {
        add(largestFromSrcset(source.getAttribute('srcset')));
    }

    for (const image of document.querySelectorAll('svg image')) {
        add(image.getAttribute('href') || image.getAttribute('xlink:href'));
    }

    const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
    if (og) add(og.content);

    // 背景图要算样式，元素太多时只看前 3000 个，避免卡住页面
    const elements = document.querySelectorAll('body *');
    const limit = Math.min(elements.length, 3000);
    for (let i = 0; i < limit; i++) {
        const bg = getComputedStyle(elements[i]).backgroundImage;
        if (!bg || bg === 'none') continue;
        for (const match of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) {
            const rect = elements[i].getBoundingClientRect();
            add(match[1], '', Math.round(rect.width), Math.round(rect.height));
        }
    }

    return { pageUrl: location.href, images: [...found.values()] };
}

/**
 * 按筛选条件渲染缩略图网格
 */
function renderGrid() {
    const grid = $('grid');
    const hideSmall = $('hide-small').checked;
    const visible = state.images.filter(image => !hideSmall || isLargeEnough(image));

    grid.replaceChildren(...visible.map(image => {
        const card = document.createElement('label');
        card.className = 'thumb';
        card.dataset.id = image.id;
        card.title = image.srcUrl.startsWith('data:') ? 'data: 内嵌图片' : image.srcUrl;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selected.has(image.id);
        checkbox.addEventListener('change', () => {
            checkbox.checked ? state.selected.add(image.id) : state.selected.delete(image.id);
            updateCount();
        });

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.src = image.srcUrl;
        img.alt = image.alt;
        // 页面里没加载完的图拿不到尺寸，在弹窗里补量一次
        img.addEventListener('load', () => {
            if (image.width) return;
            image.width = img.naturalWidth;
            image.height = img.naturalHeight;
            size.textContent = `${image.width}×${image.height}`;
            // 量出来太小就补一次筛选
            if ($('hide-small').checked && !isLargeEnough(image)) {
                card.hidden = true;
                checkbox.checked = false;
                state.selected.delete(image.id);
                updateCount();
            }
        });

        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = image.width ? `${image.width}×${image.height}` : '';

        const status = document.createElement('span');
        status.className = 'job';

        card.append(checkbox, img, size, status);
        return card;
    }));

    // 被筛掉的图不应留在已选里
    const visibleIds = new Set(visible.map(image => image.id));
    for (const id of state.selected) {
        if (!visibleIds.has(id)) state.selected.delete(id);
    }

    const empty = $('empty');
    empty.hidden = visible.length > 0;
    empty.textContent = state.images.length ? `没有大于 ${MIN_SIZE}px 的图片` : '这个页面没有找到图片';
    updateCount();
}

/**
 * 尺寸未知（背景图、懒加载）时放行，交给用户自己判断
 * @param {{width: number, height: number}} image
 * @returns {boolean}
 */
function isLargeEnough(image) {
    if (!image.width || !image.height) return true;
    return image.width >= MIN_SIZE && image.height >= MIN_SIZE;
}

/**
 * 全选 / 取消全选当前可见的图片
 */
function onSelectAll(event) {
    for (const card of visibleCards()) {
        const checkbox = card.querySelector('input');
        checkbox.checked = event.target.checked;
        event.target.checked ? state.selected.add(card.dataset.id) : state.selected.delete(card.dataset.id);
    }
    updateCount();
}

/**
 * 当前网格里没被隐藏的卡片
 * @returns {HTMLElement[]}
 */
function visibleCards() {
    return [...$('grid').children].filter(card => !card.hidden);
}

/**
 * 刷新计数与上传按钮状态
 */
function updateCount() {
    const total = visibleCards().length;
    $('count').textContent = `已选 ${state.selected.size} / ${total}`;
    $('select-all').checked = total > 0 && state.selected.size === total;
    $('upload').disabled = state.selected.size === 0 || $('upload').dataset.running === 'true';
}

/**
 * 把勾选的图片交给后台上传。上传在后台进行，关掉弹窗不会中断。
 */
async function startUpload() {
    if (!normalizeEndpoint(state.settings.endpoint)) {
        chrome.runtime.openOptionsPage();
        return;
    }
    const items = state.images
        .filter(image => state.selected.has(image.id))
        .map(({ id, srcUrl, pageUrl, frameId, alt }) => ({ id, srcUrl, pageUrl, frameId, alt, tabId: state.tab.id }));

    $('upload').dataset.running = 'true';
    $('upload').disabled = true;
    await chrome.runtime.sendMessage({ type: 'upload-batch', items });
}

/**
 * 按后台写入的进度更新卡片状态与底栏
 * @param {{running: boolean, copied?: boolean, jobs: Object<string, {status: string, url?: string, error?: string, srcUrl: string}>}} batch
 */
function renderBatch(batch) {
    if (!batch) return;
    const jobs = Object.entries(batch.jobs || {});
    // 进度属于别的页面时不往当前网格上套
    const belongsHere = jobs.every(([id, job]) => state.images[id]?.srcUrl === job.srcUrl);

    const labels = { pending: '排队', uploading: '上传中', done: '✓', error: '✕' };
    if (belongsHere) {
        for (const [id, job] of jobs) {
            const card = $('grid').querySelector(`[data-id="${id}"]`);
            if (!card) continue;
            const badge = card.querySelector('.job');
            badge.textContent = labels[job.status] || '';
            badge.dataset.status = job.status;
            badge.title = job.error || job.url || '';
        }
    }

    const done = jobs.filter(([, job]) => job.status === 'done').length;
    const failed = jobs.filter(([, job]) => job.status === 'error').length;
    const finished = done + failed;

    $('upload').dataset.running = String(Boolean(batch.running));
    if (batch.running) {
        $('batch-status').textContent = `上传中 ${finished}/${jobs.length}`;
    } else if (jobs.length) {
        const parts = [`成功 ${done}`];
        if (failed) parts.push(`失败 ${failed}`);
        if (batch.copied) parts.push('已复制');
        $('batch-status').textContent = parts.join(' · ');
        $('copy-results').hidden = done === 0;
        state.lastResults = jobs.filter(([, job]) => job.url).map(([id, job]) => ({ url: job.url, alt: state.images[id]?.alt || '' }));
    }
    updateCount();
}

/**
 * 复制最近一次批量上传的全部链接
 */
async function copyResults() {
    const text = (state.lastResults || []).map(r => formatLink(r.url, state.settings.format, r.alt)).join('\n');
    await navigator.clipboard.writeText(text);
    $('batch-status').textContent = `已复制 ${state.lastResults.length} 条链接`;
}

/**
 * 切换标签页
 * @param {'page'|'history'} name
 */
async function switchTab(name) {
    for (const button of document.querySelectorAll('[role="tab"]')) {
        button.setAttribute('aria-selected', String(button.dataset.tab === name));
    }
    $('tab-page').hidden = name !== 'page';
    $('tab-history').hidden = name !== 'history';
    if (name === 'history') {
        const { history = [] } = await chrome.storage.local.get('history');
        renderHistory(history);
    }
}

/**
 * 渲染上传历史，点击条目复制链接
 * @param {Array<{url: string, srcUrl: string, pageUrl: string, time: number}>} history
 */
function renderHistory(history = []) {
    $('history-empty').hidden = history.length > 0;
    $('history').replaceChildren(...history.map(entry => {
        const li = document.createElement('li');

        const img = document.createElement('img');
        img.src = entry.url;
        img.loading = 'lazy';
        img.alt = '';

        const meta = document.createElement('div');
        meta.className = 'meta';
        const link = document.createElement('a');
        link.href = entry.url;
        link.target = '_blank';
        link.textContent = new URL(entry.url).pathname;
        const time = document.createElement('span');
        time.className = 'muted';
        time.textContent = new Date(entry.time).toLocaleString();
        meta.append(link, time);

        const copy = document.createElement('button');
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
            await navigator.clipboard.writeText(formatLink(entry.url, state.settings.format));
            copy.textContent = '已复制';
            setTimeout(() => { copy.textContent = '复制'; }, 1200);
        });

        li.append(img, meta, copy);
        return li;
    }));
}
