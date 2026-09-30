# Picumet 本地测试平台使用明细

> 配套文档：[全链路验证报告](LAB_TEST_REPORT_2026-09-26.md)（结论、缺陷清单与优化方案）。
> 本文只讲**怎么跑**：环境怎么搭、每个脚本怎么用、参数有哪些、结果落在哪、踩过哪些坑。

---

## 1. 前置依赖

| 依赖 | 版本要求 | 用途 |
| :--- | :--- | :--- |
| bun | 1.3.14（`packageManager` 固定） | 跑 `workers/`、`frontend/` 与 `scripts/lab/s3tool.ts` |
| Docker + compose | Docker 29.x（`docker compose` 插件或 `docker-compose`） | 四个 S3 兼容实例 + SMTP 收件箱 |
| Python | 3.11+（实测 3.13） | 全部用例脚本（**仅标准库**，无需 pip 安装） |
| Node | 22+ | wrangler / vite 运行时 |

需要空闲的本地端口：`8787`（API）、`5173`（前端）、`9000/9002/9004/9006`（A/B/C/D 四桶）、`1025`（SMTP）。

> **MinIO 已不可获取**（Docker Hub 各 mirror 拒绝、`dl.min.io` 返回 410），本平台用 GitHub 发布的 **VersityGW**（S3 协议兼容网关）自建镜像；对被测系统而言就是一个普通 S3 endpoint。

---

## 2. 目录结构

```
scripts/
├── _picumet_e2e.py            # 公共工具：HTTP 会话/CSRF、multipart 组包、LocalDb(LocalD1 只读)、S3 包装、Reporter、hget
├── verify-*.py                # 既有验收脚本（内容寻址 / 容灾 / 多项目分享），保持原样可独立运行
└── lab/                       # 本平台
    ├── _lab.py                # Lab 门面：认证、用户/挂载/矩阵、上传（单对象 / 预签名分片 / Worker 分片）、分享、管理端、D1 核对
    ├── fixtures.py            # 拓扑夹具：幂等 setup / topology / 用户快照还原 / SSRF 负向断言 / PRESERVED_ROOT_DIRS
    ├── corpus.py              # 语料选源：gastigado、Archives/Video 中性缩略图、仓库文档、ISO
    ├── s3tool.ts              # 直连桶的对象级 CLI（ping/mkbucket/ls/head/get/put/rm/copy），复用 workers/node_modules 的 AWS SDK
    ├── image-host.html        # 图床批量加载验证页（一个页面并发引入一个目录的签名直链）
    ├── 00_setup.py … 15_limits.py   # 15 个用例模块（见 §6）
    ├── run_all.py             # 一键运行 + 汇总
    └── env/                   # 环境构建脚本（独立目录）
        ├── s3/{Dockerfile,docker-compose.yml,s3.sh}
        ├── smtp/{Dockerfile,docker-compose.yml,smtp.sh,smtp_sink.py}
        └── stack.sh           # 备份/还原/重置/启停/状态
```

---

## 3. 首次搭建（5 步）

```bash
# 1) 四桶 + SMTP 收件箱（首次会下载 VersityGW 二进制并构建镜像）
scripts/lab/env/s3/s3.sh install   && scripts/lab/env/s3/s3.sh up
scripts/lab/env/smtp/smtp.sh install && scripts/lab/env/smtp/smtp.sh up

# 2) 全新本地 D1（自动应用 migrations）并把开发栈起到后台
scripts/lab/env/stack.sh reset --db
scripts/lab/env/stack.sh up        # workers: 8787 (--test-scheduled) / frontend: 5173

# 3) 配置拓扑（A/B/C/D + /public + /dedup + 测试用户；幂等）
python3 scripts/lab/00_setup.py

# 4) 播种并保留样本（图片/视频/缩略图/文档/ISO）
python3 scripts/lab/14_samples.py

# 5) 全量用例（约 8–12 分钟；跳过两处耗时实测见 §7）
python3 scripts/lab/run_all.py
```

`stack.sh` 起服务时建议**单独调用**（不要写进管道）：它用 `setsid` + 关闭 3–20 号 fd 脱离会话，管道会让调用方一直等 EOF。

---

## 4. 环境脚本用法

### 4.1 `scripts/lab/env/s3/s3.sh`（四桶 A/B/C/D）

