# CF-Photos

基于 Cloudflare Workers + R2 的高性能图床应用。

## 功能特性
- [x] 支持通过路径访问 R2 中的图片
- [ ] 支持图片列表展示 (计划中)

## 使用方法

### 展示图片
直接访问图片 URL：
`GET https://your-worker.workers.dev/i/2026/02/25/abc1234.jpeg`

### 上传图片
本项目支持三种上传方式,适配 uPic、curl 等多种客户端。所有上传接口均位于 `/upload`。

#### 1. Multipart (表单) 上传 (推荐,uPic 默认)
最常用的上传方式,支持原始文件名保持。
- **URL**: `POST /upload`
- **文件字段名**: `image` 或 `file`
- **其他字段**: 可选 `token` 用于鉴权
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
  "path": "/i/2026/02/25/random7.jpg",
  "url": "https://domain.com/i/2026/02/25/random7.jpg",
  "del": "",
  "thumb": ""
}
```

## 管理功能

### 获取图片列表
用于列出 R2 存储中 `i/` 目录下的所有图片。
- **URL**: `GET /admin/list`
- **鉴权**: 必须带上 `Authorization: Bearer your_secret_token`
- **参数**:
    - `limit`: (可选) 每次返回的数量,默认 50,最大 100。
    - `cursor`: (可选) 分页游标,用于获取下一页数据。
    - `year`: (可选) 按年份筛选,如 `2026`。
    - `month`: (可选) 按月份筛选,如 `02` (需配合 `year` 使用)。
    - `day`: (可选) 按日期筛选,如 `25` (需配合 `year` 和 `month` 使用)。
- **示例 (curl)**:
```bash
# 获取 2026 年 2 月 25 日的所有图片
curl -H "Authorization: Bearer your_secret_token" \
  "https://your-worker.workers.dev/admin/list?year=2026&month=02&day=25"
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

## 客户端配置 (以 uPic 为例)

根据 [uPic 自定义图床教程](https://blog.svend.cc/upic/tutorials/custom/)，配置如下：

1.  **API 地址**: `https://your-worker.workers.dev/upload`
2.  **请求方式**: `POST`
3.  **文件字段名**: `file`
4.  **请求头**:
    - `Authorization`: `Bearer your_secret_token`
5.  **URL 路径**: `["data", "url"]` (后端返回 JSON 结构为 `{"data": {"url": "..."}}`)
6.  **域名**: `https://your-worker.workers.dev` (用于拼接完整路径)

### 上传图片示例 (cURL)
#### 1. Form 数据上传 (uPic 模式)
```bash
curl -X POST -F "file=@wang.jpeg" \
  -H "Authorization: Bearer your_secret_token" \
  http://localhost:8788/upload
```

#### 2. 二进制流上传
```bash
curl -X POST --data-binary "@wang.jpeg" \
  -H "Authorization: Bearer your_secret_token" \
  -H "Content-Type: image/jpeg" \
  http://localhost:8788/upload
```

## 配置

### 1. R2 绑定
在 `wrangler.toml` 中配置：
```toml
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "photo-backup"
```

### 2. 鉴权 Token
在部署时，通过以下命令设置生产环境 Token：
```bash
npx wrangler secret put AUTH_TOKEN
```
本地开发时，可以在项目根目录创建 `.dev.vars` 文件：
```env
AUTH_TOKEN=your_secret_token
```

### 本地开发
1. 克隆仓库
2. 安装依赖: `npm install`
3. 本地预览: `npx wrangler dev`

### 部署
执行以下命令部署到 Cloudflare Workers:
```bash
npx wrangler deploy
```

## 配置
在 `wrangler.toml` 中配置 R2 绑定：
```toml
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "photo-backup"
```
