# CF-Photos

基于 Cloudflare Workers + WebDAV 的高性能图床应用。

## 功能特性
- [x] 支持通过路径访问 WebDAV 中的图片
- [x] 支持图片列表展示
- [x] 支持管理后台手动上传图片 (文件选择、拖拽 & 复制粘贴)

## 使用方法

### 展示图片 / 视频 / 音频
直接访问图片 URL：
`GET https://your-worker.workers.dev/i/2026/02/25/abc1234.jpeg`

读取接口对所有文件下发 `Content-Security-Policy: default-src 'none'; script-src 'none'; sandbox` 与 `X-Content-Type-Options: nosniff`。这是为了封掉存储型 XSS：后台页面与 `/i/...` 同源，而 Token 就存在浏览器的 localStorage 里，一旦上传的内容能在本站域名下执行脚本就等于把 Token 交出去。`sandbox` 只在响应被当作**文档打开**时生效，`<img>` / `<video>` / `<audio>` 这类子资源加载完全不受影响，因此内嵌显示与外站热链都照常工作。

### 上传文件
支持图片、视频与音频(扩展名由 `Content-Type` 或原始文件名推断)。图片/视频/音频的读取接口均支持 `Range` 请求,`<video>` / `<audio>` 可以正常拖拽定位。

会被浏览器当作网页打开的类型与后缀一律拒绝，返回 **415**：`text/html`、`application/xhtml+xml`、`xml` 与 `javascript` 系列，以及 `.html` / `.htm` / `.xhtml` / `.xht` / `.shtml` / `.xml` / `.xsl` / `.xslt` / `.js` / `.mjs` / `.cjs`。四条上传路径(multipart、JSON base64、裸二进制、`PUT /i/...`)都会检查，前端不做校验也拦得住。

**SVG 是允许的**——它是正当的图床格式,内嵌到 `<img>` 里本来就不执行脚本。直接用浏览器打开一个含 `<script>` 的 SVG 时,图形照常显示,但脚本被 `sandbox` 挡下(控制台会报 `Blocked script execution ... the document's frame is sandboxed`),而且此时页面处于不透明源,读 `localStorage` 会直接抛 `SecurityError`。

本项目支持三种上传方式,适配 uPic、curl 等多种客户端。所有上传接口均位于 `/upload`。

> **大小限制**：Multipart 与 JSON(Base64) 会把整个文件读进 Worker 内存，上限 **20 MB**，超出返回 413；这两种方式还要求带 `Content-Length`，分块传输返回 411。二进制流式上传（裸二进制 `POST` / `PUT /i/...`）不经过内存、**不受此限制**，只受 Cloudflare 套餐的请求体上限约束（Free/Pro 100 MB、Business 200 MB、Enterprise 更高，超限由边缘直接返回 413）。
>
> 更上层还有 Cloudflare 按账户套餐在边缘强制的单次请求体上限，超限请求根本到不了 Worker。后台会在上传前按 `MAX_UPLOAD_MB`（`wrangler.toml` 中配置，默认 95）预检并直接给出提示，换套餐时改这个值即可。
>
> 20 MB 覆盖除 ProRAW 外的全部 iPhone 原图（12MP HEIC 约 2~4 MB、48MP HEIF Max 约 6~8 MB、全景图 10~25 MB）。ProRAW（12MP 约 25 MB、48MP 约 75 MB）**只能走流式上传**。

#### 1. Multipart (表单) 上传 (推荐,uPic 默认)
最常用的上传方式,支持原始文件名保持。
- **URL**: `POST /upload`
- **文件字段名**: `image` 或 `file`
- **其他字段**: 可选 `token` 用于鉴权
- **大小上限**: 20 MB
- **示例 (curl)**:
```bash
curl -X POST -F "image=@photo.jpg" \
  -H "Authorization: Bearer your_secret_token" \
  https://your-worker.workers.dev/upload
```

#### 2. JSON (Base64) 上传 (uPic 勾选"使用 Base64")
当客户端将图片转为 Base64 字符串并封装在 JSON 中发送时使用。
- **URL**: `POST /upload`
- **Content-Type**: `application/json`
- **JSON 结构**: `{"image": "Base64数据...", "token": "your_secret_token"}`
- **示例 (curl)**:
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"image": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "token": "your_secret_token"}' \
  https://your-worker.workers.dev/upload
