// 挂载点级默认角色权限矩阵（§28）：仓库落库 → 引擎封闭集合判定 → 管理端 API 往返 → 端到端生效
// 语义：条目存在时在该挂载点内、无显式 path_rules 命中、且非文件属主时构成封闭集合
// （动作在条目内 → allow，不在 → deny）；无条目 → 回落角色默认权限矩阵（既有行为零变化）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { checkPermission, type PermissionResult } from '../src/services/permissions/check';
import { MountRolePermissionsRepo, Db, MountRepo, ProviderRepo } from '../src/db';
import type { Mount, PathRule, Permission, Principal } from '@shared/types';
import { PERMISSION_MATRIX } from '@shared/types';

const MATRIX: Permission[] = [...PERMISSION_MATRIX];

let ctx: TestContext;
let db: Db;
let adminCookie = '';
let adminCsrf = '';
let rootMountId = '';
/** 专供管理端往返用例的挂载点（避免 uploadMode 等副作用落到根挂载点上） */
let zoneMountId = '';

/** 引擎层固定夹具（纯判定用例用，不碰 DB） */
const mount: Mount = {
  id: 'm-matrix',
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

function userPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'u1',
    role: 'user',
    defaultPath: '/',
    defaultPermissions: MATRIX,
    ...overrides,
  };
}

function rule(overrides: Partial<PathRule>): PathRule {
  return {
    id: 'r1',
    pathPattern: '/**',
    effect: 'allow',
    permissions: MATRIX,
    requirePassword: false,
    priority: 0,
    origin: 'admin',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 引擎调用封装：只暴露本用例关心的入参（矩阵固定为末位可选参数） */
function judge(
  principal: Principal,
  path: string,
  action: Permission,
  rules: PathRule[] = [],
  ownerId?: string,
  matrix?: Map<string, Permission[]>
): PermissionResult {
  return checkPermission(principal, mount, path, action, rules, ownerId, undefined, undefined, undefined, matrix);
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  await registerAndLogin(ctx, 'mx_admin');
  ctx.db.exec("UPDATE users SET role = 'admin' WHERE username = 'mx_admin'");
  // 角色变更后需重新登录（JWT 与库内角色一致性校验）
  adminCookie = await relogin('mx_admin');
  adminCsrf = await getCsrf(ctx, adminCookie);

  rootMountId = (await MountRepo.listMounts(db)).find((m) => m.mountPath === '/')!.id;
  const providerId = (await ProviderRepo.listProviders(db))[0].id;
  const created = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { providerId, mountPath: '/mxzone', name: '矩阵专区分区' },
  });
  expect(created.status).toBe(201);
  zoneMountId = (await json<{ data: { mount: { id: string } } }>(created)).data.mount.id;
});

// ============ 辅助 ============

async function relogin(username: string, password = 'password123'): Promise<string> {
  const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username, password } });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return `auth_token=${token?.[1] ?? ''}`;
}