| 子命令 | 说明 |
| :--- | :--- |
| `install` | 下载 VersityGW 到 `${PICUMET_S3_CACHE:-/home/<user>/picumet-s3}/context` 并 `docker build` 出 `picumet-s3-gateway:local` |
| `up` | 启动四个容器（A=9000 / B=9002 / C=9004 / D=9006），并在各自数据目录下建立 `picumet` bucket |
| `down` | 停止四个容器 |
| `stop-one <a\|b\|c\|d>` / `start-one <a\|b\|c\|d>` | 单实例停机/启动（**容灾用例 07 依赖它**） |
| `status` | 容器状态 + 每个桶的文件数与体积 |
| `reset` | 清空四个数据目录（保留容器） |
| `mirror <src> <dst> <key>` | 文件级复制一个对象（模拟 rclone 等外部镜像通道；VersityGW posix 后端对象即文件） |

环境变量：`PICUMET_S3_CACHE`（构建缓存/二进制）、`PICUMET_S3_DATA`（桶数据目录）、`S3_AK`/`S3_SK`（默认 `minioadmin`）。

### 4.2 `scripts/lab/env/smtp/smtp.sh`（本地收件箱）

| 子命令 | 说明 |
| :--- | :--- |
| `install` / `up` / `down` | 构建并启停 `picumet-smtp-sink:local`（宿主 1025） |
| `status` | 容器状态 + 已收邮件数 |
| `reset` | 清空收件箱 |
| `latest [n]` | 打印最近 n 封（`jq`） |

收件箱默认 `/home/<user>/picumet-smtp/mailbox`：`mailbox.jsonl`（一行一封）+ `mail-<seq>.json`（含 envelope/headers/body）。

### 4.3 `scripts/lab/env/stack.sh`（开发栈全生命周期）

| 子命令 | 说明 |
| :--- | :--- |
| `status` | 端口（8787/5173/9000/9002/9004/9006/1025）+ 容器 + D1 行数概览 + 可用备份 |
| `backup` | 备份 `.wrangler/state`、`.dev.vars`、`wrangler.toml`、`migrations`、git HEAD → `${PICUMET_BACKUP_DIR:-/home/<user>/picumet-backup}/<ts>`，并维护 `LATEST` 软链 |
| `restore [ts]` | 停栈 → 从备份（缺省 `LATEST`）还原 state/配置 → 提示手动 `up` |
| `reset --db` | 删除 `.wrangler/state` 与 `tmp`，重新应用 migrations（**不动 S3/SMTP 容器数据**） |
| `up` / `down` | 后台启停 workers(8787, `--test-scheduled`) 与前端(5173)；日志与 PID 在 `.tmp/lab-logs/` |

> 备份范围只含 **D1/KV/R2（workerd 本地状态）与配置**；四个 S3 容器与 SMTP 收件箱的数据目录不在其中。

---

## 5. 拓扑与样本策略

`00_setup.py` 建立的拓扑（幂等）：

| 对象 | 配置 |
| :--- | :--- |
| 提供商 | `lab-bucket-A`→9000、`B`→9002、`C`→9004、`D`→9006（bucket `picumet`，region `us-east-1`） |
| `/` | 池 **[A(主,可写), D(拼好,可写), B(standby)]**，锚点派生为 A |
| `/public` | 提供商 C，`uploadMode=flat`，priority 1000 |
| `/dedup` | R2 绑定提供商（Worker 代理写入）——内容寻址/去重的**正例对照** |
| `/samples/isos` | R2 绑定提供商（S3 分片在 workerd 下不可用，见报告 F-01），priority 950 |
| 用户 | `labalice`/`labbob` defaultPath=`/`；`labcarol`=`/public`；`labisolated`=`/users/labisolated` |

**样本保留**：`fixtures.PRESERVED_ROOT_DIRS = {'samples','bulk'}` —— `00_setup.py` 的「清空根目录」与各套件的清理都会**跳过**这两个目录，因此样本与语料在重复搭建后依然在库（实测日志出现 `samples:preserved`）。`14_samples.py` 自身也**只增不删**（同名跳过）。

> 样本含 3 个 ISO（WePE 225 MiB / FirPE 888 MiB / HikariPE 968 MiB）落在 R2 绑定桶，会让 `.wrangler/state` 明显变大——`stack.sh backup` 的体积随之上升（可用 `s3.sh reset` / `stack.sh reset --db` 清理后重播）。

---

## 6. 用例模块

