// 分享访问策略（§B）：仅登录 / 指定用户 / 绝对时间二选一 / 网关实时校验
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

async function createShare(cookie: string, csrf: string, body: Record<string, unknown>) {
  return request(ctx, '/api/shares', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body,
  });
}

describe('分享访问策略', () => {
  it('仅登录分享：匿名 401 LOGIN_REQUIRED，登录用户可见', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'login-only.txt', 'login-only');

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], requireLogin: true });
    expect(res.status).toBe(201);
    const createData = await json(res);
    const shareId = createData.data.share.id as string;
    expect(createData.data.share.requireLogin).toBe(true);

    const anon = await request(ctx, `/api/shares/${shareId}`);
    expect(anon.status).toBe(401);
    expect((await json(anon)).error.code).toBe('LOGIN_REQUIRED');

    const { authCookie: viewerCookie } = await registerAndLogin(ctx, 'sa_viewer');
    const asViewer = await request(ctx, `/api/shares/${shareId}`, { cookie: viewerCookie });
    expect(asViewer.status).toBe(200);
    expect((await json(asViewer)).data.share.items[0]).toBeTruthy();
  });

  it('指定用户分享：匿名 401、名单外 403、名单内 200', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa2_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'named.txt', 'named-content');
    const { authCookie: allowedCookie } = await registerAndLogin(ctx, 'sa2_allowed');
    const { authCookie: otherCookie } = await registerAndLogin(ctx, 'sa2_other');

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], allowedUsers: ['sa2_allowed'] });
    expect(res.status).toBe(201);
    const createData = await json(res);
    const shareId = createData.data.share.id as string;
    expect(createData.data.share.allowedUserCount).toBe(1);

    const anon = await request(ctx, `/api/shares/${shareId}`);
    expect(anon.status).toBe(401);
    expect((await json(anon)).error.code).toBe('LOGIN_REQUIRED');

    const other = await request(ctx, `/api/shares/${shareId}`, { cookie: otherCookie });
    expect(other.status).toBe(403);
    expect((await json(other)).error.code).toBe('FORBIDDEN');

    const allowed = await request(ctx, `/api/shares/${shareId}`, { cookie: allowedCookie });
    expect(allowed.status).toBe(200);
  });

  it('指定用户分享：未知用户名被拒绝', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa3_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'unknown-user.txt', 'x');
    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], allowedUsers: ['no-such-user'] });
    expect(res.status).toBe(400);
  });

  it('绝对截止时间：未来时间可见，过期时间 410', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa4_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'absolute.txt', 'absolute-content');

    const future = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], expiresAt: Date.now() + 3600 * 1000 });
    expect(future.status).toBe(201);
    const futureId = (await json(future)).data.share.id as string;
    const viewFuture = await request(ctx, `/api/shares/${futureId}`);
    expect(viewFuture.status).toBe(200);

    const past = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], expiresAt: Date.now() - 1000 });
    expect(past.status).toBe(201);
    const pastId = (await json(past)).data.share.id as string;
    const viewPast = await request(ctx, `/api/shares/${pastId}`);
    expect(viewPast.status).toBe(410);
    expect((await json(viewPast)).error.code).toBe('SHARE_EXPIRED');
  });

  it('expiresIn 与 expiresAt 同时提交 → 400', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa5_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'both.txt', 'both');
    const res = await createShare(authCookie, csrf, {
      fileIds: [uploaded.file.id],
      expiresIn: 3600,
      expiresAt: Date.now() + 3600 * 1000,
    });
    expect(res.status).toBe(400);
  });

  it('网关实时校验：仅登录分享的令牌匿名消费 401，登录后 200', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa6_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'gw-login.txt', 'gw-login-content');
    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], requireLogin: true });
    const shareId = (await json(res)).data.share.id as string;

    // 登录态签发令牌
    const dl = await request(ctx, `/api/shares/${shareId}/download`, { cookie: authCookie });
    expect(dl.status).toBe(200);
    const url = ((await json(dl)).data.url as string).replace('http://localhost:8787', '');

    // 匿名消费 → 策略拦截（令牌已消费，但不放行对象）
    const anon = await request(ctx, url);
    expect(anon.status).toBe(401);
    expect((await json(anon)).error.code).toBe('LOGIN_REQUIRED');

    // 重新签发并以登录态消费 → 成功
    const dl2 = await request(ctx, `/api/shares/${shareId}/download`, { cookie: authCookie });
    const url2 = ((await json(dl2)).data.url as string).replace('http://localhost:8787', '');
    const ok = await request(ctx, url2, { cookie: authCookie });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('gw-login-content');
  });

  it('网关实时校验：撤销分享后未消费令牌立即失效', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sa7_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'gw-revoked.txt', 'revoked-content');
    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id] });
    const shareId = (await json(res)).data.share.id as string;

    const dl = await request(ctx, `/api/shares/${shareId}/download`, { cookie: authCookie });
    const url = ((await json(dl)).data.url as string).replace('http://localhost:8787', '');

    const revoke = await request(ctx, `/api/shares/${shareId}`, { method: 'DELETE', cookie: authCookie });
    expect(revoke.status).toBe(200);

    const consume = await request(ctx, url);
    expect(consume.status).toBe(410);
    expect((await json(consume)).error.code).toBe('SHARE_REVOKED');
  });
});
