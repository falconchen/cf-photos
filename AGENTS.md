# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                         # install deps (Node.js 22+)
npm run dev -- --ip 127.0.0.1  # local dev server at http://127.0.0.1:8787 (reads/writes REAL WebDAV)
npm test                       # run all tests (node:test, no framework)
node --test test/webdav.test.mjs                        # run one test file
node --test --test-name-pattern '分页' test/webdav.test.mjs  # run one test by name
npx wrangler deploy --dry-run  # verify the Worker bundles without deploying
npm run deploy                 # wrangler deploy to Cloudflare
```

There is no linter or build step. Tests are plain `.mjs` files under `test/` using `node:test` + `node:assert/strict`, with `fetch` stubbed by passing a fake request function as `new WebDAVStorage(env, fakeFetch)`.

## Configuration

Local secrets live in `.dev.vars` (git-ignored; `cp .dev.vars.example .dev.vars` then `chmod 600`). Required vars: `WEBDAV_URL` (credential-free, query-free HTTPS root, e.g. `https://example.com/dav`), `WEBDAV_USERNAME`, `WEBDAV_PASSWORD`, `AUTH_TOKEN`. Optional: `TIMEZONE_OFFSET` (hours, default 8) — non-secret, lives in `wrangler.toml` `[vars]`, overridable in `.dev.vars`. In production these are set individually via `npx wrangler secret put <NAME>`; `.dev.vars` is never deployed.

`AUTH_TOKEN` guards the app's upload/list/delete endpoints and is independent of the WebDAV password. If `AUTH_TOKEN` is unset, `AuthMiddleware` fails open (no auth) — always set it.

## Architecture

Single Cloudflare Worker. `src/index.js` is a hand-rolled router (path + method `if` chain) that builds `new ImageService(new WebDAVStorage(env))` per request and dispatches.

**Storage abstraction is the key design point.** `ImageService` is storage-agnostic and depends only on an R2-`Bucket`-shaped interface: `get(key)` → `{ body, httpEtag, writeHttpMetadata(headers) }` or `null`; `put(key, body, { httpMetadata })`; `delete(key)`; `list({ prefix, delimiter, limit, cursor, order })` → `{ objects, delimitedPrefixes, truncated, cursor }`. `order` (`'asc'` default / `'desc'`) is a WebDAV-branch extension: native R2 silently ignores it, so `main` / `r2` always list ascending. This repo has three branches sharing `ImageService` unchanged:
- `main` / `r2` — inject `env.MY_BUCKET` (native R2) directly.
- `webdav` (current) — inject `WebDAVStorage`, which reimplements that same shape over WebDAV HTTP verbs. No R2 binding; `wrangler.toml` has no bucket.

`src/services/WebDAVStorage.js` — translates the R2 interface to `GET` / `PUT` / `MKCOL` / `PROPFIND` / `DELETE`, parsing namespaced XML with `fast-xml-parser`. Notable constraints:
- The constructor's default `request` **must** stay wrapped as `(...args) => fetch(...args)`. Storing bare `fetch` as an instance property makes `this.request(...)` call it with the storage instance as receiver, and workerd throws `TypeError: Illegal invocation` — which `send()`'s catch then disguises as "WebDAV 请求失败或超时". Stub-injected tests cannot catch this; the dedicated receiver test does.
- All keys are confined to `i/`; `validate()` rejects traversal, control chars, backslashes, empty segments. `delete()` refuses to delete a collection.
- `redirect: 'manual'` everywhere — a redirect is an error, never followed, so credentials never leak to another host. XML with `<!DOCTYPE>` / `<!ENTITY>` is rejected (XXE guard).
- `put()` creates each missing parent dir via `MKCOL` (tolerating 405), then re-verifies via `PROPFIND` that a 405 was a real directory and not a same-named file.
- WebDAV has no snapshot pagination. `list()` does a Depth:1 walk, encoding a base64 JSON cursor `{ prefix, dirs, after, order }` (queue of pending dirs + last-seen file + direction). Each call scans ≤35 directories and **may legitimately return an empty `objects` array with a non-null `cursor`** — callers must keep following the cursor.
- `order: 'desc'` reverses both the directory stack and the in-directory filename sort, so the walk runs newest→oldest end to end (keys are time-ordered, see the path scheme below). The cursor records its direction and a mismatched one is rejected as `无效的分页游标` — changing sort order means restarting from a null cursor. `after: ''` means "no bound yet" in both directions.

