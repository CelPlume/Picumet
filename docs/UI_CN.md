<div align="center">

<img src="../assets/logo.svg" alt="Picumet Logo" width="128" />

# Picumet 前端指南

**多云对象存储管理平台**

[English](UI.md) | 中文

</div>

Picumet 的前端是一个 React 单页应用，负责文件管理器、分享页、用户设置和管理后台。这份文档说明页面的组织结构、响应式布局、主题、无障碍与交互方式。

## 开始之前

- 已安装 Node.js 22 或更高版本，并可用 [bun](https://bun.sh/) 1.3 或更高版本。
- 后端已在本机运行。环境搭建见 [开发指南](DEVELOPMENT_CN.md)。
- 对 React、TypeScript、Tailwind CSS 有基本了解。

启动开发服务器：

1. 进入 `frontend/` 目录。
2. 执行 `bun install` 安装依赖。
3. 执行 `bun run dev` 启动 Vite。

终端会打印本地地址，通常是 `http://localhost:5173`。

## 总览

前端代码位于 `frontend/` 目录，通过 HTTP 请求 Workers API。技术选型如下：

- React 18，路由使用 `react-router-dom`。
- Vite 负责构建和热更新。
- TypeScript 提供类型检查，共享类型来自 `shared/types.ts`。
- Tailwind CSS 负责样式。
- i18next 支持中文和英文。
- TanStack Query 管理服务端状态、缓存和变更。

所有页面都通过 `React.lazy` 和 `Suspense` 按路由懒加载，首屏包体积保持较小。

## 页面路由

`frontend/src/App.tsx` 定义了全部路由，如下表。未登录用户访问受保护页面时，会先跳到 `/login` 并带上 `redirect` 参数，登录成功后回到原页面。管理路由校验当前用户角色，非 `admin` 角色会看到权限提示。

```mermaid
flowchart LR
    USER["用户"] -->|未登录| PUBLIC
    USER -->|已登录| AUTH
    USER -->|管理员| ADMIN

    subgraph PUBLIC["公开路由"]
        direction TB
        R1["/ 落地页"]
        R2["/login 登录"]
        R3["/register 注册"]
        R4["/reset-password 重置密码"]
        R5["/free-mode 自由模式"]
        R6["/share/:id 分享页"]
        R7["/i/:id 图床短链"]
    end

    subgraph AUTH["认证路由"]
        direction TB
        R8["/files 文件管理器"]
        R9["/shares 我的分享"]
        R10["/settings/profile 个人资料"]
        R11["/settings/security 安全设置"]
        R12["/settings/api-keys API 密钥"]
        R13["/settings/appearance 外观设置"]
    end

    subgraph ADMIN["管理路由"]
        direction TB
        R14["/admin 仪表板"]
        R15["/admin/users 用户管理"]
        R16["/admin/storage 存储配置"]
        R17["/admin/permissions 权限规则"]
        R18["/admin/shares 分享管理"]
        R19["/admin/files 全部文件"]
        R20["/admin/logs 访问日志"]
        R21["/admin/settings 系统设置"]
    end
```

### 页面清单

| 页面 | 路径 | 访问 | 组件 |
|---|---|---|---|
| 落地页 | `/` | 公开 | `Landing` |
| 登录 | `/login` | 公开 | `Login` |
| 注册 | `/register` | 公开 | `Register` |
| 重置密码 | `/reset-password` | 公开 | `ResetPassword` |
| 自由模式 | `/free-mode` | 公开 | `FreeMode` |
| 分享页 | `/share/:id` `/i/:id` | 公开 | `SharePage` |
| 文件管理器 | `/files` `/files/*` | 登录 | `Files` |
| 我的分享 | `/shares` | 登录 | `MyShares` |
| 设置布局 | `/settings/*` | 登录 | `SettingsLayout` |
| 个人资料 | `/settings/profile` | 登录 | `Profile` |
| 安全设置 | `/settings/security` | 登录 | `Security` |
| API 密钥 | `/settings/api-keys` | 登录 | `ApiKeys` |
| 外观设置 | `/settings/appearance` | 登录 | `Appearance` |
| 管理后台布局 | `/admin` | 管理员 | `AdminLayout` |
| 仪表板 | `/admin` | 管理员 | `Dashboard` |
| 用户管理 | `/admin/users` | 管理员 | `Users` |
| 存储配置 | `/admin/storage` | 管理员 | `Storage` |
| 挂载点 | `/admin/mounts` | 管理员 | 跳转到 `/admin/storage?tab=mounts` |
| 权限规则 | `/admin/permissions` | 管理员 | `Permissions` |
| 分享管理 | `/admin/shares` | 管理员 | `Shares` |
| 全部文件 | `/admin/files` | 管理员 | `Files` |
| 访问日志 | `/admin/logs` | 管理员 | `Logs` |
| 系统设置 | `/admin/settings` | 管理员 | `Settings` |

## 布局

### 应用外壳

`AppShell` 组件包裹登录后的页面，提供统一的页面骨架：

- 顶部栏固定在最上方，包含 Logo、站点标题、主导航，右侧依次是主题切换、语言切换和用户菜单。
- 顶部栏下方是公告横幅。
- 内容区居中，最大宽度 `1400px`。

```text
┌─────────────────────────────────────────────────────────────┐
│ [☰] [Logo] [文件] [分享] [设置] [管理]  [◐] [中] [@]       │
├─────────────────────────────────────────────────────────────┤
│   公告横幅                                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    主内容区                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

屏幕宽度小于 `768px` 时，顶部栏隐藏导航，只留汉堡按钮，点击后从左侧滑出 `Drawer` 菜单，里面是同样的链接。

### 文件管理器工作区

文件管理器（`/files`）分三个区域：

```text
┌──────────────────────────────────────────────────────────────┐
│ 面包屑                          [↑ 上传] [+ 新建] [☑] [▦]   │
│ [搜索] [排序 ▾] [方向]                                       │
├────────────┬──────────────────────────────────────┬──────────┤
│            │  文件卡片 / 文件列表                  │          │
│  侧边栏    │  ┌────┐ ┌────┐ ┌────┐ ┌────┐        │ 属性面板 │
│  文件夹    │  │ ▤  │ │ ▤  │ │ 🖼 │ │ 📄 │        │          │
│  类型      │  └────┘ └────┘ └────┘ └────┘        │          │
│  收藏      │                                        │          │
│            │  [批量操作栏 · 底部悬浮]              │          │
└────────────┴──────────────────────────────────────┴──────────┘
```

- **面包屑**：显示当前文件夹路径，点任意一段可跳转。
- **工具栏**：包含 **上传**、**新建文件夹**、**选择** 与批量选择，以及卡片/列表视图切换。
- **搜索与排序**：按名称过滤，可按名称、时间、大小排序，支持升序/降序。
- **内容区**：渲染响应式卡片网格或列表行。
- **属性面板**：选中文件或从菜单选择 **属性** 后，面板出现在右侧。
- **批量操作栏**：只要选中了任意文件，就会悬浮在视口底部。

### 分享页面

**公开分享页**：`/share/:id` 展示单个分享内容，`/i/:id` 是图床短链。带密码的分享先显示密码门，验证通过后才加载内容。验证后页面显示标题、分享者、大小、过期时间和浏览徽章，以及下载、复制链接、二维码操作。二维码用 `qrcode` 库在前端本地生成。图床短链直接渲染图片，不带分享卡片。

**分享列表**：`/shares` 展示你创建的分享链接。视图切换可以在响应式卡片网格和列表行之间切换。每张卡片显示文件图标、标题、状态徽章、大小、过期时间、查看次数和下载次数，并提供二维码、打开、复制链接、撤销等快捷操作。列表带分页，每页条数可调，默认 20。

### 设置与管理页面

设置布局（`/settings/*`）左侧是纵向导航，包含个人资料、安全设置、API 密钥、外观设置。管理后台（`/admin`）是两栏结构，左侧纵向导航、右侧内容区，手机上导航堆在内容上方。管理页面包括带统计卡片的仪表板、用户管理、存储配置、权限规则、分享管理、全部文件、访问日志和系统设置。

### 公开页面

登录（`/login`）、注册（`/register`）、重置密码（`/reset-password`）共用居中的卡片布局。注册需要用户名、密码、邮箱和可选的邀请码，站点开启后还要通过 Cloudflare Turnstile。登录成功后，应用跳转到 `redirect` 指向的页面，没有时就进入 `/files`。自由模式页（`/free-mode`）允许访客用临时凭据连接自己的 R2、S3 或 Oracle 存储桶，凭据只在服务器内存里保存一个会话。

### 顶栏组件

| 组件 | 位置 | 作用 |
|---|---|---|
| `Logo` | 左上 | 品牌标识，使用站点设置里的 Logo 和标题。 |
| `ThemeToggle` | 右上 | 在浅色、深色、跟随系统之间切换。 |
| `LanguageSwitcher` | 右上 | 切换中文和英文。 |
| `UserMenu` | 右上 | 显示显示名，提供设置和退出登录入口。 |
| `AnnouncementBanner` | 顶栏下方 | 展示管理员发布的站点公告。 |

## 响应式设计

界面分三个宽度区间：

| 断点 | 宽度 | 布局表现 |
|---|---|---|
| 手机 | 小于 `640px` | 导航收进抽屉，卡片 2 列，属性面板变为右侧抽屉。 |
| 平板 | `768px`–`1024px` | 导航留在顶栏，卡片 3–4 列。 |
| 桌面 | `1024px` 及以上 | 卡片 5 列，属性面板固定在右侧。 |

设计要点：

- **侧边栏转抽屉**：平板和桌面的主导航在顶栏，手机上改用汉堡按钮打开左侧抽屉。
- **属性面板**：`sm` 及以上宽度时，属性面板是右侧固定列，滚动时一直可见。手机上它放进右侧 `Drawer`。用 `matchMedia('(max-width: 639px)')` 生成 `isMobile` 门控，只让抽屉在真手机上打开，桌面隐藏列不会锁住页面滚动。
- **卡片网格**：使用 `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5`，列数随视口增大。
- **批量操作栏**：在 `350px` 到 `1080px` 的宽度范围内扫描验证过，始终可见，不会与内容重叠，也不会产生横向滚动。窄屏只显示图标，`1024px` 起补上文字标签。
- **表格和徽章**：次要表格列在 `sm` 以下隐藏（`hidden sm:block`）。徽章用 `whitespace-nowrap`，权限规则卡片整组换行，窄屏不会错位。

## 主题

主题 store 位于 `frontend/src/stores/theme.ts`，外观设置写入 `localStorage`，并同步成 `document.documentElement` 上的 CSS 变量。

### 主题模式

用户可以选择 **浅色**、**深色** 或 **跟随系统**。跟随系统时，应用读取 `prefers-color-scheme`，并响应系统实时切换。深色模式在根元素上加 `dark` 类。

### 强调色

用户从预设或取色器里选强调色。应用把十六进制值转成 HSL 三元组，写到 `--primary` 和 `--ring` 变量，Tailwind 以 `hsl(var(--primary))` 消费。再用 YIQ 公式算出前景色，浅色或深色强调色下文字和图标都保持可读。

### 模糊与背景

- **模糊三档**：外观设置的「模糊效果」滑块控制 `blurLevel = 'off' | 'default' | 'frosted'`（默认 default），写入 `--glass-alpha` 与 `--glass-blur` 两个 CSS 变量；`off` 时根元素加 `.no-blur`，全站 backdrop-filter（含遮罩、文件项磨砂底、菜单）失效为实底。
- **统一表面**：以下组件共享同一套表面类（`frontend/src/index.css` + `components/ui/`）：导航栏、侧栏（文件树）、下拉菜单、右键菜单、Select 弹层、Toast、弹窗窗体、文件卡片与列表、设置和管理面板、骨架屏。禁止硬编码模糊/透明度，一律消费 `--glass-alpha` / `--glass-blur`。
- **背景图片**：用户可上传不超过 `2MB` 的图片（JPG/PNG/WebP）或不用背景，图片以 base64 data URL 存于 `localStorage`；有壁纸时 default 档自动提高不透明度（深 0.92 / 浅 0.82）保证 WCAG AA。纯色背景选项已移除。

### Tabs 与滑动指示器

`frontend/src/components/ui/tabs.tsx` 无外部依赖实现 shadcn 默认变体：

- 选项卡列表为 `bg-muted` 药丸容器，激活项为凸起的 `bg-background` 药丸并带轻微阴影。
- 指示器在 `useEffect` 中测量激活项（`offsetLeft`/`offsetWidth`）后，以 300ms `ease-out` 滑到目标位置；由于测量发生在绘制之后，指示器会从上一位置向两个方向平滑过渡。
- `TabsContent` 使用共享淡入动画。使用示例：管理端存储（提供商/挂载）、权限编辑器（GUI/代码）。

顶栏导航（`AppShell`）采用同款测量指示器；其位置缓存在模块级变量中，路由切换时 AppShell 重挂载也不会让指示器跳回原点，左右两个方向都能平滑动画。
- **背景图片**：用户可以上传不超过 `2MB` 的图片（JPG、PNG、WebP），也可以不设置背景。图片以 base64 存在 `localStorage`。纯色背景选项已经移除。

### 文件图标与文件夹显示

| 设置 | 选项 | 效果 |
|---|---|---|
| 文件图标风格 | `iconify` 或 `emoji` | 切换 Iconify 图标和 emoji 两种渲染。 |
| 文件夹显示 | `icon` 或 `contents` | 显示普通文件夹图标，或前 4 项的 2×2 预览网格。 |
| 自定义 emoji | 按文件设置 | 属性面板里给单个文件设置的 emoji 会覆盖默认图标。 |

## 设计系统规则（强制，按前端模块拆分）

> 从历史迭代沉淀、**逐条对照现有代码核实**（以代码为准，每节标注实现文件）。改 UI 前必读；改代码必须同步改本节。

### `stores/theme.ts` + `index.css` — 玻璃拟态与主题

- 表面统一 `glass-surface`（卡片/面板/侧栏/文件项，--card 底）、`glass-surface-popover`（菜单/弹层，--popover 底）+ `glass-blur`；遮罩 `glass-overlay`。强度由 `blurLevel = 'off' | 'default' | 'frosted'`（默认 default）写入 `--glass-alpha` / `--glass-blur`；`off` 时根元素加 `.no-blur`，全站 backdrop-filter（含遮罩/文件项/菜单）失效为实底。禁止硬编码模糊/透明度。
- 壁纸（根元素 `has-bg-image`）时 default 档自动提高不透明度（深 0.92 / 浅 0.82）保 WCAG AA。
- 强调色：accent → HSL 写 `--primary`/`--ring`，**不做深色提亮补偿**（黑色默认方案已放弃）；浅色模式白色文字 <4.5:1 时压暗循环（最低 35%）；前景由 YIQ 决定。

### `components/ui/dropdown.tsx` + `select.tsx` — 弹出菜单

- Dropdown、Select **必须 `createPortal` 到 `document.body`** 并复用 `DROPDOWN_MENU_CLASS` / `DROPDOWN_ITEM_CLASS`（内联渲染会被 backdrop-filter 祖先破坏模糊）。右键菜单（`pages/Files.tsx`）同样 Portal（z-[100]）。
- 禁止原生 `<select>`；`Select` 菜单与触发器等宽对齐；关闭时机 = 点击外部 / Escape / resize / 滚动。

### `components/ui/toast.tsx` — Toast（HeroUI v3 复刻）

- 最新在最上层；折叠态后方层下移 12px 露上沿 + 0.05 逐层缩小、高度压为最前层、内容隐藏、**非最前层无投影**；仅折叠态后方层 `overflow-hidden`（最前层/展开层必须 visible：关闭按钮 -top-1 与投影会被直角裁切）；最多可见 3 层。
- 卡片高度内容自适应（RO 量 offsetHeight，勿用 contentRect——漏内边距会裁切）；进入 350ms 上方滑入；退出 250ms：最前层上滑、非最前层原地缩退 0.96；默认 4s；悬停展开全部并暂停倒计时。
- 关闭走 `markLeaving` 退场，禁止直接 `remove()`（堆叠瞬间塌缩）。
- `toast('success'|'error'|'info', msg)` 统一触发；成功/失败必须反馈，禁止静默成功；路由切换 `clearAll()` 逐条退场（Toaster 用 `useLocation`，必须在 Router 内）。

### `components/ui/dialog.tsx` — 对话框

- 全部弹窗/抽屉共用进出动画状态机（`mounted/entered` + `EXIT_MS`），遮罩压暗与模糊同步过渡；锁滚动 = `body overflow hidden` + `html { scrollbar-gutter: stable }`，开合零位移。
- 无标题弹窗不渲染头部条（X 绝对定位右上角），避免空带。
- 破坏性操作必须走 `ConfirmDialog`（HeroUI AlertDialog 排版：图标+标题一行、描述、Footer 右对齐取消+危险钮，`max-w-sm`）+ success/error toast；禁止原生 `confirm()`。

### `index.css` `.item-surface` + `explorer.tsx` / `MyShares.tsx` — 文件项三态

- rest = 玻璃表面 + 透明边框；hover = **压暗**（黑色 8% `background-image` 叠加，非半透明填充——半透明透壁纸）；selected（`.item-surface-selected` / 框选 `.lasso-item-selected`）= 玻璃底叠加 `primary/0.14` + `primary/0.55` 边框。文件页卡片/列表与分享页卡片/列表同一效果。

### `components/files/lasso.ts` + `pages/Files.tsx` — 拖拽多选

- 拖拽面 = AppShell **根容器**（`rowRef.closest('main').parentElement`，监听器经 `lassoRef` 转发、effect 只绑一次）：公告横幅条、页面四周留白、内容下方空白、整行内部全部可起拖；条目命中只认 `[data-file-id]`；`skipSelector` 跳过按钮/输入/复选框/卡片本体；移动超 4px 才 `setPointerCapture`；`onClickCapture` 抑制拖后 click。
- 文件页根容器常驻 `select-none`（挂载即加、卸载移除）：拖拽起手即可能触发原生文本选择，无法事后阻止，必须整页禁选。
- 选择复选框 = `Checkbox`（选中 `border-primary bg-primary`）+ `.lasso-item-dot` 缩放；点击空白/切换目录/开启弹窗即清空选择并收起批量栏；排序为单一下拉（`SORT_FIELDS`，升降序是菜单内 Check 项）。

### `components/files/FileTree.tsx` — 文件树

- `currentPath` 及祖先自动展开、切目录收起其它分支；空文件夹不呈现展开形态。
- 桌面 `sticky top-20` + `h-[calc(100vh-6rem)]` 固定，内滚 `scrollbar-none`。

### `components/files/preview.tsx` — 预览

- 弹窗 `w-[min(1400px,94vw)]`、媒体区 `h-[min(72vh,780px)]`，随浏览器宽度自适应。

### `pages/MyShares.tsx` — 分享

- 卡片紧凑排版；快速操作整合三点下拉；列表行 hover 与文件页同一压暗效果。

### `components/settings/BlurSlider.tsx` — 离散档位滑块

- 原生 range `appearance:none` 全透明（消除 accent-color 原生渲染），仅承担拖拽/键盘；填充条/刻度点/滑块/标签自绘且与圆心对齐；填充最右对齐滑块圆心；点击标签/轨道/拖拽吸附/方向键 + `aria-valuetext`；档位描述随选中变化。新增离散档位设置复用此模式。

### `components/ui/checkbox.tsx` — 复选框

- 选中 `border-primary bg-primary`（符合强调色）；未选中 `bg-background/60 backdrop-blur-sm`。

### `components/ui/skeleton.tsx` — 骨架屏

- 容器一律 `glass-surface glass-blur` + 圆角边框。

### `pages/settings/Appearance.tsx` — 外观设置

- 强调色独立整行（预设色板 `ACCENT_PRESETS` + 末位彩虹自定义唤起原生取色器）；文件图标/文件夹显示同行两列；模糊滑块独立行无边框。

### 布局与滚动条（AppShell / 设置 / 管理页 / `index.css`）

- 设置/管理内容 `lg:grid-cols-2`；admin 系统设置左列堆叠"系统设置+公告"、右列 SMTP。
- 设置/管理侧栏 sticky + 内滚；内滚区域 `scrollbar-none`，可见滚动条用 `scrollbar-thin`（8px 圆角 muted）。两者是普通 CSS 类，**不支持 `md:` 变体前缀**（写 `md:scrollbar-none` 无效，历史 bug 来源）。

### 验收纪律

UI 改动完成标准 = 无头浏览器逐界面截图自检 + claude-vision-skill 复核（先自查、后 vision）；对比度遵循 WCAG AA（正文 4.5:1）。

## 无障碍

界面遵循常规 Web 无障碍实践：

- **语义结构**：页面使用 `header`、`nav`、`main`、`footer` 等地标，表单使用 `<label>`、`<input>`、`<button>`。
- **标签**：每个输入项都有可见标签；纯图标按钮带 `aria-label`，例如视图切换和汉堡菜单。
- **焦点**：可交互元素有可见的焦点环，Tab 顺序与 DOM 顺序一致。
- **对比度**：正文对比度满足 WCAG 要求，YIQ 算法算出的强调色前景保证交互文字可读。
- **替代文本**：有意义的图片带描述性 `alt`，Logo 和装饰性图形用 `alt=""` 或合适的 aria 标签。
- **动效克制**：界面动画短且轻，批量操作栏只有一个小幅滑入动画。

## 交互

### 选择文件

单击卡片或行选中一个文件。按住 **Ctrl**/**Cmd** 或 **Shift** 再点，可以扩展选择范围。工具栏的 **选择** 按钮进入多选模式，菜单里提供 **全选**、**反选**、**清空选择**。多选模式或悬停时，每个卡片都会显示复选框。

### 打开文件

双击项目打开：

- 文件夹进入其内部。
- 图片、视频、音频、代码在预览弹窗里打开。
- 其他文件直接下载。

### 预览文件

预览弹窗按类型处理内容：

- **图片**：支持 `50%`–`300%` 缩放、`90°` 旋转，可下载原图。控件固定在底部，放大后不会被图片盖住。
- **视频和音频**：使用原生播放器，支持播放、拖动进度、音量、全屏。
- **代码**：用 highlight.js 高亮。应用先对源码做 HTML 转义再高亮，不会渲染原始 HTML 或 Markdown。
- **密码保护的文件**：弹窗先要求输入密码，再加载内容。

### 右键菜单与悬停操作

右键点击文件，会先选中它，再打开属性面板。悬停卡片或行时，左上角出现复选框，右上角出现三点菜单。菜单提供打开、下载、复制链接、分享、重命名、移动、设置密码、属性、删除。

### 上传文件

上传弹窗从工具栏或空状态打开。可以把文件拖进拖拽区，或用文件选择器选择。弹窗显示目标文件夹，每个文件带进度条排队上传。上传走会话式流程，最多同时 3 个：先请求上传会话，再用预签名地址直传或走 Worker 代理，最后完成会话。失败的任务显示错误和重试按钮。

### 拖拽

把文件拖到上传弹窗的拖拽区，可以加入上传队列。文件夹之间也可以拖拽移动，验证记录见进度文档。

### 复制链接

复制链接区分单个文件和批量选择：

- **单个文件**：复制非媒体文件时直接复制直链。复制图片或视频会打开复制链接弹窗。
- **批量**：批量操作栏可以一次复制所有选中文件；如果选择里含图片或视频，应用会打开复制链接弹窗。
- **弹窗**：顶部显示所选文件的 chips，下面是 **直链**、**HTML 代码**、**Markdown 代码** 三种格式的单选，外加 **签名链接** 开关。签名链接一小时后过期。应用把生成的链接用换行拼起来写入剪贴板。

### 文件夹内部预览

文件夹显示设为 `contents` 时，文件夹卡片显示 2×2 的预览网格，取当前排序下的前 4 项。文件夹和普通文件显示图标，图片显示缩略图，视频显示 canvas 抽帧的画面。空文件夹回退到文件夹图标。

### 视频缩略图

视频卡片在浏览器里直接生成缩略图。隐藏的 `<video>` 元素跳到约 `20%` 处，把当前帧画到 `<canvas>`，导出成 JPEG data URL。解码或跨域失败时，回退到文件图标。

### 图片自动预览

图片卡片会拉取预览地址，在卡片里直接渲染图片。地址按文件缓存，加载失败的地址也会记下来，同一个坏地址不会反复请求。

### 批量操作

只要选中一项或多项，底部就会出现批量操作栏。操作包括下载、分享（仅单选）、复制链接、移动、重命名（仅单选）、删除、属性（仅单选），另有 **取消选择** 按钮。

## 性能

- **路由懒加载**：每个页面都走 `React.lazy` 和 `Suspense`，浏览器只在路由打开时才下载对应页面代码。
- **服务端状态缓存**：TanStack Query 缓存文件列表和变更状态，避免重复请求。
- **图片地址缓存**：预览地址按文件只解析一次，后续复用内存里的映射。
- **客户端缩略图**：视频卡片用 canvas 在本地生成缩略图，不占用服务端带宽和存储。
- **懒加载图片**：文件夹预览的缩略图带 `loading="lazy"`。

## 检查清单

改动 UI 时逐项核对：

- [ ] 每个可交互元素都有可见的焦点指示。
- [ ] 纯图标按钮都有 `aria-label`。
- [ ] 有意义的图片带描述性 `alt`，装饰图片用 `alt=""`。
- [ ] 表单每个字段都有标签，输入类型正确。
- [ ] 布局在 `640px`、`768px`、`1024px` 三个断点正常重排，无横向滚动。
- [ ] 只靠悬停的交互，用键盘和触屏也能完成。
- [ ] 批量操作栏在 `350px`–`1080px` 范围内始终可见。
- [ ] 新页面通过路由懒加载。
- [ ] 主题设置写入 `localStorage`，并尊重系统偏好。

## 下一步

- [系统架构](ARCHITECTURE_CN.md)：后端服务与共享类型。
- [API 参考](API_CN.md)：界面调用的 HTTP 接口。
- [开发指南](DEVELOPMENT_CN.md)：本地环境、测试与规范。
- [部署指南](DEPLOYMENT_CN.md)：发布到 Cloudflare。
- [进度报告](PROGRESS.md)：实现状态与路线图。
- [项目概览](../README_CN.md)
