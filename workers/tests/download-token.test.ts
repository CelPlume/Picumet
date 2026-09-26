// 下载令牌原子消费：令牌只能成功消费一次，重复使用返回 401
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
      body: { fileIds: [uploaded.file.id], allowDownload: true },
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

// 下载计数只在网关消费时增加一次，签发阶段不计数
describe('分享下载计数', () => {
  it('签发下载令牌不计数，实际下载才计数一次', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'dlcount1');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'count.txt', 'count-content');

    const shareRes = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileIds: [uploaded.file.id], allowDownload: true, maxDownloads: 5 },
    });
    const shareId = (await json(shareRes)).data.share.id as string;

    // 签发多次令牌：计数不应增加
    for (let i = 0; i < 3; i++) {
      const dlRes = await request(ctx, `/api/shares/${shareId}/download`);
      expect(dlRes.status).toBe(200);
    }
    let share = (await ShareRepoProxy.getShare(ctx, shareId))!;
    expect(share.downloadCount).toBe(0);

    // 实际下载 1 次 → 计数 1
    const dlRes = await request(ctx, `/api/shares/${shareId}/download`);
    const url = (await json(dlRes)).data.url.replace('http://localhost:8787', '');
    const gw = await request(ctx, url);
    expect(gw.status).toBe(200);
    share = (await ShareRepoProxy.getShare(ctx, shareId))!;
    expect(share.downloadCount).toBe(1);
  });

  it('maxDownloads 用尽后网关拒绝下载（410）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'dlcount2');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'limit.txt', 'limit-content');

    const shareRes = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileIds: [uploaded.file.id], allowDownload: true, maxDownloads: 1 },
    });
    const shareId = (await json(shareRes)).data.share.id as string;

    const dlRes = await request(ctx, `/api/shares/${shareId}/download`);
    const url = (await json(dlRes)).data.url.replace('http://localhost:8787', '');

    const first = await request(ctx, url);
    expect(first.status).toBe(200);
    const second = await request(ctx, url); // 令牌已删，即使计数到上限也应 401（令牌不可重放）
    expect(second.status).toBe(401);

    // 重新签发令牌 → 计数已到上限 → 网关 410
    const dlRes2 = await request(ctx, `/api/shares/${shareId}/download`);
    expect(dlRes2.status).toBe(200);
    const url2 = (await json(dlRes2)).data.url.replace('http://localhost:8787', '');
    const blocked = await request(ctx, url2);
    expect(blocked.status).toBe(410);
  });
});

// 测试辅助：直接经仓库读取分享计数
const ShareRepoProxy = {
  async getShare(ctx: TestContext, id: string) {
    const { ShareRepo, Db } = await import('../src/db');
    return ShareRepo.getShare(Db.fromSqlite(ctx.db), id);
  },
};
