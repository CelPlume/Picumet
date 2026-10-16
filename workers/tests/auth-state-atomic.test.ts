import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, type TestContext } from './helpers';
import { AuthStateRepo, Db } from '../src/db';

let ctx: TestContext;
let db: Db;
const ENC_KEY = 'test-encryption-key-32-bytes-long!';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
});

describe('AuthStateRepo 强一致鉴权状态原子操作', () => {
  it('createState 写入加密状态，getState 只读查看不消耗', async () => {
    const token = 'token-alpha-1234567890';
    const payload = { userId: 'u1', role: 'user', extra: 'data' };

    await AuthStateRepo.createState(db, {
      token,
      kind: 'sso_state',
      payload,
      expiresAt: Date.now() + 60_000,
      encryptionKey: ENC_KEY,
    });

    const read = await AuthStateRepo.getState<typeof payload>(db, {
      token,
      kind: 'sso_state',
      encryptionKey: ENC_KEY,
    });

    expect(read).not.toBeNull();
    expect(read?.payload).toEqual(payload);
    expect(read?.version).toBe(0);

    // 再次读取依然有效（未被消费）
    const readAgain = await AuthStateRepo.getState<typeof payload>(db, {
      token,
      kind: 'sso_state',
      encryptionKey: ENC_KEY,
    });
    expect(readAgain).not.toBeNull();
  });

  it('consumeState 原子消费：首次认领成功，后续重放返回 null', async () => {
    const token = 'token-beta-single-use';
    const payload = { code: 'pkce-test', providerId: 'google' };

    await AuthStateRepo.createState(db, {
      token,
      kind: 'sso_state',
      payload,
      expiresAt: Date.now() + 60_000,
      encryptionKey: ENC_KEY,
    });

    // 首次认领
    const claimed1 = await AuthStateRepo.consumeState<typeof payload>(db, {
      token,
      kind: 'sso_state',
      encryptionKey: ENC_KEY,
    });
    expect(claimed1).toEqual(payload);

    // 第二次认领（重放攻击）
    const claimed2 = await AuthStateRepo.consumeState<typeof payload>(db, {
      token,
      kind: 'sso_state',
      encryptionKey: ENC_KEY,
    });
    expect(claimed2).toBeNull();

    // 只读查看也应返回 null（已被消费）
    const read = await AuthStateRepo.getState(db, {
      token,
      kind: 'sso_state',
      encryptionKey: ENC_KEY,
    });
    expect(read).toBeNull();
  });

  it('updateState 乐观锁版本控制：预期版本匹配更新成功，版本不匹配拒绝', async () => {
    const token = 'token-gamma-multi-step';
    const payload1 = { step: 'password', attempts: 0 };

    await AuthStateRepo.createState(db, {
      token,
      kind: 'sso_pending',
      payload: payload1,
      expiresAt: Date.now() + 60_000,
      encryptionKey: ENC_KEY,
    });

    // 推进步骤 1（预期版本 0 -> 成功）
    const payload2 = { step: 'totp', attempts: 0 };
    const ok1 = await AuthStateRepo.updateState(db, {
      token,
      kind: 'sso_pending',
      payload: payload2,
      expectedVersion: 0,
      encryptionKey: ENC_KEY,
    });
    expect(ok1).toBe(true);

    const readStep2 = await AuthStateRepo.getState<typeof payload2>(db, {
      token,
      kind: 'sso_pending',
      encryptionKey: ENC_KEY,
    });
    expect(readStep2?.payload.step).toBe('totp');
    expect(readStep2?.version).toBe(1);

    // 用旧版本 0 再次更新（并发冲突）-> 必须返回 false
    const okStale = await AuthStateRepo.updateState(db, {
      token,
      kind: 'sso_pending',
      payload: { step: 'email', attempts: 0 },
      expectedVersion: 0,
      encryptionKey: ENC_KEY,
    });
    expect(okStale).toBe(false);
  });

  it('purgeExpired 批量回收过期或已消费条目', async () => {
    const tokenExp = 'token-expired-test';
    await AuthStateRepo.createState(db, {
      token: tokenExp,
      kind: 'sso_state',
      payload: { x: 1 },
      expiresAt: Date.now() - 1000, // 已过期
      encryptionKey: ENC_KEY,
    });

    const purged = await AuthStateRepo.purgeExpired(db, 50);
    expect(purged).toBeGreaterThanOrEqual(1);

    const read = await AuthStateRepo.getState(db, {
      token: tokenExp,
      kind: 'sso_state',
      encryptionKey: ENC_KEY,
    });
    expect(read).toBeNull();
  });
});
