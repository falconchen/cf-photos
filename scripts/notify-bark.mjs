#!/usr/bin/env node
/**
 * 构建结束后往 Bark 推一条部署结果通知
 *
 * 跑在 Cloudflare Workers Builds 的构建容器里，由 package.json 的 deploy:ci
 * 在 wrangler deploy 之后调用，参数是 wrangler 的退出码（0 为成功）。
 *
 * 设计上只能成功、不能拖垮部署：缺少 BARK_KEY、Bark 服务器不通、返回非 200，
 * 一律打一行日志后以 0 退出。真正的部署成败由 deploy:ci 里的 exit $s 决定。
 *
 * 需要的构建变量（Workers Builds → Settings → Build → Variables and secrets，
 * 不是运行时的 Variables & Secrets，两者互不可见）：
 *   BARK_KEY     必填，Bark App 里那串设备 key
 *   BARK_SERVER  选填，自建服务器地址，默认 https://api.day.app
 *
 * 用法:
 *   node scripts/notify-bark.mjs <exit-code>
 */

const TIMEOUT_MS = 10_000;

const key = (process.env.BARK_KEY || '').trim();
const server = (process.env.BARK_SERVER || 'https://api.day.app').trim().replace(/\/+$/, '');
const code = Number(process.argv[2] ?? 0);
const ok = code === 0;

// Workers Builds 注入的内置变量，本地手动跑时都是 undefined，取不到就省略那一行
const branch = process.env.WORKERS_CI_BRANCH || '';
const sha = (process.env.WORKERS_CI_COMMIT_SHA || '').slice(0, 7);
const buildId = process.env.WORKERS_CI_BUILD_UUID || '';

/**
 * 发送通知；任何异常都咽掉，只在构建日志里留痕
 */
async function main() {
    if (!key) {
        console.log('[bark] 未配置 BARK_KEY，跳过通知');
        return;
    }

    const lines = [];
    if (branch) lines.push(`分支 ${branch}`);
    if (sha) lines.push(`提交 ${sha}`);
    if (!ok) lines.push(`退出码 ${code}`);
    if (buildId) lines.push(`构建 ${buildId.slice(0, 8)}`);

    const payload = {
        device_key: key,
        title: ok ? '✅ cf-photos 部署成功' : '❌ cf-photos 部署失败',
        body: lines.join(' · ') || (ok ? '部署完成' : '部署失败'),
        group: 'cf-photos',
        // 失败走时效性通知，静音时段也能弹出来；成功就安静地进通知中心
        level: ok ? 'active' : 'timeSensitive',
    };

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
        const res = await fetch(`${server}/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        });
        const text = await res.text().catch(() => '');
        console.log(`[bark] ${res.status} ${text.slice(0, 200)}`);
    } catch (err) {
        console.log(`[bark] 通知发送失败（不影响部署）：${err.message}`);
    }
}

await main();
