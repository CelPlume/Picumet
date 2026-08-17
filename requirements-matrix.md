# Picumet 需求追踪矩阵

**版本**: 1.0  
**日期**: 2026-08-18  
**状态**: Approved by User

## 状态说明
- ✅ **Included**: 已纳入当前范围
- 📋 **Planned**: 计划在后续阶段实现
- ❌ **Rejected**: 明确不做
- ⏸️ **Deferred**: 暂时搁置，待确认

---

## 1. 部署平台

| 需求 | 状态 | 阶段 | 数据模型 | API | 页面 | 验收 |
|------|------|------|----------|-----|------|------|
| Cloudflare Pages + Workers | ✅ Included | Phase 1 | 完整 | 完整 | 完整 | ✅ |
| Vercel | ❌ Rejected | - | - | - | - | - |
| EdgeOne | ❌ Rejected | - | - | - | - | - |

---

## 2. 对象存储提供商

| 需求 | 状态 | 阶段 | Provider实现 | 测试 | 文档 |
|------|------|------|--------------|------|------|
| Cloudflare R2 | ✅ Included | Phase 1 | ✅ | 待补充 | ✅ |
| AWS S3 | ✅ Included | Phase 3 | 待实现 | 待补充 | 待补充 |
| Oracle Cloud | ✅ Included | Phase 3 | 待实现 | 待补充 | 待补充 |
| Backblaze B2 | ❌ Rejected | - | - | - | - |
| IDrive e2 | ❌ Rejected | - | - | - | - |
| Google Cloud Storage | ❌ Rejected | - | - | - | - |
| 腾讯云 COS | ❌ Rejected | - | - | - | - |
| 阿里云 OSS | ❌ Rejected | - | - | - | - |
| 华为云 OBS | ❌ Rejected | - | - | - | - |
| Scaleway | ❌ Rejected | - | - | - | - |
| Filebase | ❌ Rejected | - | - | - | - |
| 七牛云 Kodo | ❌ Rejected | - | - | - | - |

---

## 3. 核心文件管理功能

| 需求 | 状态 | 阶段 | 数据模型 | API | 组件 | 验收 |
|------|------|------|----------|-----|------|------|
| 文件浏览（列表/卡片视图） | ✅ Included | Phase 1 | file_metadata | GET /api/files | FileExplorer | ✅ |
| 文件上传（单文件） | ✅ Included | Phase 1 | upload_sessions | POST /api/files/upload/init | UploadModal | ✅ |
| 文件上传（分片/大文件） | ✅ Included | Phase 2 | upload_sessions | POST /api/files/upload/multipart | UploadModal | 待补充 |
| 文件删除（硬删除） | ✅ Included | Phase 1 | - | DELETE /api/files/:id | ConfirmDialog | ✅ |
| 文件重命名 | ✅ Included | Phase 1 | file_metadata | PATCH /api/files/:id | RenameModal | 待补充 |
| 文件移动 | ✅ Included | Phase 2 | file_metadata | POST /api/files/:id/move | - | 待补充 |
| 文件预览（图片） | ✅ Included | Phase 2 | - | - | ImageViewer | 待补充 |
| 文件预览（视频/音频） | ✅ Included | Phase 2 | - | - | VideoPlayer | 待补充 |
| 文件预览（代码高亮） | ✅ Included | Phase 2 | - | - | CodeViewer | 待补充 |
| 回收站 | ❌ Rejected | - | - | - | - | - |

**删除回收站理由**: 用户明确要求移除，避免软删除导致的对象存储和数据库不一致问题。

---

## 4. 文件管理器交互

| 需求 | 状态 | 阶段 | 组件 | 验收 |
|------|------|------|------|------|
| 单选/多选 | ✅ Included | Phase 1 | FileExplorer | 待补充 |
| 列表视图范围选择 | ✅ Included | Phase 2 | FileList | 待补充 |
| 双击打开文件夹/图片 | ✅ Included | Phase 1 | FileItem | 待补充 |
| 拖拽排序（同级） | ✅ Included | Phase 2 | FileGrid | 待补充 |
| 拖拽移动（跨文件夹） | ✅ Included | Phase 2 | FileExplorer | 待补充 |
| 拖拽到侧边栏 | ✅ Included | Phase 2 | Sidebar | 待补充 |
| 拖拽循环检测 | ✅ Included | Phase 2 | 移动逻辑 | 待补充 |
| 卡片/列表视图切换 | ✅ Included | Phase 1 | ViewToggle | 待补充 |
| 按文件夹记忆视图 | ✅ Included | Phase 2 | localStorage | 待补充 |

