// 注册限流强化回归：
// - authRateLimitMiddleware 阈值读 auth_rate_limit_per_minute（默认 5，0 = 关闭；仅生产或 RATE_LIMIT_FORCE）
// - 注册成功速率 register_success_per_hour_per_ip（默认 3，0 = 关闭；按成功计数 = 冷却语义）
// - ipBanMiddleware：命中 403 通用文案 / 过期放行 / 未命中放行 / KV 缓存失效
// - 管理端 IP 封禁 CRUD + 审计（admin_ip_ban / admin_ip_unban）
// - 封禁用户 ban_reason 落库 + admin_user_status 审计
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/shared/types';
import { createTestContext, initSeeded, request, json, type TestContext } from './helpers';
import { invalidateAuthRateLimitCache, resetMemoryLimits } from '../src/middleware/rate-limit';
import { Db, SettingsRepo } from '../src/db';

let ctx: TestContext;
const prodEnv = () => ({ ...ctx.env, ENVIRONMENT: 'production' }) as unknown as Env;

/** 生产环境请求（限流/封禁中间件仅 production 或 RATE_LIMIT_FORCE 生效） */
async function prodRequest(path: string, opts: Parameters<typeof request>[2] = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const req = new Request(`http://localhost:8787${path}`, { method: opts.method ?? 'GET', headers, body });
  return ctx.app.fetch(req, prodEnv(), {} as ExecutionContext);
}

/** 从 Set-Cookie 提取 auth_token（正则收窄，缺失时断言失败） */
function authTokenOf(res: Response): string {
  const m = res.headers.get('set-cookie')?.match(/auth_token=([^;]+)/);
  expect(m).toBeTruthy();
  return `auth_token=${m?.[1]}`;
}

/** node:sqlite .get() 无类型边界：测试断言收窄助手（仅测试内使用） */
function queryRow<T>(sql: string, ...params: (string | number | null)[]): T {
  const row = ctx.db.prepare(sql).get(...params) as T | undefined;
  expect(row).toBeDefined();
  return row as T;
}

function queryAll<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return ctx.db.prepare(sql).all(...params) as T[];
}

/** dev seed 的管理员会话（admin/admin123456）与 CSRF */
async function adminSession(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  expect(res.status).toBe(200);
  const cookie = authTokenOf(res);
  const csrfRes = await request(ctx, '/api/auth/csrf-token', { cookie });
  const csrf = (await json<{ data: { token: string } }>(csrfRes)).data.token;
  return { cookie, csrf };
}

/** 测试 DB 句柄（直接读写 system_settings / users / access_logs 断言用） */
const testDb = () => Db.fromSqlite(ctx.db);

