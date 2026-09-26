// 桶级默认角色权限矩阵（§31）：引擎判定优先级（桶级 → 挂载点级 → 角色默认）、
// 仓库落库/读取、读路径按文件实际落桶判定、写路径候选桶过滤（跳过 → 全部被拒 403）。
// 语义：桶级条目（mount+provider+role）存在时构成该桶内该角色的封闭集合；无条目 → 回落挂载点级
// （§28），两层都无 → 角色默认权限（存量行为零变化）。
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext,
  initSeeded,
  request,
  json,
  registerAndLogin,
  getCsrf,
  grantApiKeyRule,
  type TestContext,
} from './helpers';
import { checkPermission, type PermissionResult } from '../src/services/permissions/check';
import { MountProviderRolePermissionsRepo, Db, ProviderRepo } from '../src/db';
import type { Mount, PathRule, Permission, Principal } from '@shared/types';
import { PERMISSION_MATRIX } from '@shared/types';

const MATRIX: Permission[] = [...PERMISSION_MATRIX];

let ctx: TestContext;
let db: Db;
let adminCookie = '';
let adminCsrf = '';

/** 引擎层固定夹具（纯判定用例用，不碰 DB） */
const mount: Mount = {
  id: 'm-bucket',
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

const EMPTY: Map<string, Permission[]> = new Map();

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

/** 引擎调用封装：桶级入参（providerId / bucketMatrix）固定为末两位可选参数 */
function judge(
  principal: Principal,
  path: string,
  action: Permission,
  rules: PathRule[] = [],
  ownerId?: string,
  mountMatrix?: Map<string, Permission[]>,
  providerId?: string,
  bucketMatrix?: Map<string, Permission[]>
): PermissionResult {
  return checkPermission(
    principal,
    mount,
    path,
    action,
    rules,
    ownerId,
    undefined,
    undefined,
    undefined,
    mountMatrix,
    providerId,
    bucketMatrix
  );
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  await registerAndLogin(ctx, 'bm_admin');
  ctx.db.exec("UPDATE users SET role = 'admin' WHERE username = 'bm_admin'");
  const res = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'bm_admin', password: 'password123' },
  });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${token?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'bucket-matrix' },
  });
  expect(res.status).toBe(201);
  const body = await json<{ data: { provider: { id: string } } }>(res);
  return body.data.provider.id;
}

interface MemberInput {
  providerId: string;
  weight?: number;
  capacityBytes?: number | null;
  sortOrder?: number;
  standby?: boolean;
  rolePermissions?: Array<{ role: string; permissions: string[] }>;
}

async function createMount(body: Record<string, unknown>): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { priority: 400, ...body },
  });
  expect(res.status).toBe(201);
  const created = await json<{ data: { mount: { id: string } } }>(res);
  return created.data.mount.id;
}

function patchMount(mountId: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/mounts/${mountId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

/** 仅建上传会话（不落盘）：用于断言选桶失败等入口行为 */
async function initUploadSession(cookie: string, dir: string, fileName: string, content = 'init'): Promise<Response> {
  const csrf = await getCsrf(ctx, cookie);
  return request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: new TextEncoder().encode(content).byteLength, mimeType: 'text/plain' },
  });
}

