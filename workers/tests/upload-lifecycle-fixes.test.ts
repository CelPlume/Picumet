// 分片上传生命周期：
//   · 过期分片会话的清扫主动终止 Provider multipart upload；abort 失败登记带 upload_id 的清理队列，
//     队列消费端重试成功后出队；
//   · upload-complete 的原子领取：已领取的会话 409，超过残留窗口的领取可被重试接管。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { releaseExpiredReservations, cleanupMultipartAborts } from '../src/services/cleanup';
import type { Env } from '../src/shared/types';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

const MB = 1024 * 1024;

function sessionRow(id: string): { status: string; upload_id: string | null; provider_id: string | null; mount_id: string } {
  const row = ctx.db
    .prepare('SELECT status, upload_id, provider_id, mount_id FROM upload_sessions WHERE id = ?')
    .get(id) as { status: string; upload_id: string | null; provider_id: string | null; mount_id: string } | undefined;
  expect(row).toBeTruthy();
  return row as { status: string; upload_id: string | null; provider_id: string | null; mount_id: string };
}

async function initMultipart(username: string, fileName: string): Promise<{ sessionId: string; uploadId: string; cookie: string; csrf: string }> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: '/', fileName, fileSize: 12 * MB, mimeType: 'application/octet-stream', partCount: 2 },
  });
  expect(res.status).toBe(200);
  const data = (await json(res)).data as { sessionId: string; uploadId: string };
  return { sessionId: data.sessionId, uploadId: data.uploadId, cookie: authCookie, csrf };
}

async function putPart(sessionId: string, n: number, cookie: string, csrf: string, size = 8 * MB): Promise<Response> {
  const bytes = new Uint8Array(size);
  bytes[0] = n;
  return ctx.app.fetch(
    new Request(`http://localhost:8787/api/files/upload/multipart/${sessionId}/part/${n}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
    ctx.env as unknown as Env,
    {} as ExecutionContext
  );
}

function expireSession(sessionId: string): void {
  ctx.db.prepare('UPDATE upload_sessions SET expires_at = 0 WHERE id = ?').run(sessionId);
}

describe('过期分片会话终止 Provider multipart upload', () => {
  it('清扫过期会话 → 状态 expired 且 Provider 分片上传被终止', async () => {
    const { sessionId, uploadId, cookie, csrf } = await initMultipart('ul_a', 'sweep.bin');
    expect((await putPart(sessionId, 1, cookie, csrf)).status).toBe(200);
    expect(ctx.r2.mpu.has(uploadId)).toBe(true);

    expireSession(sessionId);
    await releaseExpiredReservations(ctx.env);

    expect(sessionRow(sessionId).status).toBe('expired');
    expect(ctx.r2.mpu.has(uploadId)).toBe(false);
  });

  it('abort 失败 → 登记带 upload_id 的清理队列（不丢线索）', async () => {
    const { sessionId, uploadId, cookie, csrf } = await initMultipart('ul_b', 'queue.bin');
    expect((await putPart(sessionId, 1, cookie, csrf)).status).toBe(200);
    // 移除 Provider 侧会话，使 abort 抛错（No such upload）
    ctx.r2.mpu.delete(uploadId);

    expireSession(sessionId);
    await releaseExpiredReservations(ctx.env);

    const orphan = ctx.db
      .prepare(`SELECT object_key, upload_id, cleaned FROM orphan_objects WHERE reason = 'multipart_abort' AND upload_id = ?`)
      .get(uploadId) as { object_key: string; upload_id: string; cleaned: number } | undefined;
    expect(orphan).toBeTruthy();
    expect(Number(orphan?.cleaned)).toBe(0);
    expect(orphan?.object_key).toBeTruthy();
  });

  it('清理队列消费端：abort 重试成功后出队', async () => {
    const { sessionId, uploadId, cookie, csrf } = await initMultipart('ul_c', 'consume.bin');
    expect((await putPart(sessionId, 1, cookie, csrf)).status).toBe(200);
    const session = sessionRow(sessionId);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO orphan_objects (id, mount_id, object_key, reason, error, created_at, cleaned, provider_id, upload_id)
         VALUES ('ul-c-orphan', ?, 'consume.bin', 'multipart_abort', NULL, ?, 0, ?, ?)`
      )
      .run(session.mount_id, now, session.provider_id, uploadId);

    const cleaned = await cleanupMultipartAborts(ctx.env);
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(ctx.r2.mpu.has(uploadId)).toBe(false);
    const row = ctx.db.prepare(`SELECT cleaned FROM orphan_objects WHERE id = 'ul-c-orphan'`).get() as { cleaned: number };
    expect(Number(row.cleaned)).toBe(1);
  });
});

describe('upload-complete 原子领取', () => {
  it('已领取 → 409；领取过期后可接管并完成', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ul_claim');
    const csrf = await getCsrf(ctx, authCookie);
    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'claim.bin', fileSize: 128, mimeType: 'text/plain' },
    });
    const { sessionId, uploadMode } = (await json(initRes)).data as { sessionId: string; uploadMode: string };
    expect(uploadMode).toBe('worker');

    const raw = await request(ctx, `/api/files/upload/raw/${sessionId}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'text/plain' },
      body: 'x'.repeat(128),
    });
    expect(raw.status).toBe(200);
    const etag = ((await json(raw)).data as { etag: string }).etag;

    // 模拟另一请求已领取（未过期）
    ctx.db.prepare('UPDATE upload_sessions SET complete_claimed_at = ? WHERE id = ?').run(Date.now(), sessionId);
    const blocked = await request(ctx, '/api/files/upload-complete', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { sessionId, etag },
    });
    expect(blocked.status).toBe(409);

    // 领取残留超过窗口 → 重试接管
    ctx.db.prepare('UPDATE upload_sessions SET complete_claimed_at = ? WHERE id = ?').run(Date.now() - 10 * 60_000, sessionId);
    const done = await request(ctx, '/api/files/upload-complete', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { sessionId, etag },
    });
    expect(done.status).toBe(200);
    expect(sessionRow(sessionId).status).toBe('completed');
  });
});
