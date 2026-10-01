-- 0011：Umami 访问统计
--
-- 访问统计来源二选一：stats_source = d1（网关侧 access_logs 逐次日志，仅覆盖
--   private_gateway 流量）| umami（前端 tracker：SPA 路由切换自动
--   pageview + 下载/复制链接等前端事件）。两者互斥，避免双写双计。
-- Umami 配置键：脚本地址（全站唯一可配置脚本执行面，写入口严格校验：仅 http(s):、
--   无内嵌凭据、无 fragment、长度上限，http 仅回环主机本地联调）、Website ID（UUID）、
--   可选 data-host-url（采集端点覆盖）与 data-domains（域名白名单，逗号分隔 hostname）、
--   三个采集行为开关（performance / exclude-search / do-not-track）。
-- 仅设置种子行，无表结构变更。
--
-- 回滚脚本（注释形式保留）：
--   DELETE FROM system_settings WHERE key IN (
--     'stats_source', 'umami_enabled', 'umami_script_url', 'umami_website_id',
--     'umami_host_url', 'umami_domains', 'umami_performance', 'umami_exclude_search',
--     'umami_do_not_track');

INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('stats_source', 'd1', '访问统计来源（d1 = 网关审计日志 / umami = 前端行为统计）', unixepoch() * 1000),
('umami_enabled', 'false', 'Umami 启用开关（stats_source=umami 时生效）', unixepoch() * 1000),
('umami_script_url', '', 'Umami tracker 脚本地址（自托管 https://<instance>/script.js 或 https://cloud.umami.is/script.js）', unixepoch() * 1000),
('umami_website_id', '', 'Umami 站点 ID（data-website-id，UUID）', unixepoch() * 1000),
('umami_host_url', '', 'Umami 采集端点覆盖（data-host-url，可选）', unixepoch() * 1000),
('umami_domains', '', 'Umami 域名白名单（data-domains，逗号分隔 hostname，可选）', unixepoch() * 1000),
('umami_performance', 'false', 'Umami 采集性能指标（data-performance，Core Web Vitals）', unixepoch() * 1000),
('umami_exclude_search', 'false', 'Umami 排除搜索参数（data-exclude-search）', unixepoch() * 1000),
('umami_do_not_track', 'false', 'Umami 遵循浏览器 Do Not Track（data-do-not-track）', unixepoch() * 1000);
