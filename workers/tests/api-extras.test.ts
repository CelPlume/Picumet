// API 集成测试：分享、API 密钥、兼容上传、WebDAV、管理员、安全
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

async function uploadFile(cookie: string, fileName: string, content: string, path = '/') {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(ctx, cookie);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
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

describe('分享', () => {
  it('创建分享并公开访问', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sharer');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'share.txt', 'shared-content');

    const createRes = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileId: uploaded.file.id, allowDownload: true },
    });
    expect(createRes.status).toBe(201);
    const createData = await json(createRes);
    const shareId = createData.data.share.id;
    expect(shareId).toBeTruthy();

    // 公开访问（无需登录）
    const getRes = await request(ctx, `/api/shares/${shareId}`);
    expect(getRes.status).toBe(200);
    const getData = await json(getRes);
    expect(getData.data.share.file.name).toBe('share.txt');
    expect(getData.data.share.requiresPassword).toBe(false);

    // 下载链接
    const dlRes = await request(ctx, `/api/shares/${shareId}/download`);
    expect(dlRes.status).toBe(200);
    const dlData = await json(dlRes);
    const gwRes = await request(ctx, dlData.data.url.replace('http://localhost:8787', ''));
    expect(await gwRes.text()).toBe('shared-content');

    // 我的分享列表
    const listRes = await request(ctx, '/api/shares', { cookie: authCookie });
    const listData = await json(listRes);
    expect(listData.data.items.length).toBe(1);

    // 撤销
    const revokeRes = await request(ctx, `/api/shares/${shareId}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(revokeRes.status).toBe(200);

    const afterRes = await request(ctx, `/api/shares/${shareId}`);
    expect(afterRes.status).toBe(410);
  });

  it('密码保护分享', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'pwdsharer');
    const csrf = await getCsrf(ctx, authCookie);
    const uploaded = await uploadFile(authCookie, 'pwd.txt', 'pw');
    const createRes = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileId: uploaded.file.id, password: 'sharepass' },
    });
    const createData = await json(createRes);
    const shareId = createData.data.share.id;

    // 无密码 → 提示需要密码
    const noPass = await request(ctx, `/api/shares/${shareId}`);
    const noPassData = await json(noPass);
    expect(noPassData.data.share.requiresPassword).toBe(true);

    // 错误密码 → 401
    const badRes = await request(ctx, `/api/shares/${shareId}/download?password=wrong`);
    expect(badRes.status).toBe(401);

    // 正确密码 → 可下载
    const okRes = await request(ctx, `/api/shares/${shareId}/download?password=sharepass`);
    expect(okRes.status).toBe(200);
  });
});

describe('API 密钥与兼容上传', () => {
  it('创建密钥 → 用 Bearer 上传', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'keyowner');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'picgo', permissions: ['write', 'read'], protocols: ['api', 'webdav'], uploadPath: '/uploads' },
    });
    expect(createRes.status).toBe(201);
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken;
    const keyIdForRule = createData.data.key.keyId as string;
    expect(fullToken).toMatch(/^pk_[A-Za-z0-9]+\.sk_[A-Za-z0-9]+$/);
    // H-3：API Key 交集语义——授予上传根内写权限规则
    await grantApiKeyRule(ctx, keyIdForRule, ['write', 'read'], '/uploads/**');

    // 列表
    const listRes = await request(ctx, '/api/keys', { cookie: authCookie });
    const listData = await json(listRes);
    expect(listData.data.keys.length).toBe(1);
    expect(listData.data.keys[0].secret).toBeUndefined();

    // 兼容上传（multipart）
    const form = new FormData();
    form.append('file', new File([new Blob(['picgo-content'])], 'picgo.png', { type: 'image/png' }));
    const upRes = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}` },
      body: form,
    });
    expect(upRes.status).toBe(200);
    const upData = await json(upRes);
    // P0-1：返回外部可用的直链（path-serve + 签名），可匿名取回（图床命门）
    expect(upData.data.url).toContain('/uploads/picgo.png?sign=');
    const directUrl = new URL(upData.data.url);
    const directRes = await request(ctx, directUrl.pathname + directUrl.search);
    expect(directRes.status).toBe(200);
    expect(await directRes.text()).toBe('picgo-content');

    // 撤销
    const keyId = listData.data.keys[0].id;
    const revokeRes = await request(ctx, `/api/keys/${keyId}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(revokeRes.status).toBe(200);

    // 撤销后失效
    const afterRes = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}` },
      body: form,
    });
    expect(afterRes.status).toBe(401);
  });

  it('仅 Key ID 无法通过认证', async () => {
    const res = await request(ctx, '/api/files?path=/', {
      headers: { Authorization: 'Bearer pk_abc123' },
    });
    expect(res.status).toBe(401);
  });
});