/** 矩阵走管理端 PATCH（§28 契约入口） */
function patchMountPermissions(
  mountId: string,
  rolePermissions: Array<{ role: string; permissions: string[] }>
): Promise<Response> {
  return request(ctx, `/api/admin/mounts/${mountId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { rolePermissions },
  });
}

async function mountRow(mountId: string): Promise<{ uploadMode: string; rolePermissions: Array<{ role: string; permissions: string[] }> }> {
  const res = await request(ctx, '/api/admin/mounts', { cookie: adminCookie });
  const data = await json<{
    data: { mounts: Array<{ id: string; uploadMode: string; rolePermissions: Array<{ role: string; permissions: string[] }> }> };
  }>(res);
  return data.data.mounts.find((m) => m.id === mountId)!;
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
  return (await json<{ data: { file: { id: string } } }>(complete)).data.file.id;
}

function deleteFile(cookie: string, fileId: string): Promise<Response> {
  return getCsrf(ctx, cookie).then((csrf) =>
    request(ctx, `/api/files/${fileId}`, { method: 'DELETE', cookie, headers: { 'X-CSRF-Token': csrf } })
  );
}

function fileExists(fileId: string): boolean {
  const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM file_metadata WHERE id = ?').get(fileId) as { c: number };
  return Number(row.c) > 0;
}

// ============ 1. 引擎判定（§28 封闭集合） ============

describe('权限引擎：挂载点级默认角色权限矩阵', () => {
  const alice = userPrincipal({ id: 'alice' });
  const readWrite: Map<string, Permission[]> = new Map([['user', ['read', 'write']]]);

  it('① 封闭集合：条目内动作放行，条目外动作拒绝', () => {
    expect(judge(alice, '/zone/a.txt', 'read', [], undefined, readWrite)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, readWrite)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'update', [], undefined, readWrite)).toBe('deny');
    expect(judge(alice, '/zone/a.txt', 'delete', [], undefined, readWrite)).toBe('deny');
    expect(judge(alice, '/zone/a.txt', 'download', [], undefined, readWrite)).toBe('deny');
  });

  it('② 无条目回落角色默认（与现状一致）；矩阵也不能越过用户根边界', () => {
    // 未传矩阵 / 空矩阵：第 9 步角色默认权限照旧（defaultPath 内全放行）
    for (const action of MATRIX) {
      expect(judge(alice, '/zone/a.txt', action)).toBe('allow');
      expect(judge(alice, '/zone/a.txt', action, [], undefined, new Map())).toBe('allow');
    }
    // 只有该角色的条目才介入：guest 条目不影响 user
    expect(judge(alice, '/zone/a.txt', 'delete', [], undefined, new Map([['guest', ['download']]]))).toBe('allow');
    // 第 3 步用户根边界是安全边界，先于矩阵：矩阵放行也救不回根路径外
    const bob = userPrincipal({ id: 'bob', defaultPath: '/bob' });
    expect(judge(bob, '/zone/a.txt', 'read', [], undefined, readWrite)).toBe('deny');
    // 存量挂载点（无矩阵条目）行为零变化
    const legacy = userPrincipal({ id: 'legacy' });
    expect(judge(legacy, '/zone/a.txt', 'delete')).toBe(judge(legacy, '/zone/a.txt', 'delete', [], undefined, new Map()));
  });

  it('③ 显式 path_rule 恒优先于矩阵（任何 origin）', () => {
    const allowDelete = rule({ pathPattern: '/zone/**', effect: 'allow', permissions: ['delete'] });
    expect(judge(alice, '/zone/a.txt', 'delete', [allowDelete], undefined, readWrite)).toBe('allow');

    const denyRead = rule({ id: 'r2', pathPattern: '/zone/a.txt', effect: 'deny', permissions: ['read'] });
    expect(judge(alice, '/zone/a.txt', 'read', [denyRead], undefined, readWrite)).toBe('deny');

    // 规则未命中该动作 = 第 6 步不产出结论 → 仍由矩阵兜底
    const allowWrite = rule({ id: 'r3', pathPattern: '/zone/**', effect: 'allow', permissions: ['write'] });
    expect(judge(alice, '/zone/a.txt', 'delete', [allowWrite], undefined, readWrite)).toBe('deny');
  });

  it('④ 文件属主短路（第 7 步）先于矩阵；矩阵仍约束属主的写动作', () => {
    // 属主自删：矩阵没写 delete 也放行（属主回退在第 7 步返回）
    expect(judge(alice, '/zone/a.txt', 'delete', [], 'alice', readWrite)).toBe('allow');
    // 写动作不在属主回退词表里 → 由矩阵决定（矩阵无 write 即拒绝，封闭集合不被属主身份放宽）
    expect(judge(alice, '/zone/a.txt', 'write', [], 'alice', new Map([['user', ['read']]]))).toBe('deny');
    // 非属主不受属主回退影响
    expect(judge(alice, '/zone/a.txt', 'delete', [], 'someone-else', readWrite)).toBe('deny');
  });

  it('⑤ share 不参与矩阵（整层跳过，交回既有语义）', () => {
    // 矩阵无 share：若参与矩阵即 deny，跳过则该用户默认路径内按既有语义放行
    expect(judge(alice, '/zone/a.txt', 'share', [], undefined, readWrite)).toBe('allow');
    // 矩阵里即使出现 share 也不决定 share（引擎对该动作根本不看矩阵）
    expect(judge(alice, '/zone/a.txt', 'share', [], undefined, new Map([['user', ['share']]]))).toBe('allow');
    // 跳过矩阵不等于放行一切：匿名访客没有第 9 步兜底，share 仍拒绝
    const anonymous: Principal = {
      type: 'guest',
      id: 'anonymous',
      role: 'guest',
      defaultPath: '/',
      capabilities: [],
      defaultPermissions: ['download'],
    };
    expect(judge(anonymous, '/zone/a.txt', 'share', [], undefined, new Map([['guest', ['share']]]))).toBe('deny');
  });
});

// ============ 2. 仓库：mount_role_permissions ============

describe('仓库：mount_role_permissions 落库与读取', () => {
  it('setForMount 全量替换 + 去重 + 过滤 share/非法值 + 单条空数组=删条目', async () => {
    await MountRolePermissionsRepo.setForMount(db, rootMountId, [
      { role: 'user', permissions: ['read', 'write', 'read', 'share', 'bogus'] },
      { role: 'guest', permissions: ['download'] },
    ]);
    expect(await MountRolePermissionsRepo.listByMount(db, rootMountId)).toEqual([
      { role: 'guest', permissions: ['download'] },
      { role: 'user', permissions: ['read', 'write'] },
    ]);
    // 列形态：逗号分隔的动作词表
    const rows = ctx.db
      .prepare('SELECT role, permissions FROM mount_role_permissions WHERE mount_id = ? ORDER BY role ASC')
      .all(rootMountId) as Array<{ role: string; permissions: string }>;
    expect(rows).toEqual([
      { role: 'guest', permissions: 'download' },
      { role: 'user', permissions: 'read,write' },
    ]);

    // 全量替换：只传 guest → user 条目被删除
    await MountRolePermissionsRepo.setForMount(db, rootMountId, [{ role: 'guest', permissions: ['read'] }]);
    expect(await MountRolePermissionsRepo.listByMount(db, rootMountId)).toEqual([{ role: 'guest', permissions: ['read'] }]);

    // 单条空数组（或仅剩 share） = 该条目不存在
    await MountRolePermissionsRepo.setForMount(db, rootMountId, [{ role: 'guest', permissions: [] }]);
    await MountRolePermissionsRepo.setForMount(db, rootMountId, [{ role: 'user', permissions: ['share'] }]);
    expect(await MountRolePermissionsRepo.listByMount(db, rootMountId)).toEqual([]);

    // 传 [] = 清空整个矩阵
    await MountRolePermissionsRepo.setForMount(db, rootMountId, [{ role: 'admin', permissions: ['read'] }]);
    await MountRolePermissionsRepo.setForMount(db, rootMountId, []);
    expect(await MountRolePermissionsRepo.listByMount(db, rootMountId)).toEqual([]);
  });

  it('getMatrix 只含有效条目；listByMounts 一次 IN 查询按挂载分组', async () => {
    await MountRolePermissionsRepo.setForMount(db, rootMountId, [{ role: 'user', permissions: ['read'] }]);
    await MountRolePermissionsRepo.setForMount(db, zoneMountId, [{ role: 'guest', permissions: ['download'] }]);

    const matrix = await MountRolePermissionsRepo.getMatrix(db, rootMountId);
    expect([...matrix.keys()]).toEqual(['user']);
    expect(matrix.get('user')).toEqual(['read']);
    expect((await MountRolePermissionsRepo.getMatrix(db, zoneMountId)).get('guest')).toEqual(['download']);
    // 无条目的挂载点 = 空 Map（引擎据此回落第 9 步）
    expect((await MountRolePermissionsRepo.getMatrix(db, 'no-such-mount')).size).toBe(0);

    const grouped = await MountRolePermissionsRepo.listByMounts(db, [rootMountId, zoneMountId, 'no-such-mount']);
    expect(grouped.get(rootMountId)).toEqual([{ role: 'user', permissions: ['read'] }]);
    expect(grouped.get(zoneMountId)).toEqual([{ role: 'guest', permissions: ['download'] }]);
    expect(grouped.has('no-such-mount')).toBe(false);
    expect((await MountRolePermissionsRepo.listByMounts(db, [])).size).toBe(0);

    await MountRolePermissionsRepo.setForMount(db, rootMountId, []);
    await MountRolePermissionsRepo.setForMount(db, zoneMountId, []);
  });

  it('非法 role 抛 400 且整批不落库（事务前校验）', async () => {
    await expect(
      MountRolePermissionsRepo.setForMount(db, rootMountId, [{ role: 'editor', permissions: ['read'] }])
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

    // 合法条目在前、非法条目在后：校验先于事务，前者也不得写入
    await expect(
      MountRolePermissionsRepo.setForMount(db, rootMountId, [
        { role: 'user', permissions: ['read'] },
        { role: 'editor', permissions: ['read'] },
      ])
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await MountRolePermissionsRepo.listByMount(db, rootMountId)).toEqual([]);
  });
});

// ============ 3. 管理端 API 往返 ============

describe('管理端挂载点 API：uploadMode 与 rolePermissions', () => {
  it('PATCH 全量替换 / 缺省不改 / [] 清空 / GET 回读一致', async () => {
    const seed = await patchMountPermissions(zoneMountId, [
      { role: 'user', permissions: ['read', 'write', 'read'] },
      { role: 'guest', permissions: ['download'] },
    ]);
    expect(seed.status).toBe(200);
    expect((await mountRow(zoneMountId)).rolePermissions).toEqual([
      { role: 'guest', permissions: ['download'] },
      { role: 'user', permissions: ['read', 'write'] },
    ]);

    // 全量替换：只传 guest → user 条目消失；同时改 uploadMode
    const replaced = await request(ctx, `/api/admin/mounts/${zoneMountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { uploadMode: 'user_space', rolePermissions: [{ role: 'guest', permissions: ['read'] }] },
    });
    expect(replaced.status).toBe(200);
    let row = await mountRow(zoneMountId);
    expect(row.rolePermissions).toEqual([{ role: 'guest', permissions: ['read'] }]);
    expect(row.uploadMode).toBe('user_space');

    // 缺省字段不改：只传 rolePermissions 时 uploadMode 保持
    expect((await patchMountPermissions(zoneMountId, [{ role: 'user', permissions: ['download'] }])).status).toBe(200);
    row = await mountRow(zoneMountId);
    expect(row.uploadMode).toBe('user_space');
    expect(row.rolePermissions).toEqual([{ role: 'user', permissions: ['download'] }]);

    // 单条空数组 = 删除该角色条目
    expect((await patchMountPermissions(zoneMountId, [{ role: 'user', permissions: [] }])).status).toBe(200);
    expect((await mountRow(zoneMountId)).rolePermissions).toEqual([]);

    // 传 [] = 清空矩阵（全量替换语义）
    await MountRolePermissionsRepo.setForMount(db, zoneMountId, [{ role: 'admin', permissions: ['read'] }]);
    expect((await patchMountPermissions(zoneMountId, [])).status).toBe(200);
    expect((await mountRow(zoneMountId)).rolePermissions).toEqual([]);
    // 清空后 DB 也真的没有行（不是只读层过滤）
    expect(await MountRolePermissionsRepo.listByMount(db, zoneMountId)).toEqual([]);
  });

  it('POST 创建挂载点即接受 uploadMode 与 rolePermissions', async () => {
    const providerId = (await ProviderRepo.listProviders(db))[0].id;
    const created = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        providerId,
        mountPath: '/mxzone2',
        name: '矩阵专区分区二',
        uploadMode: 'flat',
        rolePermissions: [{ role: 'guest', permissions: ['read', 'download'] }],
      },
    });
    expect(created.status).toBe(201);
    const body = await json<{ data: { mount: { id: string; uploadMode: string }; rolePermissions: Array<{ role: string; permissions: string[] }> } }>(created);
    expect(body.data.mount.uploadMode).toBe('flat');
    expect(body.data.rolePermissions).toEqual([{ role: 'guest', permissions: ['read', 'download'] }]);
    expect((await mountRow(body.data.mount.id)).rolePermissions).toEqual([{ role: 'guest', permissions: ['read', 'download'] }]);
    // 缺省 uploadMode = free（列默认值），rolePermissions 缺省 = 空矩阵
    expect((await mountRow(rootMountId)).uploadMode).toBe('free');
  });

  it('非法入参一律 400：角色白名单 / 矩阵词表（share 与未知动作）/ uploadMode 枚举', async () => {
    expect((await patchMountPermissions(zoneMountId, [{ role: 'editor', permissions: ['read'] }])).status).toBe(400);
    expect((await patchMountPermissions(zoneMountId, [{ role: 'user', permissions: ['read', 'share'] }])).status).toBe(400);
    expect((await patchMountPermissions(zoneMountId, [{ role: 'user', permissions: ['read', 'admin'] }])).status).toBe(400);
    expect(
      (
        await request(ctx, `/api/admin/mounts/${zoneMountId}`, {
          method: 'PATCH',
          cookie: adminCookie,
          headers: { 'X-CSRF-Token': adminCsrf },
          body: { uploadMode: 'user-space' },
        })
      ).status
    ).toBe(400);
    // 校验失败不得留下半截写入
    expect((await mountRow(zoneMountId)).rolePermissions).toEqual([]);
  });
});