---

## 5. 属性面板

| 需求 | 状态 | 阶段 | 数据模型 | 组件 | 验收 |
|------|------|------|----------|------|------|
| 单击打开属性面板 | ✅ Included | Phase 2 | - | PropertiesPanel | 待补充 |
| 手动关闭面板 | ✅ Included | Phase 2 | - | PropertiesPanel | 待补充 |
| 编辑自定义标题 | ✅ Included | Phase 2 | file_metadata.custom_title | PropertiesPanel | 待补充 |
| 编辑自定义颜色 | ✅ Included | Phase 2 | file_metadata.custom_color | ColorPicker | 待补充 |
| 编辑封面与图标 | ✅ Included | Phase 2 | file_metadata.cover_url/icon_emoji | PropertiesPanel | 待补充 |

---

## 6. 链接复制与分享

| 需求 | 状态 | 阶段 | 数据模型 | API | 组件 | 验收 |
|------|------|------|----------|-----|------|------|
| 复制URL直链 | ✅ Included | Phase 1 | - | GET /api/files/:id/copy-link | ShareLinkCopy | 待补充 |
| 复制HTML格式 | ✅ Included | Phase 1 | - | 同上 | ShareLinkCopy | 待补充 |
| 复制Markdown格式 | ✅ Included | Phase 1 | - | 同上 | ShareLinkCopy | 待补充 |
| 带签名的链接 | ✅ Included | Phase 1 | - | 同上 | ShareLinkCopy | 待补充 |
| 分享链接（密码保护） | ✅ Included | Phase 2 | shares | POST /api/shares | ShareModal | ✅ |
| 分享链接二维码 | ✅ Included | Phase 2 | - | - | QRCodeModal | 待补充 |
| 分享过期时间 | ✅ Included | Phase 2 | shares.expires_at | ShareModal | 待补充 |
| 分享下载次数限制 | ✅ Included | Phase 2 | shares.max_downloads | ShareModal | 待补充 |

---

## 7. 外观定制

| 需求 | 状态 | 阶段 | 存储 | 组件 | 验收 |
|------|------|------|------|------|------|
| 深色/浅色主题 | ✅ Included | Phase 1 | localStorage | ThemeSwitcher | 待补充 |
| 用户自定义强调色 | ✅ Included | Phase 3 | users.theme_config | AppearanceSettings | 待补充 |
| 用户自定义字体色 | ✅ Included | Phase 3 | users.theme_config | AppearanceSettings | 待补充 |
| 模糊效果开关 | ✅ Included | Phase 3 | localStorage | AppearanceSettings | 待补充 |
| 用户自定义背景 | ✅ Included | Phase 3 | users.background_url | AppearanceSettings | 待补充 |

---

## 8. 国际化

| 需求 | 状态 | 阶段 | 实现 | 组件 | 验收 |
|------|------|------|------|------|------|
| 中文 | ✅ Included | Phase 1 | i18n | LanguageSwitcher | 待补充 |
| 英文 | ✅ Included | Phase 1 | i18n | LanguageSwitcher | 待补充 |

---

## 9. 响应式布局

| 需求 | 状态 | 阶段 | 实现 | 验收 |
|------|------|------|------|------|
| 桌面端 | ✅ Included | Phase 1 | Tailwind响应式 | 待补充 |
| 平板端 | ✅ Included | Phase 1 | Tailwind响应式 | 待补充 |
| 手机端（独立交互） | ✅ Included | Phase 2 | 移动端组件 | 待补充 |

---

## 10. 用户系统

| 需求 | 状态 | 阶段 | 数据模型 | API | 页面 | 验收 |
|------|------|------|----------|-----|------|------|
| 用户注册 | ✅ Included | Phase 1 | users | POST /api/auth/register | /register | ✅ |
| 用户登录 | ✅ Included | Phase 1 | users | POST /api/auth/login | /login | ✅ |
| 管理员登录（独立入口） | ✅ Included | Phase 3 | - | 待补充 | /admin/login | 待补充 |
| 邮箱验证 | ✅ Included | Phase 1 | users.email_verified | GET /api/auth/verify | - | 待补充 |
| 访客模式 | ✅ Included | Phase 1 | - | 角色guest | - | 待补充 |
| 自由模式（自带凭据） | ✅ Included | Phase 15 | Workers内存会话 | POST /api/free-mode/init | /free-mode | 待补充 |

