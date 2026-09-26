// 管理端 Provider 更新（PUT /api/admin/storage/providers/:id）：SEC-02 SSRF 回归
// - endpoint 改为私网/云元数据地址 → 400（与创建路径同一文案），且不覆盖库中原值
// - endpoint 改为空串 = 切回 R2 绑定 → 成功，type 变 r2、凭据清空
// - endpoint 改为合法公网地址 → 成功（防误伤正常更新路径）
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { ProviderSchemaBase } from '../src/services/admin/storage-schemas';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  // 注册并提升为管理员（角色变更后必须重新登录，JWT 才携带 admin 角色）
  await registerAndLogin(ctx, 'sec_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'sec_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sec_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

interface ProviderRow {
  endpoint: string;
  type: string;
  hasCredentials: boolean;
}

/** 建一个带凭据的 S3 Provider（合法公网 endpoint），返回 id */
async function createS3Provider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: {
      name,
      bucket: 'sec-bucket',
      endpoint: 'https://s3.example.com',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
    },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { provider: { id: string } }).provider.id;
}

function putProvider(id: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/storage/providers/${id}`, {
    method: 'PUT',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

/** 管理端列表回读该 Provider 行 */
async function providerRow(id: string): Promise<ProviderRow> {
  const res = await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie });
  expect(res.status).toBe(200);
  const row = ((await json(res)).data as { providers: Array<{ id: string } & ProviderRow> }).providers.find((p) => p.id === id);
  expect(row).toBeTruthy();
  return row!;
}

describe('PUT /api/admin/storage/providers/:id 的 endpoint SSRF 校验（SEC-02）', () => {
  it('endpoint 改为私网/云元数据地址 → 400，且库中原 endpoint 不被覆盖', async () => {
    const id = await createS3Provider('sec-metadata');
    const res = await putProvider(id, { endpoint: 'http://169.254.169.254' });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string; message: string } }>(res)).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      // 与创建路径同一文案
      message: '存储端点无效：必须为公网 http(s) 地址，且不允许私网/保留地址',
    });
    const row = await providerRow(id);
    expect(row.endpoint).toBe('https://s3.example.com');
    expect(row.hasCredentials).toBe(true);
  });

  it('endpoint 改为空串 = 切回 R2 绑定 → 成功且凭据清空', async () => {
    const id = await createS3Provider('sec-binding');
    const res = await putProvider(id, { endpoint: '' });
    expect(res.status).toBe(200);
    const row = await providerRow(id);
    expect(row.endpoint).toBe('');
    expect(row.type).toBe('r2');
    expect(row.hasCredentials).toBe(false);
  });

  it('endpoint 改为合法公网地址 → 成功落库', async () => {
    const id = await createS3Provider('sec-valid');
    const res = await putProvider(id, { endpoint: 'https://s3.us-east-1.amazonaws.com' });
    expect(res.status).toBe(200);
    const row = await providerRow(id);
    expect(row.endpoint).toBe('https://s3.us-east-1.amazonaws.com');
    expect(row.type).toBe('s3');
    expect(row.hasCredentials).toBe(true);
  });
});

describe('publicDomain 私网/保留地址拒绝（SEC-12）', () => {
  const base = { name: 'sec-domain', bucket: 'sec-bucket' };

  it('https 公网域名通过', () => {
    expect(ProviderSchemaBase.safeParse({ ...base, publicDomain: 'https://cdn.example.com/obj' }).success).toBe(true);
  });

  it('私网/保留 IPv4、IPv6 与内部主机名一律拒绝', () => {
    for (const domain of [
      'https://10.0.0.1',
      'https://192.168.1.1/obj',
      'https://172.16.0.9',
      'https://169.254.169.254',
      'https://100.100.100.100',
      'https://[fd00::1]',
      'https://[::1]',
      'https://nas.local',
      'https://metadata.internal',
    ]) {
      expect(ProviderSchemaBase.safeParse({ ...base, publicDomain: domain }).success, domain).toBe(false);
    }
  });

  it('本地开发口径保留：http://localhost 与 http://127.0.0.1 豁免', () => {
    expect(ProviderSchemaBase.safeParse({ ...base, publicDomain: 'http://localhost:3000' }).success).toBe(true);
    expect(ProviderSchemaBase.safeParse({ ...base, publicDomain: 'http://127.0.0.1:9000' }).success).toBe(true);
  });
});