async function uploadFile(
  cookie: string,
  dir: string,
  fileName: string,
  content: string
): Promise<{ fileId: string; providerId: string | null }> {
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
  await request(ctx, `/api/files/upload/raw/${init.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: init.data.sessionId, etag: 'etag' },
  });
  const complete = await json<{ data: { file: { id: string } } }>(completeRes);
  const fileId = complete.data.file.id;
  const row = ctx.db.prepare('SELECT provider_id FROM file_metadata WHERE id = ?').get(fileId) as {
    provider_id: string | null;
  };
  return { fileId, providerId: row.provider_id };
}

function getFile(cookie: string, fileId: string): Promise<Response> {
  return request(ctx, `/api/files/${fileId}`, { cookie });
}

async function mountRow(mountId: string): Promise<{
  maxStorage: number | null;
  poolMembers: Array<{
    providerId: string;
    standby: boolean;
    rolePermissions: Array<{ role: string; permissions: string[] }>;
  }>;
}> {
  const res = await request(ctx, '/api/admin/mounts', { cookie: adminCookie });
  const data = await json<{
    data: {
      mounts: Array<{
        id: string;
        maxStorage: number | null;
        poolMembers: Array<{
          providerId: string;
          standby: boolean;
          rolePermissions: Array<{ role: string; permissions: string[] }>;
        }>;
      }>;
    };
  }>(res);
  return data.data.mounts.find((m) => m.id === mountId)!;
}

// ============ 1. 引擎判定优先级（§31：桶级 → 挂载点级 → 角色默认） ============

describe('权限引擎：桶级默认角色权限矩阵', () => {
  const alice = userPrincipal({ id: 'alice' });

  it('① 桶级条目优先于挂载点级：封闭集合可收紧，也可比挂载点级更宽', () => {
    const mountAll: Map<string, Permission[]> = new Map([['user', MATRIX]]);
    const mountReadOnly: Map<string, Permission[]> = new Map([['user', ['read']]]);
    const bucketReadOnly: Map<string, Permission[]> = new Map([['user', ['read']]]);
    const bucketReadWrite: Map<string, Permission[]> = new Map([['user', ['read', 'write']]]);

    // 收紧：挂载点级全开，桶级只给 read → 条目外动作一律 deny
    expect(judge(alice, '/zone/a.txt', 'read', [], undefined, mountAll, 'p1', bucketReadOnly)).toBe('allow');
    for (const action of ['write', 'update', 'delete', 'download'] as const) {
      expect(judge(alice, '/zone/a.txt', action, [], undefined, mountAll, 'p1', bucketReadOnly)).toBe('deny');
    }
    // 放宽：挂载点级只给 read，桶级给 read+write → 桶级胜出（优先级更高，不是取交集）
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, mountReadOnly, 'p1', bucketReadWrite)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, mountReadOnly, undefined, undefined)).toBe('deny');

    // 只对「同一桶」生效：换一个桶（p2 无条目）→ 回落挂载点级
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, mountReadOnly, 'p2', EMPTY)).toBe('deny');
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, mountAll, 'p2', EMPTY)).toBe('allow');

    // share 不参与矩阵：桶级条目没写 share 也不影响 share（整层跳过，交既有语义）
    expect(judge(alice, '/zone/a.txt', 'share', [], undefined, mountAll, 'p1', bucketReadOnly)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'share', [], undefined, undefined, 'p1', bucketReadOnly)).toBe('allow');

    // 显式 path_rule 恒优先于桶级矩阵（任何 origin）
    const denyRead = rule({ pathPattern: '/zone/a.txt', effect: 'deny', permissions: ['read'] });
    expect(judge(alice, '/zone/a.txt', 'read', [denyRead], undefined, mountAll, 'p1', bucketReadWrite)).toBe('deny');
    // 属主回退（第 6 步）先于桶级矩阵；写动作不在属主词表内 → 仍由桶级矩阵决定
    expect(judge(alice, '/zone/a.txt', 'delete', [], 'alice', mountAll, 'p1', bucketReadOnly)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'write', [], 'alice', mountAll, 'p1', bucketReadOnly)).toBe('deny');
  });

  it('② 无桶级条目回落挂载点级（含「桶级只有别的角色」）', () => {
    const mountReadOnly: Map<string, Permission[]> = new Map([['user', ['read']]]);
    const otherRoleOnly: Map<string, Permission[]> = new Map([['guest', ['download']]]);

    // 传了落桶但该桶没有 user 条目 → 挂载点级 user 条目照旧生效
    expect(judge(alice, '/zone/a.txt', 'read', [], undefined, mountReadOnly, 'p1', otherRoleOnly)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, mountReadOnly, 'p1', otherRoleOnly)).toBe('deny');
    // 空桶级矩阵（该桶一条都没有）→ 同上
    expect(judge(alice, '/zone/a.txt', 'read', [], undefined, mountReadOnly, 'p1', EMPTY)).toBe('allow');
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, mountReadOnly, 'p1', EMPTY)).toBe('deny');
  });

  it('③ 两层都无 = 现行为（角色默认权限），未传落桶时桶级矩阵不介入', () => {
    for (const action of MATRIX) {
      // providerId 传入 + 该桶无条目 / 完全不传 providerId：结果一致（角色默认内全放行）
      expect(judge(alice, '/zone/a.txt', action, [], undefined, undefined, 'p1', EMPTY)).toBe(
        judge(alice, '/zone/a.txt', action)
      );
      expect(judge(alice, '/zone/a.txt', action, [], undefined, EMPTY, 'p1', EMPTY)).toBe('allow');
    }
    // 未传 providerId：即使调用方塞了桶级矩阵也不介入（存量调用点行为零变化）
    const bucketReadOnly: Map<string, Permission[]> = new Map([['user', ['read']]]);
    expect(judge(alice, '/zone/a.txt', 'write', [], undefined, undefined, undefined, bucketReadOnly)).toBe('allow');
    // 用户根边界仍先于桶级矩阵：矩阵放行也救不回根路径外
    const bob = userPrincipal({ id: 'bob', defaultPath: '/bob' });
    expect(judge(bob, '/zone/a.txt', 'read', [], undefined, undefined, 'p1', bucketReadOnly)).toBe('deny');
  });
});

// ============ 2. 仓库：mount_provider_role_permissions ============

/** 仓库按 provider_id 升序返回，而 provider_id 是随机 UUID → 断言前按稳定键排序（顺序本身已有引擎无关的覆盖测试） */
function sortedEntries<T extends { providerId: string; role: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.role.localeCompare(b.role));
}

describe('仓库：桶级矩阵落库与读取', () => {
  let repoMountId = '';
  let repoProviderA = '';
  let repoProviderB = '';

  beforeAll(async () => {
    repoProviderA = await createProvider('bm-repo-a');
    repoProviderB = await createProvider('bm-repo-b');
    repoMountId = await createMount({
      providerId: repoProviderA,
      mountPath: '/bm-repo',
      name: '桶级矩阵仓库用例',
      poolMembers: [{ providerId: repoProviderA }, { providerId: repoProviderB }],
    });
  });

  it('setForMount 按 (挂载点, 桶) 全量替换 + 去重 + 过滤 share/非法值', async () => {
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderA, [
      { role: 'user', permissions: ['read', 'write', 'read', 'share', 'bogus'] },
      { role: 'guest', permissions: ['download'] },
    ]);
    const listedA = await MountProviderRolePermissionsRepo.listByMount(db, repoMountId);
    expect(sortedEntries(listedA)).toEqual([
      { providerId: repoProviderA, role: 'guest', permissions: ['download'] },
      { providerId: repoProviderA, role: 'user', permissions: ['read', 'write'] },
    ]);
    // 同一桶内 role 升序（guest < user）是契约的一部分：provider_id 相同时按 role 稳定
    expect(listedA.map((e) => e.role)).toEqual(['guest', 'user']);

    // 另一个桶独立（同挂载点的桶级条目互不影响）
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderB, [
      { role: 'user', permissions: ['read'] },
    ]);
    expect((await MountProviderRolePermissionsRepo.getMatrix(db, repoMountId, repoProviderA)).get('user')).toEqual([
      'read',
      'write',
    ]);
    expect((await MountProviderRolePermissionsRepo.getMatrix(db, repoMountId, repoProviderB)).get('user')).toEqual([
      'read',
    ]);

    // 全量替换：只传 guest → 该桶 user 条目被删除，另一桶的条目不受影响（各桶按自己的键）
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderA, [
      { role: 'guest', permissions: ['read'] },
    ]);
    expect(sortedEntries(await MountProviderRolePermissionsRepo.listByMount(db, repoMountId))).toEqual(
      sortedEntries([
        { providerId: repoProviderA, role: 'guest', permissions: ['read'] },
        { providerId: repoProviderB, role: 'user', permissions: ['read'] },
      ])
    );

    // 空词表（permissions=[]）与只剩 share/非法值 = 该条目不存在；传 [] = 清空该桶矩阵
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderA, [
      { role: 'guest', permissions: [] },
      { role: 'user', permissions: ['share'] },
    ]);
    expect((await MountProviderRolePermissionsRepo.getMatrix(db, repoMountId, repoProviderA)).size).toBe(0);
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderB, []);
    expect(await MountProviderRolePermissionsRepo.listByMount(db, repoMountId)).toEqual([]);
    // 无条目的桶 = 空 Map（引擎据此回落挂载点级）
    expect((await MountProviderRolePermissionsRepo.getMatrix(db, repoMountId, 'no-such-provider')).size).toBe(0);
    expect((await MountProviderRolePermissionsRepo.listByMounts(db, [])).size).toBe(0);
  });

  it('listByMounts 一次 IN 查询按挂载点分组；非法 role 抛 400 且整批不落库', async () => {
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderA, [
      { role: 'user', permissions: ['read', 'download'] },
    ]);
    const grouped = await MountProviderRolePermissionsRepo.listByMounts(db, [repoMountId, 'no-such-mount']);
    expect(grouped.get(repoMountId)).toEqual([
      { providerId: repoProviderA, role: 'user', permissions: ['read', 'download'] },
    ]);
    expect(grouped.has('no-such-mount')).toBe(false);

    await expect(
      MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderA, [
        { role: 'editor', permissions: ['read'] },
      ])
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    // 校验先于事务：原条目未被清空
    expect(await MountProviderRolePermissionsRepo.listByMount(db, repoMountId)).toEqual([
      { providerId: repoProviderA, role: 'user', permissions: ['read', 'download'] },
    ]);
    await MountProviderRolePermissionsRepo.setForMount(db, repoMountId, repoProviderA, []);
  });
});

// ============ 3. 读路径：按文件实际落桶判定 ============

describe('读路径：同一挂载点两个桶、不同矩阵', () => {
  it('④ 同一用户对 A 桶文件可读、对 B 桶文件 403', async () => {
    const providerA = await createProvider('bm-read-a');
    const providerB = await createProvider('bm-read-b');
    // ordered：A 容量恰好等于首文件大小 → 首个文件落 A；写满后第二个文件回退 B
    const mountId = await createMount({
      providerId: providerA,
      mountPath: '/bm-read',
      name: '桶级读判定',
      poolStrategy: 'ordered',
      poolMembers: [
        { providerId: providerA, sortOrder: 0, capacityBytes: 3 },
        { providerId: providerB, sortOrder: 1, capacityBytes: null },
      ],
    });

    const inA = await uploadFile(adminCookie, '/bm-read', 'a.txt', 'aaa');
    const inB = await uploadFile(adminCookie, '/bm-read', 'b.txt', 'bbbb');
    expect(inA.providerId).toBe(providerA);
    expect(inB.providerId).toBe(providerB);

    const { authCookie } = await registerAndLogin(ctx, 'bm_reader');
    // 未配置桶级矩阵：角色默认权限内可读（200）——既有行为
    expect((await getFile(authCookie, inA.fileId)).status).toBe(200);
    expect((await getFile(authCookie, inB.fileId)).status).toBe(200);

    // 桶级矩阵：A 给 user read+download（条目内 → allow）；B 只给 user download（条目内无 read → deny）
    const patch = await patchMount(mountId, {
      poolMembers: [
        {
          providerId: providerA,
          sortOrder: 0,
          capacityBytes: 3,
          rolePermissions: [{ role: 'user', permissions: ['read', 'download'] }],
        },
        { providerId: providerB, sortOrder: 1, rolePermissions: [{ role: 'user', permissions: ['download'] }] },
      ] as MemberInput[],
    });
    expect(patch.status).toBe(200);

    // 管理端回显：桶级矩阵随 (挂载点, 桶) 落在对应池成员上
    const rows = await mountRow(mountId);
    const byId = Object.fromEntries(rows.poolMembers.map((m) => [m.providerId, m]));
    expect(byId[providerA].rolePermissions).toEqual([{ role: 'user', permissions: ['read', 'download'] }]);
    expect(byId[providerB].rolePermissions).toEqual([{ role: 'user', permissions: ['download'] }]);

    // 读路径按文件实际落桶判定：A 桶文件 read 200；B 桶文件条目内没有 read → 403
    const readA = await getFile(authCookie, inA.fileId);
    expect(readA.status).toBe(200);
    const readB = await getFile(authCookie, inB.fileId);
    expect(readB.status).toBe(403);
    const readBBody = await json<{ error: { code: string } }>(readB);
    expect(readBBody.error.code).toBe('FORBIDDEN');

    // 下载动作同样按落桶判定：A 条目含 download → 200；B 条目含 download → 200（read 被拒不等于 download 被拒）
    const csrf = await getCsrf(ctx, authCookie);
    const dlA = await request(ctx, `/api/files/${inA.fileId}/download`, {
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(dlA.status).toBe(200);
    const dlB = await request(ctx, `/api/files/${inB.fileId}/download`, {
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(dlB.status).toBe(200);

    // B 桶条目收紧为只给 read → read 放行、download 拒绝（封闭集合双向可验证）
    const patchB = await patchMount(mountId, {
      poolMembers: [
        { providerId: providerA, sortOrder: 0, capacityBytes: 3 },
        { providerId: providerB, sortOrder: 1, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
      ] as MemberInput[],
    });
    expect(patchB.status).toBe(200);
    expect((await getFile(authCookie, inB.fileId)).status).toBe(200);
    const dlB2 = await request(ctx, `/api/files/${inB.fileId}/download`, {
      cookie: authCookie,
      headers: { 'X-CSRF-Token': await getCsrf(ctx, authCookie) },
    });
    expect(dlB2.status).toBe(403);
  });
});

// ============ 4. 写路径：候选桶矩阵不含 write → 跳过；全部跳过 → 403 ============

describe('写路径：候选桶按桶级矩阵过滤', () => {
  it('⑤ 首选桶不含 write → 落到下一个候选；全部候选都被拒 → 403', async () => {
    const providerA = await createProvider('bm-write-a');
    const providerB = await createProvider('bm-write-b');
    const mountId = await createMount({
      providerId: providerA,
      mountPath: '/bm-write',
      name: '桶级写判定',
      poolStrategy: 'ordered',
      poolMembers: [
        { providerId: providerA, sortOrder: 0 },
        { providerId: providerB, sortOrder: 1 },
      ],
    });

    const { authCookie } = await registerAndLogin(ctx, 'bm_writer');

    // A 桶（策略首选）对 user 明确不给 write，B 桶无条目 → 跳过 A，落 B
    const patch = await patchMount(mountId, {
      poolMembers: [
        { providerId: providerA, sortOrder: 0, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
        { providerId: providerB, sortOrder: 1 },
      ] as MemberInput[],
    });
    expect(patch.status).toBe(200);

    const uploaded = await uploadFile(authCookie, '/bm-write', 'w.txt', 'write-a');
    expect(uploaded.providerId).toBe(providerB);
    const filesInA = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND provider_id = ? AND type = 'file'`)
      .get(mountId, providerA) as { c: number };
    expect(Number(filesInA.c)).toBe(0);

    // 两个候选桶都对 user 明确不给 write → 全部候选被跳过 → 403（不是 413）
    const patchBoth = await patchMount(mountId, {
      poolMembers: [
        { providerId: providerA, sortOrder: 0, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
        { providerId: providerB, sortOrder: 1, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
      ] as MemberInput[],
    });
    expect(patchBoth.status).toBe(200);

    const rejected = await initUploadSession(authCookie, '/bm-write', 'blocked.txt');
    expect(rejected.status).toBe(403);
    const body = await json<{ error: { code: string; message: string } }>(rejected);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('当前存储桶的角色权限不允许此操作');

    // 预留不残留：上面的 403 发生在池成员预留之前，用户/挂载两道预留必须已补偿归零
    const mountQuota = ctx.db.prepare('SELECT quota_reserved FROM mounts WHERE id = ?').get(mountId) as {
      quota_reserved: number;
    };
    expect(Number(mountQuota.quota_reserved)).toBe(0);
    const memberQuotas = ctx.db
      .prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ quota_reserved: number }>;
    expect(memberQuotas.map((m) => Number(m.quota_reserved))).toEqual([0, 0]);

    // 恢复 B 桶的写权限后写入照常（桶级条目是唯一原因）
    const patchBack = await patchMount(mountId, {
      poolMembers: [
        { providerId: providerA, sortOrder: 0, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
        { providerId: providerB, sortOrder: 1, rolePermissions: [{ role: 'user', permissions: ['read', 'write'] }] },
      ] as MemberInput[],
    });
    expect(patchBack.status).toBe(200);
    expect((await uploadFile(authCookie, '/bm-write', 'w2.txt', 'write-b')).providerId).toBe(providerB);
  });

  it('写路径覆盖写：原落桶被桶级矩阵拒绝 → 按策略换桶（不回落到被拒桶）', async () => {
    const providerA = await createProvider('bm-ow-a');
    const providerB = await createProvider('bm-ow-b');
    const mountId = await createMount({
      providerId: providerA,
      mountPath: '/bm-ow',
      name: '桶级覆盖写判定',
      poolStrategy: 'ordered',
      poolMembers: [
        { providerId: providerA, sortOrder: 0 },
        { providerId: providerB, sortOrder: 1 },
      ],
    });
    const { authCookie } = await registerAndLogin(ctx, 'bm_overwriter');
    // 覆盖写要落在原有文件行上 → 走统一写入路径（WebDAV PUT），与 storage-pool 用例同款
    const csrf = await getCsrf(ctx, authCookie);
    const keyRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'bm-ow', permissions: ['write', 'read'], protocols: ['webdav'], uploadPath: '/' },
    });
    expect(keyRes.status).toBe(201);
    const keyData = await json<{ data: { key: { keyId: string; secret: string } } }>(keyRes);
    await grantApiKeyRule(ctx, keyData.data.key.keyId, ['write', 'read'], '/');
    const davAuth = {
      Authorization: `Basic ${Buffer.from(`${keyData.data.key.keyId}:${keyData.data.key.secret}`).toString('base64')}`,
    };

    const firstPut = await request(ctx, '/webdav/bm-ow/x.txt', {
      method: 'PUT',
      headers: { ...davAuth, 'Content-Type': 'text/plain' },
      body: 'xxxx',
    });
    expect(firstPut.status).toBe(201);
    const fileRow = ctx.db
      .prepare(`SELECT id, provider_id FROM file_metadata WHERE mount_id = ? AND name = 'x.txt'`)
      .get(mountId) as { id: string; provider_id: string | null };
    expect(fileRow.provider_id).toBe(providerA);

    // A 桶对 user 明确不给 write（属主回退词表不含 write → 仍由桶级矩阵决定）
    const patch = await patchMount(mountId, {
      poolMembers: [
        { providerId: providerA, sortOrder: 0, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
        { providerId: providerB, sortOrder: 1 },
      ] as MemberInput[],
    });
    expect(patch.status).toBe(200);

    // 覆盖写同一路径：首选候选 = 原落桶 A（被桶级矩阵拒绝）→ 按策略回退到 B
    const overwritePut = await request(ctx, '/webdav/bm-ow/x.txt', {
      method: 'PUT',
      headers: { ...davAuth, 'Content-Type': 'text/plain' },
      body: 'yyyy',
    });
    expect(overwritePut.status).toBe(201);
    const after = ctx.db
      .prepare(`SELECT id, provider_id FROM file_metadata WHERE mount_id = ? AND name = 'x.txt'`)
      .get(mountId) as { id: string; provider_id: string | null };
    expect(after.id).toBe(fileRow.id);
    expect(after.provider_id).toBe(providerB);
  });
});

