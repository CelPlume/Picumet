// 分享出口文件级密码：分享密码 ≠ 文件密码。
// preview/download 出口按目标文件 accessPassword 拦截；verify-file 逐文件验证后种短期授权 cookie。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

/** 创建分享响应（仅取测试用到的字段） */
interface CreatedShare {
  data: { share: { id: string } };
}
/** verify-file / verify 授权响应 */
interface AuthorizeResult {
  data: { authorized: boolean };
}
/** 错误响应 */
interface ApiFail {
  error: { code: string; message: string };
}
/** 分享下载签发响应 */
interface DownloadIssued {
  data: { url: string; expiresIn: number };
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

/** 属主给文件设置访问密码（accessPassword 哈希落库） */
async function setFilePassword(cookie: string, fileId: string, password: string): Promise<void> {
  const csrf = await getCsrf(ctx, cookie);
  const res = await request(ctx, `/api/files/${fileId}`, {
    method: 'PUT',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { accessPassword: password },
  });
  expect(res.status).toBe(200);
}

/** 属主创建分享，返回 shareId */
async function createShare(cookie: string, body: Record<string, unknown>): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const res = await request(ctx, '/api/shares', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body,
  });
  expect(res.status).toBe(201);
  return (await json<CreatedShare>(res)).data.share.id;
}

/** POST /:id/verify-file：分享访客验证目标文件的访问密码 */
function verifyFile(shareId: string, body: Record<string, unknown>, cookie?: string): Promise<Response> {
  return request(ctx, `/api/shares/${shareId}/verify-file`, { method: 'POST', cookie, body });
}

