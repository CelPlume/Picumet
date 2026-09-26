// 角色默认权限（§4.4 第 8 步）与文件级游客可见性（§C）：
// 权限落库 → 引擎判定 → 管理端读写 → 匿名访客实际行为 的端到端一致性
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import {
  checkPermission,
  syntheticGuestRule,
  loadPrincipalRules,
  DEFAULT_ROLE_PERMISSIONS,
} from '../src/services/permissions/check';
import { RoleDefaultsRepo } from '../src/db/repos/role-defaults';
import { Db, RuleRepo, UserRepo } from '../src/db';
import type { GuestVisibility, Mount, PathRule, Permission, Principal, Role } from '@shared/types';
import { PERMISSION_MATRIX } from '@shared/types';

/** 默认权限矩阵（5 项）：分享由能力位 can_share 表达，不在矩阵内 */
const MATRIX: Permission[] = [...PERMISSION_MATRIX];

let ctx: TestContext;
let db: Db;
let adminCookie = '';
let adminCsrf = '';

/** 引擎层固定夹具：与挂载无关的纯判定用例用 */
const mount: Mount = {
  id: 'm-role',
  mountPath: '/',
  name: 'root',
  providerId: 'p1',
  sortBy: 'name',
  sortOrder: 'asc',
  priority: 0,
  status: 'active',
  maxStorage: null,
  usedStorage: 0,
  quotaReserved: 0,
  createdAt: 0,
  poolStrategy: 'least_used',
  capacityBytes: null,
  uploadMode: 'free',
};

const anonymous: Principal = {
  type: 'guest',
  id: 'anonymous',
  role: 'guest',
  defaultPath: '/',
  capabilities: [],
  defaultPermissions: DEFAULT_ROLE_PERMISSIONS.guest,
};

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  await registerAndLogin(ctx, 'rp_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'rp_admin'`);
  adminCookie = await relogin('rp_admin');
  adminCsrf = await getCsrf(ctx, adminCookie);
});

// ============ 辅助 ============

async function relogin(username: string, password = 'password123'): Promise<string> {
  const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username, password } });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return `auth_token=${token?.[1] ?? ''}`;
}