`src/services/ImageService.js` (~1500 lines) — all business logic: the three upload paths (multipart, JSON/base64, raw binary), date-based path generation (`/i/YYYY/MM/DD/<8-char-base60-time-id><ext>` — 时分秒各 1 位 + 毫秒 2 位 + crypto 随机 3 位；目录日期与文件名时间同用 `TIMEZONE_OFFSET`，故 `ImageService` 的构造函数接收 `env` 作为第二个参数), MIME↔extension mapping for images, video and audio (`_extensionFrom` prefers the original filename's suffix, sanitised to `[a-z0-9]{1,8}`, and falls back to the MIME map), media fetch (passes through remote `Content-Type` / `ETag` / `Last-Modified`, caches 1 day, and forwards the client's `Range` header to WebDAV — the backend's `206` / `Content-Range` / `Accept-Ranges` are passed through so `<video>` can seek), delete, `listImages` (validates `year`/`month`/`day` before building the prefix, defaults to `order: 'desc'`), `listDirs` (the year/month/day filter options, via `_listSubdirs` over `list()`'s `delimiter` branch), and `renderDashboard()` which returns the entire admin UI as an inline HTML string — static, no WebDAV call, with the dashboard's own JS filling the filter selects from `/admin/dirs`. The “auto-follow empty-but-cursor pages, up to 20 rounds” loop lives in that inline JS (`loadImages()`), **not** in `listImages`, which makes exactly one `storage.list()` call.

`src/index.js` also caps the two buffering upload paths (multipart, JSON base64) at `MAX_BUFFERED_UPLOAD` = 20 MB, checked against `Content-Length` **before** the body is parsed — a missing `Content-Length` is a 411, over the cap a 413. The cap is derived from memory, not policy: multipart peaks at ~2–3× the file, base64 at ~4–5×, and the 128 MB isolate is shared across concurrent requests, so raising it turns a clean 413 into an OOM. The dashboard's own uploader uses the raw-binary path (XHR with the `File` as the body, plus an `X-Upload-Filename` header to keep the original suffix) precisely so large media is not subject to that cap. The streaming paths (raw-binary `POST /upload`, `PUT /i/...`) are deliberately uncapped — `request.body` is passed straight through to WebDAV, so only Cloudflare's per-plan request-body limit applies. Large media (video/audio, iPhone ProRAW) must use those.

`src/middleware/AuthMiddleware.js` — static `Bearer` token check. Upload endpoints also accept the token as a `token` form/JSON field (for uPic and similar clients), but the header wins and is checked **before** the body is parsed: an `Authorization` header that is present and wrong is rejected outright, so a doomed request never gets its file buffered into the 128 MB isolate. The body-token fallback applies only when no `Authorization` header is sent at all — that path unavoidably parses first, so an anonymous request can still force a full buffer (a `Content-Length` guard would be the fix). `hasHeader()` is what distinguishes the two cases.

`fetchImage` 的响应经过安全加固，堵的是存储型 XSS：后台页面与 `/i/...` 同源，`AUTH_TOKEN` 就存在同源的 `localStorage.cf_photo_token` 里，一旦上传内容能在本站域名下执行脚本就等于交出 Token。三步，顺序不能换：① 后端 Content-Type 缺失或为 `application/octet-stream` 时，用 `_mimeFromExtension` 按后缀回填——**这是 `nosniff` 的前提**，不回填就会把后端只回 octet-stream 的正常图片变成白屏；② 类型为空、命中 `RISKY_MIME_TYPES`、或后缀命中 `RISKY_EXTENSIONS` 时，改写为 `application/octet-stream` + `Content-Disposition: attachment`（见下面实测：后端对 `.html` 压根不回 Content-Type，只判 MIME 会漏，所以后缀那一路必须留着）；③ 恒定下发 `Content-Security-Policy: default-src 'none'; script-src 'none'; sandbox` 与 `X-Content-Type-Options: nosniff`。`fetchImage` 只有一处 `new Response`，200 与 206 共用这套头。不加 `Cross-Origin-Resource-Policy`——那会打断外站热链，而热链正是图床要的。

**后端会自己重新推导 Content-Type，别以为浏览器看到的就是我们 PUT 的那个。** 对 teracloud（Apache + `mime.types`）实测：PUT 一个 `.png` 却声明 `application/octet-stream`，GET 回来是 `image/png`；PUT 一个无后缀文件并声明 `image/png`，GET 回来**没有** Content-Type 头。也就是说它忽略我们存的类型，改按**文件后缀**推导。结论：真正的控制点是后缀而不是我们写进 `httpMetadata` 的 MIME——这正是上传侧 `RISKY_EXTENSIONS` 那一半必须存在的原因，只拦 MIME 挡不住。完整实测（左为 PUT 声明，右为 GET 返回）：`.mp4`→`video/mp4`、`.png`→`image/png`、`.svg`→`image/svg+xml`、`.xml`→`application/xml`、`.js` 声明 `text/javascript` 却返回 `application/javascript`（两者都在 `RISKY_MIME_TYPES` 里，已覆盖）、`.html`→**无此头**、`.heic`→**无此头**、无后缀→**无此头**。