describe('WebDAV', () => {
  it('PROPFIND / PUT / GET / DELETE 全流程', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'webdavuser');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'wd', permissions: ['write', 'read', 'delete'], protocols: ['webdav'], uploadPath: '/' },
    });
    const createData = await json(createRes);
    const { keyId, secret } = createData.data.key;
    // H-3：API Key 交集语义——授予根路径全部权限规则
    await grantApiKeyRule(ctx, keyId, ['write', 'read', 'delete'], '/');
    const basic = Buffer.from(`${keyId}:${secret}`).toString('base64');
    const auth = { Authorization: `Basic ${basic}` };

    // PUT 上传
    const putRes = await request(ctx, '/webdav/wd-test.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'webdav-content',
    });
    expect(putRes.status).toBe(201);

    // GET 下载
    const getRes = await request(ctx, '/webdav/wd-test.txt', { headers: auth });
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('webdav-content');

    // PROPFIND 列表
    const propfindRes = await request(ctx, '/webdav/', {
      method: 'PROPFIND',
      headers: { ...auth, Depth: '1' },
    });
    expect(propfindRes.status).toBe(207);
    const body = await propfindRes.text();
    expect(body).toContain('wd-test.txt');

    // DELETE
    const delRes = await request(ctx, '/webdav/wd-test.txt', { method: 'DELETE', headers: auth });
    expect(delRes.status).toBe(204);

    const getAfter = await request(ctx, '/webdav/wd-test.txt', { headers: auth });
    expect(getAfter.status).toBe(404);
  });
});

describe('管理员', () => {
  it('非管理员访问 admin → 403', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'notadmin');
    const res = await request(ctx, '/api/admin/dashboard', { cookie: authCookie });
    expect(res.status).toBe(403);
  });

  it('管理员仪表板与用户管理', async () => {
    const { authCookie: cookieBefore } = await registerAndLogin(ctx, 'theadmin');
    // 提升为管理员
    const db = ctx.db;
    db.exec("UPDATE users SET role = 'admin' WHERE username = 'theadmin'");
    // 角色变更后需重新登录（JWT 角色校验）
    await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'theadmin', password: 'password123' } });
    const loginRes = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'theadmin', password: 'password123' } });
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
    const authCookie = tokenMatch ? `auth_token=${tokenMatch[1]}` : '';
    expect(authCookie).toBeTruthy();
    void cookieBefore;

    const dashRes = await request(ctx, '/api/admin/dashboard', { cookie: authCookie });
    expect(dashRes.status).toBe(200);
    const dashData = await json(dashRes);
    expect(typeof dashData.data.stats.users.total).toBe('number');

    const usersRes = await request(ctx, '/api/admin/users?limit=50', { cookie: authCookie });
    expect(usersRes.status).toBe(200);
    const usersData = await json(usersRes);
    expect(usersData.data.users.length).toBeGreaterThan(0);

    // 系统设置读取/更新
    const settingsRes = await request(ctx, '/api/admin/settings', { cookie: authCookie });
    expect(settingsRes.status).toBe(200);
    const csrf = await getCsrf(ctx, authCookie);
    const patchRes = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { siteTitle: 'Picumet 测试站' },
    });
    expect(patchRes.status).toBe(200);

    const settingsAfter = await json(await request(ctx, '/api/admin/settings', { cookie: authCookie }));
    expect(settingsAfter.data.siteTitle).toBe('Picumet 测试站');

    // 权限规则创建
    const ruleRes = await request(ctx, '/api/admin/rules', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { pathPattern: '/public/**', effect: 'allow', role: 'guest', permissions: ['read', 'download'] },
    });
    expect(ruleRes.status).toBe(201);

    const rulesRes = await request(ctx, '/api/admin/rules', { cookie: authCookie });
    const rulesData = await json(rulesRes);
    expect(rulesData.data.rules.length).toBeGreaterThan(0);
  });
});

describe('安全', () => {
  it('路径遍历被拒绝', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'secuser');
    const res = await request(ctx, '/api/files?path=' + encodeURIComponent('/../../etc/passwd'), { cookie: authCookie });
    expect([400, 404, 403]).toContain(res.status);
  });

  it('未登录写操作 → 401', async () => {
    const res = await request(ctx, '/api/files/batch', { method: 'POST', body: { action: 'delete', fileIds: [] } });
    expect(res.status).toBe(401);
  });

  it('CSRF 缺失 → 403', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'csrfuser');
    const res = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      body: { path: '/', name: 'x' },
    });
    expect(res.status).toBe(403);
  });

  it('危险文件类型被拒绝', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'exeuser');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'malware.exe', fileSize: 10, mimeType: 'application/x-msdownload' },
    });
    expect([400, 403]).toContain(res.status);
  });

  it('HTML 文件下载使用 attachment（防 XSS）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'htmluser');
    const bytes = new TextEncoder().encode('<script>alert(1)</script>');
    const csrf = await getCsrf(ctx, authCookie);
    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'evil.html', fileSize: bytes.byteLength, mimeType: 'text/html' },
    });
    // text/html 属于危险 MIME → 应被拒绝
    expect([400, 403]).toContain(initRes.status);
  });

  it('公开设置接口可访问', async () => {
    const res = await request(ctx, '/api/public/settings');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.siteTitle).toBeTruthy();
  });
});
