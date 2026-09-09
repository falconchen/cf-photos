#!/usr/bin/env node
/**
 * 扫描 WebDAV 存量文件里可被浏览器当作网页打开的后缀
 *
 * 上传侧的阻断（ImageService._rejectRiskyUpload）只对新文件生效；这个脚本用来
 * 找出加固之前可能已经躺在 i/ 里的 .html / .xml / .js 等文件。读取侧的 CSP 与
 * 类型改写已经让它们无法执行脚本，所以这不是紧急清理，而是一次盘点。
 *
 * 只读：只发 PROPFIND，不删除、不修改任何东西。命中项会附一条现成的删除命令，
 * 要不要执行由人决定。
 *
 * 用法:
 *   node scripts/scan-risky-files.mjs [选项]
 *     -c, --config FILE  读取 WEBDAV_* 的 env 文件（默认：仓库内 .dev.vars）
 *         --base URL     用于拼接删除命令的站点地址（默认 http://127.0.0.1:8787）
 *         --all          列出扫到的每一个文件，而不只是命中项
 *     -h, --help         显示帮助
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebDAVStorage } from '../src/services/WebDAVStorage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 与 ImageService 的 RISKY_EXTENSIONS 保持一致。刻意不含 .svg：SVG 是允许的图床
// 格式，由 fetchImage 下发的 CSP sandbox 兜住，不该在这里报成问题。
const RISKY_EXTENSIONS = new Set([
    '.html', '.htm', '.xhtml', '.xht', '.shtml',
    '.xml', '.xsl', '.xslt', '.js', '.mjs', '.cjs'
]);

/**
 * 解析命令行参数
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{config: string, base: string, all: boolean}}
 */
function parseArgs(argv) {
    const options = { config: resolve(ROOT, '.dev.vars'), base: 'http://127.0.0.1:8787', all: false };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
            process.exit(0);
        } else if (arg === '-c' || arg === '--config') {
            options.config = resolve(argv[++i]);
        } else if (arg === '--base') {
            options.base = argv[++i].replace(/\/$/, '');
        } else if (arg === '--all') {
            options.all = true;
        } else {
            console.error(`未知参数: ${arg}（用 --help 查看用法）`);
            process.exit(2);
        }
    }

    return options;
}

/**
 * 从 env 文件里读取 WebDAV 配置
 * 只认 KEY=VALUE，支持可选的引号，忽略注释与空行
 * @param {string} file env 文件路径
 * @returns {Object} 形如 { WEBDAV_URL, WEBDAV_USERNAME, WEBDAV_PASSWORD }
 */
function loadEnv(file) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        console.error(`读不到配置文件 ${file}：${error.message}`);
        process.exit(1);
    }

    const env = {};
    for (const line of text.split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) continue;
        env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }

    for (const name of ['WEBDAV_URL', 'WEBDAV_USERNAME', 'WEBDAV_PASSWORD']) {
        if (!env[name]) {
            console.error(`${file} 里缺少 ${name}`);
            process.exit(1);
        }
    }

    return env;
}

/**
 * 取出 key 的小写后缀（含点）
 * @param {string} key 存储 key
 * @returns {string} 后缀，没有点时为空串
 */
function extensionOf(key) {
    const slash = key.lastIndexOf('/');
    const dot = key.lastIndexOf('.');
    return dot > slash ? key.slice(dot).toLowerCase() : '';
}

const options = parseArgs(process.argv.slice(2));
const storage = new WebDAVStorage(loadEnv(options.config));

console.log(`扫描 ${loadEnv(options.config).WEBDAV_URL} 下的 i/ …\n`);

const hits = [];
let scanned = 0;
let rounds = 0;
let cursor = null;

// list() 每次最多扫 35 个目录，完全可能返回空 objects 但 cursor 非 null，
// 必须一直跟着游标走到底，否则深层目录会被漏掉。
do {
    const page = await storage.list(cursor ? { limit: 100, cursor } : { limit: 100 });
    rounds++;

    for (const object of page.objects) {
        scanned++;
        const extension = extensionOf(object.key);
        if (RISKY_EXTENSIONS.has(extension)) {
            hits.push(object);
            console.log(`  [命中] ${object.key}  ${object.size} 字节  ${object.uploaded || '时间未知'}`);
        } else if (options.all) {
            console.log(`         ${object.key}  ${object.size} 字节`);
        }
    }

    cursor = page.truncated ? page.cursor : null;
} while (cursor);

console.log(`\n共扫描 ${scanned} 个文件（${rounds} 轮翻页），命中 ${hits.length} 个。`);

if (hits.length === 0) {
    console.log('没有发现可被当作网页打开的存量文件。');
} else {
    console.log('\n读取侧的 CSP 与类型改写已经让这些文件无法执行脚本；确认不需要后可以执行：\n');
    for (const object of hits) {
        console.log(`  curl -X DELETE -H "Authorization: Bearer $AUTH_TOKEN" ${options.base}/admin/delete/${object.key}`);
    }
    console.log('');
}
