// 新建用户默认路径继承角色默认：
// 默认种子 '/' 时行为不变 → 改 role_defaults.default_path 后直连创建与注册链路均继承 → 显式入参优先
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, registerAndLogin, type TestContext } from './helpers';
import { Db, UserRepo } from '../src/db';
import { RoleDefaultsRepo } from '../src/db/repos/role-defaults';
import type { Role } from '@shared/types';

let ctx: TestContext;
let db: Db;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
});

describe('UserRepo.createUser 默认路径继承角色默认', () => {
  // 首个用例不触碰 role_defaults，验证迁移种子 '/'（与既有行为一致）
  it('默认种子下新建用户 defaultPath=/', async () => {
    const u = await UserRepo.createUser(db, {
      username: 'dp_seed',
      email: 'dp_seed@default-path.test',
      passwordHash: 'hash',
    });
    expect(u.defaultPath).toBe('/');
  });

  it('角色默认改为 /users 后，新用户继承该路径', async () => {
    await RoleDefaultsRepo.upsertDefaults(db, 'user' as Role, {
      defaultPath: '/users',
      maxStorage: UserRepo.DEFAULT_MAX_STORAGE,
      maxFiles: 10000,
    });
    expect(await RoleDefaultsRepo.defaultPathOf(db, 'user' as Role)).toBe('/users');

    const direct = await UserRepo.createUser(db, {
      username: 'dp_inherit',
      email: 'dp_inherit@default-path.test',
      passwordHash: 'hash',
    });
    expect(direct.defaultPath).toBe('/users');

    // 注册链路（auth/handlers）复用同一 createUser 来源：注册用户同样落在角色默认路径
    await registerAndLogin(ctx, 'dp_register');
    const registered = await UserRepo.getUserByUsername(db, 'dp_register');
    expect(registered?.defaultPath).toBe('/users');
  });

  it('显式 defaultPath 入参优先于角色默认', async () => {
    const u = await UserRepo.createUser(db, {
      username: 'dp_explicit',
      email: 'dp_explicit@default-path.test',
      passwordHash: 'hash',
      defaultPath: '/users/custom',
    });
    expect(u.defaultPath).toBe('/users/custom');
  });

  it('admin 角色同样按各自角色默认继承（角色隔离）', async () => {
    await RoleDefaultsRepo.upsertDefaults(db, 'admin' as Role, {
      defaultPath: '/ops',
      maxStorage: UserRepo.DEFAULT_MAX_STORAGE,
      maxFiles: 10000,
    });
    const u = await UserRepo.createUser(db, {
      username: 'dp_admin',
      email: 'dp_admin@default-path.test',
      passwordHash: 'hash',
      role: 'admin',
    });
    expect(u.defaultPath).toBe('/ops');
  });

  it('角色未登记 / 默认路径为脏值时回退 /', async () => {
    expect(await RoleDefaultsRepo.defaultPathOf(db, 'ghost' as Role)).toBe('/');

    await RoleDefaultsRepo.upsertDefaults(db, 'user' as Role, {
      defaultPath: 'users',
      maxStorage: UserRepo.DEFAULT_MAX_STORAGE,
      maxFiles: 10000,
    });
    const u = await UserRepo.createUser(db, {
      username: 'dp_dirty',
      email: 'dp_dirty@default-path.test',
      passwordHash: 'hash',
    });
    expect(u.defaultPath).toBe('/');
  });
});
