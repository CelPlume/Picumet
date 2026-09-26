// 审计日志冷归档：D1 保留可检索的热层窄行，整小时窗口导出 NDJSON.gz 到 R2
// （AUDIT_BUCKET），校验（行数 + SHA-256 + manifest 与 rollup 同批落库）完成后才分批删除已归档热行。
//
// 顺序保证（绝不先删后归档）：
//   1) 先续跑「manifest 已落库但热行未删完」的窗口（只删不重导，崩溃安全）；
//   2) 再取最旧的、已过保留期的小时窗口：导出 → gzip → SHA-256 → put R2 → manifest + rollup 同批落库；
//   3) 最后按受控批次删除该窗口热行；删不完保留 pruned=0，下轮继续。
// 冷层未配置（env.AUDIT_BUCKET 缺失）或保留期 <= 0：整体跳过——只读不删，D1 热行不会因归档缺失被清理。
import { Db, LogRepo, SettingsRepo, num, str, type Row } from '../../db';
import type { AuditRollupAggregate } from '../../db';
import { sha256HexBytes, uuid } from '../../utils/crypto';
import type { Env } from '../../shared/types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 每轮最多推进的窗口数（含续跑清理），限制单次 cron 的工作量 */
const WINDOWS_PER_RUN = 12;
/** 单窗口导出分页读取行数 */
const PAGE_ROWS = 2_000;
/** 单窗口导出上限：超过则整窗跳过并抛错（运维可据此调大保留期/排查异常流量） */
const MAX_WINDOW_ROWS = 100_000;
/** 单窗口单轮删除批大小与批数上限（避免一次 SQL 触碰数十万行） */
const DELETE_BATCH = 5_000;
const MAX_PRUNE_BATCHES = 10;
/** 归档格式版本（NDJSON 行结构变化时递增） */
const ARCHIVE_VERSION = 1;
/** 默认保留期（天）；system_settings.audit_retention_days 覆盖；<= 0 = 永久保留（不归档不删除） */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * 归档窗口对象键：`audit/YYYY/MM/DD/HH.ndjson.gz`（UTC；小时窗口一一对应，天然不可变/幂等）。
 */
function archiveObjectKey(start: number): string {
  const d = new Date(start);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `audit/${yyyy}/${mm}/${dd}/${hh}.ndjson.gz`;
}

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const body = new Response(input as BodyInit).body;
  if (!body) throw new Error('gzip 初始化失败');
  const gz = await new Response(body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(gz);
}

/** 保留期读取：非法值回退默认（<= 0 = 永久保留） */
async function readRetentionDays(db: Db): Promise<number> {
  const raw = await SettingsRepo.get(db, 'audit_retention_days');
  if (raw == null || raw === 'null') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RETENTION_DAYS;
}

/** 分页读取窗口内全部行（(created_at, id) 游标；超上限抛错，该窗口保持未归档） */
async function readWindowRows(db: Db, start: number, end: number): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: { createdAt: number; id: string } | null = null;
  for (;;) {
    const rows: Row[] = cursor
      ? await db.all(
          `SELECT * FROM access_logs
           WHERE created_at >= ? AND created_at < ?
             AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at ASC, id ASC LIMIT ?`,
          [start, end, cursor.createdAt, cursor.createdAt, cursor.id, PAGE_ROWS]
        )
      : await db.all(
          `SELECT * FROM access_logs WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC, id ASC LIMIT ?`,
          [start, end, PAGE_ROWS]
        );
    out.push(...rows);
    if (rows.length < PAGE_ROWS) break;
    const last: Row = rows[rows.length - 1];
    cursor = { createdAt: num(last.created_at), id: str(last.id)! };
    if (out.length > MAX_WINDOW_ROWS) {
      throw new Error(`审计归档窗口行数超过上限（${MAX_WINDOW_ROWS}），已跳过该窗口`);
    }
  }
  return out;
}

/** 窗口行 → 按 (小时桶, action, status_code) 聚合（status_code 无值以 0 占位） */
function aggregateRollups(rows: Row[]): AuditRollupAggregate[] {
  const map = new Map<string, AuditRollupAggregate>();
  for (const r of rows) {
    const bucketStart = Math.floor(num(r.created_at) / HOUR_MS) * HOUR_MS;
    const action = str(r.action) ?? 'unknown';
    const statusCode = r.status_code == null ? 0 : num(r.status_code);
    const key = `${bucketStart}\u0000${action}\u0000${statusCode}`;
    const current = map.get(key);
    if (current) {
      current.eventCount += 1;
      current.bytesTransferred += num(r.bytes_transferred);
    } else {
      map.set(key, { bucketStart, action, statusCode, eventCount: 1, bytesTransferred: num(r.bytes_transferred) });
    }
  }
  return [...map.values()];
}

