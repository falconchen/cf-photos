# Cloudflare R2 图床应用规格说明书 (Spec)

## 项目简介
本项目是一个基于 Cloudflare Workers 和 R2 存储的图床应用。初始阶段主要功能是展示存储在 R2 中的图片。

## 系统架构
- **后端**: Cloudflare Workers (JavaScript)
- **存储**: Cloudflare R2 (Bucket: `photo-backup`)

## 图片路径规则
图片存储在 R2 的 `i/` 目录下，按日期分级，例如：
`/i/2022/05/12/12n4yjt.jpeg`
其中文件名 `12n4yjt` 是随机生成的 7 位字符。

## API 设计

### 1. 获取图片接口
- **URL**: `GET /i/{year}/{month}/{day}/{filename}`
- **描述**: 根据路径从 R2 读取并返回图片内容。
- **响应**: 
  - 成功: 返回图片二进制流，`Content-Type` 为对应的图片类型。
  - 失败 (文件不存在): 返回 404 Not Found。
  - 失败 (系统错误): 返回 500 Internal Server Error。

### 2. 上传图片接口
- **URL**: `POST /upload`
- **描述**: 上传图片，后端自动生成基于日期的随机路径。
- **验证**: 需要在 Header 中包含 `Authorization: Bearer <your_token>`。
- **请求体**: 图片二进制数据。
- **响应**:
  - 成功: 返回 201 Created，JSON 包含图片访问 URL。
  - 失败: 返回 401 Unauthorized 或 500 Internal Server Error。

## 开发规范
- 语言: JavaScript (ES Modules)
- 遵循 S.O.L.I.D 原则。
- 函数级别注释使用中文。
- 使用 `wrangler` 进行部署和管理。