// ============ 4. 端到端：矩阵经权限管道生效 ============

describe('端到端：矩阵在权限管道中生效', () => {
  it('① 封闭集合：矩阵内放行、矩阵外拒绝；清空后回落角色默认', async () => {
    expect((await patchMountPermissions(rootMountId, [{ role: 'user', permissions: ['read', 'write'] }])).status).toBe(200);
    const alice = await registerAndLogin(ctx, 'mx_alice');
    const bob = await registerAndLogin(ctx, 'mx_bob');
    const fileId = await uploadFile(alice.authCookie, '/', 'mx-closed.txt', 'closed');

    // read 在矩阵内 → 非属主也能读
    expect((await request(ctx, `/api/files/${fileId}`, { cookie: bob.authCookie })).status).toBe(200);
    // delete 不在矩阵内 → 拒绝，文件仍在
    expect((await deleteFile(bob.authCookie, fileId)).status).toBe(403);
    expect(fileExists(fileId)).toBe(true);

    // 清空矩阵 → 回落第 9 步角色默认权限（既有行为：defaultPath='/' 内放行 delete）
    expect((await patchMountPermissions(rootMountId, [])).status).toBe(200);
    expect((await deleteFile(bob.authCookie, fileId)).status).toBe(200);
    expect(fileExists(fileId)).toBe(false);
  });

  it('④ 文件属主短路优先于矩阵 deny（属主仍可删自己的文件）', async () => {
    expect((await patchMountPermissions(rootMountId, [{ role: 'user', permissions: ['read', 'write'] }])).status).toBe(200);
    const owner = await registerAndLogin(ctx, 'mx_owner');
    const fileId = await uploadFile(owner.authCookie, '/', 'mx-owner.txt', 'mine');
    // 收紧矩阵：无 delete（也无 write）
    expect((await patchMountPermissions(rootMountId, [{ role: 'user', permissions: ['read'] }])).status).toBe(200);

    expect((await deleteFile(owner.authCookie, fileId)).status).toBe(200);
    expect(fileExists(fileId)).toBe(false);
  });

  it('⑤ share 不受矩阵影响（矩阵无 share 仍可分享；同矩阵下 delete 仍被拒）', async () => {
    expect((await patchMountPermissions(rootMountId, [{ role: 'user', permissions: ['read', 'write'] }])).status).toBe(200);
    const owner = await registerAndLogin(ctx, 'mx_share_owner');
    const fileId = await uploadFile(owner.authCookie, '/', 'mx-share.txt', 'share-me');
    expect((await patchMountPermissions(rootMountId, [{ role: 'user', permissions: ['read'] }])).status).toBe(200);

    const other = await registerAndLogin(ctx, 'mx_sharer');
    const csrf = await getCsrf(ctx, other.authCookie);
    const created = await request(ctx, '/api/shares', {
      method: 'POST',
      cookie: other.authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { fileIds: [fileId] },
    });
    expect(created.status).toBe(201);
    // 对照：同一矩阵下矩阵确实在生效（delete 不在条目内 → 拒绝）
    expect((await deleteFile(other.authCookie, fileId)).status).toBe(403);
  });

  it('③ 显式 path_rule 压过矩阵（规则 allow → 矩阵的 deny 不生效）', async () => {
    expect((await patchMountPermissions(rootMountId, [{ role: 'user', permissions: ['read', 'write'] }])).status).toBe(200);
    const owner = await registerAndLogin(ctx, 'mx_rule_owner');
    const csrf = await getCsrf(ctx, owner.authCookie);
    const folder = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: owner.authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: 'mxrule' },
    });
    expect(folder.status).toBe(201);
    const fileId = await uploadFile(owner.authCookie, '/mxrule', 'doc.txt', 'ruled');

    const other = await registerAndLogin(ctx, 'mx_rule_other');
    // 矩阵（user = read+write）无 delete → 先确认拒绝
    expect((await deleteFile(other.authCookie, fileId)).status).toBe(403);

    // 显式规则（admin origin、role=user、allow delete）覆盖矩阵
    const ruleRes = await request(ctx, '/api/admin/rules', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { pathPattern: '/mxrule', effect: 'allow', role: 'user', permissions: ['delete'] },
    });
    expect(ruleRes.status).toBe(201);
    const ruleId = (await json<{ data: { rule: { id: string } } }>(ruleRes)).data.rule.id;
    expect((await deleteFile(other.authCookie, fileId)).status).toBe(200);

    // 清理规则，避免影响后续用例
    expect(
      (
        await request(ctx, `/api/admin/rules/${ruleId}`, {
          method: 'DELETE',
          cookie: adminCookie,
          headers: { 'X-CSRF-Token': adminCsrf },
        })
      ).status
    ).toBe(200);
  });
});

