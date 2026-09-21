// 追踪链路（§D）：path-serve 失败/异常落库、分享浏览去重
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

async function uploadFile(cookie: string, fileName: string, content: string): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: '/', fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initData = (await json(initRes)).data as { sessionId: string };
  await request(ctx, `/api/files/upload/raw/${initData.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.sessionId, etag: 'etag' },
  });
  return ((await json(completeRes)).data as { file: { id: string } }).file.id;
}

interface LogRow {
  action: string;
  status_code: number | null;
  path: string | null;
  metadata: string | null;
}

describe('追踪链路', () => {
  it('path-serve 失败落库（download_failed + 状态码），成功流量不落库', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'track_owner');
    await uploadFile(authCookie, 'track.txt', 'track-content');

    // 匿名访问未开放游客 → 401，应落库
    const denied = await request(ctx, '/track.txt');
    expect(denied.status).toBe(401);
    const deniedRow = ctx.db
      .prepare("SELECT action, status_code, path, metadata FROM access_logs WHERE action = 'download_failed' AND path = '/track.txt' ORDER BY created_at DESC LIMIT 1")
      .get() as LogRow | undefined;
    expect(deniedRow?.status_code).toBe(401);
    expect(JSON.parse(deniedRow?.metadata ?? '{}').code).toBe('LOGIN_REQUIRED');

    // 已挂载路径上的不存在文件 → 404，应落库
    const missing = await request(ctx, '/track-missing.txt');
    expect(missing.status).toBe(404);
    const missingRow = ctx.db
      .prepare("SELECT action, status_code FROM access_logs WHERE action = 'download_failed' AND path = '/track-missing.txt' ORDER BY created_at DESC LIMIT 1")
      .get() as LogRow | undefined;
    expect(missingRow?.status_code).toBe(404);

    // 成功直链（签名）不产生 download 日志行（成功流量不落库，控制写入放大）
    const { authCookie: ownerCookie2 } = await registerAndLogin(ctx, 'track_owner2');
    const fileId2 = await uploadFile(ownerCookie2, 'track-ok.txt', 'ok-content');
    const csrf = await getCsrf(ctx, ownerCookie2);
    const linksRes = await request(ctx, `/api/files/${fileId2}/copy-links?signed=true&expiresIn=3600`, {
      cookie: ownerCookie2,
      headers: { 'X-CSRF-Token': csrf },
    });
    const direct = (await json(linksRes)).data.formats.direct as string;
    const u = new URL(direct);
    const ok = await request(ctx, u.pathname + u.search);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok-content');
    const successRows = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM access_logs WHERE action = 'download_failed' AND path = '/track-ok.txt'")
      .get() as { c: number };
    expect(Number(successRows.c)).toBe(0);
  });

  it('分享浏览去重：同 IP 60s 内重复打开只计一次', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'track_sharer');
    const csrf = await getCsrf(ctx, authCookie);
    const fileId = await uploadFile(authCookie, 'share-view.txt', 'view-content');
    const createRes = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileIds: [fileId] },
    });
    const shareId = ((await json(createRes)).data as { share: { id: string } }).share.id;

    const first = await request(ctx, `/api/shares/${shareId}`);
    expect(first.status).toBe(200);
    expect(((await json(first)).data as { share: { viewCount: number } }).share.viewCount).toBe(1);

    const second = await request(ctx, `/api/shares/${shareId}`);
    expect(second.status).toBe(200);
    expect(((await json(second)).data as { share: { viewCount: number } }).share.viewCount).toBe(1);

    const row = ctx.db
      .prepare('SELECT view_count FROM shares WHERE id = ?')
      .get(shareId) as { view_count: number };
    expect(Number(row.view_count)).toBe(1);
  });
});
