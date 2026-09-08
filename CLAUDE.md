# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Storage abstraction is the key design point.** `ImageService` is storage-agnostic and depends only on an R2-`Bucket`-shaped interface: `get(key)` → `{ body, httpEtag, writeHttpMetadata(headers) }` or `null`; `put(key, body, { httpMetadata })`; `delete(key)`; `list({ prefix, delimiter, limit, cursor })` → `{ objects, delimitedPrefixes, truncated, cursor }`. This repo has three branches sharing `ImageService` unchanged:
- `main` / `r2` — inject `env.MY_BUCKET` (native R2) directly.
- `webdav` (current) — inject `WebDAVStorage`, which reimplements that same shape over WebDAV HTTP verbs. No R2 binding; `wrangler.toml` has no bucket.

`src/services/WebDAVStorage.js` — translates the R2 interface to `GET` / `PUT` / `MKCOL` / `PROPFIND` / `DELETE`, parsing namespaced XML with `fast-xml-parser`. Notable constraints:
- The constructor's default `request` **must** stay wrapped as `(...args) => fetch(...args)`. Storing bare `fetch` as an instance property makes `this.request(...)` call it with the storage instance as receiver, and workerd throws `TypeError: Illegal invocation` — which `send()`'s catch then disguises as "WebDAV 请求失败或超时". Stub-injected tests cannot catch this; the dedicated receiver test does.
- All keys are confined to `i/`; `validate()` rejects traversal, control chars, backslashes, empty segments. `delete()` refuses to delete a collection.
- `redirect: 'manual'` everywhere — a redirect is an error, never followed, so credentials never leak to another host. XML with `<!DOCTYPE>` / `<!ENTITY>` is rejected (XXE guard).
- `put()` creates each missing parent dir via `MKCOL` (tolerating 405), then re-verifies via `PROPFIND` that a 405 was a real directory and not a same-named file.
- WebDAV has no snapshot pagination. `list()` does a Depth:1 walk, encoding a base64 JSON cursor `{ prefix, dirs, after }` (queue of pending dirs + last-seen file). Each call scans ≤35 directories and **may legitimately return an empty `objects` array with a non-null `cursor`** — callers must keep following the cursor.

`src/services/ImageService.js` (~1500 lines) — all business logic: the three upload paths (multipart, JSON/base64, raw binary), date-based path generation (`/i/YYYY/MM/DD/<8-char-base60-time-id><ext>` — 时分秒各 1 位 + 毫秒 2 位 + crypto 随机 3 位；目录日期与文件名时间同用 `TIMEZONE_OFFSET`，故 `ImageService` 的构造函数接收 `env` 作为第二个参数), MIME↔extension mapping, image fetch (passes through remote `Content-Type` / `ETag` / `Last-Modified`, caches 1 day), delete, `listImages` (auto-follows empty-but-cursor pages up to ~20 rounds so deep dirs aren't shown as "no images"), and `renderDashboard()` which returns the entire admin UI as an inline HTML string.

`src/middleware/AuthMiddleware.js` — static `Bearer` token check. Upload endpoints also accept the token as a `token` form/JSON field (for uPic and similar clients).

## Conventions (from spec.md)

- JavaScript ES Modules only. Follow SOLID.
- **Function-level doc comments are written in Chinese.** Match the existing bilingual style (Chinese comments, English identifiers).

## Endpoints

`GET /` dashboard · `POST /upload` (multipart `image`/`file`, or JSON base64, or raw binary) · `GET /i/{y}/{m}/{d}/{name}` fetch · `PUT /i/...` upload to explicit path · `GET /admin/list?limit&cursor&year&month&day` · `DELETE /admin/delete/{key}`.

## Verifying WebDAV changes

Beyond `npm test`: with real `.dev.vars`, upload a throwaway image, confirm the downloaded bytes match, check it appears in `/admin/list` and in a date-filtered query, then delete it and confirm a subsequent fetch returns 404.
