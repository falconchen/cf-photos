# Cloudflare WebDAV 图床应用规格说明书 (Spec)

## 项目简介
本项目是一个基于 Cloudflare Workers 和 WebDAV 存储的图床应用。初始阶段主要功能是：
- [x] 支持通过路径访问 WebDAV 中的图片
- [x] 支持图片列表展示
- [x] 支持管理后台手动上传图片 (文件选择 & 拖拽)

## 系统架构
- **后端**: Cloudflare Workers (JavaScript)
- **存储**: WebDAV（通过 HTTPS 连接，配置根目录下的 `i/`）

## 图片路径规则
图片存储在 WebDAV 的 `i/` 目录下，按日期分级，例如：
`/i/2022/05/12/FHZ9LuQq.jpeg`
其中文件名是 8 位 Base60 字符（本地时间的时、分、秒各 1 位 + 毫秒 2 位 + 强随机 3 位），因此同一天内文件名按上传时间递增。目录日期与文件名时间都按环境变量 `TIMEZONE_OFFSET`（小时，默认 8）换算。

## API 设计

### 1. 获取图片接口
- **URL**: `GET /i/{year}/{month}/{day}/{filename}`
- **描述**: 根据路径从 WebDAV 读取并返回图片内容。
- **响应**: 
  - 成功: 返回图片二进制流，`Content-Type` 为对应的图片类型。
  - 安全头: 恒定下发 `Content-Security-Policy: default-src 'none'; script-src 'none'; sandbox` 与 `X-Content-Type-Options: nosniff`，防止上传内容在本站域名下执行脚本；无法识别或属于文档类的类型改写为 `application/octet-stream` + `Content-Disposition: attachment`。
  - 失败 (文件不存在): 返回 404 Not Found。
  - 失败 (系统错误): 返回 500 Internal Server Error。

### 2. 上传图片接口
- **URL**: `POST /upload`
- **描述**: 上传图片，后端自动生成基于日期与时间的路径。
- **验证**: 需要在 Header 中包含 `Authorization: Bearer <your_token>`。
- **请求体**: 图片二进制数据。
- **响应**:
  - 成功: 返回 201 Created，JSON 包含图片访问 URL。
  - 失败: 返回 401 Unauthorized 或 500 Internal Server Error。

### 3. 管理后台
- **功能**: 展示图片列表、删除图片、年份筛选、**手动上传图片**。
- **上传方式**: 支持点击按钮触发弹窗，通过文件选择、拖拽或复制粘贴上传。

### 4. MCP 接口
- **URL**: `POST /mcp`
- **传输**: Streamable HTTP，无状态，只返回 JSON 响应，不使用 SSE，不下发会话 id。
- **协议版本**: 声明 `2025-11-25`，兼容 `2025-06-18` / `2025-03-26`。
- **验证**: 需要在 Header 中包含 `Authorization: Bearer <your_token>`；未配置 `AUTH_TOKEN` 时返回 503。
- **工具**: `upload_image`，参数 `source_url` 与 `image_base64` 二选一，只接受图片、不接受 SVG。
- **响应**: 单个 JSON-RPC 响应；通知返回 202；`GET` / `DELETE` 返回 405；`OPTIONS` 返回 CORS 预检。

- 语言: JavaScript (ES Modules)
- 遵循 S.O.L.I.D 原则。
- 函数级别注释使用中文。
- 使用 `wrangler` 进行部署和管理。
