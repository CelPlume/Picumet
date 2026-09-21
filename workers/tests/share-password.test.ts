// 分享密码：可逆密文落库（enc: + AES-GCM）+ 创建者列表回看 + 公开响应零泄漏 + 带参数直进
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

/** 创建分享响应（仅取测试用到的字段） */
interface CreatedShare {
  data: { share: { id: string; passwordProtected: boolean } };
}
/** 公开详情响应（仅取测试用到的字段） */
interface ShareDetail {
  data: { share: { requiresPassword: boolean; items: Array<{ id: string }> } };
}
/** 我的分享列表条目（含创建者回看的 `password?`） */
interface MyShareItem {
  id: string;
  passwordProtected: boolean;
  password?: string;
}
/** shares 行上的密码列快照 */
interface SharePasswordRow {
  password_hash: string | null;
  password_cipher: string | null;
}

async function uploadFile(cookie: string, fileName: string, content: string, context: TestContext = ctx): Promise<{ file: { id: string; name: string } }> {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(context, cookie);
  const initRes = await request(context, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: '/', fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initData = await json<{ data: { sessionId: string } }>(initRes);
  await request(context, `/api/files/upload/raw/${initData.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(context, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.data.sessionId, etag: 'etag' },
  });
  return (await json<{ data: { file: { id: string; name: string } } }>(completeRes)).data;
}

async function createShare(cookie: string, csrf: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, '/api/shares', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body,
  });
}

async function myShares(cookie: string, context: TestContext = ctx): Promise<MyShareItem[]> {
  const res = await request(context, '/api/shares?limit=100', { cookie });
  expect(res.status).toBe(200);
  return (await json<{ data: { items: MyShareItem[] } }>(res)).data.items;
}

function sharePasswordRow(context: TestContext, shareId: string): SharePasswordRow | undefined {
  return context.db
    .prepare('SELECT password_hash, password_cipher FROM shares WHERE id = ?')
    .get(shareId) as SharePasswordRow | undefined;
}

/** 列表条目按 id 取回；缺失即测试前提不成立，直接失败 */
function findShare(items: MyShareItem[], shareId: string): MyShareItem {
  const item = items.find((i) => i.id === shareId);
  if (!item) throw new Error(`分享 ${shareId} 不在我的分享列表中`);
  return item;
}

describe('分享密码密文与回看', () => {
  it('创建带密码分享：password_cipher 以 enc: 落库，创建者列表解出明文', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'cipher.txt', 'cipher-body');
    const plaintext = 'share-pwd-abc123';

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], password: plaintext });
    expect(res.status).toBe(201);
    const body = await json<CreatedShare>(res);
    const shareId = body.data.share.id;

    // 创建响应回报「已设密码」，但不含密文列名与明文
    expect(body.data.share.passwordProtected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('password_cipher');
    expect(JSON.stringify(body)).not.toContain(plaintext);

    const row = sharePasswordRow(ctx, shareId);
    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_cipher).toMatch(/^enc:/);
    expect(row?.password_cipher).not.toContain(plaintext);

    const item = findShare(await myShares(authCookie), shareId);
    expect(item.passwordProtected).toBe(true);
    expect(item.password).toBe(plaintext);
  });

  it('未设密码的分享：password_cipher 为 NULL，列表条目不出现 password 字段', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_nopwd');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'open.txt', 'open-body');

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id] });
    expect(res.status).toBe(201);
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    expect(sharePasswordRow(ctx, shareId)?.password_cipher).toBeNull();

    const item = findShare(await myShares(authCookie), shareId);
    expect(item.passwordProtected).toBe(false);
    expect(Object.hasOwn(item, 'password')).toBe(false);
  });

  it('密文非法 / 换钥（解密失败）：列表仍 200 且该条目省略 password 字段', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_broken');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'broken.txt', 'broken-body');

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], password: 'broken-pwd' });
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    // 非法密文：base64 解出字节数不足 IV 长度 → GCM 解密抛错
    ctx.db.prepare('UPDATE shares SET password_cipher = ? WHERE id = ?').run('enc:AAAA', shareId);

    const item = findShare(await myShares(authCookie), shareId);
    expect(item.passwordProtected).toBe(true);
    expect(Object.hasOwn(item, 'password')).toBe(false);
  });

  it('ENCRYPTION_KEY 缺失：降级为仅存哈希（创建成功，列表无 password 字段）', async () => {
    const isolated = createTestContext();
    await initSeeded(isolated);
    // 模拟部署环境未提供 ENCRYPTION_KEY
    const envWithoutKey = isolated.env as unknown as { ENCRYPTION_KEY?: string };
    envWithoutKey.ENCRYPTION_KEY = undefined;

    const { authCookie } = await registerAndLogin(isolated, 'sp_nokey');
    const csrf = await getCsrf(isolated, authCookie);
    const uploaded = await uploadFile(authCookie, 'nokey.txt', 'nokey-body', isolated);

    const res = await request(isolated, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileIds: [uploaded.file.id], password: 'degraded-pwd' },
    });
    expect(res.status).toBe(201);
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    const row = sharePasswordRow(isolated, shareId);
    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_cipher).toBeNull();

    const item = findShare(await myShares(authCookie, isolated), shareId);
    expect(item.passwordProtected).toBe(true);
    expect(Object.hasOwn(item, 'password')).toBe(false);
  });
});

describe('公开响应零泄漏', () => {
  it('匿名访问带密码分享：详情/目录/下载/预览均不含明文密码与 password_cipher', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_leak');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'leak.txt', 'leak-body');
    const plaintext = 'leak-secret-pwd';

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], password: plaintext });
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    // 详情：未携带密码 → 遮蔽 200（items 为空），body 不含明文/密文列
    const detail = await request(ctx, `/api/shares/${shareId}`);
    expect(detail.status).toBe(200);
    const detailRaw = await detail.text();
    expect(detailRaw).not.toContain('password_cipher');
    expect(detailRaw).not.toContain(plaintext);

    // 目录浏览 / 下载 / 预览：密码未验证 → 401，响应体同样零泄漏
    const paths = [
      `/api/shares/${shareId}/list?root=${uploaded.file.id}`,
      `/api/shares/${shareId}/download?itemId=${uploaded.file.id}`,
      `/api/shares/${shareId}/preview?itemId=${uploaded.file.id}`,
    ];
    for (const path of paths) {
      const denied = await request(ctx, path);
      expect(denied.status).toBe(401);
      const raw = await denied.text();
      expect(raw).not.toContain('password_cipher');
      expect(raw).not.toContain(plaintext);
    }
  });

  it('创建者本人 GET /:id 回传明文密码（分享面板「复制密码」需要），他人不可见且永不下发密文', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_owner_detail');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'owner-detail.txt', 'owner-detail-body');
    const plaintext = 'owner-detail-pwd';

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], password: plaintext });
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    // 创建者：拿得到明文（未验证密码时也返回，供本页复制/附带密码）
    const detail = await request(ctx, `/api/shares/${shareId}`, { cookie: authCookie });
    expect(detail.status).toBe(200);
    const ownerBody = (await json<{ data: { share: { password?: string } } }>(detail)).data.share;
    expect(ownerBody.password).toBe(plaintext);

    // 其他登录用户：只有遮蔽响应，不含明文与密文
    const { authCookie: otherCookie } = await registerAndLogin(ctx, 'sp_other_detail');
    const other = await request(ctx, `/api/shares/${shareId}`, { cookie: otherCookie });
    const otherRaw = await other.text();
    expect(otherRaw).not.toContain(plaintext);
    expect(otherRaw).not.toContain('password_cipher');

    // 匿名同样不泄露
    const anon = await request(ctx, `/api/shares/${shareId}`);
    const anonRaw = await anon.text();
    expect(anonRaw).not.toContain(plaintext);
    expect(anonRaw).not.toContain('password_cipher');
  });

  it('无密码分享的公开详情同样不含 password_cipher', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_open_leak');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'open-leak.txt', 'open-leak-body');

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id] });
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    const detail = await request(ctx, `/api/shares/${shareId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(await json(detail))).not.toContain('password_cipher');
  });
});