```

#### 3. 二进制流上传
直接将图片二进制数据放在请求体中发送。
- **URL**: `POST /upload` 或 `PUT /i/{year}/{month}/{day}/{filename}` (PUT 方式支持自定义路径)
- **大小上限**: 无 20 MB 限制,body 流式透传给 WebDAV,大文件请用这种方式
- **可选请求头**: `X-Upload-Filename` 传原始文件名(需 URL 编码),服务端据此保留后缀;不传则按 `Content-Type` 推断
- **示例 (curl)**:
```bash
curl -X POST --data-binary "@photo.jpg" \
  -H "Authorization: Bearer your_secret_token" \
  -H "Content-Type: image/jpeg" \
  https://your-worker.workers.dev/upload
```

---

### 响应格式 (JSON)
所有上传方式成功后均返回以下格式的 JSON:
```json
{
  "result": "success",
  "code": 200,
  "srcName": "original_filename.jpg",
  "path": "/i/2026/02/25/FHZ9LuQq.jpg",
  "url": "https://domain.com/i/2026/02/25/FHZ9LuQq.jpg",
  "del": "",
  "thumb": ""
}
```

## 管理功能

### 获取文件列表
用于列出 WebDAV 存储中 `i/` 目录下的所有文件。
- **URL**: `GET /admin/list`
- **鉴权**: 必须带上 `Authorization: Bearer your_secret_token`
- **参数**:
    - `limit`: (可选) 每次返回的数量,默认 50,最大 100。
    - `cursor`: (可选) 分页游标,用于获取下一页数据。
    - `year`: (可选) 按年份筛选,如 `2026`。
    - `month`: (可选) 按月份筛选,如 `02` (需配合 `year` 使用)。
    - `day`: (可选) 按日期筛选,如 `25` (需配合 `year` 和 `month` 使用)。
    - `order`: (可选) 排序方向,`desc` 最新在前 (默认) / `asc` 最早在前。由于文件名是时间序 ID,排序在目录与文件名两级同时生效。切换方向后必须从空游标重新开始,沿用旧游标会返回 `无效的分页游标`。
- **示例 (curl)**:
```bash
# 获取 2026 年 2 月 25 日的所有图片
curl -H "Authorization: Bearer your_secret_token" \
  "https://your-worker.workers.dev/admin/list?year=2026&month=02&day=25"
```
```bash
# 按上传时间正序取最早的 20 张
curl -H "Authorization: Bearer your_secret_token" \
  "https://your-worker.workers.dev/admin/list?limit=20&order=asc"
```
- **响应 (JSON)**:
```json
{
  "result": "success",
  "data": {
    "images": [
      {
        "key": "i/2026/02/25/abc1234.jpg",
        "url": "https://domain.com/i/2026/02/25/abc1234.jpg",
        "size": 102400,
        "uploaded": "2026-02-25T15:00:00.000Z"
      }
    ],
    "cursor": "...",
    "count": 1
  }
}
```

> 注意：WebDAV 没有快照式分页，某一页可能返回空 `images` 却仍带非空 `cursor`（本轮扫描的目录里恰好没有文件）。调用方需要继续沿游标翻页，不能据此判定「没有图片」。

### 获取筛选目录
列出 WebDAV 中真实存在的年 / 月 / 日目录，供后台的三级筛选下拉框使用。
- **URL**: `GET /admin/dirs`
- **鉴权**: 必须带上 `Authorization: Bearer your_secret_token`
- **参数**:
    - 不传参数: 返回所有年份。
    - `year`: 返回该年份下存在的月份。
    - `year` + `month`: 返回该月份下存在的日期。
- **示例 (curl)**:
```bash
# 列出 2026 年 9 月有图片的日期
curl -H "Authorization: Bearer your_secret_token" \
  "https://your-worker.workers.dev/admin/dirs?year=2026&month=09"
```
- **响应 (JSON)**: 目录名按降序排列。
```json
{
  "result": "success",
  "code": 200,
  "data": { "dirs": ["21", "08"] }
}
```

## 客户端配置 (以 uPic 为例)

根据 [uPic 自定义图床教程](https://blog.svend.cc/upic/tutorials/custom/)，配置如下：

1.  **API 地址**: `https://your-worker.workers.dev/upload`
2.  **请求方式**: `POST`
3.  **文件字段名**: `file`
4.  **请求头**:
    - `Authorization`: `Bearer your_secret_token`
