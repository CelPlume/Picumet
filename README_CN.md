<div align="center">

<img src="assets/logo.svg" alt="Picumet Logo" width="128" />

# Picumet

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002.svg)](https://hono.dev/)
[![React](https://img.shields.io/badge/React-18-61DAFB.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF.svg)](https://vitejs.dev/)
[![D1](https://img.shields.io/badge/D1-SQLite-9E4CFF.svg)](https://developers.cloudflare.com/d1/)
[![R2](https://img.shields.io/badge/R2-S3%20Compatible-0B7ECF.svg)](https://developers.cloudflare.com/r2/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://www.docker.com/)

**多云对象存储管理平台**

[English](README.md) | 中文

</div>

Picumet 是一个多云对象存储管理平台,提供统一的文件管理界面和细粒度权限控制,支持分享链接与 PicGo/PicList 接入,整体运行在 Cloudflare 边缘网络。

## 环境要求

- Node.js 22 或更高版本
- [bun](https://bun.sh/) 1.3 或更高版本,本项目统一用 bun 管理依赖
- 若部署到生产环境,需要一个 Cloudflare 账号

## 本地开发

1. 安装后端依赖

   ```sh
   cd workers
   bun install
   ```

2. 安装前端依赖

   ```sh
   cd ../frontend
   bun install
   ```

3. 配置环境变量

   ```sh
   cp workers/.dev.vars.example workers/.dev.vars
   ```

4. 启动 Workers API,监听 8787 端口

   ```sh
   cd workers
   bun run dev
   ```

5. 首次启动时初始化数据库

   ```sh
   bunx wrangler d1 execute picumet-db --local --file=migrations/0001_initial.sql
   ```

6. 启动前端,开发服务器监听 5173 端口,并把 `/api` 代理到 8787

   ```sh
   cd frontend
   bun run dev
   ```

前端地址 `http://localhost:5173`,API 地址 `http://localhost:8787`。

种子账号(仅限开发环境):

| 角色 | 账号 | 密码 |
| :--- | :--- | :--- |
| 管理员 | `admin` | `admin123456` |
| 演示用户 | `demo` | `demo123456` |

生产环境通过 `ADMIN_PASSWORD` 注入管理员密码,长度至少 12 位,代码不内置固定默认凭据。

## 运行测试

```sh
cd workers && bun run test            # 后端 127 项
cd workers && bun run typecheck       # 后端类型检查
cd frontend && bun run test           # 前端 7 项
cd frontend && bun run test:coverage  # 前端覆盖率门禁,安全关键模块不低于 80%
cd frontend && bun run typecheck      # 前端类型检查
cd frontend && bun run build          # 前端构建
```

CI 在每次 push 或 PR 到 `main` 时执行依赖安装、类型检查、测试和覆盖率门禁,不自动部署。部署统一走 `wrangler deploy` 或 Cloudflare 侧自动部署。

## 功能概览

| 类别 | 说明 |
| :--- | :--- |
| 认证 | 注册、登录(HttpOnly Cookie + JWT)、邮箱验证、密码找回。 |
| 权限 | 管理员/用户/访客三级角色、路径级 ACL、文件与路径密码。 |
| 文件 | 卡片/列表视图、单文件与分片上传、断点续传、硬删除、重命名、移动(Saga)、批量操作、搜索、排序。 |
| 预览 | 图片缩放/旋转、视频/音频播放、代码高亮(highlight.js,预先转义)。文件卡片带视频缩略图和文件夹内部预览。 |
| 复制链接 | 多文件弹窗,支持直链/HTML/Markdown/BBCode,公开直链或签名直链。 |
| 分享 | 密码、过期时间、下载次数限制、公开页、二维码。 |
| 外观 | 浅色/深色/跟随系统、强调色(动态前景色)、模糊效果、图片/URL 背景、文件夹显示开关、自定义文件 emoji。 |
| API 密钥 | `pk_x.sk_y` 不透明令牌(只存哈希)、IP 白名单、WebDAV Basic 认证、PicGo 上传接口 `/api/upload`。 |
| 管理后台 | 仪表板、用户、配额、存储源、挂载点、权限规则、分享、文件、日志、系统设置。 |
| 自由模式 | 用户自带对象存储凭据的临时会话,凭据用 AES-256-GCM 加密写入 KV,短 TTL。 |
| 安全 | CSP、CSRF Token、速率限制(fail-closed)、路径遍历防护、危险文件拦截、SSRF 校验、SQL 参数化、下载令牌原子消费。 |

## 架构原则

按业务领域组织代码,不按技术层次。

- 后端业务代码放在 `workers/src/services/<domain>/`,每个服务自包含 `handlers.ts`、`schemas.ts`、`types.ts`、领域逻辑和 `README.md`。`index.ts` 只负责路由与中间件装配。
- 所有服务依赖权限服务做鉴权,依赖存储服务访问对象,避免循环依赖。
- 中间件(`auth`、`csrf`、`rate-limit`)、数据层(`db/repos/`)、工具(`utils/`)和公共契约(`shared/`)属于薄基础设施层,不承载业务。
- 前端遵循同样规则。`pages/` 每个路由一个页面,页面内的子功能收进 `components/files/` 和 `components/layout/`,`components/ui/` 只放可复用的 UI 原语。

完整设计见[架构文档](docs/ARCHITECTURE_CN.md),范围与进度见[进度文档](docs/PROGRESS.md)。

## 项目结构

```
picumet/
├── assets/logo.svg          # 品牌标识
├── frontend/                # React 应用(Vite + TypeScript + Tailwind)
│   └── src/
│       ├── pages/           # 每个路由一个页面
│       ├── components/      # files/ · layout/ · ui/
│       ├── lib/             # api · utils · i18n
│       └── stores/          # theme · auth · site
├── workers/                 # Cloudflare Workers API(Hono + D1/KV/R2)
│   └── src/
│       ├── services/        # auth · files · uploads · shares · storage · webdav · ...
│       ├── middleware/      # auth · csrf · rate-limit · global
│       ├── db/repos/        # D1 数据访问层
│       ├── utils/           # path · crypto · ssrf · smtp
│       └── shared/          # schemas · types · errors · response
├── shared/                  # 前后端共享类型
└── docs/                    # 文档
```

## 文档

| 指南 | 内容 |
| :--- | :--- |
| [系统架构](docs/ARCHITECTURE_CN.md) | 服务设计、数据模型、安全设计。 |
| [API 参考](docs/API_CN.md) | 认证、全部端点、错误码。 |
| [前端指南](docs/UI_CN.md) | 路由、布局、响应式、无障碍。 |
| [开发指南](docs/DEVELOPMENT_CN.md) | 本地环境、测试、代码规范。 |
| [部署指南](docs/DEPLOYMENT_CN.md) | Cloudflare 部署、CI、密钥管理。 |
| [实施进度](docs/PROGRESS.md) | 范围、状态、审计闭环。 |

## 下一步

- 阅读[架构文档](docs/ARCHITECTURE_CN.md)了解服务设计。
- 按上面的步骤搭建本地环境。
- 在[进度文档](docs/PROGRESS.md)中查看计划中的工作,例如 Oracle 存储提供商和路径变量 DSL。
