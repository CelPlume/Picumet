// AList/OpenList 兼容 shim 回归：login → fs/form → fs/list → fs/get → /d 直链 → fs/remove 全流程
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

interface AlistBundle {
  token: string;
  keyId: string;
}

async function createAlistKey(username: string): Promise<AlistBundle> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'alist', permissions: ['read', 'write', 'delete'], protocols: ['api'], uploadPath: '/uploads' },
  });
  expect(res.status).toBe(201);
  const data = await json(res) as { data: { key: { keyId: string; secret: string } } };
  const keyId = data.data.key.keyId;
  await grantApiKeyRule(ctx, keyId, ['read', 'write', 'delete'], '/uploads/**');
  return { keyId, token: `${keyId}.${data.data.key.secret}` };
}

function multipart(name: string, content: string): FormData {
  const form = new FormData();
  form.append('file', new File([new Blob([content])], name, { type: 'image/png' }));
  return form;
}

describe('AList/OpenList 兼容 shim（/openlist）', () => {
  it('login（keyId/secret）→ fs/form → fs/list → fs/get → /d 直链 → fs/remove', async () => {
    const k = await createAlistKey('alistuser');

    // 登录：username=keyId, password=secret
    const login = await request(ctx, '/openlist/api/auth/login', {
      method: 'POST',
      body: { username: k.keyId, password: k.token.slice(k.keyId.length + 1) },
    });
    expect(login.status).toBe(200);
    const loginData = await json(login) as { code: number; message: string; data: { token: string } };
    expect(loginData.code).toBe(200);
    expect(loginData.message).toBe('success');
    const token = loginData.data.token;
    expect(token).toBe(k.token);

    // 错误凭据
    const badLogin = await request(ctx, '/openlist/api/auth/login', {
      method: 'POST',
      body: { username: k.keyId, password: 'sk_wrong' },
    });
    expect((await json(badLogin) as { code: number }).code).not.toBe(200);

    // fs/form 上传（File-Path 完整路径；Authorization 裸 token）
    const filePath = '/uploads/alist/pic.png';
    const form = multipart('pic.png', 'alist-content');
    const upload = await request(ctx, '/openlist/api/fs/form', {
      method: 'PUT',
      headers: { Authorization: token, 'File-Path': encodeURIComponent(filePath) },
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploadData = await json(upload) as { code: number; message: string };
    expect(uploadData.code).toBe(200);
    expect(uploadData.message).toBe('success');

    // fs/list：目录刷新（handleResError 要求成功，文件已落地也不可失败）
    const list = await request(ctx, '/openlist/api/fs/list', {
      method: 'POST',
      headers: { Authorization: token },
      body: { path: '/uploads/alist', refresh: true, page: 1, per_page: 100 },
    });
    expect(list.status).toBe(200);
    const listData = await json(list) as { code: number; data: { content: Array<{ name: string; is_dir: boolean }> } };
    expect(listData.code).toBe(200);
    expect(listData.data.content.some((e) => e.name === 'pic.png' && !e.is_dir)).toBe(true);

    // fs/get：取 sign
    const get = await request(ctx, '/openlist/api/fs/get', {
      method: 'POST',
      headers: { Authorization: token },
      body: { path: filePath, refresh: true },
    });
    expect(get.status).toBe(200);
    const getData = await json(get) as { code: number; data: { sign: string; is_dir: boolean; size: number } };
    expect(getData.code).toBe(200);
    expect(getData.data.sign).toBeTruthy();
    expect(getData.data.is_dir).toBe(false);

    // /d 直链：PicList 拼接形态 '/d' + encodeURIComponent(path)?sign=
    const direct = await request(ctx, `/openlist/d${encodeURIComponent(filePath)}?sign=${getData.data.sign}`);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toBe('alist-content');

    // 无 sign → 403（私有挂载）
    const noSign = await request(ctx, `/openlist/d${encodeURIComponent(filePath)}`);
    expect(noSign.status).toBe(403);

    // fs/remove
    const remove = await request(ctx, '/openlist/api/fs/remove', {
      method: 'POST',
      headers: { Authorization: token },
      body: { dir: '/uploads/alist', names: ['pic.png'] },
    });
    expect(remove.status).toBe(200);
    expect((await json(remove) as { code: number }).code).toBe(200);

    // 删除后直链 404
    const gone = await request(ctx, `/openlist/d${encodeURIComponent(filePath)}?sign=${getData.data.sign}`);
    expect(gone.status).toBe(404);
  });

  it('超出密钥上传根的路径被拒绝（fs/form + fs/get）', async () => {
    const k = await createAlistKey('alistscope');
    const form = multipart('evil.png', 'evil');
    const upload = await request(ctx, '/openlist/api/fs/form', {
      method: 'PUT',
      headers: { Authorization: k.token, 'File-Path': encodeURIComponent('/etc/evil.png') },
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploadData = await json(upload) as { code: number };
    expect(uploadData.code).toBe(403);

    const get = await request(ctx, '/openlist/api/fs/get', {
      method: 'POST',
      headers: { Authorization: k.token },
      body: { path: '/etc/evil.png' },
    });
    expect((await json(get) as { code: number }).code).toBe(403);
  });

  // SEC-06（审计 §SEC-06）：协议面授权矩阵——不含 api 的密钥 login/fs/list 一律拒绝
  it('SEC-06：protocols 不含 api 的密钥 login 与 fs/list 均 403，含 api 的密钥正常', async () => {
    // 仅声明 webdav 协议的密钥（凭据/状态/IP 均有效，仅协议不匹配）
    const { authCookie } = await registerAndLogin(ctx, 'alistproto');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'alist-webdav-only', permissions: ['read', 'write', 'delete'], protocols: ['webdav'], uploadPath: '/uploads' },
    });
    expect(createRes.status).toBe(201);
    const webdavOnly = await json(createRes) as { data: { key: { keyId: string; secret: string } } };
    const keyId = webdavOnly.data.key.keyId;
    const token = `${keyId}.${webdavOnly.data.key.secret}`;
    await grantApiKeyRule(ctx, keyId, ['read', 'write', 'delete'], '/uploads/**');

    // login：AList 契约恒为 HTTP 200 + code 表达结果；失败走 AListFail 形状
    const login = await request(ctx, '/openlist/api/auth/login', {
      method: 'POST',
      body: { username: keyId, password: webdavOnly.data.key.secret },
    });
    expect(login.status).toBe(200);
    const loginData = await json(login) as { code: number; message: string; data: null };
    expect(loginData).toEqual({ code: 403, message: '用户名或密码错误', data: null });

    // fs/list：token 本身有效（已过认证/IP 校验），被 fsApi 统一协议中间件拦截
    const list = await request(ctx, '/openlist/api/fs/list', {
      method: 'POST',
      headers: { Authorization: token },
      body: { path: '/uploads/alist' },
    });
    expect(list.status).toBe(200);
    const listData = await json(list) as { code: number; message: string; data: null };
    expect(listData).toEqual({ code: 403, message: '该密钥未授权 api 协议', data: null });

    // 对照组：含 api 协议的密钥 login 与 fs/list 正常放行
    const k = await createAlistKey('alistprotook');
    const okLogin = await request(ctx, '/openlist/api/auth/login', {
      method: 'POST',
      body: { username: k.keyId, password: k.token.slice(k.keyId.length + 1) },
    });
    expect(okLogin.status).toBe(200);
    expect((await json(okLogin) as { code: number; data: { token: string } }).code).toBe(200);

    const okList = await request(ctx, '/openlist/api/fs/list', {
      method: 'POST',
      headers: { Authorization: k.token },
      body: { path: '/uploads/alist' },
    });
    expect(okList.status).toBe(200);
    expect((await json(okList) as { code: number }).code).toBe(200);
  });
});