| 模块 | 需要 | 关键参数 | 覆盖 |
| :--- | :--- | :--- | :--- |
| `00_setup.py` | 四桶 | `--pool-strategy {least_used,round_robin,hash,free_weighted,ordered}` | 拓扑搭建、SSRF 负向断言、池/矩阵/用户配置 |
| `01_files.py` | — | — | 目录、上传（多类型/unicode 名）、列表/树、改名（含目录迁移子树）、移动、复制链接、下载+Range、删除、路径与文件名校验 |
| `02_content_addressing.py` | `--test-scheduled` 起的 API | `--grace-wait <秒>`（默认 65）、`--skip-gc` | 会话路径 vs 兼容路径 vs 预签名路径的内容寻址对照、去重、引用释放、回收队列、跨挂载隔离 |
| `03_public.py` | — | — | flat 语义、多用户上传、文件名映射、可见性→他人只能下载、游客、审核队列+gallery、匿名边界 |
| `04_shares.py` | — | — | 单/多项目分享、密码、过期、maxViews/maxDownloads、指定用户、requireLogin、文件夹浏览、网关一次性令牌、文件级密码、撤销、管理端 |
| `05_permissions.py` | — | — | 隔离边界、列表/树一致、用户规则、挂载级/桶级矩阵、路径段边界、LIKE 转义、挂载放置守卫、API Key 范围 |
| `06_composite_pool.py` | 四桶 | — | 5 种策略的 A/D 分摊、standby 不写入、元数据↔物理对象一致、锚点派生 |
| `07_failover.py` | Docker | `--skip-docker` | 单桶定向放置、外部镜像、停主桶回退、位置提示、备桶零写入 |
| `08_large_multipart.py` | — | `--skip-r2-multipart` | ISO 三例、100 MiB 阈值边界、S3 分片 vs R2 绑定分片、断点续传契约、幂等完成、SHA-256 |
| `09_admin_audit.py` | — | — | 仪表盘/趋势、用户与角色、全部文件、封禁、日志游标、设置、公告撤回、分享管理、Provider 生命周期、API Key 协议面、**S3 网关 SigV4 实链路** |
| `10_bulk_corpus.py` | 语料目录 | `--keep`（默认先清空 `/bulk`） | 真实语料上传、字节/数量一致、落桶分布、逐目录列表、树、管理端视图、配额 |
| `11_ui.py` | 浏览器桥 + 前端 | — | 登录、文件列表、视图切换、管理端存储/设置、分享页、console 错误（结果文件契约见 §8） |
| `12_smtp.py` | SMTP 收件箱 | — | 收件箱自检、配置回读、测试邮件、注册验证码、找回密码、邮箱变更 OTP |
| `13_guest.py` | — | — | 游客开关、受保护 API/协议面、直链与签名、文件级 `guest_visibility`、匿名分享、gallery、`role='guest'` 规则与 deny 压制 |
| `14_samples.py` | 四桶 | `--skip-isos` | 样本播种（图片/视频/缩略图/文档/ISO）、落桶核对、保留策略 |
| `15_limits.py` | 四桶（限速用 API Key） | `--prepare` / `--phase dev\|prod` / `--restore` | 全局限流、下载限速、传输并发、认证限流、**直链是否受限**（两阶段，见 §7） |
| `16_big_iso.py` | — | `--file <路径>`（可重复）/ `--mount root\|dedup` / `--keep` / `--username --password` | 大文件全链路实测：会话 → 逐片上传（预签名直传或 Worker 代理，动态分片大小）→ 合并 → 元数据 → 网关下载 SHA-256 对比 → 清理（见 §12） |
| `mpu_probe.ts`（bun） | 目标桶 | `<endpoint> --parts 500,650,800 --part-size-mib 5` | 绕开应用直连引擎：探测 multipart-complete 分片数上限（VersityGW 实测 650 OK / 800 FAIL，见 §12） |

约定：**模块内 feature 断言失败不中断**（逐项记录，跑完给完整矩阵）；只有前置条件失败才硬退出。

---

## 7. 两个需要特殊步骤的用例

### 7.1 限速与限数（`15_limits.py`）——必须手动切生产环境

三个限制器都是**生产专属**（`middleware/rate-limit.ts`、`download-limit.ts`、`concurrency.ts` 在 `ENVIRONMENT !== 'production'` 时直接放行），所以：

