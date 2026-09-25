<div align="center">

<img src="../assets/logo.svg" alt="Picumet Logo" width="128" />

# 开发指南

**多云对象存储管理平台**

[English](DEVELOPMENT.md) | 中文

</div>

本文介绍 Picumet 的本地开发流程:环境准备、测试、代码规范,以及容易踩坑的地方。假设你已经克隆了仓库,内容围绕 `workers/` 与 `frontend/` 两个目录展开。

## 开始之前

先安装以下工具。

| 工具 | 版本 | 用途 |
| :--- | :--- | :--- |
| Node.js | 22 及以上 | 构建工具链的运行时 |
| bun | 1.3 及以上 | `workers/` 与 `frontend/` 的包管理器(`packageManager: bun@1.3.14`) |
| wrangler | 4 及以上 | Cloudflare Workers 命令行工具,用于本地调试 API |

如果还没装 bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

项目统一使用 bun,不要混入 npm、pnpm 或 yarn 的锁文件。

## 搭建本地环境

### 安装依赖

准备两个终端。第一个安装 API 依赖,第二个安装前端依赖:

```bash
cd workers && bun install
cd ../frontend && bun install
```

### 配置环境变量

复制示例文件,再改掉本地开发需要的值:

```bash
cp workers/.dev.vars.example workers/.dev.vars
```

至少把 `JWT_SECRET` 和 `ENCRYPTION_KEY` 换成独立的值。文件里已带好 SMTP、Turnstile、初始管理员等配置的开发默认值。

### 应用数据库迁移

对本地 D1 数据库执行迁移:

```bash
cd workers
bunx wrangler d1 migrations apply picumet-db --local
```

该命令会按顺序应用 `workers/migrations/` 下所有待执行的迁移。新迁移文件按 `NNNN_description.sql` 命名,保证执行顺序稳定。

### 启动 API

在 `workers/` 目录启动 Workers API:

```bash
cd workers && bun run dev
```

API 监听在 `http://localhost:8787`。

### 启动前端

在第二个终端进入 `frontend/` 启动前端开发服务器:

```bash
cd frontend && bun run dev
```

前端监听在 `http://localhost:5173`。Vite 会把 `/api/*` 和 `/webdav/*` 代理到 `http://localhost:8787`,本地不需要配置 CORS。

### 验证环境

打开下面的地址:

- 前端:`http://localhost:5173`
- API:`http://localhost:8787`

首次启动时,`workers/src/seed.ts` 会创建默认管理员、演示用户、默认 R2 Provider 和根挂载点,并生成演示文件夹。种子只在 KV 键 `seed:done` 未设置时执行一次。

开发种子账号:

| 角色 | 用户名 | 密码 |
| :--- | :--- | :--- |
| 管理员 | `admin` | `admin123456` |
| 演示用户 | `demo` | `demo123456` |

开发密码可用 `.dev.vars` 里的 `ADMIN_PASSWORD`、`DEMO_PASSWORD` 覆盖。生产环境必须提供强 `ADMIN_PASSWORD`;没有它时,种子不会创建管理员,业务 API 会一直返回 `503`,直到初始化完成。

## 运行测试与类型检查

以下命令都在各自包目录下执行。

| 任务 | 命令 | 目录 |
| :--- | :--- | :--- |
| 后端测试 | `bun run test` | `workers/` |
| 后端类型检查 | `bun run typecheck` | `workers/` |
| 前端测试 | `bun run test` | `frontend/` |
| 前端覆盖率门禁 | `bun run test:coverage` | `frontend/` |
| 前端类型检查 | `bun run typecheck` | `frontend/` |
| 前端构建 | `bun run build` | `frontend/` |

后端测试跑在内存版 `node:sqlite` 模拟的 D1/KV/R2 上(见 `tests/helpers.ts`),不依赖 `workerd`;前端测试外加覆盖率门禁,聚焦安全关键模块 `src/lib/escape.ts` 与 `src/pages/Register.tsx`(lines 80%、functions 60%、branches 40%)。

`.github/workflows/ci.yml` 在推送到 `main` 或发起 PR 时运行。`workers` job 执行安装、类型检查和测试;`frontend` job 在此基础上增加覆盖率门禁和生产构建。CI 只做质量门禁,不自动部署,发布统一手动执行 `wrangler deploy`。

### 本地验收脚本（跨系统行为）

