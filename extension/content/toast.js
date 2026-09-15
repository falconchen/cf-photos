/**
 * 页面内通知：由后台通过 chrome.scripting.executeScript 注入到页面顶层 frame，
 * 仿 macOS 通知横幅，从右上角侧滑进入。
 *
 * 运行在扩展的隔离世界里，window 上的挂载只有本扩展可见，页面脚本碰不到。
 * 样式放在 closed Shadow DOM 里，并用 adoptedStyleSheets 注入——构造样式表属于
 * CSSOM，不受页面 CSP 的 style-src 限制，<style> 标签则可能被拦。
 */
(() => {
    if (window.__cfPhotosToast) return;

    const MAX_TOASTS = 4;
    const DISMISS_DISTANCE = 80;

    const css = `
:host { all: initial; }
.stack {
  position: fixed; top: 12px; right: 12px; z-index: 2147483647;
  display: flex; flex-direction: column; gap: 10px;
  width: min(360px, calc(100vw - 24px));
  pointer-events: none;
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.toast {
  --bg: rgba(246, 246, 248, .78);
  --text: #1d1d1f;
  --muted: rgba(60, 60, 67, .62);
  --line: rgba(0, 0, 0, .08);
  --button: rgba(0, 0, 0, .06);
  --button-hover: rgba(0, 0, 0, .11);
  position: relative; pointer-events: auto; box-sizing: border-box;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 11px 12px 11px 11px;
  color: var(--text); background: var(--bg);
  border: .5px solid var(--line); border-radius: 16px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .16), 0 1px 3px rgba(0, 0, 0, .08);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  transform: translateX(calc(100% + 24px)); opacity: 0;
  transition: transform .45s cubic-bezier(.2, .9, .25, 1.08), opacity .3s ease;
  touch-action: pan-y; user-select: none; cursor: default;
}
.toast.in { transform: translateX(0); opacity: 1; }
.toast.dragging { transition: none; }
.toast.out { transform: translateX(calc(100% + 24px)); opacity: 0; transition: transform .3s ease-in, opacity .3s ease-in; }
@media (prefers-color-scheme: dark) {
  .toast {
    --bg: rgba(40, 40, 44, .74);
    --text: #f5f5f7;
    --muted: rgba(235, 235, 245, .6);
    --line: rgba(255, 255, 255, .12);
    --button: rgba(255, 255, 255, .1);
    --button-hover: rgba(255, 255, 255, .18);
  }
}
@media (prefers-reduced-motion: reduce) {
  .toast, .toast.out { transform: none; transition: opacity .2s ease; }
}
.close {
  position: absolute; top: -6px; left: -6px; width: 20px; height: 20px; padding: 0;
  display: grid; place-items: center; border-radius: 50%;
  border: .5px solid var(--line); background: var(--bg); color: var(--muted);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .15);
  font-family: inherit; font-size: 11px; font-weight: 600; line-height: 1; cursor: pointer;
  opacity: 0; transform: scale(.8); transition: opacity .15s, transform .15s;
}
.toast:hover .close, .close:focus-visible { opacity: 1; transform: scale(1); }
.icon { position: relative; flex: none; width: 36px; height: 36px; }
.icon svg { display: block; width: 36px; height: 36px; }
.badge {
  position: absolute; right: -3px; bottom: -3px; width: 16px; height: 16px;
  display: grid; place-items: center; border-radius: 50%;
  box-shadow: 0 0 0 2px var(--bg);
  color: #fff; font-family: inherit; font-size: 10px; font-weight: 700; line-height: 1;
}
.toast[data-kind="success"] .badge { background-color: #28c840; }
.toast[data-kind="error"] .badge { background-color: #ff453a; }
.toast[data-kind="progress"] .badge {
  background: var(--bg); box-shadow: none; border: 2px solid rgba(127, 127, 127, .35); border-top-color: #f38020;
  width: 12px; height: 12px; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.body { flex: 1; min-width: 0; }
.head { line-height: 16px; margin-bottom: 1px; }
.app { font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--muted); text-transform: uppercase; }
.side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.time { font-size: 11px; line-height: 16px; color: var(--muted); white-space: nowrap; }
.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.message {
  margin-top: 1px; color: var(--text); opacity: .86;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-all; user-select: text;
}
.message.mono { font: 12px/1.35 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.bar { height: 3px; margin-top: 7px; border-radius: 2px; background: var(--button); overflow: hidden; }
.bar i { display: block; height: 100%; width: 0; background: #f38020; border-radius: inherit; transition: width .3s ease; }
.actions { display: flex; gap: 6px; margin-top: 8px; }
.actions button {
  flex: 1; padding: 4px 8px; border: none; border-radius: 7px;
  background: var(--button); color: var(--text);
  font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.4; cursor: pointer;
}
.actions button:hover { background: var(--button-hover); }
.actions button:focus-visible, .close:focus-visible { outline: 2px solid #f38020; outline-offset: 1px; }
.thumb { display: block; width: 40px; height: 40px; border-radius: 8px; object-fit: cover; background: var(--button); }
[hidden] { display: none !important; }
`;

    const SVG_NS = 'http://www.w3.org/2000/svg';

    /**
     * 创建元素。不用 innerHTML：启用 Trusted Types 的站点（GitHub、Google 系）会拦截它
     * @param {string} tag
     * @param {Object} [attrs]
     * @param {Array<Node|string>} [children]
     * @param {string} [ns]
     */
    function h(tag, attrs = {}, children = [], ns) {
        const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        el.append(...children);
        return el;
    }

    /**
     * 扩展图标：橙色圆角方块 + 上传箭头，与 icons/*.png 一致
     */
    function appIcon() {
        const s = (tag, attrs, children) => h(tag, attrs, children, SVG_NS);
        return s('svg', { viewBox: '0 0 36 36', 'aria-hidden': 'true' }, [
            s('defs', {}, [
                s('linearGradient', { id: 'cfp-g', x1: '0', y1: '0', x2: '0', y2: '1' }, [
                    s('stop', { offset: '0', 'stop-color': '#f89a3c' }),
                    s('stop', { offset: '1', 'stop-color': '#ee7411' })
                ])
            ]),
            s('rect', { x: '1', y: '1', width: '34', height: '34', rx: '8.5', fill: 'url(#cfp-g)' }),
            s('path', { d: 'M18 8.5 26 17.5h-5v6h-6v-6h-5z', fill: '#fff' }),
            s('rect', { x: '10', y: '26', width: '16', height: '2.6', rx: '1.3', fill: '#fff' })
        ]);
    }

    const host = document.createElement('div');
    host.style.setProperty('all', 'initial');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'CF-Photos 通知');
    root.append(stack);

    const toasts = new Map();
    // 每条通知已应用的最大 seq；关闭后仍保留，防止迟到的更新把它重新弹出来
    const appliedSeq = new Map();

    /**
     * 显示或更新一条通知。id 相同则原地更新（进度 → 成功 / 失败），seq 不大于已应用值的更新直接丢弃。
     * @param {{id: string, kind: 'progress'|'success'|'error', title: string, message?: string,
     *          mono?: boolean, progress?: number, url?: string, copyText?: string,
     *          thumb?: string, duration?: number, seq?: number}} options
     */
    function show(options) {
        const last = appliedSeq.get(options.id) ?? -Infinity;
        if (typeof options.seq === 'number') {
            if (options.seq <= last) return;
            appliedSeq.set(options.id, options.seq);
        }

        // 挂在 <html> 而不是 <body> 上：body 带 transform / filter 时 fixed 定位会相对 body 失效
        if (!host.isConnected) document.documentElement.append(host);

        let entry = toasts.get(options.id);
        if (!entry) {
            entry = create(options.id);
            toasts.set(options.id, entry);
            // 新通知在最上面，与 macOS 一致
            stack.prepend(entry.el);
            while (toasts.size > MAX_TOASTS) dismiss(toasts.keys().next().value);
            // 下一帧再加 in，保证初始位置先被渲染，过渡才会触发
            requestAnimationFrame(() => requestAnimationFrame(() => entry.el.classList.add('in')));
        }
        update(entry, options);
    }

    /**
     * 创建通知 DOM 并绑定关闭、悬停暂停、右滑关闭
     * @param {string} id
     */
    function create(id) {
        const parts = {
            close: h('button', { class: 'close', 'aria-label': '关闭' }, ['✕']),
            badge: h('span', { class: 'badge' }),
            title: h('div', { class: 'title' }),
            message: h('div', { class: 'message' }),
            fill: h('i'),
            copy: h('button', { 'data-action': 'copy' }, ['复制链接']),
            open: h('button', { 'data-action': 'open' }, ['打开']),
            thumb: h('img', { class: 'thumb', alt: '' })
        };
        parts.bar = h('div', { class: 'bar' }, [parts.fill]);
        parts.actions = h('div', { class: 'actions' }, [parts.copy, parts.open]);
        parts.bar.hidden = parts.actions.hidden = parts.thumb.hidden = true;

        const el = h('div', { class: 'toast' }, [
            parts.close,
            h('div', { class: 'icon' }, [appIcon(), parts.badge]),
            h('div', { class: 'body' }, [
                h('div', { class: 'head' }, [h('span', { class: 'app' }, ['CF-Photos'])]),
                parts.title,
                parts.message,
                parts.bar,
                parts.actions
            ]),
            // 时间固定在右上角，缩略图在它下面，有无缩略图时时间位置一致
            h('div', { class: 'side' }, [h('span', { class: 'time' }, ['现在']), parts.thumb])
        ]);

        const entry = {
            el,
            options: null,
            timer: 0,
            remaining: 0,
            startedAt: 0,
            parts
        };

        parts.close.addEventListener('click', () => dismiss(id));
        entry.parts.copy.addEventListener('click', async () => {
            const ok = await copy(entry.options.copyText || entry.options.url || '');
            entry.parts.copy.textContent = ok ? '已复制' : '复制失败';
            setTimeout(() => { entry.parts.copy.textContent = '复制链接'; }, 1500);
        });
        parts.open.addEventListener('click', () => {
            window.open(entry.options.url, '_blank', 'noopener');
        });
        // 缩略图加载失败（页面 CSP 拦了、混合内容）就不显示，别留个破图
        entry.parts.thumb.addEventListener('error', () => { entry.parts.thumb.hidden = true; });

        el.addEventListener('mouseenter', () => pause(entry));
        el.addEventListener('mouseleave', () => resume(entry, id));
        enableSwipe(entry, id);
        return entry;
    }

    /**
     * 把选项写进 DOM，并重设自动消失计时
     */
    function update(entry, options) {
        entry.options = options;
        const { el, parts } = entry;
        el.dataset.kind = options.kind;
        el.setAttribute('role', options.kind === 'error' ? 'alert' : 'status');

        parts.badge.textContent = options.kind === 'success' ? '✓' : options.kind === 'error' ? '!' : '';
        parts.title.textContent = options.title;
        parts.message.textContent = options.message || '';
        parts.message.hidden = !options.message;
        parts.message.classList.toggle('mono', Boolean(options.mono));

        const hasProgress = options.kind === 'progress' && typeof options.progress === 'number';
        parts.bar.hidden = !hasProgress;
        if (hasProgress) parts.fill.style.width = `${Math.round(Math.max(0, Math.min(1, options.progress)) * 100)}%`;

        parts.actions.hidden = !(options.kind === 'success' && (options.url || options.copyText));
        parts.open.hidden = !options.url;

        if (options.thumb && parts.thumb.getAttribute('src') !== options.thumb) {
            parts.thumb.hidden = false;
            parts.thumb.referrerPolicy = 'no-referrer';
            parts.thumb.src = options.thumb;
        } else if (!options.thumb) {
            parts.thumb.hidden = true;
        }

        clearTimeout(entry.timer);
        entry.remaining = options.duration || 0;
        entry.startedAt = Date.now();
        if (entry.remaining && !el.matches(':hover')) schedule(entry, options.id);
    }

    function schedule(entry, id) {
        entry.startedAt = Date.now();
        entry.timer = setTimeout(() => dismiss(id), entry.remaining);
    }

    function pause(entry) {
        if (!entry.remaining) return;
        clearTimeout(entry.timer);
        entry.remaining = Math.max(1500, entry.remaining - (Date.now() - entry.startedAt));
    }

    function resume(entry, id) {
        if (entry.remaining) schedule(entry, id);
    }

    /**
     * 向右拖动超过阈值即关闭，否则回弹
     */
    function enableSwipe(entry, id) {
        const { el } = entry;
        let startX = 0;
        let dx = 0;
        let pointerId = null;

        el.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button, .message')) return;
            pointerId = event.pointerId;
            startX = event.clientX;
            dx = 0;
            el.setPointerCapture(pointerId);
            el.classList.add('dragging');
        });
        el.addEventListener('pointermove', event => {
            if (event.pointerId !== pointerId) return;
            dx = Math.max(0, event.clientX - startX);
            el.style.transform = `translateX(${dx}px)`;
            el.style.opacity = String(Math.max(.2, 1 - dx / 300));
        });
        const end = event => {
            if (event.pointerId !== pointerId) return;
            pointerId = null;
            el.classList.remove('dragging');
            el.style.transform = '';
            el.style.opacity = '';
            if (dx > DISMISS_DISTANCE) dismiss(id);
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
    }

    /**
     * 滑出并移除
     * @param {string} id
     */
    function dismiss(id) {
        const entry = toasts.get(id);
        if (!entry) return;
        toasts.delete(id);
        clearTimeout(entry.timer);
        entry.el.classList.add('out');
        const remove = () => {
            entry.el.remove();
            if (!toasts.size) host.remove();
        };
        entry.el.addEventListener('transitionend', remove, { once: true });
        setTimeout(remove, 400);
    }

    /**
     * 写剪贴板：优先 Clipboard API，页面权限策略拦了再退回 execCommand。
     * 两者都依赖按钮点击带来的用户激活。
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async function copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
            root.append(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            return ok;
        }
    }

    window.__cfPhotosToast = { show, dismiss };
})();