async function uploadFile(cookie: string, dir: string, fileName: string, content: string): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  expect(initRes.status).toBe(200);
  const init = await json<{ data: { sessionId: string } }>(initRes);
  const raw = await request(ctx, `/api/files/upload/raw/${init.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  expect(raw.status).toBe(200);
  const rawBody = await json<{ data: { etag: string } }>(raw);
  const complete = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: init.data.sessionId, etag: rawBody.data.etag },
  });
  expect(complete.status).toBe(200);
  const completeBody = await json<{ data: { file: { id: string } } }>(complete);
  return completeBody.data.file.id;
}

async function createFolder(cookie: string, name: string, parent = '/'): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: parent, name },
  });
  expect(res.status).toBe(201);
  const row = ctx.db.prepare('SELECT id FROM file_metadata WHERE name = ? AND type = \'folder\'').get(name) as {
    id: string;
  };
  return row.id;
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

function putFile(cookie: string, fileId: string, body: unknown, csrf: string): Promise<Response> {
  return request(ctx, `/api/files/${fileId}`, {
    method: 'PUT',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body,
  });
}

function dbPermissions(role: string): string[] {
  const row = ctx.db.prepare('SELECT permissions FROM role_defaults WHERE role = ?').get(role) as
    | { permissions: string }
    | undefined;
  return JSON.parse(row?.permissions ?? '[]') as string[];
}

function dbCapabilities(role: string): string[] {
  const row = ctx.db.prepare('SELECT capabilities FROM role_defaults WHERE role = ?').get(role) as
    | { capabilities: string }
    | undefined;
  return JSON.parse(row?.capabilities ?? '[]') as string[];
}

function dbUserPermissions(userId: string): string[] | null {
  const row = ctx.db.prepare('SELECT permissions FROM users WHERE id = ?').get(userId) as
    | { permissions: string | null }
    | undefined;
  return row?.permissions == null ? null : (JSON.parse(row.permissions) as string[]);
}

function dbGuestVisibility(fileId: string): string | null {
  const row = ctx.db.prepare('SELECT guest_visibility FROM file_metadata WHERE id = ?').get(fileId) as
    | { guest_visibility: string | null }
    | undefined;
  return row?.guest_visibility ?? null;
}

function setGuestVisibilityColumn(id: string, value: GuestVisibility | null): void {
  ctx.db.prepare('UPDATE file_metadata SET guest_visibility = ? WHERE id = ?').run(value, id);
}

// ============ 1. 角色默认权限落库 ============

describe('角色默认权限落库', () => {
  it('迁移种子：admin/user = 矩阵 5 项、guest 仅 download；能力位种子默认可分享', () => {
    expect(dbPermissions('admin')).toEqual(MATRIX);
    expect(dbPermissions('user')).toEqual(MATRIX);
    expect(dbPermissions('guest')).toEqual(['download']);
    // 分享/发布/授权的唯一开关是能力位（分享不进权限矩阵）
    expect(dbCapabilities('admin')).toEqual(['can_share']);
    expect(dbCapabilities('user')).toEqual(['can_share']);
    expect(dbCapabilities('guest')).toEqual([]);
    expect(MATRIX).not.toContain('share');
  });

  it('取值兜底：DB 有值用 DB；显式空数组保留；未登记/缺列按引擎常量', async () => {
    expect(await RoleDefaultsRepo.permissionsOf(db, 'guest')).toEqual(['download']);
    expect(await RoleDefaultsRepo.permissionsOf(db, 'admin')).toEqual(DEFAULT_ROLE_PERMISSIONS.admin);
    // 未登记的自定义角色按 user 语义（与「第 8 步对所有用户的既有放行」一致）
    expect(await RoleDefaultsRepo.permissionsOf(db, 'some-custom-role' as Role)).toEqual(DEFAULT_ROLE_PERMISSIONS.user);

    // 显式清空（[]）原样保留：管理员把角色默认权限清空即该角色默认路径内一律不放行
    await RoleDefaultsRepo.upsertDefaults(db, 'editor' as Role, {
      defaultPath: '/',
      maxStorage: 1073741824,
      maxFiles: 10000,
      permissions: [],
    });
    expect(await RoleDefaultsRepo.permissionsOf(db, 'editor' as Role)).toEqual([]);
    const editor: Principal = {
      type: 'user',
      id: 'editor-1',
      role: 'editor' as Role,
      defaultPath: '/',
      defaultPermissions: [],
    };
    expect(checkPermission(editor, mount, '/editor-1/a.txt', 'read', [])).toBe('deny');
    expect(checkPermission(editor, mount, '/editor-1/a.txt', 'write', [])).toBe('deny');
    await RoleDefaultsRepo.remove(db, 'editor' as Role);
  });

  it('用户默认路径内按角色默认权限放行，路径外仍拒绝（属主隔离不变）', () => {
    const alice: Principal = {
      type: 'user',
      id: 'alice',
      role: 'user',
      defaultPath: '/alice',
      defaultPermissions: DEFAULT_ROLE_PERMISSIONS.user,
    };
    for (const action of MATRIX) {
      expect(checkPermission(alice, mount, '/alice/a.txt', action, [])).toBe('allow');
    }
    // share 不在矩阵内，但默认路径内沿用既有放行（分享开关是能力位 can_share）
    expect(checkPermission(alice, mount, '/alice/a.txt', 'share', [])).toBe('allow');
    expect(checkPermission(alice, mount, '/bob/a.txt', 'share', [])).toBe('deny');
    for (const action of ['read', 'update', 'delete'] as const) {
      expect(checkPermission(alice, mount, '/bob/a.txt', action, [])).toBe('deny');
    }

    // 未装载 defaultPermissions（存量调用方）→ 常量兜底，行为与迁移种子一致
    const legacy: Principal = { type: 'user', id: 'alice', role: 'user', defaultPath: '/alice' };
    expect(checkPermission(legacy, mount, '/alice/a.txt', 'download', [])).toBe('allow');

    // 登录的 guest 角色用户：仅 download
    const guestRoleUser: Principal = {
      type: 'user',
      id: 'g1',
      role: 'guest',
      defaultPath: '/g1',
      defaultPermissions: DEFAULT_ROLE_PERMISSIONS.guest,
    };
    expect(checkPermission(guestRoleUser, mount, '/g1/a.txt', 'download', [])).toBe('allow');
    expect(checkPermission(guestRoleUser, mount, '/g1/a.txt', 'read', [])).toBe('deny');
    expect(checkPermission(guestRoleUser, mount, '/g1/a.txt', 'write', [])).toBe('deny');
    // share 不在矩阵内：默认路径内沿用既有放行（分享由 can_share 能力位把关）
    expect(checkPermission(guestRoleUser, mount, '/g1/a.txt', 'share', [])).toBe('allow');
  });
});

// ============ 2. 匿名访客：文件级 guest_visibility ============

describe('匿名访客合成规则（syntheticGuestRule）', () => {
  it('仅匿名访客 + 显式 download/view 时生成；NULL/none 不额外开放', () => {
    expect(syntheticGuestRule('/a/b.txt', null, 'm-role', anonymous)).toBeNull();
    expect(syntheticGuestRule('/a/b.txt', undefined, 'm-role', anonymous)).toBeNull();
    expect(syntheticGuestRule('/a/b.txt', 'none', 'm-role', anonymous)).toBeNull();
    expect(syntheticGuestRule('/a/b.txt', 'download', 'm-role', anonymous)).toMatchObject({
      id: '__synthetic_guest__',
      mountId: 'm-role',
      pathPattern: '/a/b.txt',
      effect: 'allow',
      origin: 'system',
      status: 'active',
      permissions: ['download'],
    });
    expect(syntheticGuestRule('/a/b.txt', 'view', 'm-role', anonymous)?.permissions).toEqual(['read', 'download']);

    // 登录用户不吃文件级游客可见性（其能力来自角色默认/规则/可见性）
    const bob: Principal = { type: 'user', id: 'bob', role: 'user', defaultPath: '/bob' };
    expect(syntheticGuestRule('/a/b.txt', 'view', 'm-role', bob)).toBeNull();
  });

  it('NULL 拒绝、download 仅下载、view 可读可下载、none 全拒', () => {
    const judge = (guestVisibility: GuestVisibility | null, action: Permission) =>
      checkPermission(anonymous, mount, '/own/a.txt', action, [], 'owner-1', undefined, 'private', guestVisibility);

    // NULL：不额外开放（公网直读仍 403）
    expect(judge(null, 'download')).toBe('deny');
    expect(judge(null, 'read')).toBe('deny');

    expect(judge('download', 'download')).toBe('allow');
    expect(judge('download', 'read')).toBe('deny');
    expect(judge('download', 'write')).toBe('deny');

    expect(judge('view', 'read')).toBe('allow');
    expect(judge('view', 'download')).toBe('allow');
    expect(judge('view', 'write')).toBe('deny');

    expect(judge('none', 'read')).toBe('deny');
    expect(judge('none', 'download')).toBe('deny');
  });

  it('admin deny 规则压过合成游客规则（同 visibility 合成规则的系统档位）', () => {
    const denyRule: PathRule = {
      id: 'deny-guest',
      mountId: mount.id,
      pathPattern: '/own/a.txt',
      effect: 'deny',
      role: 'guest',
      permissions: ['read', 'download'],
      requirePassword: false,
      priority: 0,
      origin: 'admin',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    };
    expect(checkPermission(anonymous, mount, '/own/a.txt', 'download', [denyRule], 'owner-1', undefined, 'private', 'download')).toBe('deny');
  });
});

// ============ 3. 文件级 guestVisibility 写入与回读 ============

describe('文件级 guestVisibility（PUT /api/files/:id）', () => {
  it('四种取值落库并在详情/列表回读（inherit = NULL）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'rp_owner');
    const csrf = await getCsrf(ctx, authCookie);
    const fileId = await uploadFile(authCookie, '/', 'guest-vis.txt', 'gv');

    // 新上传默认未设置
    expect(dbGuestVisibility(fileId)).toBeNull();
    const initial = await json<{ data: { file: { guestVisibility: string | null } } }>(
      await request(ctx, `/api/files/${fileId}`, { cookie: authCookie })
    );
    expect(initial.data.file.guestVisibility).toBeNull();

    for (const [value, expected] of [
      ['download', 'download'],
      ['view', 'view'],
      ['none', 'none'],
      ['inherit', null],
    ] as const) {
      const res = await putFile(authCookie, fileId, { guestVisibility: value }, csrf);
      expect(res.status).toBe(200);
      expect(dbGuestVisibility(fileId)).toBe(expected);
      const detail = await json<{ data: { file: { guestVisibility: string | null } } }>(
        await request(ctx, `/api/files/${fileId}`, { cookie: authCookie })
      );
      expect(detail.data.file.guestVisibility).toBe(expected);
    }

    // 列表项同样返回
    await putFile(authCookie, fileId, { guestVisibility: 'view' }, csrf);
    const list = await json<{ data: { items: Array<{ id: string; guestVisibility: string | null }> } }>(
      await request(ctx, '/api/files?path=/', { cookie: authCookie })
    );
    const item = list.data.items.find((i) => i.id === fileId);
    expect(item?.guestVisibility).toBe('view');
  });

  it('无 update 权限者改不了（自定义角色权限经 API 生效）', async () => {
    const { authCookie: ownerCookie } = await registerAndLogin(ctx, 'rp_owner2');
    const fileId = await uploadFile(ownerCookie, '/', 'locked-vis.txt', 'x');

    // 自定义角色 viewer：仅 read + download
    const created = await request(ctx, '/api/admin/roles', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { role: 'viewer' },
    });
    expect(created.status).toBe(200);
    const defaults = await request(ctx, '/api/admin/roles/viewer/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { defaultPath: '/', maxStorage: 1073741824, maxFiles: 10000, permissions: ['read', 'download'] },
    });
    expect(defaults.status).toBe(200);

    const viewer = await registerAndLogin(ctx, 'rp_viewer');
    await UserRepo.updateUser(db, viewer.userId, { role: 'viewer' });
    const viewerCookie = await relogin('rp_viewer');

    // 角色默认权限（read/download）在该用户的权限视图里如实体现
    const detail = await json<{ data: { permissions: string[] } }>(
      await request(ctx, `/api/files/${fileId}`, { cookie: viewerCookie })
    );
    expect(detail.data.permissions.sort()).toEqual(['download', 'read', 'share']);
    expect(dbGuestVisibility(fileId)).toBeNull();

    const csrf = await getCsrf(ctx, viewerCookie);
    const denied = await putFile(viewerCookie, fileId, { guestVisibility: 'view' }, csrf);
    expect(denied.status).toBe(403);
    expect(dbGuestVisibility(fileId)).toBeNull();
  });
});

// ============ 4. 匿名访客实际行为 ============

describe('匿名访客：guest_visibility 端到端', () => {
  it('NULL/none 拒绝，download 可下载，view 可列目录与下载；站点开关仍是总闸', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'rp_gowner');
    const folderId = await createFolder(authCookie, 'gvzone');
    const fileId = await uploadFile(authCookie, '/gvzone', 'doc.txt', 'gv-content');
    await setGuestAccess(true);

    // NULL：不额外开放（既有语义不变）
    expect((await request(ctx, '/gvzone/doc.txt')).status).toBe(403);
    expect((await request(ctx, '/api/public/fs?path=/gvzone')).status).toBe(403);

    // 文件 download：匿名可下载，但目录仍不可列（download 不含 read）
    setGuestVisibilityColumn(fileId, 'download');
    const download = await request(ctx, '/gvzone/doc.txt');
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('gv-content');
    expect((await request(ctx, '/api/public/fs?path=/gvzone')).status).toBe(403);

    // 目录 view：匿名可列目录
    setGuestVisibilityColumn(folderId, 'view');
    const listed = await request(ctx, '/api/public/fs?path=/gvzone');
    expect(listed.status).toBe(200);
    const listedBody = await json<{ data: { items: Array<{ name: string }> } }>(listed);
    expect(listedBody.data.items.map((i) => i.name)).toContain('doc.txt');

    // 文件 view：可预览（列表内直链可匿名取回）+ 下载
    setGuestVisibilityColumn(fileId, 'view');
    expect((await request(ctx, '/gvzone/doc.txt')).status).toBe(200);
    const viewBody = await json<{ data: { items: Array<{ name: string; url: string | null }> } }>(
      await request(ctx, '/api/public/fs?path=/gvzone')
    );
    const viewUrl = viewBody.data.items.find((i) => i.name === 'doc.txt')?.url;
    expect(viewUrl).toBeTruthy();
    const viaUrl = await request(ctx, new URL(viewUrl ?? '').pathname + new URL(viewUrl ?? '').search);
    expect(viaUrl.status).toBe(200);
    expect(await viaUrl.text()).toBe('gv-content');

    // 文件 none：逐项过滤掉
    setGuestVisibilityColumn(fileId, 'none');
    const filtered = await json<{ data: { items: Array<{ name: string }> } }>(
      await request(ctx, '/api/public/fs?path=/gvzone')
    );
    expect(filtered.data.items.map((i) => i.name)).not.toContain('doc.txt');

    // 目录 none：整目录拒绝
    setGuestVisibilityColumn(folderId, 'none');
    setGuestVisibilityColumn(fileId, 'download');
    expect((await request(ctx, '/api/public/fs?path=/gvzone')).status).toBe(403);
    // 文件自身的显式开放仍可直取
    expect((await request(ctx, '/gvzone/doc.txt')).status).toBe(200);

    // 站点总闸：显式 guest_visibility 不越过 allow_guest_access
    await setGuestAccess(false);
    const gated = await request(ctx, '/gvzone/doc.txt');
    expect(gated.status).toBe(401);
    const gatedBody = await json<{ error: { code: string } }>(gated);
    expect(gatedBody.error.code).toBe('LOGIN_REQUIRED');
  });
});

// ============ 5. 管理端角色 API ============

describe('管理端角色 API 与 permissions', () => {
  it('GET /api/admin/roles 返回 permissions；PUT 保存后回读一致（去重）且不写 users 表', async () => {
    const before = await json<{ data: { roles: Array<{ role: string; permissions: string[] }> } }>(
      await request(ctx, '/api/admin/roles', { cookie: adminCookie })
    );
    expect(before.data.roles.find((r) => r.role === 'admin')?.permissions).toEqual(MATRIX);
    expect(before.data.roles.find((r) => r.role === 'guest')?.permissions).toEqual(['download']);

    const member = await registerAndLogin(ctx, 'rp_guest_member');
    await UserRepo.updateUser(db, member.userId, { role: 'guest' });
    const memberBefore = await UserRepo.getUserById(db, member.userId);

    const put = await request(ctx, '/api/admin/roles/guest/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        defaultPath: '/',
        maxStorage: 1073741824,
        maxFiles: 10000,
        permissions: ['read', 'download', 'read'],
      },
    });
    expect(put.status).toBe(200);
    expect(dbPermissions('guest')).toEqual(['read', 'download']);

    const after = await json<{ data: { roles: Array<{ role: string; permissions: string[] }> } }>(
      await request(ctx, '/api/admin/roles', { cookie: adminCookie })
    );
    expect(after.data.roles.find((r) => r.role === 'guest')?.permissions).toEqual(['read', 'download']);

    // 能力位（users.capabilities）与角色路径权限是两套：PUT 不动用户行
    const memberAfter = await UserRepo.getUserById(db, member.userId);
    expect(memberAfter?.capabilities).toEqual(memberBefore?.capabilities);

    // 还原种子值，避免影响后续用例
    await request(ctx, '/api/admin/roles/guest/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { defaultPath: '/', maxStorage: 1073741824, maxFiles: 10000, permissions: ['download'] },
    });
    expect(dbPermissions('guest')).toEqual(['download']);
  });

  it('读取层过滤非矩阵项：库里存有 share 也只返回矩阵 5 项', async () => {
    await RoleDefaultsRepo.create(db, 'legacy-role' as Role);
    // 模拟存量/种子里的 6 项历史值（含 share）
    ctx.db
      .prepare('UPDATE role_defaults SET permissions = ? WHERE role = ?')
      .run(JSON.stringify(['read', 'share', 'download']), 'legacy-role');
    expect(await RoleDefaultsRepo.permissionsOf(db, 'legacy-role' as Role)).toEqual(['read', 'download']);

    const roles = await json<{ data: { roles: Array<{ role: string; permissions: string[] }> } }>(
      await request(ctx, '/api/admin/roles', { cookie: adminCookie })
    );
    const legacy = roles.data.roles.find((r) => r.role === 'legacy-role');
    expect(legacy?.permissions).toEqual(['read', 'download']);
    await RoleDefaultsRepo.remove(db, 'legacy-role' as Role);
  });

  it('POST /api/admin/roles 新角色默认矩阵 5 项，非法权限值被拒', async () => {
    const created = await request(ctx, '/api/admin/roles', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { role: 'editor' },
    });
    expect(created.status).toBe(200);
    const createdBody = await json<{ data: { permissions: string[] } }>(created);
    expect(createdBody.data.permissions).toEqual(MATRIX);

    const roles = await json<{ data: { roles: Array<{ role: string; permissions: string[] }> } }>(
      await request(ctx, '/api/admin/roles', { cookie: adminCookie })
    );
    const editor = roles.data.roles.find((r) => r.role === 'editor');
    expect(editor?.permissions).toEqual(MATRIX);

    const invalid = await request(ctx, '/api/admin/roles/editor/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { defaultPath: '/', maxStorage: 1073741824, maxFiles: 10000, permissions: ['read', 'admin'] },
    });
    expect(invalid.status).toBe(400);
    // share 不在矩阵内：不接受（避免与能力位 can_share 重复）
    const shareRejected = await request(ctx, '/api/admin/roles/editor/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { defaultPath: '/', maxStorage: 1073741824, maxFiles: 10000, permissions: ['read', 'share'] },
    });
    expect(shareRejected.status).toBe(400);
    expect(dbPermissions('editor')).toEqual(MATRIX);
  });
});

// ============ 6. 用户级默认权限（users.permissions） ============

describe('用户级默认权限（users.permissions）', () => {
  it('用户个别设置优先于角色默认，经 API 生效并回读', async () => {
    const { authCookie: ownerCookie } = await registerAndLogin(ctx, 'rp_up_owner');
    const fileId = await uploadFile(ownerCookie, '/', 'up.txt', 'up-content');
    const member = await registerAndLogin(ctx, 'rp_up_member');
    // 角色默认（user = 矩阵 5 项）下该用户本可 update/download 他人文件
    expect(await RoleDefaultsRepo.permissionsOf(db, 'user')).toEqual(MATRIX);

    const put = await request(ctx, `/api/admin/users/${member.userId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { permissions: ['read'] },
    });
    expect(put.status).toBe(200);
    expect(dbUserPermissions(member.userId)).toEqual(['read']);

    const memberCookie = await relogin('rp_up_member');
    const detail = await json<{ data: { permissions: string[] } }>(
      await request(ctx, `/api/files/${fileId}`, { cookie: memberCookie })
    );
    expect(detail.data.permissions).toContain('read');
    expect(detail.data.permissions).not.toContain('update');
    expect(detail.data.permissions).not.toContain('write');
    expect(detail.data.permissions).not.toContain('download');

    // 管理端用户列表每行返回 permissions（NULL = 跟随角色默认）
    const list = await json<{ data: { users: Array<{ id: string; permissions: string[] | null }> } }>(
      await request(ctx, '/api/admin/users?search=rp_up_member', { cookie: adminCookie })
    );
    expect(list.data.users.find((u) => u.id === member.userId)?.permissions).toEqual(['read']);

    // null = 清除个别设置，回到跟随角色默认
    const cleared = await request(ctx, `/api/admin/users/${member.userId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { permissions: null },
    });
    expect(cleared.status).toBe(200);
    expect(dbUserPermissions(member.userId)).toBeNull();
    const restored = await json<{ data: { permissions: string[] } }>(
      await request(ctx, `/api/files/${fileId}`, { cookie: memberCookie })
    );
    expect(restored.data.permissions).toContain('download');
  });

  it('保存角色默认设置即覆盖该角色下用户的个别设置', async () => {
    const member = await registerAndLogin(ctx, 'rp_ov_member');
    const put = await request(ctx, `/api/admin/users/${member.userId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { permissions: ['read'] },
    });
    expect(put.status).toBe(200);
    expect(dbUserPermissions(member.userId)).toEqual(['read']);

    const save = await request(ctx, '/api/admin/roles/user/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { defaultPath: '/', maxStorage: 1073741824, maxFiles: 10000, permissions: ['read', 'download'] },
    });
    expect(save.status).toBe(200);
    expect(dbUserPermissions(member.userId)).toEqual(['read', 'download']);

    // 还原角色默认，避免影响后续用例（同样会覆盖用户行）
    const restore = await request(ctx, '/api/admin/roles/user/defaults', {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { defaultPath: '/', maxStorage: 1073741824, maxFiles: 10000, permissions: MATRIX },
    });
    expect(restore.status).toBe(200);
    expect(dbPermissions('user')).toEqual(MATRIX);
  });

  it('share 不在权限矩阵内，分享流程仍沿用（能力位默认可分享）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'rp_share_owner');
    const fileId = await uploadFile(authCookie, '/', 'shareable.txt', 'share-content');
    const csrf = await getCsrf(ctx, authCookie);

    const created = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileIds: [fileId] },
    });
    expect(created.status).toBe(201);
    const body = await json<{ data: { share: { id: string } } }>(created);
    expect(body.data.share.id).toBeTruthy();

    // 矩阵不含 share，但默认路径内的 share 判定与能力位保持既有语义
    const principal: Principal = {
      type: 'user',
      id: 'share-user',
      role: 'user',
      defaultPath: '/share-user',
      defaultPermissions: ['read'],
    };
    expect(checkPermission(principal, mount, '/share-user/a.txt', 'share', [])).toBe('allow');
    expect(checkPermission(principal, mount, '/share-user/a.txt', 'download', [])).toBe('deny');
  });
});