describe('认证限流阈值可配置（auth_rate_limit_per_minute）', () => {
  it('种子阈值 10：IP 档 10/分、标识档 5/分（=max(5, 10/2)）→ 同账号第 6 次 429', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    resetMemoryLimits();
    invalidateAuthRateLimitCache();
    // 标识维度（同一 username）独立预算 5：前 5 次进入业务（401 凭证错误），第 6 次 429
    for (let i = 0; i < 5; i++) {
      const res = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'nosuch', password: 'wrong-password' } });
      expect(res.status).toBe(401);
    }
    const hit = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'nosuch', password: 'wrong-password' } });
    expect(hit.status).toBe(429);
  });

  it('NAT 不连坐：单账号打满标识阈值（5）→ 该账号 429，同 IP 其他账号仍 401', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    resetMemoryLimits();
    invalidateAuthRateLimitCache();
    // 对账号 A 连打 5 次（IP 维度 5 < 10，不触发 IP 档）
    for (let i = 0; i < 5; i++) {
      const res = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'victim-a', password: 'wrong-password' } });
      expect(res.status).toBe(401);
    }
    // 第 6 次：标识维度打满 → 429
    const hitA = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'victim-a', password: 'wrong-password' } });
    expect(hitA.status).toBe(429);
    // 同 IP 的账号 B：IP 未打满（6 < 10）、B 自己的标识预算全新 → 正常进入业务（401 密码错误）
    const other = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'other-user', password: 'wrong-password' } });
    expect(other.status).toBe(401);
  });

  it('阈值改 2：第 3 次 429；0 = 关闭该档', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    await SettingsRepo.set(testDb(), 'auth_rate_limit_per_minute', 2);
    invalidateAuthRateLimitCache();
    for (let i = 0; i < 2; i++) {
      const res = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'nosuch', password: 'wrong-password' } });
      expect(res.status).toBe(401);
    }
    const hit = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'nosuch', password: 'wrong-password' } });
    expect(hit.status).toBe(429);
    // 0 = 关闭：不再限流
    await SettingsRepo.set(testDb(), 'auth_rate_limit_per_minute', 0);
    invalidateAuthRateLimitCache();
    for (let i = 0; i < 7; i++) {
      const res = await prodRequest('/api/auth/login', { method: 'POST', body: { username: 'nosuch', password: 'wrong-password' } });
      expect(res.status).toBe(401);
    }
  });

  it('管理端设置往返：PATCH authRateLimitPerMinute → GET 透出', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const { cookie, csrf } = await adminSession();
    const patch = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { authRateLimitPerMinute: 10 },
    });
    expect(patch.status).toBe(200);
    const get = await request(ctx, '/api/admin/settings', { cookie });
    const data = await json<{ data: { authRateLimitPerMinute: number } }>(get);
    expect(data.data.authRateLimitPerMinute).toBe(10);
  });
});

describe('注册成功速率（register_success_per_hour_per_ip）', () => {
  it('阈值 2：第 3 次注册 429 REGISTER_RATE_LIMITED；0 = 关闭', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    await SettingsRepo.set(testDb(), 'register_success_per_hour_per_ip', 2);
    // 认证限流默认已是 2/分，3 次注册会先被它拦下（429 RATE_LIMIT_EXCEEDED）；
    // 本例只验「注册成功速率」，先把认证限流档位调到 50 以隔离两个限额
    await SettingsRepo.set(testDb(), 'auth_rate_limit_per_minute', 50);
    invalidateAuthRateLimitCache();
    const r1 = await prodRequest('/api/auth/register', { method: 'POST', body: { username: 'user1', password: 'password123', email: 'u1@test.local' } });
    const r2 = await prodRequest('/api/auth/register', { method: 'POST', body: { username: 'user2', password: 'password123', email: 'u2@test.local' } });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const r3 = await prodRequest('/api/auth/register', { method: 'POST', body: { username: 'user3', password: 'password123', email: 'u3@test.local' } });
    expect(r3.status).toBe(429);
    const body = await json<{ error: { code: string } }>(r3);
    expect(body.error.code).toBe('REGISTER_RATE_LIMITED');
    // 0 = 关闭
    await SettingsRepo.set(testDb(), 'register_success_per_hour_per_ip', 0);
    const r4 = await prodRequest('/api/auth/register', { method: 'POST', body: { username: 'user4', password: 'password123', email: 'u4@test.local' } });
    expect(r4.status).toBe(201);
  });
});