describe('带参数直进（?password=）', () => {
  it('query 密码正确直接返回内容；错误 401 INVALID_PASSWORD', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_query');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'query.txt', 'query-body');
    const plaintext = 'query-direct-pwd';

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], password: plaintext });
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    // 正确密码 → 200 且 items 非空（等价于已通过验证）
    const ok = await request(ctx, `/api/shares/${shareId}?password=${encodeURIComponent(plaintext)}`);
    expect(ok.status).toBe(200);
    const okShare = (await json<ShareDetail>(ok)).data.share;
    expect(okShare.requiresPassword).toBe(true);
    expect(okShare.items.length).toBeGreaterThan(0);

    // 错误密码 → 401 INVALID_PASSWORD
    const bad = await request(ctx, `/api/shares/${shareId}?password=definitely-wrong`);
    expect(bad.status).toBe(401);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe('INVALID_PASSWORD');

    // 下载端点同样支持 query 密码直进
    const dlOk = await request(ctx, `/api/shares/${shareId}/download?itemId=${uploaded.file.id}&password=${encodeURIComponent(plaintext)}`);
    expect(dlOk.status).toBe(200);
    const dlBad = await request(ctx, `/api/shares/${shareId}/download?itemId=${uploaded.file.id}&password=definitely-wrong`);
    expect(dlBad.status).toBe(401);

    // 未携带密码 → 遮蔽 200（不抛错，保持既有行为）
    const masked = await request(ctx, `/api/shares/${shareId}`);
    expect(masked.status).toBe(200);
    expect((await json<ShareDetail>(masked)).data.share.items).toEqual([]);
  });

  it('POST /:id/verify（body 密码）行为不变：错误 401、正确 200 并种授权 cookie', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sp_verify');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'verify.txt', 'verify-body');
    const plaintext = 'verify-pwd-99';

    const res = await createShare(authCookie, csrf, { fileIds: [uploaded.file.id], password: plaintext });
    const shareId = (await json<CreatedShare>(res)).data.share.id;

    const bad = await request(ctx, `/api/shares/${shareId}/verify`, { method: 'POST', body: { password: 'nope' } });
    expect(bad.status).toBe(401);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe('INVALID_PASSWORD');

    const good = await request(ctx, `/api/shares/${shareId}/verify`, { method: 'POST', body: { password: plaintext } });
    expect(good.status).toBe(200);
    expect((await json<{ data: { authorized: boolean } }>(good)).data.authorized).toBe(true);

    const authValue = (good.headers.get('set-cookie') ?? '').match(new RegExp(`share_auth_${shareId}=([^;]+)`))?.[1];
    expect(authValue).toBeTruthy();
    const viaCookie = await request(ctx, `/api/shares/${shareId}`, { cookie: `share_auth_${shareId}=${authValue}` });
    expect(viaCookie.status).toBe(200);
    expect((await json<ShareDetail>(viaCookie)).data.share.items.length).toBeGreaterThan(0);
  });
});
