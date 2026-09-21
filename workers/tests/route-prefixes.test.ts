// 路由前缀（direct_prefix / root_target）：设置读写与校验、path-serve 直服范围、直链生成
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { Db } from '../src/db';
import { directUrl, loadRoutePrefixes } from '../src/services/storage/direct-links';

interface PrefixSettings {
  directPrefix: string;
  rootTarget: string;
}
interface ApiEnvelope<T> {
  data: T;
}
interface ApiErrorBody {
  error: { code: string; message: string };
}

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'prefix_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'prefix_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'prefix_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function patchSettings(body: Record<string, unknown>): Promise<Response> {
  return request(ctx, '/api/admin/settings', {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

async function readSettings(): Promise<PrefixSettings> {
  const res = await request(ctx, '/api/admin/settings', { cookie: adminCookie });
  expect(res.status).toBe(200);
  return (await json<ApiEnvelope<PrefixSettings>>(res)).data;
}

async function setPrefix(directPrefix: string, rootTarget = 'landing'): Promise<void> {
  const res = await patchSettings({ directPrefix, rootTarget });
  expect(res.status).toBe(200);
}

describe('路由前缀设置', () => {
  it('默认值与现状等价，且经 admin / public 两条通道暴露', async () => {
    // 0001 §23 播种两行默认值
    const seeded = await Db.fromSqlite(ctx.db).all(
      `SELECT key FROM system_settings WHERE key IN ('direct_prefix', 'root_target') ORDER BY key`
    );
    expect(seeded.map((r) => r.key)).toEqual(['direct_prefix', 'root_target']);

    expect(await readSettings()).toMatchObject({ directPrefix: '', rootTarget: 'landing' });

    const publicRes = await request(ctx, '/api/public/settings');
    expect(publicRes.status).toBe(200);
    const pub = await json<ApiEnvelope<PrefixSettings>>(publicRes);
    expect(pub.data.directPrefix).toBe('');
    expect(pub.data.rootTarget).toBe('landing');
  });

  it('非法枚举取值 400，并给出中文原因', async () => {
    const badPrefix = await patchSettings({ directPrefix: '/x' });
    expect(badPrefix.status).toBe(400);
    expect((await json<ApiErrorBody>(badPrefix)).error.message).toContain('直链前缀');

    const badRoot = await patchSettings({ rootTarget: 'home' });
    expect(badRoot.status).toBe(400);
    expect((await json<ApiErrorBody>(badRoot)).error.message).toContain('根路径语义');

    // 非法写入不得落库
    expect(await readSettings()).toMatchObject({ directPrefix: '', rootTarget: 'landing' });
  });

  it('归一化：去尾斜杠、补前导斜杠', async () => {
    expect((await patchSettings({ directPrefix: 'download/' })).status).toBe(200);
    expect((await readSettings()).directPrefix).toBe('/download');
    await setPrefix('');
  });

  it('root_target=direct 仅当直链前缀留空（部分 PATCH 按落库后生效值校验）', async () => {
    expect((await patchSettings({ rootTarget: 'direct' })).status).toBe(200);
    expect((await readSettings()).rootTarget).toBe('direct');

    const conflict = await patchSettings({ directPrefix: '/d' });
    expect(conflict.status).toBe(400);
    expect((await json<ApiErrorBody>(conflict)).error.message).toContain('直链前缀必须留空');
    expect(await readSettings()).toMatchObject({ directPrefix: '', rootTarget: 'direct' });

    // 先改回落地页，再设前缀即合法
    await setPrefix('', 'landing');
    expect((await patchSettings({ directPrefix: '/d' })).status).toBe(200);
    expect((await readSettings()).directPrefix).toBe('/d');
    await setPrefix('');
  });

  it('脏值兜底：库里越界取值或键缺失时回退默认，不污染直服范围', async () => {
    const db = Db.fromSqlite(ctx.db);
    ctx.db.exec(`UPDATE system_settings SET value = '"junk"' WHERE key IN ('direct_prefix', 'root_target')`);
    expect(await loadRoutePrefixes(db)).toEqual({ directPrefix: '', rootTarget: 'landing' });
    expect(await readSettings()).toMatchObject({ directPrefix: '', rootTarget: 'landing' });

    ctx.db.exec(`DELETE FROM system_settings WHERE key IN ('direct_prefix', 'root_target')`);
    expect(await loadRoutePrefixes(db)).toEqual({ directPrefix: '', rootTarget: 'landing' });

    // 复原默认行（等价于 0001 §23 的播种）
    ctx.db.exec(
      `INSERT INTO system_settings (key, value, description, updated_at) VALUES ('direct_prefix', '""', NULL, 1), ('root_target', '"landing"', NULL, 1)`
    );
  });
});

describe('directUrl', () => {
  const origin = 'http://localhost:8787';

  it('空前缀保持历史形状，非空前缀插在虚拟路径之前', () => {
    expect(directUrl(origin, '', '/dl/a.txt')).toBe(`${origin}/dl/a.txt`);
    expect(directUrl(origin, '/d', '/dl/a.txt')).toBe(`${origin}/d/dl/a.txt`);
    // 前缀传入带尾斜杠的写法也归一化
    expect(directUrl(origin, '/download/', '/dl/a.txt')).toBe(`${origin}/download/dl/a.txt`);
  });

  it('路径段逐段编码，签名以 query 附加', () => {
    expect(directUrl(origin, '', '/图片/a b.txt', 'sig')).toBe(`${origin}/%E5%9B%BE%E7%89%87/a%20b.txt?sign=sig`);
    expect(directUrl(origin, '/raw', '/a.txt', 'sig')).toBe(`${origin}/raw/a.txt?sign=sig`);
  });
});

describe('path-serve 直服范围与直链生成', () => {
  let ownerCookie = '';
  let fileId = '';

  beforeAll(async () => {
    const { authCookie } = await registerAndLogin(ctx, 'prefix_owner');
    ownerCookie = authCookie;
    const csrf = await getCsrf(ctx, ownerCookie);
    await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: ownerCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: 'dl' },
    });
    const bytes = new TextEncoder().encode('prefix-hello');
    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: ownerCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/dl', fileName: 'hello.txt', fileSize: bytes.byteLength, mimeType: 'text/plain' },
    });
    const sessionId = (await json<ApiEnvelope<{ sessionId: string }>>(initRes)).data.sessionId;
    await request(ctx, `/api/files/upload/raw/${sessionId}`, {
      method: 'PUT',
      cookie: ownerCookie,
      headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
      body: 'prefix-hello',
    });
    const completeRes = await request(ctx, '/api/files/upload-complete', {
      method: 'POST',
      cookie: ownerCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { sessionId, etag: 'etag' },
    });
    fileId = (await json<ApiEnvelope<{ file: { id: string } }>>(completeRes)).data.file.id;
  });

  async function publicUrlOf(): Promise<string> {
    const res = await request(ctx, '/api/public/fs?path=/dl', { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await json<ApiEnvelope<{ items: Array<{ name: string; url: string | null }> }>>(res);
    const item = body.data.items.find((i) => i.name === 'hello.txt');
    expect(item?.url).toBeTruthy();
    return item?.url ?? '';
  }

  async function copyLinkOf(): Promise<string> {
    const res = await request(ctx, `/api/files/${fileId}/copy-links`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await json<ApiEnvelope<{ formats: { direct: string } }>>(res);
    return body.data.formats.direct;
  }

  it('direct_prefix="" ：根命名空间直服不变，{前缀} 形状路径不再命中', async () => {
    expect(await readSettings()).toMatchObject({ directPrefix: '' });

    const served = await request(ctx, '/dl/hello.txt', { cookie: ownerCookie });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('prefix-hello');

    // 未配置前缀时 /download/... 是普通虚拟路径，未挂载 → 404
    const notServed = await request(ctx, '/download/dl/hello.txt', { cookie: ownerCookie });
    expect(notServed.status).toBe(404);
  });

  it('direct_prefix="/download"：只服务 /download/*，其余原样 404', async () => {
    await setPrefix('/download');

    const served = await request(ctx, '/download/dl/hello.txt', { cookie: ownerCookie });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('prefix-hello');

    // 根命名空间不再直服
    const rootNow = await request(ctx, '/dl/hello.txt', { cookie: ownerCookie });
    expect(rootNow.status).toBe(404);
    expect((await json<ApiErrorBody>(rootNow)).error.code).toBe('NOT_FOUND');

    // 前缀边界：/downloadxyz 不算落在前缀下
    const nearMiss = await request(ctx, '/downloadxyz/dl/hello.txt', { cookie: ownerCookie });
    expect(nearMiss.status).toBe(404);

    // 排除清单在剥离前缀后同样生效：/download/api/* 不得被当作虚拟路径
    const apiUnderPrefix = await request(ctx, '/download/api/health', { cookie: ownerCookie });
    expect(apiUnderPrefix.status).toBe(404);

    // 还原后根命名空间恢复
    await setPrefix('');
    const restored = await request(ctx, '/dl/hello.txt', { cookie: ownerCookie });
    expect(restored.status).toBe(200);
  });

  it('直链生成：copy-links 与公开列表随 directPrefix 变化，未设置时与现状一致', async () => {
    const origin = 'http://localhost:8787';

    await setPrefix('');
    expect(await copyLinkOf()).toBe(`${origin}/dl/hello.txt`);
    const defaultUrl = new URL(await publicUrlOf());
    expect(defaultUrl.pathname).toBe('/dl/hello.txt');
    const defaultFetch = await request(ctx, `${defaultUrl.pathname}${defaultUrl.search}`, { cookie: ownerCookie });
    expect(defaultFetch.status).toBe(200);
    expect(await defaultFetch.text()).toBe('prefix-hello');

    await setPrefix('/d');
    expect(await copyLinkOf()).toBe(`${origin}/d/dl/hello.txt`);
    const prefixedUrl = new URL(await publicUrlOf());
    expect(prefixedUrl.pathname).toBe('/d/dl/hello.txt');
    expect(prefixedUrl.searchParams.get('sign')).toBeTruthy();
    const prefixedFetch = await request(ctx, `${prefixedUrl.pathname}${prefixedUrl.search}`, { cookie: ownerCookie });
    expect(prefixedFetch.status).toBe(200);
    expect(await prefixedFetch.text()).toBe('prefix-hello');

    await setPrefix('');
  });
});