// ============ 5. §28/§30 语义未被改写 ============

describe('挂载点级矩阵与既有行为', () => {
  it('挂载点级矩阵在无桶级条目时照旧生效（§28 未被改写）', async () => {
    const providerId = (await ProviderRepo.listProviders(db))[0].id;
    const mountId = await createMount({
      providerId,
      mountPath: '/bm-mountlevel',
      name: '挂载点级矩阵',
    });
    // 挂载点级矩阵：user 只给 read → 新建文件被入口判定拒绝（写路径入口按挂载点级/角色默认，桶级只追加候选过滤）
    const setMount = await patchMount(mountId, {
      rolePermissions: [{ role: 'user', permissions: ['read'] }],
    });
    expect(setMount.status).toBe(200);
    const { authCookie } = await registerAndLogin(ctx, 'bm_mountlevel');
    const rejected = await initUploadSession(authCookie, '/bm-mountlevel', 'a.txt');
    expect(rejected.status).toBe(403);
    const rejectedBody = await json<{ error: { code: string } }>(rejected);
    expect(rejectedBody.error.code).toBe('FORBIDDEN');

    // 挂载点级放开 write，唯一的候选桶却被桶级矩阵拒绝 → 仍是 403（桶级只收紧、不放松新文件写入）
    const allowMountWrite = await patchMount(mountId, {
      rolePermissions: [{ role: 'user', permissions: ['read', 'write'] }],
      poolMembers: [{ providerId, rolePermissions: [{ role: 'user', permissions: ['read'] }] }],
    });
    expect(allowMountWrite.status).toBe(200);
    const deniedByBucket = await initUploadSession(authCookie, '/bm-mountlevel', 'b.txt');
    expect(deniedByBucket.status).toBe(403);

    // 唯一候选桶的桶级条目放开 write → 写入放行并落在该桶
    const allowBucketWrite = await patchMount(mountId, {
      poolMembers: [{ providerId, rolePermissions: [{ role: 'user', permissions: ['read', 'write'] }] }],
    });
    expect(allowBucketWrite.status).toBe(200);
    expect((await uploadFile(authCookie, '/bm-mountlevel', 'c.txt', 'ok')).providerId).toBe(providerId);
  });
});