```bash
# 阶段 1：dev（证明「本地不生效」）+ 准备低限速档与 API Key
python3 scripts/lab/15_limits.py --prepare
python3 scripts/lab/15_limits.py --phase dev

# 阶段 2：切生产实测（会话 Cookie 带 Secure，明文 HTTP 无法保持登录态 → 用例改用匿名面 + API Key）
sed -i 's/^ENVIRONMENT=.*/ENVIRONMENT=production/' workers/.dev.vars
scripts/lab/env/stack.sh down && scripts/lab/env/stack.sh up
python3 -u scripts/lab/15_limits.py --phase prod

# 还原
sed -i 's/^ENVIRONMENT=.*/ENVIRONMENT=development/' workers/.dev.vars
scripts/lab/env/stack.sh down && scripts/lab/env/stack.sh up
python3 scripts/lab/15_limits.py --restore
```

分桶技巧：脚本按请求设置 `CF-Connecting-IP` 模拟不同客户端，使每个限制器落在独立计数窗口（`utils/ip.ts` 读取该头；生产由 Cloudflare 覆盖，本地正好用于隔离）。

### 7.2 UI 用例（`11_ui.py`）——由浏览器桥驱动

`11_ui.py` 不自带浏览器：它**校验桥产出的结果文件** `.tmp/lab-results/11_ui_bridge.json`（结构 `{checks:[{id,ok,detail}]}`，id 取 `U1..U8`），缺失则打印核对清单并非零退出。执行流程：

1. 用宿主 Playwright/浏览器桥打开 `http://localhost:5173`（登录 `admin/admin123456`）；
2. 依次核对：登录跳转、根列表（含 `bulk` 与挂载点目录行）、视图切换、`/public` 平铺、管理端存储页（5 个提供商 + 池成员）、系统设置页（站点/SMTP/安全/公告分组）、分享页、console 错误数=0；
3. 截图写入 `.tmp/lab-shots/ui-*.png`，结果写入上述 JSON；
4. 再跑 `python3 scripts/lab/11_ui.py` 让它复核并进汇总。

限速页/图床页同理：`scripts/lab/image-host.html` 是一个页面并发引入某目录全部签名直链的验证页（脚本里会替换成真实 URL），浏览器打开后 `window.__tally` 给出 `{total, ok, failed, elapsedMs}`。

---

## 8. 结果与证据落盘

| 路径 | 内容 |
| :--- | :--- |
| `.tmp/lab-results/<模块>.json` | 每模块逐项检查（`label/ok/detail`）、通过/失败计数、耗时 |
| `.tmp/lab-results/_summary.json` | `run_all.py` 汇总（含各模块失败项列表） |
| `.tmp/lab-results/P0-domparser-evidence.txt` | F-01/F-04/F-15 的复现命令、原始响应、栈与阈值实测 |
| `.tmp/lab-results/14_samples.json` | 样本清单（目录、数量、体积、落桶分布） |
| `.tmp/lab-results/15_limits-state.json` | 限速用例使用的 API Key 与直链样本（`--restore` 时清理） |
| `.tmp/lab-results/11_ui_bridge.json` | UI 用例的桥产出结果（§7.2） |
| `.tmp/lab-shots/ui-*.png` | 界面截图（登录/文件页/公共页/管理端/分享页/分页对照/图床批量加载） |
| `.tmp/lab-logs/{api,web}.log` | `stack.sh up` 启动的服务日志（`wrangler:info` 逐请求耗时） |

`.tmp/` 已被 `.gitignore` 忽略；结果可随时由 `run_all.py` 重新生成。

---

## 9. 一键运行（`run_all.py`）

```bash
python3 scripts/lab/run_all.py                                  # 00–15 全量（00_setup 需先手工跑一次）
python3 scripts/lab/run_all.py --only 04,06,09                  # 只跑指定编号
python3 scripts/lab/run_all.py --skip 08                        # 跳过指定编号
python3 scripts/lab/run_all.py --skip-gc                        # 把 --skip-gc 透传给 02/08
python3 scripts/lab/run_all.py --skip-r2-multipart              # 跳过 08 的 R2 分片实测
python3 scripts/lab/run_all.py --timeout 1800                   # 单模块超时（秒）
```

`run_all.py` 会按文件名顺序发现 `[0-9][0-9]_*.py`（`00_setup.py` 除外），逐个子进程执行、打印尾部输出、最后汇总成表格并写 `_summary.json`。

---

## 10. 常见问题