两个由此而来的副作用，都是有意接受的：① `.heic` 过去因为后端不回类型只能靠浏览器嗅探显示，现在回填会给它 `image/heic`，是实打实的改善；② 无后缀文件回填不出类型，会落进降级分支变成 `attachment` 下载。写这段时全库 503 个文件的后缀分布是 `.png` 360 / `.jpeg` 74 / `.jpg` 30 / `.webp` 31 / `.gif` 4 / `.mp4` 2 / `.mov` 1 / `.svg` 1，**无后缀文件 0 个**，所以②当前不影响任何东西；但 `uploadWithBase64` 的裸 base64 分支在认不出类型时确实会产出无后缀文件，将来可能碰到。

**SVG 是有意保留的，靠 CSP 而不是靠禁用来防护——别当成遗漏又去把它禁掉。** SVG 在 `<img>` 里本就不执行脚本，只有被当作文档打开时才会，而 `sandbox` 恰好只在那种场景生效。已在真实浏览器里验证：含 `<script>` 的 SVG 直接打开时图形正常渲染，控制台报 `Blocked script execution ... the document's frame is sandboxed`，`window.origin` 为 `"null"`，`localStorage` 访问抛 `SecurityError`；同一文件放进 `<img>` 仍正常加载。因此 `image/svg+xml` 与 `.svg` 刻意**不在** `RISKY_MIME_TYPES` / `RISKY_EXTENSIONS` 里。

上传侧是纵深防御：`_rejectRiskyUpload(contentType, extension)` 在四条路径（`uploadFormData` / `uploadWithBase64` / `uploadWithAutoPath` / `uploadImage`）写盘之前各调用一次，命中返回 415。`PUT /i/...` 的后缀来自客户端指定的 URL，是最直接的一条注入路，单独从 key 里取后缀检查。`McpService` 不接这个守卫——它要求 `mime.startsWith('image/')` 且显式拒绝 SVG，本来就更严。注意后台页面的 `MEDIA_PREFIXES` 只是前端提示，curl 可绕，服务端这层才是真的。

`MIME_MAP` 在模块作用域，`EXTENSION_TO_MIME` 由它反转而来（同后缀多 MIME 时先到先得，如 `.jpg` 取 `image/jpeg`）。加后缀或类型只改 `MIME_MAP` 一处，别再起第二张表。

`scripts/scan-risky-files.mjs` 是配套的只读盘点脚本，直连 WebDAV（读 `.dev.vars`，不依赖 dev server），跟着 `list()` 的游标走到底列出存量里的危险后缀。它必须处理「`objects` 为空但 `cursor` 非 null」的分页语义，漏了会漏报深层目录。

## Conventions (from spec.md)

- JavaScript ES Modules only. Follow SOLID.
- **Function-level doc comments are written in Chinese.** Match the existing bilingual style (Chinese comments, English identifiers).

## Endpoints

`GET /` dashboard · `POST /upload` (multipart `image`/`file`, or JSON base64, or raw binary) · `GET /i/{y}/{m}/{d}/{name}` fetch · `PUT /i/...` upload to explicit path · `GET /admin/list?limit&cursor&year&month&day&order` (`order=desc` newest-first, the default; `asc` oldest-first) · `GET /admin/dirs?year&month` (filter options: no params → years, `year` → that year's months, `year`+`month` → that month's days; descending) · `DELETE /admin/delete/{key}`.

## Verifying WebDAV changes

Beyond `npm test`: with real `.dev.vars`, upload a throwaway image, confirm the downloaded bytes match, check it appears first in `/admin/list` (default newest-first), last under `order=asc`, and in a `year`+`month`+`day` filtered query whose values `/admin/dirs` reports, then delete it and confirm a subsequent fetch returns 404.

For the stored-XSS hardening: plant a `.html` and a `<script>`-bearing `.svg` **directly through `WebDAVStorage`** (bypassing `ImageService`, which now rejects them) to simulate pre-fix files, then confirm the `.html` comes back as `application/octet-stream` + `Content-Disposition: attachment` while the `.svg` keeps `image/svg+xml`; confirm every response carries the CSP and `nosniff`, including a `Range` request's 206; open the SVG in a real browser and check that it renders, that the console reports `Blocked script execution`, and that `localStorage` throws; load both through `<img>` from the dashboard to prove embedding still works; verify all four upload paths return 415 for `text/html` and for a `.html` filename; run `scripts/scan-risky-files.mjs` and confirm it finds the planted `.html` and does not flag svg/png/mp4. Delete everything afterwards. Note that `Cache-Control: public, max-age=86400` means already-cached responses keep the old headers for up to a day — purge Cloudflare's cache after deploying, and use curl or a private window when verifying.
