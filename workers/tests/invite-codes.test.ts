// 邀请码注册机制（迁移 0010）：
// - 注册门控矩阵：关闭 / 关闭+带码 / 开启必填无码 / 格式不符 / 错码 / 有效码 / 开启选填无码
// - 生成权限矩阵：all_users / admin_only × 管理员 / 普通用户（POST 与 GET 同门禁）
// - 累计数量上限（单个与批量 count）
// - 核销原子性：有效码注册写 users.invited_by_code_id + 配额行；FK 失败（码不存在）整体回滚
// - GET /api/invites 按码聚合受邀记录（用户名 / 所用码 / 注册时间）
// - 管理设置 GET/PATCH 往返与公开设置透出
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { Db, UserRepo } from '../src/db';
import { generateInviteCode, INVITE_CODE_PATTERN } from '../src/services/invites/invites';

let ctx: TestContext;
let adminCookie: string;

function setSetting(key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now());
}

/** 每个 describe 前后复位到迁移种子默认值，避免用例间串扰 */
function resetInviteSettings(): void {
  setSetting('invite_enabled', 'false');
  setSetting('invite_required', 'false');
  setSetting('invite_generation', 'all_users');
  setSetting('invite_max_per_user', '5');
}

async function register(username: string, inviteCode?: string): Promise<Response> {
  return request(ctx, '/api/auth/register', {
    method: 'POST',
    body: {
      username,
      password: 'password123',
      email: `${username}@invite.test`,
      ...(inviteCode === undefined ? {} : { inviteCode }),
    },
  });
}

async function errCode(res: Response): Promise<string> {
  const body = await json<{ error: { code: string } }>(res);
  return body.error.code;
}

async function createInvites(cookie: string, body?: Record<string, unknown>): Promise<Response> {
  return request(ctx, '/api/invites', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': await getCsrf(ctx, cookie) },
    body: body ?? {},
  });
}

interface InviteListBody {
  data: {
    codes: Array<{
      id: string;
      code: string;
      name: string | null;
      createdAt: number;
      invitedUsers: Array<{ username: string; code: string; registeredAt: number }>;
    }>;
    max: number;
  };
}

async function listInvites(cookie: string): Promise<InviteListBody> {
  return json<InviteListBody>(await request(ctx, '/api/invites', { cookie }));
}