// ============ 5. 端到端：公开浏览入口同样受矩阵约束 ============

describe('端到端：公开浏览入口（/api/public/fs）按 guest 条目判定', () => {
  it('无矩阵=现状拒绝；矩阵给 guest read/download 即可匿名列目录；条目缺 read 收紧、缺 download 逐项过滤', async () => {
    const settings = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { allowGuestAccess: true },
    });
    expect(settings.status).toBe(200);

    const owner = await registerAndLogin(ctx, 'mx_pub_owner');
    const csrf = await getCsrf(ctx, owner.authCookie);
    const folder = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: owner.authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: 'mxpub' },
    });
    expect(folder.status).toBe(201);
    await uploadFile(owner.authCookie, '/mxpub', 'pub.txt', 'public-bytes');

    // 现状（无矩阵、无 guest 规则、目录未设 guest_visibility）：匿名列目录被拒
    expect((await patchMountPermissions(rootMountId, [])).status).toBe(200);
    expect((await request(ctx, '/api/public/fs?path=/mxpub')).status).toBe(403);

    // 矩阵给 guest read+download → 匿名可列目录，且文件逐项放行（附可读直链）
    expect(
      (await patchMountPermissions(rootMountId, [{ role: 'guest', permissions: ['read', 'download'] }])).status
    ).toBe(200);
    const listed = await request(ctx, '/api/public/fs?path=/mxpub');
    expect(listed.status).toBe(200);
    const items = (await json<{ data: { items: Array<{ name: string; url: string | null }> } }>(listed)).data.items;
    expect(items.map((i) => i.name)).toEqual(['pub.txt']);
    expect(items[0].url).toBeTruthy();

    // 条目缺 read：目录本身落在封闭集合外 → 拒绝（收紧）
    expect((await patchMountPermissions(rootMountId, [{ role: 'guest', permissions: ['download'] }])).status).toBe(200);
    expect((await request(ctx, '/api/public/fs?path=/mxpub')).status).toBe(403);

    // 条目缺 download：目录可列，但文件被逐项过滤掉
    expect((await patchMountPermissions(rootMountId, [{ role: 'guest', permissions: ['read'] }])).status).toBe(200);
    const filtered = await request(ctx, '/api/public/fs?path=/mxpub');
    expect(filtered.status).toBe(200);
    expect((await json<{ data: { items: Array<{ name: string }> } }>(filtered)).data.items).toEqual([]);

    // 清空矩阵 → 回到现状（匿名拒绝），登录用户路径不受影响
    expect((await patchMountPermissions(rootMountId, [])).status).toBe(200);
    expect((await request(ctx, '/api/public/fs?path=/mxpub')).status).toBe(403);
    expect((await request(ctx, '/api/files?path=/mxpub', { cookie: owner.authCookie })).status).toBe(200);
  });
});
