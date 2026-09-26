// 分片上传断点续传契约：记录分片、缺口拒绝完成、补齐后完成
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { Db, SessionRepo } from '../src/db';
import { releaseExpiredReservations } from '../src/services/cleanup';
import type { Env } from '../src/shared/types';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('分片上传断点续传契约', () => {
  const MB = 1024 * 1024;

  it('记录分片、查询缺失、缺口拒绝完成、补齐后完成', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'mpuser');
    const csrf = await getCsrf(ctx, authCookie);
    const fileSize = 20 * MB; // totalParts = ceil(20MB/8MB) = 3

    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'big.bin', fileSize, mimeType: 'application/octet-stream', partCount: 3 },
    });
    expect(initRes.status).toBe(200);
    const initData = (await json(initRes)).data as {
      sessionId: string;
      totalParts: number;
      uploadMode: string;
      parts: unknown[];
    };
    expect(initData.totalParts).toBe(3);
    expect(initData.uploadMode).toBe('worker');
    expect(initData.parts).toHaveLength(0); // R2 绑定不支持分片预签名
    const sessionId = initData.sessionId;

    const putPart = async (n: number, size: number) => {
      const bytes = new Uint8Array(size);
      bytes[0] = n;
      bytes[size - 1] = n;
      const req = new Request(`http://localhost:8787/api/files/upload/multipart/${sessionId}/part/${n}`, {
        method: 'PUT',
        headers: { Cookie: authCookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      return ctx.app.fetch(req, ctx.env as unknown as Env, {} as ExecutionContext);
    };

    const getParts = async () => {
      const res = await request(ctx, `/api/files/upload/multipart/${sessionId}/parts`, { cookie: authCookie });
      return (await json(res)).data as {
        totalParts: number;
        completedCount: number;
        parts: Array<{ partNumber: number; etag: string }>;
        missingParts: number[];
      };
    };

    // 上传 1 和 3，跳过 2 → 存在缺口
    expect((await putPart(1, 8 * MB)).status).toBe(200);
    expect((await putPart(3, 4 * MB)).status).toBe(200);

    const mid = await getParts();
    expect(mid.completedCount).toBe(2);
    expect(mid.missingParts).toEqual([2]);
    expect(mid.parts.map((p) => p.partNumber).sort()).toEqual([1, 3]);

    // 缺口存在时拒绝完成
    const gapComplete = await request(ctx, '/api/files/upload-complete', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { sessionId },
    });
    expect(gapComplete.status).toBe(422);

    // 补齐第 2 片 → 无缺口 → 完成
    expect((await putPart(2, 8 * MB)).status).toBe(200);
    const after = await getParts();
    expect(after.completedCount).toBe(3);
    expect(after.missingParts).toEqual([]);

    const completeRes = await request(ctx, '/api/files/upload-complete', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { sessionId },
    });
    expect(completeRes.status).toBe(200);
    const completeData = await json(completeRes);
    expect(completeData.data.file.id).toBeTruthy();
  });
});

// ============ 上传会话异常预留回收 ============