function invitedByCodeId(username: string): string | null {
  const row = ctx.db.prepare(`SELECT invited_by_code_id FROM users WHERE username = ?`).get(username) as
    | { invited_by_code_id: string | null }
    | undefined;
  return row?.invited_by_code_id ?? null;
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  resetInviteSettings();
  await registerAndLogin(ctx, 'inv_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'inv_admin'`);
  // 角色变更后需重新登录，JWT 才携带 admin
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'inv_admin', password: 'password123' },
  });
  const token = (relogin.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${token?.[1] ?? ''}`;
});

describe('注册门控', () => {
  it('未开启邀请码：无码注册成功', async () => {
    resetInviteSettings();
    const res = await register('ig_plain');
    expect(res.status).toBe(201);
    expect(invitedByCodeId('ig_plain')).toBeNull();
  });

  it('未开启邀请码：带码注册拒绝 INVITE_NOT_ENABLED', async () => {
    resetInviteSettings();
    const res = await register('ig_off_code', 'ABC123');
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('INVITE_NOT_ENABLED');
  });

  it('开启 + 必填：无码注册拒绝 INVITE_CODE_REQUIRED', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_required', 'true');
    const res = await register('ig_required');
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('INVITE_CODE_REQUIRED');
  });

  it('开启：格式不符拒绝 INVITE_CODE_FORMAT（小写 / 长度 / 非法字符）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    // 码值区分大小写：小写形态直接按格式不符拒绝
    expect(await errCode(await register('ig_fmt_lower', 'abc12x'))).toBe('INVITE_CODE_FORMAT');
    expect(await errCode(await register('ig_fmt_short', 'ABC12'))).toBe('INVITE_CODE_FORMAT');
    expect(await errCode(await register('ig_fmt_char', 'ABC12-'))).toBe('INVITE_CODE_FORMAT');
  });

  it('开启：格式正确但不存在的码拒绝 INVITE_CODE_INVALID', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    // 理论碰撞兜底：确保该码值不存在
    ctx.db.prepare(`DELETE FROM invite_codes WHERE code = 'ZZZZZZ'`).run();
    const res = await register('ig_missing', 'ZZZZZZ');
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('INVITE_CODE_INVALID');
  });

  it('开启 + 选填：无码注册成功且不核销', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    const res = await register('ig_optional');
    expect(res.status).toBe(201);
    expect(invitedByCodeId('ig_optional')).toBeNull();
  });

  it('有效码注册成功：核销落库 + 配额行同事务写入', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_required', 'true');
    const created = await json<{ data: { codes: Array<{ id: string; code: string }> } }>(
      await createInvites(adminCookie)
    );
    const invite = created.data.codes[0];

    const res = await register('ig_valid', invite.code);
    expect(res.status).toBe(201);
    expect(invitedByCodeId('ig_valid')).toBe(invite.id);
    // createUser 事务同时落配额行（原子性正向断言）
    const quota = ctx.db
      .prepare(`SELECT q.user_id FROM user_quotas q JOIN users u ON q.user_id = u.id WHERE u.username = 'ig_valid'`)
      .get();
    expect(quota).toBeTruthy();
  });

  it('同一邀请码可被多人核销（按码聚合）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    const created = await json<{ data: { codes: Array<{ id: string; code: string }> } }>(
      await createInvites(adminCookie)
    );
    const invite = created.data.codes[0];
    expect((await register('ig_multi_a', invite.code)).status).toBe(201);
    expect((await register('ig_multi_b', invite.code)).status).toBe(201);
    expect(invitedByCodeId('ig_multi_a')).toBe(invite.id);
    expect(invitedByCodeId('ig_multi_b')).toBe(invite.id);
  });
});

describe('核销原子性', () => {
  it('码行不存在（FK 失败）：用户与配额行整体回滚', async () => {
    const db = Db.fromSqlite(ctx.db);
    await expect(
      UserRepo.createUser(db, {
        username: 'ig_atomic',
        email: 'ig_atomic@invite.test',
        passwordHash: 'hash',
        invitedByCodeId: 'no-such-code-id',
      })
    ).rejects.toThrow();
    expect(ctx.db.prepare(`SELECT id FROM users WHERE username = 'ig_atomic'`).get()).toBeUndefined();
    expect(
      ctx.db.prepare(`SELECT user_id FROM user_quotas WHERE user_id NOT IN (SELECT id FROM users)`).all()
    ).toEqual([]);
  });
});

describe('生成权限矩阵', () => {
  it('all_users + 开启机制：普通用户可生成与查看', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    const user = await registerAndLogin(ctx, 'ig_gen_user');
    const res = await createInvites(user.authCookie);
    expect(res.status).toBe(201);
    expect((await listInvites(user.authCookie)).data.codes.length).toBeGreaterThanOrEqual(1);
  });

  it('admin_only：普通用户 POST/GET 均 403，管理员放行', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_generation', 'admin_only');
    const user = await registerAndLogin(ctx, 'ig_gen_blocked');
    const post = await createInvites(user.authCookie);
    expect(post.status).toBe(403);
    expect(await errCode(post)).toBe('FORBIDDEN');
    const get = await request(ctx, '/api/invites', { cookie: user.authCookie });
    expect(get.status).toBe(403);

    const adminPost = await createInvites(adminCookie);
    expect(adminPost.status).toBe(201);
    resetInviteSettings();
  });

  it('批量生成 count 个码：格式 [0-9A-Z]{6} 且互不重复', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    const user = await registerAndLogin(ctx, 'ig_batch');
    const res = await createInvites(user.authCookie, { count: 5, name: '批次一' });
    expect(res.status).toBe(201);
    const body = await json<{ data: { codes: Array<{ code: string; name: string | null }> } }>(res);
    expect(body.data.codes).toHaveLength(5);
    const codes = body.data.codes.map((ic) => ic.code);
    for (const code of codes) expect(code).toMatch(INVITE_CODE_PATTERN);
    expect(new Set(codes).size).toBe(5);
    // name 同批共用；'' 视同未填
    expect(body.data.codes.every((ic) => ic.name === '批次一')).toBe(true);
  });

  it('generateInviteCode 单元：码值恒定满足格式约定', () => {
    for (let i = 0; i < 200; i++) expect(generateInviteCode()).toMatch(INVITE_CODE_PATTERN);
  });
});

describe('越权防护（管理员 / 普通用户 / guest 分档）', () => {
  /** 把某个已登录用户改到指定角色（角色变更需重新登录，JWT 才带新角色） */
  async function asRole(username: string, role: string): Promise<{ authCookie: string }> {
    ctx.db.exec(`UPDATE users SET role = '${role}' WHERE username = '${username}'`);
    const res = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username, password: 'password123' },
    });
    const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
    return { authCookie: `auth_token=${token?.[1] ?? ''}` };
  }

  it('邀请码机制关闭时：普通用户 POST/GET 均 403，管理员仍可生成（预生成码值）', async () => {
    resetInviteSettings(); // invite_enabled = false、invite_generation = all_users
    const user = await registerAndLogin(ctx, 'ig_off_user');
    const post = await createInvites(user.authCookie);
    expect(post.status).toBe(403);
    expect(await errCode(post)).toBe('FORBIDDEN');
    expect((await request(ctx, '/api/invites', { cookie: user.authCookie })).status).toBe(403);
    expect((await createInvites(adminCookie)).status).toBe(201);
  });

  it('guest 角色（仅下载的受限角色）即使开关开启且 all_users 也不可生成', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    const guest = await registerAndLogin(ctx, 'ig_guest_user');
    const asGuest = await asRole('ig_guest_user', 'guest');
    const post = await createInvites(asGuest.authCookie);
    expect(post.status).toBe(403);
    expect(await errCode(post)).toBe('FORBIDDEN');
    expect((await request(ctx, '/api/invites', { cookie: asGuest.authCookie })).status).toBe(403);
  });

  it('admin_only + 开关开启：普通用户 403，管理员 201（权限与开关两个条件都生效）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_generation', 'admin_only');
    const user = await registerAndLogin(ctx, 'ig_admonly_user');
    expect((await createInvites(user.authCookie)).status).toBe(403);
    expect((await createInvites(adminCookie)).status).toBe(201);
    resetInviteSettings();
  });

  it('注册链路不接受角色/状态注入（body 带 role: admin 仍建普通用户）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_required', 'false');
    const res = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: {
        username: 'ig_inject',
        password: 'password123',
        email: 'ig_inject@invite.test',
        role: 'admin',
        status: 'active',
      },
    });
    expect(res.status).toBe(201);
    const row = ctx.db.prepare(`SELECT role FROM users WHERE username = 'ig_inject'`).get() as { role: string };
    expect(row.role).toBe('user');
  });

  it('并发生成不越过数量上限（事务内计数，两个并发请求只成功一个）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_max_per_user', '1');
    const user = await registerAndLogin(ctx, 'ig_race_user');
    const [a, b] = await Promise.all([createInvites(user.authCookie), createInvites(user.authCookie)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 403]);
    const n = ctx.db.prepare(`SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = (SELECT id FROM users WHERE username = 'ig_race_user')`).get() as { n: number };
    expect(n.n).toBe(1);
    resetInviteSettings();
  });

  it('用户自助接口不可改角色或核销关系', async () => {
    const user = await registerAndLogin(ctx, 'ig_selfedit');
    const res = await request(ctx, '/api/users/me/settings', {
      method: 'PUT',
      cookie: user.authCookie,
      headers: { 'X-CSRF-Token': await getCsrf(ctx, user.authCookie) },
      body: { displayName: 'x', role: 'admin', invitedByCodeId: 'x' },
    });
    expect(res.status).toBe(200);
    const row = ctx.db.prepare(`SELECT role, invited_by_code_id FROM users WHERE username = 'ig_selfedit'`).get() as {
      role: string;
      invited_by_code_id: string | null;
    };
    expect(row.role).toBe('user');
    expect(row.invited_by_code_id).toBeNull();
  });
});

describe('生成数量上限', () => {
  it('累计达到上限后拒绝 INVITE_LIMIT（单个与批量同口径）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_max_per_user', '2');
    const user = await registerAndLogin(ctx, 'ig_limit');
    expect((await createInvites(user.authCookie, { count: 2 })).status).toBe(201);
    const over = await createInvites(user.authCookie);
    expect(over.status).toBe(403);
    expect(await errCode(over)).toBe('INVITE_LIMIT');
    // 批量请求按「既有 + 本批」判定：既有 2 + 请求 1 > 上限 2
    const overBatch = await createInvites(user.authCookie, { count: 1 });
    expect(overBatch.status).toBe(403);
    resetInviteSettings();
  });

  it('GET /api/invites 返回上限 max 与按码聚合的受邀记录', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_max_per_user', '3');
    const creator = await registerAndLogin(ctx, 'ig_aggr_creator');
    const created = await json<{ data: { codes: Array<{ id: string; code: string }> } }>(
      await createInvites(creator.authCookie, { name: '聚合用' })
    );
    const invite = created.data.codes[0];
    expect((await register('ig_aggr_invitee', invite.code)).status).toBe(201);

    const list = await listInvites(creator.authCookie);
    expect(list.data.max).toBe(3);
    const item = list.data.codes.find((ic) => ic.id === invite.id)!;
    expect(item.name).toBe('聚合用');
    expect(item.invitedUsers).toHaveLength(1);
    expect(item.invitedUsers[0].username).toBe('ig_aggr_invitee');
    expect(item.invitedUsers[0].code).toBe(invite.code);
    expect(item.invitedUsers[0].registeredAt).toBeGreaterThan(0);
    resetInviteSettings();
  });
});

describe('设置面', () => {
  it('管理端 PATCH/GET 往返四个注册设置键', async () => {
    const csrf = await getCsrf(ctx, adminCookie);
    const patch = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { inviteEnabled: true, inviteRequired: true, inviteGeneration: 'admin_only', inviteMaxPerUser: 7 },
    });
    expect(patch.status).toBe(200);
    const saved = await json<{ data: { savedKeys: string[] } }>(patch);
    for (const key of ['invite_enabled', 'invite_required', 'invite_generation', 'invite_max_per_user']) {
      expect(saved.data.savedKeys).toContain(key);
    }

    const get = await json<{
      data: { inviteEnabled: boolean; inviteRequired: boolean; inviteGeneration: string; inviteMaxPerUser: number };
    }>(await request(ctx, '/api/admin/settings', { cookie: adminCookie }));
    expect(get.data.inviteEnabled).toBe(true);
    expect(get.data.inviteRequired).toBe(true);
    expect(get.data.inviteGeneration).toBe('admin_only');
    expect(get.data.inviteMaxPerUser).toBe(7);

    // 非法枚举与越界上限直接 400（strict schema）
    const bad = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { inviteGeneration: 'everyone' },
    });
    expect(bad.status).toBe(400);
    const badMax = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { inviteMaxPerUser: 0 },
    });
    expect(badMax.status).toBe(400);
    resetInviteSettings();
  });

  it('公开设置透出邀请码门控（不含上限之外的敏感项）', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    setSetting('invite_required', 'true');
    setSetting('invite_generation', 'admin_only');
    const pub = await json<{
      data: { inviteEnabled: boolean; inviteRequired: boolean; inviteGeneration: string };
    }>(await request(ctx, '/api/public/settings'));
    expect(pub.data.inviteEnabled).toBe(true);
    expect(pub.data.inviteRequired).toBe(true);
    expect(pub.data.inviteGeneration).toBe('admin_only');
    resetInviteSettings();
  });
});

describe('管理端用户列表的受邀信息', () => {
  interface AdminUserRow {
    username: string;
    inviteCode: string | null;
    invitedBy: string | null;
  }

  async function adminUsers(query: string): Promise<{ users: AdminUserRow[]; pagination: { total: number } }> {
    const res = await request(ctx, `/api/admin/users?${query}`, { cookie: adminCookie });
    expect(res.status).toBe(200);
    return (await json<{ data: { users: AdminUserRow[]; pagination: { total: number } } }>(res)).data;
  }

  it('受邀账号带邀请人（码创建人）与邀请码，未受邀账号两列为 null', async () => {
    resetInviteSettings();
    setSetting('invite_enabled', 'true');
    // 管理员在同一份库中已累计生成过若干码（其他用例），上限放开避免依赖执行顺序
    setSetting('invite_max_per_user', '100');
    const created = await json<{ data: { codes: Array<{ code: string }> } }>(await createInvites(adminCookie));
    const invite = created.data.codes[0];
    expect((await register('ig_list_invitee', invite.code)).status).toBe(201);
    expect((await register('ig_list_plain')).status).toBe(201);

    const data = await adminUsers('page=1&limit=50');
    const invitee = data.users.find((u) => u.username === 'ig_list_invitee')!;
    expect(invitee.inviteCode).toBe(invite.code);
    expect(invitee.invitedBy).toBe('inv_admin');
    const plain = data.users.find((u) => u.username === 'ig_list_plain')!;
    expect(plain.inviteCode).toBeNull();
    expect(plain.invitedBy).toBeNull();
    resetInviteSettings();
  });

  it('搜索与筛选仍按限定后的谓词命中（JOIN 后的回归护栏）', async () => {
    const data = await adminUsers('page=1&limit=50&search=ig_list_invitee');
    expect(data.pagination.total).toBe(1);
    expect(data.users[0].username).toBe('ig_list_invitee');
    const byRole = await adminUsers('page=1&limit=50&role=user&search=ig_list');
    expect(byRole.pagination.total).toBe(2);
  });
});
