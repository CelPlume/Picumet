// 用户空间根与 defaultPath 的口径（按用户反馈两轮收敛）：
// user_space 根 = defaultPath 之下以用户名命名的独立子目录（`/public/<username>`）——
// 不同用户互不可写对方目录；defaultPath 末段已是用户名（管理员把家指到个人目录）时直接用
// defaultPath；defaultPath 为 `/`、未设置或越出挂载边界时回落 `<mountPath>/<username>`。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, registerAndLogin, getCsrf, json, type TestContext } from './helpers';
import { Db } from '../src/db';
import { resolveUserSpaceRoot } from '../src/services/files/upload-mode';
import { MountRepo, ProviderRepo } from '../src/db';

let ctx: TestContext;
let db: Db;
let rootMountId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  const provider = (await ProviderRepo.listProviders(db))[0];
  // 根挂载 / （种子自带，providerId 取自它）
  const mount = await MountRepo.findMountForPath(db, '/');
  rootMountId = mount?.id ?? (await MountRepo.createMount(db, { providerId: provider.id, mountPath: '/', name: '根', priority: 100 })).id;
});

/** 建用户并指定 default_path */
async function makeUser(username: string, defaultPath: string): Promise<{ authCookie: string; userId: string }> {
  const { userId, authCookie } = await registerAndLogin(ctx, username);
  await db.run(`UPDATE users SET default_path = ? WHERE id = ?`, [defaultPath, userId]);
  return { authCookie, userId };
}

describe('user_space 根与 defaultPath 口径一致', () => {
  it('resolveUserSpaceRoot：defaultPath=/public → 根为 /public/<username>（按用户隔离）', async () => {
    const { userId } = await makeUser('homepub', '/public');
    const mount = (await MountRepo.getMountById(db, rootMountId))!;
    expect(await resolveUserSpaceRoot(db, mount, userId)).toBe('/public/homepub');
  });

  it('resolveUserSpaceRoot：defaultPath 末段已是用户名（/users/alice）→ 不重复拼接', async () => {
    const { userId } = await makeUser('alice', '/users/alice');
    const mount = (await MountRepo.getMountById(db, rootMountId))!;
    expect(await resolveUserSpaceRoot(db, mount, userId)).toBe('/users/alice');
  });

  it('resolveUserSpaceRoot：defaultPath=/ → 回落 /<username>', async () => {
    const { userId } = await makeUser('homeslash', '/');
    const mount = (await MountRepo.getMountById(db, rootMountId))!;
    expect(await resolveUserSpaceRoot(db, mount, userId)).toBe('/homeslash');
  });

  it('resolveUserSpaceRoot：非根挂载点下 defaultPath 越界 → 回落 <mountPath>/<username>', async () => {
    const provider = (await ProviderRepo.listProviders(db))[0];
    const sub = await MountRepo.createMount(db, { providerId: provider.id, mountPath: '/mnt-b', name: 'B', priority: 90 });
    const { userId } = await makeUser('homefar2', '/somewhere-else');
    const mount = (await MountRepo.getMountById(db, sub.id))!;
    // /somewhere-else 不在 /mnt-b 边界内 → 回落该挂载点下的 /<username>
    expect(await resolveUserSpaceRoot(db, mount, userId)).toBe('/mnt-b/homefar2');
  });

  it('端到端：defaultPath=/public 的用户可在自己的 /public/<username> 下建目录', async () => {
    const { authCookie } = await makeUser('e2ehome', '/public');
    const csrf = await getCsrf(ctx, authCookie);
    // 把根挂载切成 user_space（线上事故形态）
    await db.run(`UPDATE mounts SET upload_mode = 'user_space' WHERE id = ?`, [rootMountId]);
    try {
      const res = await request(ctx, '/api/files/folder', {
        method: 'POST',
        cookie: authCookie,
        headers: { 'X-CSRF-Token': csrf },
        body: { path: '/public/e2ehome', name: 'my-dir' },
      });
      expect(res.status).toBe(201);
      // 他人目录不可写：/public/e2ehome 之外的 /public/other 403
      const res2 = await request(ctx, '/api/files/folder', {
        method: 'POST',
        cookie: authCookie,
        headers: { 'X-CSRF-Token': csrf },
        body: { path: '/public', name: 'not-mine' },
      });
      expect(res2.status).toBe(403);
    } finally {
      await db.run(`UPDATE mounts SET upload_mode = 'free' WHERE id = ?`, [rootMountId]);
    }
  });

  it('端到端：defaultPath 之外的路径仍被权限引擎拒（隔离不回退）', async () => {
    const { authCookie } = await makeUser('e2efar', '/public');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/somewhere-else', name: 'nope' },
    });
    expect(res.status).toBe(403);
  });
});

// 让 json 引用不至未用（helpers 导入对齐）
void json;