单元测试跑在内存环境里,覆盖不到「真实 D1 + 真实 R2 绑定 + 定时任务」的组合行为。仓库根目录 `scripts/` 提供两个 Python 验收脚本(仅标准库 + `wrangler` CLI),对**本地开发栈**做端到端断言:

| 脚本 | 验收内容 | 关键断言 |
| :--- | :--- | :--- |
| `scripts/verify-content-addressing.py` | §F 内容哈希寻址 | 同内容两处上传只产生一份物理对象、两行共享物理键/内容哈希、读回一致;删其一保留对象、删净后入 `blob_gc`;保护期满触发定时任务后对象删除、队列清空;覆盖写把旧内容入队 |
| `scripts/verify-storage-failover.py` | §G 读路径容灾(拼好桶/副桶) | 文件落桶为「坏主桶」(不可达 S3 端点)时,首次读取在 8s 候选超时后由同挂载点的 R2 成员返回 200;第二次读取走 `serve:loc` 提示显著更快 |

前置与用法:

```bash
# 1) 启动本地栈（要验收回收链路需带 --test-scheduled）
cd workers && bun run dev -- --test-scheduled

# 2) 另开终端执行（默认 http://localhost:8787、账号 admin/admin123456，可用参数覆盖）
python3 scripts/verify-content-addressing.py --base-url http://localhost:8787
python3 scripts/verify-storage-failover.py --base-url http://localhost:8787
```

两个脚本都会自行清理验收数据(上传目录、挂载点、provider、密钥)。公共工具在 `scripts/_picumet_e2e.py`(HTTP 会话、multipart 组包、本地 D1 查询、本地 R2 对象枚举)。`verify-content-addressing.py` 默认等待 65 秒保护期后触发定时任务,可用 `--skip-gc` 跳过这段等待。

## 代码规范

按下面的约定写代码,保持前后一致。

### 命名

- 文件:kebab-case
- React 组件:PascalCase
- 函数和变量:camelCase
- 常量:UPPER_SNAKE_CASE
- 类型和接口:PascalCase

### 导入顺序

外部库在前,其次是 Cloudflare 绑定,然后是项目内部模块,类型导入放最后。

### TypeScript

- 保持 `strict` 开启。
- 尽量避免 `any`;确需使用时要加注释说明原因。
- 每个函数都要显式标注返回类型。
- 改过类型后,在两个包分别跑 `bun run typecheck`。

## 测试要求

改动下面这些模块时,必须补上对应的测试。

### 权限判定算法

`services/permissions/check.ts` 里的权限判定按优先级依次检查:管理员特权、挂载边界、用户根路径、API 密钥权限范围、路径规则、所有者回退、默认拒绝。测试要锁死路径段边界:`/users/alice` 绝不能匹配 `/users/alice2`。规则优先级、通配符模式和默认拒绝也要有用例。

密码保护优先级同样要有用例:文件级 `access_password` 优先于命中路径规则的 `requirePassword`(见 `checkPasswordProtection`),两级不叠加——文件设了密码时路径级密码不参与校验,都没有时不需要密码。

### 文件状态机

上传会话按 `pending → uploading → verifying → completed` 流转,终态包括 `failed`、`expired`、`aborted`。分片上传还会经过 `parts_uploaded` 和 `completing`。要覆盖断点续传、中止,以及按分片覆盖度和最终 HEAD 大小做完成校验的逻辑。

### 配额原子性

配额更新必须原子。测试并发上传不会突破限额,删除和中止路径恰好释放一次预留。用原子的 `UPDATE`,不要用「读取-修改-写回」的序列。

### 安全回归

改过认证、上传或存储后,重跑安全回归套件:自由模式凭据处理、WebDAV 鉴权、SSRF 校验、加密、限流 fail-closed、一次性下载令牌消费。

## 提交规范

使用 Conventional Commits:`type(scope): subject`。正文用多个 `-m` 参数,每个参数一条要点。

```bash
git commit -m "feat(upload): add multipart upload support for large files" \
  -m "- 实现分片会话 API 与断点续传契约" \
  -m "- 服务端记录分片 ETag 用于完成校验"
```

```bash
git commit -m "fix(permission): 修复规则匹配的路径边界绕过" \
  -m "- 用 isPathWithinBoundary 替换 startsWith" \
  -m "- 补充 /users/alice 与 /users/alice2 的边界测试"
```

提交信息用英文或中文都可以。类型与 scope 的取值如下。

