# flybase

基于 **Cloudflare Workers** + **Filebase**（S3 兼容的去中心化对象存储）构建的私有网盘应用。

## 特性

- 文件上传、下载、删除、分享
- 目录（前缀）导航
- 分享链接使用 Filebase 预签名 URL，可设置有效期
- 零服务器，边缘运行，静态资源由 Cloudflare Workers Assets 直接托管

## 架构

```
浏览器 ──► Cloudflare Workers (API + 静态页面)
                │  (S3 API, SigV4)
                ▼
        Filebase (S3-compatible bucket)
```

- `src/index.js` — Worker 入口与 API 路由
- `src/s3.js` — Filebase S3 客户端封装（列表/上传/下载/删除/预签名链接）
- `public/` — 前端网盘页面（纯静态）

## 快速开始

### 1. 准备 Filebase

1. 注册 Filebase 并创建 Bucket
2. 在 Access Keys 中创建一对 Access Key / Secret Key
3. 记录 Bucket 名称

### 2. 配置

在 `wrangler.toml` 中设置 Bucket：

```toml
[vars]
FILEBASE_BUCKET = "your-bucket-name"
```

安装依赖并写入密钥（敏感信息不入库）：

```bash
npm install
npx wrangler secret put FILEBASE_ACCESS_KEY
npx wrangler secret put FILEBASE_SECRET_KEY
```

本地开发可复制 `.dev.vars.example` 为 `.dev.vars` 填入密钥。

### 3. 本地运行

```bash
npm run dev
```

### 4. 部署

```bash
npm run deploy
```

部署后 Worker 的地址即为网盘访问入口。

## API

| 方法   | 路径                          | 说明                       |
|--------|-------------------------------|----------------------------|
| GET    | `/api/objects?prefix=<prefix>` | 列出对象                   |
| PUT    | `/api/objects/<key>`           | 上传（请求体为文件内容）   |
| GET    | `/api/objects/<key>`           | 下载                       |
| DELETE | `/api/objects/<key>`           | 删除                       |
| GET    | `/api/objects/<key>/share?expires=<秒>` | 生成预签名分享链接 |

`<key>` 需要 URL 编码（含路径分隔符 `/`）。

## 安全提示

- Filebase 密钥通过 `wrangler secret` 注入，不会出现在仓库中
- 如需多用户或访问鉴权，可在 Worker 内增加 Token / 密码校验
