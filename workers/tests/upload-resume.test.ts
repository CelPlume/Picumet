// 分片上传断点续传契约回归（审计 Fix 3）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
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
