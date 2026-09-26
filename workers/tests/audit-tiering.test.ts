// 管理端日志游标分页（显式列、无总页数）、审计冷归档（导出 → 校验 → manifest/rollup 同批 →
// 分批清理）、rollup 与热表趋势合并，以及归档读取端点。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { Db, DashboardRepo } from '../src/db';
import { archiveAuditLogs } from '../src/services/audit/archive';
import type { Env } from '../src/shared/types';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'at_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'at_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'at_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  adminCookie = `auth_token=${setCookie.match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

function insertLog(id: string, action: string, createdAt: number, opts: { statusCode?: number; bytes?: number; metadata?: string } = {}): void {
  ctx.db
    .prepare(
      `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
       VALUES (?, NULL, ?, '/at', ?, '127.0.0.1', 'vitest', ?, ?, ?)`
    )
    .run(id, action, opts.metadata ?? null, opts.bytes ?? 0, opts.statusCode ?? 200, createdAt);
}

function archiveKey(hourStart: number): string {
  const d = new Date(hourStart);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `audit/${d.getUTCFullYear()}/${mm}/${dd}/${hh}.ndjson.gz`;
}

async function gunzipText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  expect(stream).toBeTruthy();
  const body = (stream as ReadableStream<Uint8Array>).pipeThrough(new DecompressionStream('gzip'));
  return new Response(body).text();
}

describe('管理端日志游标分页', () => {
  it('按 (created_at, id) 稳定排序、hasMore/nextCursor、显式列且无总页数', async () => {
    const base = Date.now() - 10 * HOUR;
    insertLog('atl-1', 'upload', base);
    insertLog('atl-2', 'download', base + 1000);
    insertLog('atl-3', 'login', base + 2000);
    const windowQuery = `from=${base}&to=${base + 3000}`;

    const firstRes = await request(ctx, `/api/admin/logs?limit=2&${windowQuery}`, { cookie: adminCookie });
    expect(firstRes.status).toBe(200);
    const first = (await json(firstRes)).data as {
      logs: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
      pagination?: unknown;
    };
    expect(first.logs).toHaveLength(2);
    expect(first.logs.map((l) => l.id)).toEqual(['atl-3', 'atl-2']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.pagination).toBeUndefined();
    expect(first.logs[0]).not.toHaveProperty('metadata');
    expect(first.logs[0]).not.toHaveProperty('userAgent');

    const secondRes = await request(
      ctx,
      `/api/admin/logs?limit=2&${windowQuery}&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      { cookie: adminCookie }
    );
    const second = (await json(secondRes)).data as {
      logs: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(second.logs.map((l) => l.id)).toEqual(['atl-1']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
});

describe('冷归档导出、校验、rollup 与清理', () => {
  it('过保留期窗口：导出 NDJSON.gz + manifest/rollup 落库 + 热行清理；趋势合并两源', async () => {
    ctx.db
      .prepare(
        `INSERT INTO system_settings (key, value, description, updated_at) VALUES ('audit_retention_days', '1', NULL, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(Date.now());
    (ctx.env as Env).AUDIT_BUCKET = ctx.r2 as unknown as R2Bucket;

    const oldHour = Math.floor((Date.now() - 3 * DAY) / HOUR) * HOUR;
    insertLog('at-old-1', 'download', oldHour + 1000, { bytes: 10 });
    insertLog('at-old-2', 'download', oldHour + 2000, { bytes: 20 });
    insertLog('at-old-3', 'login', oldHour + 3000);

    const processed = await archiveAuditLogs(ctx.env as Env);
    expect(processed).toBeGreaterThanOrEqual(1);

    // 归档对象：gzip NDJSON，逐行含完整取证字段
    const key = archiveKey(oldHour);
    const object = await ctx.r2.get(key);
    expect(object).toBeTruthy();
    const text = await gunzipText(object?.body ?? null);
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { id: string; action: string });
    expect(lines.map((l) => l.id).sort()).toEqual(['at-old-1', 'at-old-2', 'at-old-3']);
    expect(lines.every((l) => typeof l.action === 'string')).toBe(true);

    // manifest：行数 / 摘要 / 已清理
    const manifest = ctx.db
      .prepare('SELECT row_count, pruned, sha256, bytes FROM audit_archives WHERE range_start = ?')
      .get(oldHour) as { row_count: number; pruned: number; sha256: string; bytes: number };
    expect(Number(manifest.row_count)).toBe(3);
    expect(Number(manifest.pruned)).toBe(1);
    expect(manifest.sha256).toHaveLength(64);
    expect(Number(manifest.bytes)).toBeGreaterThan(0);

    // 热行已按批次清理
    const hot = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM access_logs WHERE created_at >= ? AND created_at < ?')
      .get(oldHour, oldHour + HOUR) as { c: number };
    expect(Number(hot.c)).toBe(0);

    // rollup：按 (小时桶, action, status) 聚合
    const rollup = ctx.db
      .prepare(`SELECT event_count, bytes_transferred FROM audit_rollups WHERE bucket_start = ? AND action = 'download' AND status_code = 200`)
      .get(oldHour) as { event_count: number; bytes_transferred: number };
    expect(Number(rollup.event_count)).toBe(2);
    expect(Number(rollup.bytes_transferred)).toBe(30);

    // 趋势合并：热表已无明细，rollup 计入同桶
    const buckets = await DashboardRepo.trends(Db.fromSqlite(ctx.db), {
      metric: 'downloads',
      granularity: 'day',
      from: oldHour,
      to: oldHour + HOUR,
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.count).toBe(2);
  });

  it('归档清单与下载端点：仅管理员可读，读取行为记入审计', async () => {
    const listRes = await request(ctx, '/api/admin/logs/archives', { cookie: adminCookie });
    expect(listRes.status).toBe(200);
    const archives = ((await json(listRes)).data as { archives: Array<{ id: string; rowCount: number }> }).archives;
    expect(archives.length).toBeGreaterThanOrEqual(1);
    expect(archives[0]?.rowCount).toBe(3);

    const downloadRes = await request(ctx, `/api/admin/logs/archives/${archives[0]?.id}/download`, { cookie: adminCookie });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toBe('application/gzip');
    const readEvent = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM access_logs WHERE action = 'audit_archive_read'`)
      .get() as { c: number };
    expect(Number(readEvent.c)).toBeGreaterThanOrEqual(1);
  });

  it('未配置冷层（AUDIT_BUCKET 缺失）→ 不归档也不清理，下载端点 400', async () => {
    delete (ctx.env as Env).AUDIT_BUCKET;
    const oldHour = Math.floor((Date.now() - 5 * DAY) / HOUR) * HOUR;
    insertLog('at-nocold', 'download', oldHour + 1000);

    expect(await archiveAuditLogs(ctx.env as Env)).toBe(0);
    const kept = ctx.db.prepare(`SELECT COUNT(*) AS c FROM access_logs WHERE id = 'at-nocold'`).get() as { c: number };
    expect(Number(kept.c)).toBe(1);

    const downloadRes = await request(ctx, '/api/admin/logs/archives/any/download', { cookie: adminCookie });
    expect(downloadRes.status).toBe(400);
  });
});
