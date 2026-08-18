// 下载令牌原子消费回归（审计 Fix 5）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

async function uploadFile(cookie: string, fileName: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(ctx, cookie);
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
  return (await json(completeRes)).data as { file: { id: string; name: string } };
}

describe('下载令牌原子消费', () => {
  it('令牌单次消费，重复使用返回 401', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'dluser');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'atomic.txt', 'atomic-content');

    const shareRes = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileId: uploaded.file.id, allowDownload: true },
    });
    const shareId = (await json(shareRes)).data.share.id as string;

    const dlRes = await request(ctx, `/api/shares/${shareId}/download`);
    expect(dlRes.status).toBe(200);
    const dlData = await json(dlRes);
    const url = dlData.data.url.replace('http://localhost:8787', '');

    // 第一次消费成功
    const first = await request(ctx, url);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('atomic-content');

    // 第二次消费 → 令牌已原子消费，拒绝
    const second = await request(ctx, url);
    expect(second.status).toBe(401);
  });
});