describe('上传会话异常预留回收', () => {
  const MB = 1024 * 1024;

  const reservedOf = (sql: string, id: string): number => {
    const row = ctx.db.prepare(sql).get(id) as { quota_reserved: number | null } | undefined;
    return Number(row?.quota_reserved ?? 0);
  };
  const sessionStatus = (id: string): string =>
    (ctx.db.prepare('SELECT status FROM upload_sessions WHERE id = ?').get(id) as { status: string }).status;
  const rootMountId = (): string =>
    (ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string }).id;

  it('raw 上传 Provider 写入失败 → 会话 aborted 且预留归零', async () => {
    const { userId, authCookie } = await registerAndLogin(ctx, 'sec11raw');
    const csrf = await getCsrf(ctx, authCookie);
    const fileSize = 100;
    const mountId = rootMountId();

    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'sec11raw.bin', fileSize, mimeType: 'application/octet-stream' },
    });
    expect(initRes.status).toBe(200);
    const sessionId = ((await json(initRes)).data as { sessionId: string }).sessionId;
    // 会话创建即预留（用户层）
    expect(reservedOf('SELECT quota_reserved FROM user_quotas WHERE user_id = ?', userId)).toBe(fileSize);

    // 实际字节数 ≠ 会话声明大小 → Provider 写入校验失败
    const rawRes = await request(ctx, `/api/files/upload/raw/${sessionId}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
      body: 'x'.repeat(fileSize - 1),
    });
    expect(rawRes.status).toBe(422);

    // 异常即终态：aborted，三层预留即时释放（不再滞留到过期清扫）
    expect(sessionStatus(sessionId)).toBe('aborted');
    expect(reservedOf('SELECT quota_reserved FROM user_quotas WHERE user_id = ?', userId)).toBe(0);
    expect(reservedOf('SELECT quota_reserved FROM mounts WHERE id = ?', mountId)).toBe(0);

    // 终态会话不可续传
    const retry = await request(ctx, `/api/files/upload/raw/${sessionId}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
      body: 'x'.repeat(fileSize),
    });
    expect(retry.status).toBe(409);
  });

  it('分片上传失败 → 会话回 pending、预留保留、可续传', async () => {
    const { userId, authCookie } = await registerAndLogin(ctx, 'sec11part');
    const csrf = await getCsrf(ctx, authCookie);
    const fileSize = 20 * MB; // totalParts = 3
    const mountId = rootMountId();

    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'sec11part.bin', fileSize, mimeType: 'application/octet-stream', partCount: 3 },
    });
    expect(initRes.status).toBe(200);
    const sessionId = ((await json(initRes)).data as { sessionId: string }).sessionId;
    const userBefore = reservedOf('SELECT quota_reserved FROM user_quotas WHERE user_id = ?', userId);
    const mountBefore = reservedOf('SELECT quota_reserved FROM mounts WHERE id = ?', mountId);

    const putPart = async (n: number, size: number) => {
      const bytes = new Uint8Array(size);
      bytes[0] = n;
      const req = new Request(`http://localhost:8787/api/files/upload/multipart/${sessionId}/part/${n}`, {
        method: 'PUT',
        headers: { Cookie: authCookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      return ctx.app.fetch(req, ctx.env as unknown as Env, {} as ExecutionContext);
    };

    // 篡改 upload_id → provider.uploadPart 失败（模拟 Provider 故障）
    const origUploadId = (
      ctx.db.prepare('SELECT upload_id FROM upload_sessions WHERE id = ?').get(sessionId) as { upload_id: string }
    ).upload_id;
    ctx.db.prepare(`UPDATE upload_sessions SET upload_id = 'mpu-broken' WHERE id = ?`).run(sessionId);
    expect((await putPart(1, 8 * MB)).status).toBe(500);

    // 会话回到 pending（保持可续传），预留原样保留
    expect(sessionStatus(sessionId)).toBe('pending');
    expect(reservedOf('SELECT quota_reserved FROM user_quotas WHERE user_id = ?', userId)).toBe(userBefore);
    expect(reservedOf('SELECT quota_reserved FROM mounts WHERE id = ?', mountId)).toBe(mountBefore);

    // 恢复 upload_id 后继续上传：断点续传不受故障影响
    ctx.db.prepare('UPDATE upload_sessions SET upload_id = ? WHERE id = ?').run(origUploadId, sessionId);
    expect((await putPart(1, 8 * MB)).status).toBe(200);
    const partsRes = await request(ctx, `/api/files/upload/multipart/${sessionId}/parts`, { cookie: authCookie });
    const partsData = await json(partsRes);
    expect(partsData.data.completedCount).toBe(1);
    expect(partsData.data.missingParts).toEqual([2, 3]);
  });

  it('过期的 verifying/failed 会话被清扫回收并标 expired（未过期的在途会话不动）', async () => {
    const { userId } = await registerAndLogin(ctx, 'sec11sweep');
    const db = Db.fromSqlite(ctx.db);
    const mountId = rootMountId();

    const expiredAt = Date.now() - 1000;
    const s1 = await SessionRepo.createSession(db, {
      userId, mountId, objectKey: 'sweep/v.bin', path: '/', fileName: 'v.bin',
      fileSize: 10, quotaReserved: 10, expiresAt: expiredAt,
    });
    await SessionRepo.updateStatus(db, s1, { status: 'verifying' });
    const s2 = await SessionRepo.createSession(db, {
      userId, mountId, objectKey: 'sweep/f.bin', path: '/', fileName: 'f.bin',
      fileSize: 20, quotaReserved: 20, expiresAt: expiredAt,
    });
    await SessionRepo.updateStatus(db, s2, { status: 'failed' });
    const s3 = await SessionRepo.createSession(db, {
      userId, mountId, objectKey: 'sweep/live.bin', path: '/', fileName: 'live.bin',
      fileSize: 5, quotaReserved: 5, expiresAt: Date.now() + 3600_000,
    });
    await SessionRepo.updateStatus(db, s3, { status: 'verifying' });

    // 聚合预留摆到与真实 reserve() 一致的状态（过期 30 + 在途 5）
    ctx.db.prepare('UPDATE user_quotas SET quota_reserved = quota_reserved + 35 WHERE user_id = ?').run(userId);
    ctx.db.prepare('UPDATE mounts SET quota_reserved = quota_reserved + 35 WHERE id = ?').run(mountId);

    const mountBefore = reservedOf('SELECT quota_reserved FROM mounts WHERE id = ?', mountId);
    const released = await releaseExpiredReservations(ctx.env);
    expect(released).toBe(2);

    // 仅回收过期会话的预留，在途会话（未过期 verifying）保留；挂载行为共享行，按差值断言
    expect(reservedOf('SELECT quota_reserved FROM user_quotas WHERE user_id = ?', userId)).toBe(5);
    expect(reservedOf('SELECT quota_reserved FROM mounts WHERE id = ?', mountId)).toBe(mountBefore - 30);
    expect(sessionStatus(s1)).toBe('expired');
    expect(sessionStatus(s2)).toBe('expired');
    expect(sessionStatus(s3)).toBe('verifying');
  });
});