/** 从 Set-Cookie 提取指定 cookie 值；缺失即断言失败 */
function cookieValue(res: Response, name: string): string {
  const value = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${name}=([^;]+)`))?.[1];
  expect(value, `响应应携带 ${name} cookie`).toBeTruthy();
  return value as string;
}

describe('分享出口文件级密码', () => {
  it('无分享密码 + 文件有密码：preview 401 / 网关拒绝未验证令牌，verify-file 通过后放行', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sfp_owner');
    const uploaded = await uploadFile(authCookie, 'sfp-locked.txt', 'sfp-locked-content');
    await setFilePassword(authCookie, uploaded.file.id, 'sfp-file-pwd');
    const shareId = await createShare(authCookie, { fileIds: [uploaded.file.id] });

    // 预览：未验证文件密码 → 401 PASSWORD_REQUIRED（此前该出口不检查文件密码）
    const preview = await request(ctx, `/api/shares/${shareId}/preview?itemId=${uploaded.file.id}`);
    expect(preview.status).toBe(401);
    expect((await json<ApiFail>(preview)).error.code).toBe('PASSWORD_REQUIRED');

    // 下载：令牌可签发（passwordVerified=false），网关消费时按文件当前密码拦截
    const dl = await request(ctx, `/api/shares/${shareId}/download?itemId=${uploaded.file.id}`);
    expect(dl.status).toBe(200);
    const gatewayPath = (await json<DownloadIssued>(dl)).data.url.replace('http://localhost:8787', '');
    const denied = await request(ctx, gatewayPath);
    expect(denied.status).toBe(403);
    expect((await json<ApiFail>(denied)).error.code).toBe('PASSWORD_REQUIRED');

    // verify-file：错误密码 → 401 INVALID_PASSWORD
    const bad = await verifyFile(shareId, { itemId: uploaded.file.id, password: 'definitely-wrong' });
    expect(bad.status).toBe(401);
    expect((await json<ApiFail>(bad)).error.code).toBe('INVALID_PASSWORD');

    // verify-file：正确密码 → 200 并种文件级授权 cookie
    const good = await verifyFile(shareId, { itemId: uploaded.file.id, password: 'sfp-file-pwd' });
    expect(good.status).toBe(200);
    expect((await json<AuthorizeResult>(good)).data.authorized).toBe(true);
    const fileAuth = cookieValue(good, `share_fileauth_${shareId}`);

    // 预览放行（直出对象内容）
    const previewOk = await request(ctx, `/api/shares/${shareId}/preview?itemId=${uploaded.file.id}`, {
      cookie: `share_fileauth_${shareId}=${fileAuth}`,
    });
    expect(previewOk.status).toBe(200);
    expect(await previewOk.text()).toBe('sfp-locked-content');

    // 下载放行：签发的令牌 passwordVerified=true，网关消费成功
    const dlOk = await request(ctx, `/api/shares/${shareId}/download?itemId=${uploaded.file.id}`, {
      cookie: `share_fileauth_${shareId}=${fileAuth}`,
    });
    expect(dlOk.status).toBe(200);
    const gatewayOk = (await json<DownloadIssued>(dlOk)).data.url.replace('http://localhost:8787', '');
    const served = await request(ctx, gatewayOk);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('sfp-locked-content');
  });

  it('同一授权会话可累积多个文件：cookie 复用并追加（去重）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sfp_multi');
    const first = await uploadFile(authCookie, 'sfp-multi-a.txt', 'sfp-multi-a-body');
    const second = await uploadFile(authCookie, 'sfp-multi-b.txt', 'sfp-multi-b-body');
    await setFilePassword(authCookie, first.file.id, 'sfp-multi-pwd');
    await setFilePassword(authCookie, second.file.id, 'sfp-multi-pwd');
    const shareId = await createShare(authCookie, { fileIds: [first.file.id, second.file.id] });

    // 验证第一个文件 → 种 cookie
    const v1 = await verifyFile(shareId, { itemId: first.file.id, password: 'sfp-multi-pwd' });
    expect(v1.status).toBe(200);
    const authValue = cookieValue(v1, `share_fileauth_${shareId}`);
    const cookie = `share_fileauth_${shareId}=${authValue}`;

    // 带 cookie 验证第二个文件 → 复用同一 cookie 值（KV 追加 fileId 并续期）
    const v2 = await verifyFile(shareId, { itemId: second.file.id, password: 'sfp-multi-pwd' }, cookie);
    expect(v2.status).toBe(200);
    expect(cookieValue(v2, `share_fileauth_${shareId}`)).toBe(authValue);

    // 两个文件的预览都被同一会话放行
    for (const file of [first.file, second.file]) {
      const pv = await request(ctx, `/api/shares/${shareId}/preview?itemId=${file.id}`, { cookie });
      expect(pv.status).toBe(200);
    }
  });

  it('有分享密码 + 文件密码：两道闸门都拦（分享密码先行，文件密码随后）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sfp_both');
    const uploaded = await uploadFile(authCookie, 'sfp-both.txt', 'sfp-both-content');
    await setFilePassword(authCookie, uploaded.file.id, 'sfp-both-file-pwd');
    const shareId = await createShare(authCookie, {
      fileIds: [uploaded.file.id],
      password: 'sfp-both-share-pwd',
    });

    // 未通过分享密码：即使文件密码正确也先拦下（分享密码先行）
    const beforeShareVerify = await verifyFile(shareId, { itemId: uploaded.file.id, password: 'sfp-both-file-pwd' });
    expect(beforeShareVerify.status).toBe(401);
    expect((await json<ApiFail>(beforeShareVerify)).error.code).toBe('INVALID_PASSWORD');

    // 通过分享密码闸门
    const shareVerify = await request(ctx, `/api/shares/${shareId}/verify`, {
      method: 'POST',
      body: { password: 'sfp-both-share-pwd' },
    });
    expect(shareVerify.status).toBe(200);
    const shareAuth = cookieValue(shareVerify, `share_auth_${shareId}`);

    // 分享密码已过 + 文件密码错误 → 仍拦（第二道）
    const badFilePwd = await verifyFile(shareId, { itemId: uploaded.file.id, password: 'nope' }, `share_auth_${shareId}=${shareAuth}`);
    expect(badFilePwd.status).toBe(401);
    expect((await json<ApiFail>(badFilePwd)).error.code).toBe('INVALID_PASSWORD');

    // 正确文件密码 → 签发文件级授权
    const goodFilePwd = await verifyFile(shareId, { itemId: uploaded.file.id, password: 'sfp-both-file-pwd' }, `share_auth_${shareId}=${shareAuth}`);
    expect(goodFilePwd.status).toBe(200);
    const fileAuth = cookieValue(goodFilePwd, `share_fileauth_${shareId}`);

    // 只过分享密码、未过文件密码 → 预览仍 401
    const shareOnly = await request(ctx, `/api/shares/${shareId}/preview?itemId=${uploaded.file.id}`, {
      cookie: `share_auth_${shareId}=${shareAuth}`,
    });
    expect(shareOnly.status).toBe(401);
    expect((await json<ApiFail>(shareOnly)).error.code).toBe('PASSWORD_REQUIRED');

    // 两道都过 → 放行
    const both = await request(ctx, `/api/shares/${shareId}/preview?itemId=${uploaded.file.id}`, {
      cookie: `share_auth_${shareId}=${shareAuth}; share_fileauth_${shareId}=${fileAuth}`,
    });
    expect(both.status).toBe(200);
    expect(await both.text()).toBe('sfp-both-content');
  });

  it('文件无密码 / 文件夹项目：verify-file 返回 400', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sfp_open');
    const uploaded = await uploadFile(authCookie, 'sfp-open.txt', 'sfp-open-content');
    const shareId = await createShare(authCookie, { fileIds: [uploaded.file.id] });

    // 文件未设置 accessPassword → 400
    const noPwd = await verifyFile(shareId, { itemId: uploaded.file.id, password: 'anything' });
    expect(noPwd.status).toBe(400);
    expect((await json<ApiFail>(noPwd)).error.message).toBe('该文件无需密码');

    // 文件夹项目 → 400
    const folderRes = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': await getCsrf(ctx, authCookie) },
      body: { path: '/', name: 'sfp-open-folder' },
    });
    expect(folderRes.status).toBe(201);
    const folderId = (await json<{ data: { file: { id: string } } }>(folderRes)).data.file.id;
    const folderShareId = await createShare(authCookie, { fileIds: [folderId] });
    const folder = await verifyFile(folderShareId, { itemId: folderId, password: 'anything' });
    expect(folder.status).toBe(400);
  });
});