---

## 11. 权限与配额

| 需求 | 状态 | 阶段 | 数据模型 | API | 页面 | 验收 |
|------|------|------|----------|-----|------|------|
| 三级角色（管理员/用户/访客） | ✅ Included | Phase 1 | users.role | - | - | ✅ |
| 路径级ACL | ✅ Included | Phase 1 | path_rules | - | /admin/permissions | 待补充 |
| 文件密码保护 | ✅ Included | Phase 2 | file_metadata.access_password | - | PropertiesPanel | 待补充 |
| 路径密码保护 | ✅ Included | Phase 2 | path_rules.password_hash | - | /admin/permissions | 待补充 |
| 用户存储配额 | ✅ Included | Phase 2 | user_quotas.max_storage | - | /admin/users | 待补充 |
| 用户文件数量配额 | ✅ Included | Phase 2 | user_quotas.max_files | - | /admin/users | 待补充 |
| 访客细粒度权限配置 | ✅ Included | Phase 2 | path_rules (role=guest) | CRUD /api/admin/rules | /admin/permissions | 待补充 |
| 下载速度限制 | ❌ Rejected | - | - | - | - | - |
| 月流量限制 | ❌ Rejected | - | - | - | - | - |

**删除流量/速度配额理由**: 用户明确只需要存储大小和文件数量配额。

---

## 12. 存储配置

| 需求 | 状态 | 阶段 | 数据模型 | API | 页面 | 验收 |
|------|------|------|----------|-----|------|------|
| 添加存储源 | ✅ Included | Phase 1 | mounts | POST /api/admin/mounts | /admin/storage | 待补充 |
| 配置挂载路径 | ✅ Included | Phase 1 | mounts.mount_path | - | /admin/storage | 待补充 |
| 配置上传域名 | ✅ Included | Phase 1 | mounts.upload_endpoint | - | /admin/storage | 待补充 |
| 配置加速域名（CDN） | ✅ Included | Phase 1 | mounts.public_cdn_domain | - | /admin/storage | 待补充 |
| 配置路径前缀 | ✅ Included | Phase 1 | mounts.path_prefix | - | /admin/storage | 待补充 |
| 排序方式配置 | ✅ Included | Phase 1 | mounts.default_sort | - | /admin/storage | 待补充 |
| 签名开关 | ✅ Included | Phase 1 | mounts.sign_urls | - | /admin/storage | 待补充 |
| 上传线程数 | ✅ Included | Phase 2 | mounts.upload_threads | - | /admin/storage | 待补充 |
| 同路径多挂载 | ✅ Included | Phase 3 | 待完善 | 待补充 | - | 待补充 |
| 路径变量DSL（{year}/{month}） | ✅ Included | Phase 4 | 待设计 | 待补充 | 待补充 | 待补充 |

---

## 13. 管理员功能

| 需求 | 状态 | 阶段 | 数据模型 | API | 页面 | 验收 |
|------|------|------|----------|-----|------|------|
| 管理员仪表板 | ✅ Included | Phase 2 | - | GET /api/admin/stats | /admin | 待补充 |
| 用户管理 | ✅ Included | Phase 2 | users | CRUD /api/admin/users | /admin/users | 待补充 |
| 存储配置管理 | ✅ Included | Phase 1 | mounts | CRUD /api/admin/mounts | /admin/storage | 待补充 |
| 权限规则管理 | ✅ Included | Phase 2 | path_rules | CRUD /api/admin/rules | /admin/permissions | 待补充 |
| 查看全部分享 | ✅ Included | Phase 2 | shares | GET /api/admin/shares | /admin/shares | 待补充 |
| 查看全部文件 | ✅ Included | Phase 2 | file_metadata | GET /api/admin/files | /admin/files | 待补充 |
| 访问日志 | ✅ Included | Phase 3 | access_logs | GET /api/admin/logs | /admin/logs | 待补充 |
| 流量统计 | ✅ Included | Phase 4 | Analytics Engine | 待补充 | /admin/analytics | 待补充 |

---

## 14. 系统设置