// ============ 7. 规则主体角色别名 ============

describe('规则主体角色别名', () => {
  it('role=<alias> 的规则命中该角色用户，其他角色不命中', async () => {
    const created = await RoleDefaultsRepo.create(db, 'aliased' as Role, '别名角色');
    expect(created.permissions).toEqual(MATRIX);
    expect(created.alias).toBe('别名角色');

    const aliasRule = await RuleRepo.createRule(db, {
      pathPattern: '/alias-zone/x.txt',
      effect: 'deny',
      role: '别名角色' as Role,
      permissions: ['read'],
      requirePassword: false,
      priority: 0,
    });

    const member: Principal = {
      type: 'user',
      id: 'alias-member',
      role: 'aliased' as Role,
      defaultPath: '/',
      // 与 getPrincipal 装载一致：自定义角色的默认权限来自 role_defaults（新建角色 = 全 6 项）
      defaultPermissions: await RoleDefaultsRepo.permissionsOf(db, 'aliased' as Role),
    };
    expect(member.defaultPermissions).toEqual(MATRIX);
    const memberRules = await loadPrincipalRules(db, member);
    expect(memberRules.map((r) => r.id)).toContain(aliasRule.id);
    // 命中即生效：deny 压过第 8 步的角色默认放行；write 不在规则内 → 仍放行
    expect(checkPermission(member, mount, '/alias-zone/x.txt', 'read', memberRules)).toBe('deny');
    expect(checkPermission(member, mount, '/alias-zone/x.txt', 'write', memberRules)).toBe('allow');

    const outsider: Principal = {
      type: 'user',
      id: 'alias-outsider',
      role: 'user',
      defaultPath: '/',
      defaultPermissions: await RoleDefaultsRepo.permissionsOf(db, 'user'),
    };
    const outsiderRules = await loadPrincipalRules(db, outsider);
    expect(outsiderRules.map((r) => r.id)).not.toContain(aliasRule.id);
    // 其他角色的候选集不含该规则 → 只受自身角色默认影响，可读
    expect(checkPermission(outsider, mount, '/alias-zone/x.txt', 'read', outsiderRules)).toBe('allow');
  });
});