describe('IP 封禁中间件（ipBanMiddleware）', () => {
  it('命中 403 通用文案；管理端解封后放行（KV 缓存写时失效）', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const { cookie, csrf } = await adminSession();
    // 封禁测试默认 IP 127.0.0.1（无任何来源头时的回退值）
    const create = await request(ctx, '/api/admin/ip-bans', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { ip: '127.0.0.1', reason: '测试封禁' },
    });
    expect(create.status).toBe(201);
    const hit = await prodRequest('/api/public/health/live');
    expect(hit.status).toBe(403);
    const body = await json<{ error: { message: string } }>(hit);
    expect(body.error.message).toBe('请求被拒绝');
    // 管理端列表可见
    const list = await request(ctx, '/api/admin/ip-bans', { cookie });
    const listBody = await json<{ data: { bans: Array<{ id: string; ip: string; reason: string | null }> } }>(list);
    const ban = listBody.data.bans.find((b) => b.ip === '127.0.0.1');
    expect(ban?.reason).toBe('测试封禁');
    // 解封 → 放行（KV 缓存写时失效）
    expect(ban).toBeDefined();
    const del = await request(ctx, `/api/admin/ip-bans/${ban?.id}`, { method: 'DELETE', cookie, headers: { 'X-CSRF-Token': csrf } });
    expect(del.status).toBe(200);
    const alive = await prodRequest('/api/public/health/live');
    expect(alive.status).toBe(200);
  });

  it('过期封禁放行（expires_at 已过）', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const { cookie, csrf } = await adminSession();
    await request(ctx, '/api/admin/ip-bans', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { ip: '127.0.0.1', reason: '已过期', expiresAt: Date.now() - 1000 },
    });
    const res = await prodRequest('/api/public/health/live');
    expect(res.status).toBe(200);
  });

  it('非管理员禁止管理 IP 封禁', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    await request(ctx, '/api/auth/register', { method: 'POST', body: { username: 'plain', password: 'password123', email: 'plain@test.local' } });
    const login = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'plain', password: 'password123', email: 'plain@test.local' } });
    const cookie = authTokenOf(login);
    const csrf = (await json<{ data: { token: string } }>(await request(ctx, '/api/auth/csrf-token', { cookie }))).data.token;
    const res = await request(ctx, '/api/admin/ip-bans', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { ip: '8.8.8.8' },
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('封禁用户增强（ban_reason + 审计）', () => {
  it('封禁写 ban_reason 与 admin_user_status 审计；解封清除原因', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const { cookie, csrf } = await adminSession();
    await request(ctx, '/api/auth/register', { method: 'POST', body: { username: 'target', password: 'password123', email: 'target@test.local' } });
    const uid = queryRow<{ id: string }>("SELECT id FROM users WHERE username = 'target'").id;
    const patch = await request(ctx, `/api/admin/users/${uid}`, {
      method: 'PUT',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { status: 'banned', banReason: '滥用注册' },
    });
    expect(patch.status).toBe(200);
    const row = queryRow<{ status: string; ban_reason: string | null }>('SELECT status, ban_reason FROM users WHERE id = ?', uid);
    expect(row.status).toBe('banned');
    expect(row.ban_reason).toBe('滥用注册');
    // 解封清除原因
    await request(ctx, `/api/admin/users/${uid}`, {
      method: 'PUT',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { status: 'active' },
    });
    const after = queryRow<{ status: string; ban_reason: string | null }>('SELECT status, ban_reason FROM users WHERE id = ?', uid);
    expect(after.status).toBe('active');
    expect(after.ban_reason).toBeNull();
    // 审计：admin_user_status 落库两次，metadata 带 status 与 reason
    const audits = queryAll<{ action: string; metadata: string }>(
      "SELECT action, metadata FROM access_logs WHERE action = 'admin_user_status' AND path = ? ORDER BY created_at",
      `/api/admin/users/${uid}`,
    );
    expect(audits.length).toBe(2);
    expect(JSON.parse(audits[0].metadata)).toMatchObject({ status: 'banned', reason: '滥用注册' });
  });

  it('IP 封禁 CRUD 写审计（admin_ip_ban / admin_ip_unban）', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const { cookie, csrf } = await adminSession();
    await request(ctx, '/api/admin/ip-bans', { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf }, body: { ip: '9.9.9.9' } });
    const list = await request(ctx, '/api/admin/ip-bans', { cookie });
    const banId = (await json<{ data: { bans: Array<{ id: string }> } }>(list)).data.bans[0].id;
    await request(ctx, `/api/admin/ip-bans/${banId}`, { method: 'DELETE', cookie, headers: { 'X-CSRF-Token': csrf } });
    const actions = queryAll<{ action: string }>(
      "SELECT action FROM access_logs WHERE action IN ('admin_ip_ban','admin_ip_unban') ORDER BY created_at",
    );
    expect(actions.map((a) => a.action)).toEqual(['admin_ip_ban', 'admin_ip_unban']);
  });
});
