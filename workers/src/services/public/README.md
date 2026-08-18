# Public Service（公开服务）

**职责范围**：站点设置、公告、健康检查（无需认证）。

## 目录结构

```
services/public/
├── handlers.ts    // GET /api/public/settings、/announcements、/health
└── types.ts
```

## 依赖

- `db`（SettingsRepo/AnnouncementRepo）