/** 导出 + 校验 + manifest/rollup 落库（不删除；删除在 pruneWindow） */
async function archiveWindow(db: Db, bucket: R2Bucket, start: number, end: number): Promise<void> {
  const rows = await readWindowRows(db, start, end);
  const ndjson =
    rows
      .map((r) =>
        JSON.stringify({
          id: str(r.id),
          created_at: num(r.created_at),
          user_id: str(r.user_id) ?? null,
          action: str(r.action),
          path: str(r.path) ?? null,
          metadata: str(r.metadata) ?? null,
          ip_address: str(r.ip_address) ?? null,
          user_agent: str(r.user_agent) ?? null,
          bytes_transferred: num(r.bytes_transferred),
          status_code: r.status_code == null ? null : num(r.status_code),
        })
      )
      .join('\n') + '\n';
  const gz = await gzipBytes(new TextEncoder().encode(ndjson));
  const sha256 = await sha256HexBytes(gz);
  const objectKey = archiveObjectKey(start);
  await bucket.put(objectKey, gz, { httpMetadata: { contentType: 'application/gzip' } });
  // manifest 与 rollup 同批：清单存在 = 该窗口计数已入 rollup，趋势查询不会出现缺段
  await db.transaction(async (tx) => {
    await LogRepo.insertArchiveTx(tx, {
      id: uuid(),
      rangeStart: start,
      rangeEnd: end,
      rowCount: rows.length,
      objectKey,
      bytes: gz.byteLength,
      sha256,
      version: ARCHIVE_VERSION,
      createdAt: Date.now(),
    });
    await LogRepo.upsertRollupsTx(tx, aggregateRollups(rows));
  });
}

/** 受控批次删除窗口热行；返回删除行数 */
async function pruneWindow(db: Db, start: number, end: number): Promise<number> {
  let removed = 0;
  for (let i = 0; i < MAX_PRUNE_BATCHES; i++) {
    const res = await db.run(
      `DELETE FROM access_logs WHERE id IN (
         SELECT id FROM access_logs WHERE created_at >= ? AND created_at < ?
         ORDER BY created_at ASC, id ASC LIMIT ?
       )`,
      [start, end, DELETE_BATCH]
    );
    removed += res.changes;
    if (res.changes < DELETE_BATCH) break;
  }
  return removed;
}

async function windowHasRows(db: Db, start: number, end: number): Promise<boolean> {
  const row = await db.first('SELECT 1 AS x FROM access_logs WHERE created_at >= ? AND created_at < ? LIMIT 1', [start, end]);
  return row != null;
}

/**
 * 定时任务入口：每轮先续跑未完成清理，再归档最多 WINDOWS_PER_RUN 个过期小时窗口。
 * 返回本轮推进的窗口数（含清理续跑）。
 */
export async function archiveAuditLogs(env: Env, now: number = Date.now()): Promise<number> {
  const bucket = env.AUDIT_BUCKET;
  if (!bucket) return 0; // 冷层未配置：只读不删，避免「归档缺失却清理热行」造成数据丢失
  const db = Db.fromAny(env.DB);
  const retentionDays = await readRetentionDays(db);
  if (retentionDays <= 0) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  let processed = 0;

  // 1) 续跑未完成的热行清理（manifest 已落库 → 只删不重导；重复执行幂等）
  for (const pending of await LogRepo.listPendingPrunes(db, WINDOWS_PER_RUN)) {
    await pruneWindow(db, pending.rangeStart, pending.rangeEnd);
    if (!(await windowHasRows(db, pending.rangeStart, pending.rangeEnd))) {
      await LogRepo.markArchivePruned(db, pending.id);
    }
    processed++;
    if (processed >= WINDOWS_PER_RUN) return processed;
  }

  // 2) 归档已过保留期的最旧小时窗口（每轮限量推进；`windowEnd > cutoff` 即停止）
  while (processed < WINDOWS_PER_RUN) {
    const row = await db.first('SELECT MIN(created_at) AS m FROM access_logs');
    const minTs = row?.m == null ? null : Number(row.m);
    if (minTs == null) break;
    const windowStart = Math.floor(minTs / HOUR_MS) * HOUR_MS;
    const windowEnd = windowStart + HOUR_MS;
    if (windowEnd > cutoff) break;
    if (await LogRepo.getArchiveByRange(db, windowStart)) break; // 异常残留（正常已在上一步清理）
    await archiveWindow(db, bucket, windowStart, windowEnd);
    processed++;
    await pruneWindow(db, windowStart, windowEnd);
    if (!(await windowHasRows(db, windowStart, windowEnd))) {
      const archive = await LogRepo.getArchiveByRange(db, windowStart);
      if (archive) await LogRepo.markArchivePruned(db, archive.id);
    }
  }
  return processed;
}