5.  **URL 路径**: `["url"]` (后端返回 JSON 结构为 `{"url": "..."}`)
6.  **域名**: `https://your-worker.workers.dev` (用于拼接完整路径)

> 鉴权说明：`Authorization` 头优先，且在解析请求体**之前**校验——带了头但 token 不对会直接返回 401，不会先把文件读进内存。仅在完全不带 `Authorization` 头时，才回落到 `token` 表单 / JSON 字段（供只能这样传参的客户端使用）。因此**不要同时**带一个错误的头和一个正确的 `token` 字段，那会被拒绝。

### 上传图片示例 (cURL)
#### 1. Form 数据上传 (uPic 模式)
```bash
curl -X POST -F "file=@wang.jpeg" \
  -H "Authorization: Bearer your_secret_token" \
  http://localhost:8787/upload
```

#### 2. 二进制流上传
```bash
curl -X POST --data-binary "@wang.jpeg" \
  -H "Authorization: Bearer your_secret_token" \
  -H "Content-Type: image/jpeg" \
  http://localhost:8787/upload
```

## MCP 服务端

`POST /mcp` 以 [Model Context Protocol](https://modelcontextprotocol.io/) 暴露一个 `upload_image` 工具，让 Claude Code、Claude Desktop 等 MCP 客户端可以直接把图片存进本图床并拿到公开 URL，不必再由人转述 curl。

- **传输**：Streamable HTTP，无状态。只接受 `POST`，永远返回单个 JSON-RPC 响应，不使用 SSE，也不下发会话 id。`GET` / `DELETE` 返回 405，`OPTIONS` 返回 CORS 预检。
- **协议版本**：对外声明 `2025-11-25`，可回显 `2025-06-18` / `2025-03-26`。
- **鉴权**：`Authorization: Bearer <AUTH_TOKEN>`，与 `/admin/*` 同一个 token；也接受 OAuth 访问令牌（见下方「接入 claude.ai 网页版」）。**未配置 `AUTH_TOKEN` 时该端点返回 503**，而不是像其它端点那样放行——一个无鉴权的 MCP 端点等于把「由模型远程驱动的服务端抓取器 + 公开写入原语」暴露给所有人。

### 工具 `upload_image`

两个参数二选一，必须且只能给一个：

| 参数 | 说明 |
| --- | --- |
| `source_url` | 图片的公网 HTTPS 地址，由服务端自行下载 |
| `image_base64` | 图片的 base64 或 `data:image/png;base64,...` 形式的 data URL |

支持 JPEG / PNG / GIF / WebP / AVIF / HEIC / BMP / TIFF / ICO，单张不超过 20 MB。**只接受图片**——虽然图床本身支持视频与音频，这个工具刻意不开放它们。**不接受 SVG**：存下来后由本站域名提供服务会构成对后台页面的存储型 XSS。

`source_url` 的限制：只接受公网 HTTPS **域名**地址；拒绝 IP 直连（含十进制 / 十六进制变形与 IPv6 字面量）、`localhost`、`.local` / `.internal` 等保留域名、带用户名密码的 URL，以及指向本站自己的地址；不跟随重定向（3xx 直接报错，请给出跳转后的最终地址）；出站请求不携带任何客户端请求头。

工具执行失败（地址被拦、类型不支持、超限等）返回的是正常的 JSON-RPC 响应加 `isError: true`，错误文案是中文，供模型读懂后自行改正重试。

### 接入 Claude Code

```bash
claude mcp add --transport http cf-photos https://your-worker.workers.dev/mcp \
  --header "Authorization: Bearer your_secret_token"
```

本地开发（先跑 `npm run dev -- --ip 127.0.0.1`）：

```bash
claude mcp add --transport http cf-photos-dev http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer your_secret_token"
```

`--header` 的值含空格，必须加引号。加 `--scope user` 可在所有项目里使用。用 `claude mcp list` 或会话内的 `/mcp` 查看连接状态与工具列表。

### 接入 claude.ai 网页版 / 手机端

claude.ai 的自定义连接器**不支持填写静态 `Authorization` 头**（那是 beta 白名单功能），只认 OAuth，所以本项目自带一套 OAuth 2.1 授权服务端，无需任何额外绑定或依赖。

在 claude.ai 里 **Customize → Connectors → Add custom connector**，URL 填 `https://your-worker.workers.dev/mcp`，其余留空直接添加（OAuth 客户端会自动注册）。点 Connect 后会跳到本图床的授权页，粘贴 `AUTH_TOKEN` 即可完成授权。

> 必须是已部署的公网 HTTPS 地址，claude.ai 连不上 `127.0.0.1`。

几点须知：

- 授权页的口令就是 `AUTH_TOKEN` 本身——图床只有一个主人，不另设账号体系。
- 令牌无状态：内容签在令牌里，用 `AUTH_TOKEN` 派生的密钥做 HMAC，服务端不存任何东西。因此**无法单独吊销某一枚令牌**；要全部作废就换 `AUTH_TOKEN`，此前签发的一切（含已注册的客户端）同时失效，各端重新授权即可。
- 回调地址白名单只放行 `claude.ai` / `claude.com` 与本机回环地址，别的一律在注册阶段就拒掉。
- 访问令牌 30 天、刷新令牌 90 天、授权码 10 分钟；授权强制 PKCE（S256）。
- Claude Code、Claude Desktop 不受影响，继续用 `--header "Authorization: Bearer ..."` 直连即可，两种凭据并存。

### 接入 ChatGPT

ChatGPT 的自定义 MCP 连接器**只支持 OAuth**，连「无认证」和 API key 都不给选，所以同样走上面这套。先在设置里打开 developer mode，然后新建插件：**连接**填 `https://your-worker.workers.dev/mcp`，**身份验证**选 `OAuth`，其余留空（客户端自动注册）。连接时会跳到本图床的授权页，粘贴 `AUTH_TOKEN` 即可。

- 回调地址白名单已包含 `chatgpt.com` 的两种形态（`/connector_platform_oauth_redirect` 与每连接一个的 `/connector/oauth/{callback_id}`）。
- 服务端声明了 RFC 9207 的 `authorization_response_iss_parameter_supported` 并在每个授权响应里回带 `iss`，因此 ChatGPT 会使用稳定的那个回调地址。
- ChatGPT 会按 RFC 8707 传 `resource`；指向本站 MCP 地址以外的值一律以 `invalid_target` 拒绝。
- `upload_image` 是写操作，developer mode 下每次调用可能要你确认。deep research / company knowledge 模式要求服务端提供 `search` / `fetch` 两个工具，本图床不提供，那两个模式用不了。

### 直接用 cURL 调试

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer your_secret_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## WebDAV 配置与开发

`webdav` 分支使用 WebDAV 存储，不需要 R2 绑定。接口路径和管理后台保持兼容。

1. 执行 `npm ci` 安装依赖（Node.js 22 或更高版本）。
2. 将 `.dev.vars.example` 复制为 `.dev.vars`，填写 WebDAV 地址、用户名、密码和应用管理 Token。
3. 执行 `chmod 600 .dev.vars`。该文件已被 Git 忽略，切勿提交实际凭据。
4. 执行 `npm run dev -- --ip 127.0.0.1`，打开 http://127.0.0.1:8787。

`WEBDAV_URL` 必须是 HTTPS 根地址，例如 `https://example.com/dav`。图片 `/i/2026/09/08/example.png` 对应远端 `/dav/i/2026/09/08/example.png`。上传会逐级创建缺失目录；本地开发也会读写真实 WebDAV。

`AUTH_TOKEN` 用于保护应用上传、列表和删除接口；与 WebDAV 密码相互独立。WebDAV 凭据只由 Worker 发送给配置的服务，不发给浏览器。请始终设置管理 Token。

`TIMEZONE_OFFSET` 决定上传路径 `/i/YYYY/MM/DD/` 的日期和文件名中的时间，默认 `8`（东八区），支持 `5.5`、`-3` 这类取值（范围 -12 ~ 14），留空或非法时回退到 8。它不是敏感信息，配置在 `wrangler.toml` 的 `[vars]` 里，改完重新 `npm run deploy` 生效；本地可在 `.dev.vars` 中覆盖。Workers 运行时时区恒为 UTC，所有本地时间都由该偏移换算得出。

### 部署

在 Cloudflare 中分别设置以下 secrets（交互输入实际值）：

```bash
npx wrangler secret put WEBDAV_URL
npx wrangler secret put WEBDAV_USERNAME
npx wrangler secret put WEBDAV_PASSWORD
npx wrangler secret put AUTH_TOKEN
npm run deploy
```

`.dev.vars` 不会作为生产 secrets 部署。此分支移除了 R2 绑定，不会迁移原 R2 图片；旧图片需另行复制到 WebDAV 的同名路径。

### 每日增量备份

`scripts/webdav-backup.sh` 把 WebDAV 上的 `i/` 目录镜像到本地，只依赖 `bash` 和 `curl`，从同一份 `.dev.vars` 读取凭据（凭据写进 600 权限的临时 curl 配置文件，不出现在命令行里）。

```bash
scripts/webdav-backup.sh -c .dev.vars -d ~/cf-photos-backup --dry-run  # 先看会下载什么
scripts/webdav-backup.sh -c .dev.vars -d ~/cf-photos-backup            # 实际备份
```

增量分两层：目录级只遍历「上次成功日期 − `GRACE_DAYS`（默认 2 天）」之后的 `年/月/日` 目录；文件级跳过本地已存在且字节数与远端一致的文件，因此中断后重跑即为续传。任何文件失败都不会推进 `.backup-state/last-success`，下次仍会重扫这段区间。

常用选项：`--full` 全量遍历，`--since 2026-01-01` 指定起点，`--prune` 把远端已删除的文件移入 `.trash/`（隐含 `--full`，按 `TRASH_KEEP_DAYS` 天过期后才真正删除），`--dry-run` 只报告，`-q` 静默。状态与日志在备份目录下的 `.backup-state/`（`backup.log`、`manifest.txt`、`last-success`），并用锁目录防止并发运行。

每天跑一次（crontab）：

```bash
20 3 * * * /path/to/cf-photos/scripts/webdav-backup.sh -c /path/to/.dev.vars >/dev/null 2>&1
```

macOS 用 launchd 的 plist 示例见 `scripts/webdav-backup.sh --help`。

### 实现与验证

- `src/services/WebDAVStorage.js` 封装 GET、PUT、MKCOL、PROPFIND 和 DELETE，使用 `fast-xml-parser` 解析命名空间 XML。
- 列表使用 Depth:1 逐级遍历，通过游标继续当前目录；每页最多扫描 35 个目录，可能返回空列表但仍带有下一页游标。WebDAV 没有快照分页，并发修改时应刷新列表。
- 管理后台遇到「空列表但有游标」时会自动带游标继续请求（单次操作最多 20 轮），因此深层目录不会被误显示为“暂无图片”；仍未找到时保留“加载更多”按钮供继续扫描。
- 年份、月份、日期筛选直接缩小远端目录范围；大图库推荐按日期筛选，减少网络请求。
- 图片响应保留远端 ETag 和 Last-Modified，并缓存一天；删除后已有客户端缓存可能继续有效。
- Content-Type 大体沿用远端返回值，但有两处调整：远端不回类型或只回 `application/octet-stream` 时，按文件后缀回填规范类型（`nosniff` 会禁掉浏览器嗅探，不回填会让这类文件显示不出来）；类型或后缀属于文档类、或回填后仍识别不出时，改写为 `application/octet-stream` 并加 `Content-Disposition: attachment`。
- 注意 WebDAV 后端可能自行按后缀重新推导 Content-Type 而忽略上传时声明的值（Apache 系的后端就是如此），因此**文件后缀才是决定浏览器如何处理的关键**。
- 图片路径限制在 `i/`，拒绝目录穿越；删除接口禁止删除目录。WebDAV 重定向不会自动跟随，避免凭据发往其他地址。
- 执行 `npm test` 验证协议适配、分页、路径和错误处理；执行 `npx wrangler deploy --dry-run` 验证 Worker 打包。
- 真实验证应上传独立测试图片，核对下载字节、列表及日期筛选，再删除该测试图片并确认返回 404。