| 需求 | 状态 | 阶段 | 数据模型 | API | 页面 | 验收 |
|------|------|------|----------|-----|------|------|
| 站点标题/Logo/Favicon | ✅ Included | Phase 1 | system_settings | PATCH /api/admin/settings | /admin/settings | 待补充 |
| 公告系统 | ✅ Included | Phase 2 | announcements | CRUD /api/admin/announcements | /admin/announcements | 待补充 |
| 公告关闭策略（一天/永久） | ✅ Included | Phase 3 | user_announcement_dismissals | 待补充 | 待补充 | 待补充 |
| 注册开关 | ✅ Included | Phase 1 | system_settings | - | /admin/settings | 待补充 |
| 访客访问开关 | ✅ Included | Phase 1 | system_settings | - | /admin/settings | 待补充 |
| Turnstile验证码 | ✅ Included | Phase 2 | system_settings | - | /admin/settings | 待补充 |

---

## 15. API密钥与兼容协议

| 需求 | 状态 | 阶段 | 数据模型 | API | 验收 |
|------|------|------|----------|-----|------|
| 创建API密钥 | ✅ Included | Phase 2 | api_keys | POST /api/keys | 待补充 |
| WebDAV协议 | ✅ Included | Phase 3 | - | /webdav/* | 待补充 |
| 自定义上传API | ✅ Included | Phase 2 | - | POST /api/compat/upload | 待补充 |
| PicGo/PicList接入 | ✅ Included | Phase 2 | - | - | 待补充 |
| S3协议兼容 | ❌ Rejected | - | - | - | - |
| OSS协议兼容 | ❌ Rejected | - | - | - | - |

**删除S3/OSS协议理由**: 用户明确不做完整协议网关，只做WebDAV和自定义API。

---

## 16. 安全功能

| 需求 | 状态 | 阶段 | 实现 | 验收 |
|------|------|------|------|------|
| 防XSS | ✅ Included | Phase 1 | CSP + DOMPurify | 待补充 |
| 防CSRF | ✅ Included | Phase 1 | SameSite Cookie | 待补充 |
| 速率限制 | ✅ Included | Phase 1 | KV限流 | 待补充 |
| 热点文件检测 | ✅ Included | Phase 2 | KV计数 | 待补充 |
| 路径签名URL | ✅ Included | Phase 1 | 加密签名 | 待补充 |
| 加密路径下载 | ✅ Included | Phase 2 | 签名URL强制 | 待补充 |
| 客户端加密 | ❌ Rejected | - | - | - |

**加密说明**: 存储不加密，但对特定路径的链接获取需要加密签名，防止直接访问。

---

## 17. 图片编辑

| 需求 | 状态 | 阶段 | 实现 | 验收 |
|------|------|------|------|------|
| 图片预览、放大、缩小、旋转 | ✅ Included | Phase 2 | ImageViewer | 待补充 |
| 跳转到Squoosh编辑 | ✅ Included | Phase 2 | 外部链接 | 待补充 |

---

## 18. 视频/音频预览

| 需求 | 状态 | 阶段 | 实现 | 验收 |
|------|------|------|------|------|
| DPlayer视频播放器 | ✅ Included | Phase 2 | VideoPlayer | 待补充 |
| DPlayer音频播放器 | ✅ Included | Phase 2 | AudioPlayer | 待补充 |

---

## 19. 代码预览

| 需求 | 状态 | 阶段 | 实现 | 验收 |
|------|------|------|------|------|
| 代码高亮 | ✅ Included | Phase 2 | highlight.js | 待补充 |

---

## 统计摘要

- ✅ **Included**: 99项
- 📋 **Planned**: 0项
- ❌ **Rejected**: 22项
- ⏸️ **Deferred**: 0项

**总计**: 121项需求已全部确认状态

**主要变更（2026-08-18）**:
- ✅ 按文件夹记忆视图：从Planned调整为Included（Phase 2）
- ✅ 自由模式：从Planned调整为Included（Phase 1.5），凭据仅存Workers内存
- ✅ 访客细粒度权限：从Planned调整为Included（Phase 2），复用path_rules表
- ✅ AWS S3/Oracle Cloud：从Planned调整为Included（Phase 3）
- ✅ 管理员登录独立入口：从Planned调整为Included（Phase 3）
- ✅ 路径变量DSL：从Planned调整为Included（Phase 4）
- ✅ 流量统计：从Planned调整为Included（Phase 4）
- ✅ 公告关闭策略：从Planned调整为Included（Phase 3）
- ❌ 从URL抓取元信息：删除
- ❌ 自定义文件URL：删除
