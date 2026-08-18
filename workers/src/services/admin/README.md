# Admin Service（管理服务）

**职责范围**：仪表板/统计、用户管理、全局分享、全部文件、访问日志、系统设置、公告、存储提供商、挂载点、权限规则。

## 目录结构

```
services/admin/
├── handlers.ts          // 仪表板、用户、分享、文件、日志、设置、公告
├── storage.ts           // 存储提供商、挂载点、权限规则
├── schemas.ts           // UserUpdate/Settings/Announcement
├── storage-schemas.ts   // Provider/Mount/Rule
└── types.ts
```

## 依赖

- `db`（UserRepo/ShareRepo/LogRepo/SettingsRepo/AnnouncementRepo/ProviderRepo/MountRepo/RuleRepo）
- `storage/providers.ts`、`utils/ssrf.ts`（validateEndpoint）
