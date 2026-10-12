-- 0017：KV ↔ D1 混合存储的回退表
--
-- 背景：Cloudflare Workers 免费版 KV 写入配额为 1000 次/天。配额耗尽时
-- `kv.put()` / `kv.delete()` **抛异常**（Error: KV put() limit exceeded for the day.），
-- 而 KV 在本项目里承担 SSO state、分享鉴权、熔断标记、位置提示、round-robin 计数器
-- 等**会话/加速**角色（真值都在 D1 或签名里）。一旦让异常冒泡，整条业务链路 500。
--
-- 设计：**KV 仍是第一选择，D1 是自动回退**（不是二选一）。
--   写入：先写 KV；KV 抛配额异常 → 落到本表（业务照常返回成功）。
--   读取：先读 KV；KV 未命中或不可用 → 读本表（并按 expires_at 判定过期）。
--   删除：两侧都删。
-- 因此配额耗尽时功能完整可用（只是多一次 D1 查询），配额恢复后自动回到 KV 快路径。
--
-- 键名沿用原 KV 键（sso:state:* / share:auth:* / pool:rr:* …），
-- 原样存 value（字符串，不解析），过期时间用绝对毫秒时间戳。
CREATE TABLE IF NOT EXISTS kv_fallback (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 过期回收（定时任务按 expires_at 扫描）
CREATE INDEX IF NOT EXISTS idx_kv_fallback_expires_at ON kv_fallback(expires_at);
-- 写入频次统计（观测 KV 配额压力：高频键会在这里累积，便于评估迁 D1 永久化）
CREATE INDEX IF NOT EXISTS idx_kv_fallback_created_at ON kv_fallback(created_at);

-- 回滚脚本（注释形式保留）：
-- DROP INDEX IF EXISTS idx_kv_fallback_created_at;
-- DROP INDEX IF EXISTS idx_kv_fallback_expires_at;
-- DROP TABLE IF EXISTS kv_fallback;