// API Key IP 白名单回归（审计 Fix 2）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';
import type { Env } from '../src/shared/types';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('API Key IP 白名单', () => {
  it('白名单外 IP 被 403 拒绝，白名单内 IP 放行', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ipowner');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'ip-locked', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/uploads', allowedIps: ['203.0.113.9'] },
    });
    expect(createRes.status).toBe(201);
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, createData.data.key.keyId as string, ['write', 'read'], '/uploads/**');

    const form = new FormData();
    form.append('file', new File([new Blob(['ip-content'])], 'ip.txt', { type: 'text/plain' }));

    // 白名单外 IP → 403
    const denied = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'X-Forwarded-For': '198.51.100.7' },
      body: form,
    });
    expect(denied.status).toBe(403);
    const deniedData = await json(denied);
    expect(deniedData.error?.code ?? deniedData.error).toBe('FORBIDDEN');

    // 白名单内 IP → 放行
    const allowed = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'X-Forwarded-For': '203.0.113.9' },
      body: form,
    });
    expect(allowed.status).toBe(200);
  });

  it('未配置白名单的密钥不限制来源 IP', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ipopen');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'ip-open', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/' },
    });
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, createData.data.key.keyId as string, ['write', 'read'], '/');
    const form = new FormData();
    form.append('file', new File([new Blob(['open-ip-content'])], 'open.txt', { type: 'text/plain' }));
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'X-Forwarded-For': '198.51.100.7' },
      body: form,
    });
    expect(res.status).toBe(200);
  });

  // SEC-03（审计 §SEC-03）：cf.connectingIp 是运行时注入的不可伪造来源，必须压过客户端可伪造的头
  it('带 cf.connectingIp 时白名单判定使用它而非伪造的 XFF / CF-Connecting-IP', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ipcf');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'ip-cf', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/', allowedIps: ['203.0.113.9'] },
    });
    expect(createRes.status).toBe(201);
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, createData.data.key.keyId as string, ['write', 'read'], '/');

    // 按现有 request() 的构造方式手建 Request 并注入 cf 属性（Workers 运行时等价形态）
    const sendWithCf = async (connectingIp: string): Promise<Response> => {
      const form = new FormData();
      form.append('file', new File([new Blob([`cf-${connectingIp}`])], 'cf.txt', { type: 'text/plain' }));
      const req = new Request('http://localhost:8787/api/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fullToken}`,
          'X-Forwarded-For': '10.0.0.1',
          'CF-Connecting-IP': '10.0.0.1',
        },
        body: form,
      });
      (req as Request & { cf?: { connectingIp?: string } }).cf = { connectingIp };
      return ctx.app.fetch(req, ctx.env as unknown as Env, {} as ExecutionContext);
    };

    // cf.connectingIp 在白名单内 → 放行（若误用伪造头 10.0.0.1 判定则会 403）
    const allowed = await sendWithCf('203.0.113.9');
    expect(allowed.status).toBe(200);

    // cf.connectingIp 在白名单外 → 403（伪造头声称白名单 IP 也无法通过）
    const denied = await sendWithCf('198.51.100.7');
    expect(denied.status).toBe(403);
  });

  it('无 cf 属性时取 CF-Connecting-IP 头而非 XFF 首段', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ipcfc');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'ip-cfc', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/', allowedIps: ['203.0.113.9'] },
    });
    expect(createRes.status).toBe(201);
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, createData.data.key.keyId as string, ['write', 'read'], '/');
    const form = new FormData();
    form.append('file', new File([new Blob(['cfc-ip-content'])], 'cfc.txt', { type: 'text/plain' }));

    // CF-Connecting-IP 指向白名单 IP、XFF 伪造白名单外 → 取该头，放行
    const allowed = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '10.0.0.1' },
      body: form,
    });
    expect(allowed.status).toBe(200);

    // 对照：CF-Connecting-IP 指向白名单外、XFF 伪造白名单 IP → 仍取该头，拒绝
    const denied = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'CF-Connecting-IP': '10.0.0.1', 'X-Forwarded-For': '203.0.113.9' },
      body: form,
    });
    expect(denied.status).toBe(403);
  });
});
