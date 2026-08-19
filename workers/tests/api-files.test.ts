// API 集成测试：文件全流程（上传/列表/下载/重命名/密码/删除/移动）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

async function uploadFile(cookie: string, fileName: string, content: string, path = '/', mime = 'text/plain') {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(ctx, cookie);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: mime },
  });
  expect(initRes.status).toBe(200);
  const initData = (await json(initRes)).data as { sessionId: string; uploadMode: string };

  // worker 模式：PUT 原始 body
  const rawRes = await request(ctx, `/api/files/upload/raw/${initData.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': mime, 'X-CSRF-Token': csrf },
    body: new TextDecoder().decode(bytes),
  });
  expect(rawRes.status).toBe(200);
  const rawData = (await json(rawRes)).data as { etag: string; size: number };

  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.sessionId, etag: rawData.etag },
  });
  expect(completeRes.status).toBe(200);
  return (await json(completeRes)).data as { file: { id: string; name: string; path: string; size: number } };
}

describe('文件全流程', () => {
  it('上传 → 列表 → 详情 → 下载', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'fileuser');
    const uploaded = await uploadFile(authCookie, 'hello.txt', 'Hello Picumet!\n');
    expect(uploaded.file.size).toBe(15);

    // 列表
    const listRes = await request(ctx, '/api/files?path=/', { cookie: authCookie });
    expect(listRes.status).toBe(200);
    const listData = await json(listRes);
    expect(listData.data.items.length).toBeGreaterThan(0);
    expect(listData.data.items.some((i: { name: string }) => i.name === 'hello.txt')).toBe(true);

    // 详情
    const detailRes = await request(ctx, `/api/files/${uploaded.file.id}`, { cookie: authCookie });
    expect(detailRes.status).toBe(200);
    const detailData = await json(detailRes);
    expect(detailData.data.file.name).toBe('hello.txt');
    expect(detailData.data.permissions).toContain('read');

    // 下载链接
    const dlRes = await request(ctx, `/api/files/${uploaded.file.id}/download`, { cookie: authCookie });
    expect(dlRes.status).toBe(200);
    const dlData = await json(dlRes);
    expect(dlData.data.url).toContain('/api/gateway/download/');

    // 通过网关实际下载
    const gwRes = await request(ctx, dlData.data.url.replace('http://localhost:8787', ''));
    expect(gwRes.status).toBe(200);
    expect(await gwRes.text()).toBe('Hello Picumet!\n');

    // 复制链接（直链为公开路径 URL）
    const linkRes = await request(ctx, `/api/files/${uploaded.file.id}/copy-links`, { cookie: authCookie });
    const linkData = await json(linkRes);
    expect(linkData.data.formats.direct).toContain('/hello.txt');
    expect(linkData.data.formats.markdown).toContain('![hello.txt](');
  });

  it('创建文件夹并上传到子目录', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'folderuser');
    const csrf = await getCsrf(ctx, authCookie);
    const mkRes = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: '子目录' },
    });
    expect(mkRes.status).toBe(201);

    await uploadFile(authCookie, 'inside.txt', 'inside', '/子目录');
    const listRes = await request(ctx, '/api/files?path=/子目录', { cookie: authCookie });
    const listData = await json(listRes);
    expect(listData.data.items.some((i: { name: string }) => i.name === 'inside.txt')).toBe(true);
  });

  it('重命名文件', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'renameuser');
    const uploaded = await uploadFile(authCookie, 'old.txt', 'x');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, `/api/files/${uploaded.file.id}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'new.txt' },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.file.name).toBe('new.txt');
  });

  it('设置密码 → 无密码下载被拒 → 验证密码后可下载', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'pwduser');
    const uploaded = await uploadFile(authCookie, 'secret.txt', 'topsecret');
    const csrf = await getCsrf(ctx, authCookie);

    // 设置密码
    const setRes = await request(ctx, `/api/files/${uploaded.file.id}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { accessPassword: 's3cret' },
    });
    expect(setRes.status).toBe(200);

    // 直接下载被拒
    const dlRes = await request(ctx, `/api/files/${uploaded.file.id}/download`, { cookie: authCookie });
    expect(dlRes.status).toBe(403);
    expect((await json(dlRes)).error.code).toBe('PASSWORD_REQUIRED');

    // 错误密码
    const badRes = await request(ctx, `/api/files/${uploaded.file.id}/verify-password`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { password: 'wrong' },
    });
    expect(badRes.status).toBe(401);

    // 正确密码
    const okRes = await request(ctx, `/api/files/${uploaded.file.id}/verify-password`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { password: 's3cret' },
    });
    expect(okRes.status).toBe(200);
    const okData = await json(okRes);
    expect(okData.data.url).toContain('/api/gateway/download/');

    // 用密码验证后的 token 下载
    const gwRes = await request(ctx, okData.data.url.replace('http://localhost:8787', ''));
    expect(gwRes.status).toBe(200);
    expect(await gwRes.text()).toBe('topsecret');
  });

  it('删除文件', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'deluser');
    const uploaded = await uploadFile(authCookie, 'del.txt', 'bye');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, `/api/files/${uploaded.file.id}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(200);
    const detailRes = await request(ctx, `/api/files/${uploaded.file.id}`, { cookie: authCookie });
    expect(detailRes.status).toBe(404);
  });

  it('移动文件（Saga）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'moveuser');
    const csrf = await getCsrf(ctx, authCookie);
    // 创建目标文件夹
    await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: '目标' },
    });
    const uploaded = await uploadFile(authCookie, 'moveme.txt', 'mv');

    const moveRes = await request(ctx, `/api/files/${uploaded.file.id}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/目标' },
    });
    expect(moveRes.status).toBe(200);
    const moveData = await json(moveRes);
    expect(moveData.data.jobId).toBeTruthy();

    // 任务状态
    const jobRes = await request(ctx, `/api/files/jobs/${moveData.data.jobId}`, { cookie: authCookie });
    const jobData = await json(jobRes);
    expect(['completed', 'running', 'pending']).toContain(jobData.data.job.status);

    // 目标路径下出现文件
    const listRes = await request(ctx, '/api/files?path=/目标', { cookie: authCookie });
    const listData = await json(listRes);
    expect(listData.data.items.some((i: { name: string }) => i.name === 'moveme.txt')).toBe(true);
  });

  it('批量删除', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'batchuser');
    const a = await uploadFile(authCookie, 'a.txt', 'a');
    const b = await uploadFile(authCookie, 'b.txt', 'b');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/files/batch', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { action: 'delete', fileIds: [a.file.id, b.file.id], permanent: true },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.succeeded).toContain(a.file.id);
    expect(data.data.succeeded).toContain(b.file.id);
  });
});