| 类型 | 含义 |
| :--- | :--- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档改动 |
| `style` | 格式化,行为不变 |
| `refactor` | 重构,行为不变 |
| `perf` | 性能优化 |
| `test` | 测试增改 |
| `chore` | 维护性改动 |

| Scope | 范围 |
| :--- | :--- |
| `auth` | 认证与会话 |
| `permission` | 权限算法与规则 |
| `storage` | 存储 Provider |
| `upload` | 上传与分片流程 |
| `download` | 下载网关与令牌 |
| `ui` | 前端组件与页面 |
| `api` | API 路由与 schema |
| `db` | 迁移与数据仓库 |

## 质量门禁清单

提交前对照这份清单逐项检查。

### 功能

- 功能在真实 UI 或 API 上端到端跑通。
- 边界条件和错误路径的行为与文档一致。

### 代码质量

- `strict` 类型检查通过,没有未说明的 `any`。
- 命名和导入顺序符合上面的约定。
- 没有死代码、残留的调试输出或注释掉的代码块。

### 测试

- 新行为有对应测试,且测试能在可复现的回归上失败。
- 两个包都通过 `bun run test` 和 `bun run typecheck`。

### 安全

- 权限检查基于规范化后的路径。
- 对象存储密钥与凭据不落到客户端或日志。
- fail-closed 路径保持关闭:限流、自由模式、SSRF。

### 性能

- 数据库写入用原子语句,配额不做读改写。
- 热点请求路径避免无谓的分配与拷贝。

### 文档

- 新增或改动端点时,同步更新 `docs/API.md`。
- 规范或结构变化时,更新本文档与 `docs/ARCHITECTURE.md`。

## 常见坑点

### 用 `isPathWithinBoundary`,别用 `startsWith`

`startsWith` 按字符串前缀比较,`/users/alice` 能匹配到 `/users/alice2`。`utils/path.ts` 的 `isPathWithinBoundary` 按路径段比较,不会有这个问题。

### 先删元数据,再异步清理对象

先在一个事务里删除数据库元数据,之后异步清理对象存储;清理失败的对象记入 `orphan_objects`,交给对账任务处理。先删对象再删元数据的话,元数据删除一旦失败,对象就丢了。

### 配额更新要原子

不要「读取配额 → 修改 → 写回」,并发场景下会竞态。直接用一条 `UPDATE user_quotas SET used_storage = used_storage + ? ...`。

### 授权前先规范化路径

权限检查前对每个入站路径调用 `normalizePath`,`/users/../admin/secrets` 会归一到 `/admin/secrets`,无法绕过规则。

### 改完代码重启 `wrangler dev`

Workers API 的热重载不可靠。改了 `workers/` 源码后重启进程;保险起见删掉 `.wrangler` 再重跑迁移,从干净状态起步。

## 开发路线

代码库按依赖顺序分阶段构建,后一阶段依赖前一阶段,每阶段验收标准全部通过才算完成。

| 阶段 | 内容 | 依赖 |
| :--- | :--- | :--- |
| 0 | 环境搭建 | — |
| 1 | 认证系统 | 0 |
| 2 | 核心权限系统 | 1 |
| 3 | 对象存储连接(R2) | 2 |
| 4 | 基础文件管理 | 3 |
| 5 | 配额管理 | 4 |
| 6 | 移动与重命名 | 5 |
| 7 | 密码保护与分享 | 6 |
| 8 | API 密钥与 WebDAV | 7 |
| 9 | 高级 UI | 8 |
| 10 | 外观定制与国际化 | 9 |
| 11 | 管理员功能 | 10 |
| 12 | 安全加固 | 11 |
| 13 | 分片上传 | 12 |
| 14 | 扩展存储源(S3/Oracle) | 13 |
| 15 | 自由模式 | 14 |
| 16 | 测试与部署 | 15 |

这条顺序上的关键里程碑:

- **M1**(阶段 4):可用的文件管理系统
- **M2**(阶段 8):完整的 API 与分享能力
- **M3**(阶段 11):多用户生产系统
- **M4**(阶段 15):全功能版本
- **M5**(阶段 16):正式发布

后续规划新功能时,可以按这张表判断前置依赖。

## 相关文档

- [系统架构](ARCHITECTURE_CN.md)
- [API 参考](API_CN.md)
- [页面设计](UI_CN.md)
- [部署指南](DEPLOYMENT_CN.md)
- [项目说明](../README_CN.md)
- [进度记录](PROGRESS.md)