| 现象 | 原因与处理 |
| :--- | :--- |
| `stack.sh up` 之后命令不返回 | 被写进了管道；`setsid` 已关闭继承 fd，但仍建议单独调用（或 `>/dev/null 2>&1 &` 自行后台化） |
| 套件跑到一半「没有输出」 | Python 经管道运行时缓冲；跑用例加 `-u`（`python3 -u …`），或看 `.tmp/lab-results/*.json` |
| 生产模式登录 401（切环境后） | 会话 Cookie 带 `Secure`，明文 HTTP 不发送；用**匿名面 + API Key（Bearer）**验证（`15_limits.py --phase prod` 即如此） |
| 切换环境后旧会话失效 / 请求报错 | `stack.sh down/up` 重启了 workerd；重跑 `00_setup.py` 或重新登录即可 |
| 深路径目录用例失败（500 `LIKE or GLOB pattern too complex`） | D1 的 LIKE 模式上限 50 字符，路径 ≥49 字符即触发（报告 F-04）；属**被测系统缺陷**，用例照实记录 |
| 上传/回退用例报 `DOMParser is not defined` | S3 provider 的 XML 解析缺陷（报告 F-01）；R2 绑定路径不受影响，用例会给出对照 |
| ISO 样本上传 413 配额不足 | 用户配额默认 1 GiB；`14_samples.py` 已把样本属主配额上调到 8 GiB |
| 四个桶端口冲突 | 改 `scripts/lab/env/s3/docker-compose.yml` 的端口映射，并同步 `fixtures.S3_ENDPOINTS` |
| 想从零复现 | `stack.sh restore <ts>` 还原测试前状态；`s3.sh reset` + `smtp.sh reset` + `stack.sh reset --db` 则彻底清空后重跑 §3 |

---

## 11. 新增一个用例模块

1. 在 `scripts/lab/` 建 `NN_名称.py`（`NN` 决定执行顺序，`run_all.py` 自动发现）；
2. 冒烟结构：

```python
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper
from _lab import Lab
import fixtures

def run(args):
    r = Reporter('NN_名称')                     # 结果写 .tmp/lab-results/NN_名称.json
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)               # 前置不满足会硬失败，避免在错误拓扑上得出假结论
    admin = lab.admin()
    r.check(条件, '断言标签', '失败时的证据')
    if not r.finish():
        raise VerifyError('存在失败项')

if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='…'))
    main_wrapper(lambda: run(parser.parse_args()))
```

3. 用 `Reporter.check()` 记录**可失败的断言**（不中断），用 `VerifyError` 表达**前置条件失败**；
4. 需要直连桶时用 `fixtures.s3('A'|'B'|'C'|'D')`（`scripts/lab/s3tool.ts` 封装），需要读 D1 时用 `lab.db`（只读直连 sqlite）；
5. 用例必须**自清理**（`lab.purge_dir` / 删除自己建的挂载与密钥），并**不要**动 `/samples` 与 `/bulk`（见 §5）。

## 12. 大文件实测（`16_big_iso.py` / `mpu_probe.ts`）

`08_large_multipart.py` 是**契约回归**（三例 ISO 的会话创建、阈值边界、续传契约，R2 绑定路径全链路）；要对**任意本地大文件**做端到端实测（全部分片上传 → 合并 → 网关下载 SHA-256 对比）用 `16_big_iso.py`：

```bash
# S3 预签名分片（根挂载池，动态分片大小——大文件自动放大分片、片数 ≤650）
python3 scripts/lab/16_big_iso.py --file /mnt/d/res/ISO/Win11_23H2_Chinese_Simplified_x64v2.iso --username admin --password admin123456

# R2 绑定路径（Worker 代理分片）
python3 scripts/lab/16_big_iso.py --file /mnt/d/res/ISO/Win11_23H2_Chinese_Simplified_x64v2.iso --mount dedup

# 保留上传结果（默认校验后删除）；--file 可重复以连续测多个文件
```

注意：上传主体的配额必须容纳目标文件（labalice 默认 8 GiB；更大文件用 `--username admin --password admin123456`，admin 配额 20 GiB）。分片数由服务端按 `MAX_MULTIPART_PARTS = 650` 动态计算（S3 兼容引擎的合并分片数上限——VersityGW 1.8.0 实测 650 OK / 800 FAIL `InternalError`），脚本按会话返回的 `totalParts` 切片。

排查引擎侧合并能力用 `mpu_probe.ts`（绕开应用直连桶，逐点探测 multipart-complete 分片数上限）：

```bash
cd workers && bun ../scripts/lab/mpu_probe.ts http://127.0.0.1:9000 --parts 500,650,800 --part-size-mib 5
```

> 探测片大小必须 ≥5 MiB（S3 除末片外最小 5 MiB，否则 `EntityTooSmall`）；首个失败点后自动停止。
