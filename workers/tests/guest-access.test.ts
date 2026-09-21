// 游客访问（§C）：匿名 guest 主体、站点开关、role='guest' 规则、visibility 主体感知、公开列表
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'guest_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'guest_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'guest_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function uploadFile(cookie: string, dir: string, fileName: string, content: string): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
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

async function createFolder(cookie: string, fullPath: string): Promise<void> {
  const csrf = await getCsrf(ctx, cookie);
  const segs = fullPath.split('/').filter(Boolean);
  const name = segs.pop() ?? '';
  const parent = '/' + segs.join('/');
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: parent, name },
  });
  expect(res.status).toBe(201);
}

async function guestRule(pathPattern: string, permissions: string[]): Promise<void> {
  const res = await request(ctx, '/api/admin/rules', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { pathPattern, effect: 'allow', role: 'guest', permissions },
  });
  expect(res.status).toBe(201);
}

async function setGuestAccess(enabled: boolean): Promise<void> {
  const res = await request(ctx, '/api/admin/settings', {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { allowGuestAccess: enabled },
  });
  expect(res.status).toBe(200);
}

describe('游客访问', () => {
  it('role=guest 规则 + 站点开关：匿名直读文件（此前匿名主体缺位恒 403）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'guest_owner1');
    await createFolder(authCookie, '/guestpub');
    await uploadFile(authCookie, '/guestpub', 'hello.txt', 'guest-hello');
    await guestRule('/guestpub', ['read', 'download']);

    // 开关关闭（默认）→ 401 引导登录
    const closed = await request(ctx, '/guestpub/hello.txt');
    expect(closed.status).toBe(401);
    expect((await json(closed)).error.code).toBe('LOGIN_REQUIRED');

    await setGuestAccess(true);
    const open = await request(ctx, '/guestpub/hello.txt');
    expect(open.status).toBe(200);
    expect(await open.text()).toBe('guest-hello');
  });

  it('无规则路径：匿名 403，站点开关关闭时 401', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'guest_owner2');
    await createFolder(authCookie, '/guestpriv');
    await uploadFile(authCookie, '/guestpriv', 'secret.txt', 'secret');

    await setGuestAccess(true);
    const anon = await request(ctx, '/guestpriv/secret.txt');
    expect(anon.status).toBe(403);

    await setGuestAccess(false);
    const gated = await request(ctx, '/guestpriv/secret.txt');
    expect(gated.status).toBe(401);
  });

  it('visibility 主体感知：users 对游客不可见、对登录用户可见；public 对游客可见', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'guest_owner3');
    await createFolder(authCookie, '/viszone');
    const usersFileId = await uploadFile(authCookie, '/viszone', 'users-only.txt', 'for-users');
    const publicFileId = await uploadFile(authCookie, '/viszone', 'public.txt', 'for-everyone');
    ctx.db.exec(`UPDATE file_metadata SET visibility = 'users' WHERE id = '${usersFileId}'`);
    ctx.db.exec(`UPDATE file_metadata SET visibility = 'public' WHERE id = '${publicFileId}'`);
    await setGuestAccess(true);

    // 游客：users 不可见（visibility 合成规则对匿名不生效）
    const anonUsers = await request(ctx, '/viszone/users-only.txt');
    expect(anonUsers.status).toBe(403);

    // 游客：public 可见
    const anonPublic = await request(ctx, '/viszone/public.txt');
    expect(anonPublic.status).toBe(200);
    expect(await anonPublic.text()).toBe('for-everyone');

    // 登录的其他用户：users 可见
    const { authCookie: otherCookie } = await registerAndLogin(ctx, 'guest_other3');
    const asUser = await request(ctx, '/viszone/users-only.txt', { cookie: otherCookie });
    expect(asUser.status).toBe(200);
    expect(await asUser.text()).toBe('for-users');
  });

  it('公开列表 /api/public/fs：开关、目录权限与逐项过滤（含签名直链可匿名取回）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'guest_owner4');
    await createFolder(authCookie, '/listzone');
    await uploadFile(authCookie, '/listzone', 'open.txt', 'open-content');
    const lockedId = await uploadFile(authCookie, '/listzone', 'locked.txt', 'locked-content');

    // 关闭开关：401
    await setGuestAccess(false);
    const gated = await request(ctx, '/api/public/fs?path=/listzone');
    expect(gated.status).toBe(401);

    // 打开开关但无目录规则：403
    await setGuestAccess(true);
    const denied = await request(ctx, '/api/public/fs?path=/listzone');
    expect(denied.status).toBe(403);

    // 授 guest 读目录
    await guestRule('/listzone', ['read', 'download']);
    const listed = await request(ctx, '/api/public/fs?path=/listzone');
    expect(listed.status).toBe(200);
    const body = await json(listed);
    const items = body.data.items as Array<{ name: string; type: string; url: string | null; hasPassword: boolean }>;
    const names = items.map((i) => i.name);
    expect(names).toContain('open.txt');
    expect(names).toContain('locked.txt');

    const openItem = items.find((i) => i.name === 'open.txt');
    expect(openItem?.url).toBeTruthy();
    const fetched = await request(ctx, new URL(openItem?.url ?? '').pathname + new URL(openItem?.url ?? '').search);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe('open-content');

    // 密码保护文件：标记锁定且不给直链
    ctx.db.exec(`UPDATE file_metadata SET access_password = 'hash' WHERE id = '${lockedId}'`);
    const listed2 = await request(ctx, '/api/public/fs?path=/listzone');
    const items2 = (await json(listed2)).data.items as Array<{ name: string; url: string | null; hasPassword: boolean }>;
    const lockedItem = items2.find((i) => i.name === 'locked.txt');
    expect(lockedItem?.hasPassword).toBe(true);
    expect(lockedItem?.url).toBeNull();
  });

  it('登录用户列表：按自身默认路径权限可见（不受游客开关影响）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'guest_user5');
    await createFolder(authCookie, '/minezone');
    await uploadFile(authCookie, '/minezone', 'mine.txt', 'mine-content');
    await setGuestAccess(false);

    const res = await request(ctx, '/api/public/fs?path=/minezone', { cookie: authCookie });
    expect(res.status).toBe(200);
    const items = (await json(res)).data.items as Array<{ name: string; url: string | null }>;
    expect(items.map((i) => i.name)).toContain('mine.txt');
  });
});
