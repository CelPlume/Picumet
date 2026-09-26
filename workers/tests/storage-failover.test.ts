// §G 读路径容灾：文件落桶取不到对象（缺失/上游故障）时轮询池内其余桶取回；
// 副桶命中写入位置提示（含物理键指纹），后续请求优先访问副桶；主桶正常时不产生提示。
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createTestContext, initSeeded, request, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';
import { Db, MountProviderRolePermissionsRepo, MountRepo } from '../src/db';
import { R2BindingProvider } from '../src/services/storage/r2';
import { getFileObject } from '../src/services/storage/failover';
import { ProviderError } from '../src/services/storage/errors';
import { cleanupOldObjects } from '../src/services/cleanup';
import type { Env } from '../src/shared/types';

let ctx: TestContext;
let fixture: PoolFixture;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  fixture = await seedPoolFixture();
  await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  // 熔断标记会跨用例泄漏（上游故障用例会写下它），逐个清掉保证顺序断言的前提
  ctx.kv.delete('pool:down:prov-primary-test');
  ctx.kv.delete('pool:down:prov-replica-test');
});

const PRIMARY_NAME = '主桶-测试';
const REPLICA_NAME = '副桶-测试';
const MOUNT_PATH = '/vol';
const OBJECT_KEY = 'vol/report.txt';
const CONTENT = 'failover-payload';

interface PoolFixture {
  fileId: string;
  keyId: string;
  secret: string;
  authCookie: string;
  mountId: string;
  primaryId: string;
  replicaId: string;
}

/** 两个 r2 绑定 provider（共用同一个 mock 桶，靠实例名区分）+ 挂载 /vol（池成员含两者）+ 一个文件行/对象 */
async function seedPoolFixture(): Promise<PoolFixture> {
  const now = Date.now();
  const primaryId = 'prov-primary-test';
  const replicaId = 'prov-replica-test';
  const mountId = 'mount-vol-test';
  const insertProvider = ctx.db.prepare(
    `INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, path_prefix, created_at, updated_at, status)
     VALUES (?, ?, 'r2', '', 'auto', 'picumet-storage', '', '', '', ?, ?, 'active')`
  );
  insertProvider.run(primaryId, PRIMARY_NAME, now, now);
  insertProvider.run(replicaId, REPLICA_NAME, now, now);
  ctx.db
    .prepare(
      `INSERT INTO mounts (id, provider_id, mount_path, name, priority, created_at, updated_at, status, pool_strategy)
       VALUES (?, ?, ?, '卷', 200, ?, ?, 'active', 'least_used')`
    )
    .run(mountId, primaryId, MOUNT_PATH, now, now);
  const insertMember = ctx.db.prepare('INSERT INTO mount_providers (mount_id, provider_id, weight, created_at) VALUES (?, ?, 1, ?)');
  insertMember.run(mountId, primaryId, now);
  insertMember.run(mountId, replicaId, now);

  // 兼容读端点用的网关密钥（普通会话开通，规则放开 /vol）
  const { authCookie, userId } = await registerAndLogin(ctx, 'failover' + Math.random().toString(36).slice(2, 7));
  const csrf = await getCsrf(ctx, authCookie);

  // 文件行：属主 = 密钥持有者（网关读按属主隔离）；落桶 = 主桶；物理对象放一份到 mock 桶
  const fileId = 'file-vol-report';
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, provider_id,
        physical_key, blob_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'report.txt', 'file', 'text/plain', ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(fileId, mountId, OBJECT_KEY, MOUNT_PATH, CONTENT.length, userId, primaryId, OBJECT_KEY, now, now);
  ctx.r2.putRaw(OBJECT_KEY, new TextEncoder().encode(CONTENT), { 'Content-Type': 'text/plain' } as never);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'fo', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/' },
  });
  const data = (await res.json()) as { data: { key: { keyId: string; fullToken: string } } };
  const keyId = data.data.key.keyId;
  const secret = data.data.key.fullToken;
  await grantApiKeyRule(ctx, keyId, ['write', 'read'], '/**');
  return { fileId, keyId, secret, authCookie, mountId, primaryId, replicaId };
}

/** 记录 provider 实例调用顺序；primaryMissing=true 时主桶返回"对象不存在"，fail=true 时抛上游故障 */
function spyProviders(opts: { primaryMissing?: boolean; primaryFails?: boolean; replicaMissing?: boolean; bothMissing?: boolean }): string[] {
  const calls: string[] = [];
  const original = R2BindingProvider.prototype.getObject;
  vi.spyOn(R2BindingProvider.prototype, 'getObject').mockImplementation(function (
    this: R2BindingProvider,
    key: string,
    getOpts?: Parameters<typeof original>[1]
  ) {
    calls.push(this.name);
    if (opts.bothMissing) return Promise.resolve(null);
    if (this.name === PRIMARY_NAME) {
      if (opts.primaryFails) return Promise.reject(new ProviderError('other', 'upstream down'));
      if (opts.primaryMissing) return Promise.resolve(null);
    }
    if (this.name === REPLICA_NAME && opts.replicaMissing) return Promise.resolve(null);
    if (opts.bothMissing) return Promise.resolve(null);
    return original.call(this, key, getOpts);
  });
  return calls;
}

async function fetchCompat(fixture: PoolFixture): Promise<Response> {
  return request(ctx, `/api/compat/file?path=${MOUNT_PATH}/report.txt`, {
    headers: { Authorization: `Bearer ${fixture.secret}` },
  });
}

describe('§G 读路径容灾（副桶轮询）', () => {
  it('主桶缺对象 → 轮询副桶命中，写入位置提示，后续请求直取副桶', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    const calls = spyProviders({ primaryMissing: true });

    const first = await fetchCompat(fixture);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(CONTENT);
    expect(calls).toEqual([PRIMARY_NAME, REPLICA_NAME]);

    // 命中位置提示：provider = 副桶 + 物理键指纹
    const hint = await ctx.kv.get(`serve:loc:${fixture.fileId}`);
    expect(hint).toBeTruthy();
    expect(JSON.parse(hint as string)).toEqual({ p: 'prov-replica-test', k: OBJECT_KEY });

    // 第二次请求直接优先副桶（提示命中后不再尝试主桶）
    calls.length = 0;
    const second = await fetchCompat(fixture);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(CONTENT);
    expect(calls).toEqual([REPLICA_NAME]);
  });

  it('主桶正常：不回退、不写提示', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    const calls = spyProviders({});
    const res = await fetchCompat(fixture);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
    expect(calls).toEqual([PRIMARY_NAME]);
    expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();
  });

  it('主桶上游故障 → 回退副桶成功', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    const calls = spyProviders({ primaryFails: true });
    const res = await fetchCompat(fixture);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
    expect(calls).toEqual([PRIMARY_NAME, REPLICA_NAME]);
  });

  it('全部候选不可用 → 404（不伪装成 502）', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    spyProviders({ bothMissing: true });
    const res = await fetchCompat(fixture);
    expect(res.status).toBe(404);
    expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();
  });

  it('容灾候选只认桶：文件夹/目录不会被当作回退来源', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    // 把池成员收敛为主桶一家，并制造一个与对象同名的文件夹行 + 一个指向不存在 provider 的伪成员
    ctx.db.prepare(`DELETE FROM mount_providers WHERE mount_id = ? AND provider_id = ?`).run('mount-vol-test', 'prov-replica-test');
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
         VALUES ('folder-decoy', 'mount-vol-test', 'folder:/vol/report.txt', '/vol', 'report.txt', 'folder', 0, ?, ?, ?)`
      )
      .run(
        (ctx.db.prepare(`SELECT owner_id FROM file_metadata WHERE id = ?`).get(fixture.fileId) as { owner_id: string }).owner_id,
        Date.now(),
        Date.now()
      );
    // 池成员只能是真实桶：外键直接拒绝指向不存在 provider 的成员
    expect(() =>
      ctx.db.prepare(`INSERT INTO mount_providers (mount_id, provider_id, weight, created_at) VALUES ('mount-vol-test', 'prov-not-exist', 5, ?)`).run(Date.now())
    ).toThrow();

    const calls = spyProviders({ primaryMissing: true });
    const res = await fetchCompat(fixture);
    // 主桶缺对象、其余成员都不是可用桶 → 404；同名文件夹与伪 provider 都不产生内容
    expect(res.status).toBe(404);
    expect(calls).toEqual([PRIMARY_NAME]);
    expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();

    // 复原池成员，避免影响其他用例
    ctx.db.prepare(`INSERT INTO mount_providers (mount_id, provider_id, weight, created_at) VALUES (?, ?, 1, ?)`).run('mount-vol-test', 'prov-replica-test', Date.now());
    ctx.db.prepare(`DELETE FROM file_metadata WHERE id = 'folder-decoy'`).run();
  });

  it('陈旧提示（物理键指纹不匹配）被忽略：仍先试主桶', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    await ctx.kv.put(`serve:loc:${fixture.fileId}`, JSON.stringify({ p: 'prov-replica-test', k: 'stale-key' }));
    const calls = spyProviders({});
    const res = await fetchCompat(fixture);
    expect(res.status).toBe(200);
    expect(calls).toEqual([PRIMARY_NAME]);
  });

  it('上游故障 → 写熔断标记，无提示时下个请求先试副桶', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    await ctx.kv.delete('pool:down:prov-primary-test');
    const calls = spyProviders({ primaryFails: true });

    expect((await fetchCompat(fixture)).status).toBe(200);
    expect(calls).toEqual([PRIMARY_NAME, REPLICA_NAME]);
    expect(await ctx.kv.get('pool:down:prov-primary-test')).not.toBeNull();

    // 只留熔断状态（清掉位置提示）：候选顺序被反转，不再先撞主桶超时
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    calls.length = 0;
    expect((await fetchCompat(fixture)).status).toBe(200);
    expect(calls).toEqual([REPLICA_NAME]);
    expect(await ctx.kv.get('pool:down:prov-primary-test')).not.toBeNull();

    await ctx.kv.delete('pool:down:prov-primary-test');
  });

  it('对象缺失不熔断（数据状态而非桶健康）', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    await ctx.kv.delete('pool:down:prov-primary-test');
    spyProviders({ primaryMissing: true });

    expect((await fetchCompat(fixture)).status).toBe(200);
    expect(await ctx.kv.get('pool:down:prov-primary-test')).toBeNull();
  });

  it('记录桶恢复：兜底尝试命中后清除熔断标记', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    await ctx.kv.put('pool:down:prov-primary-test', '1');
    const calls = spyProviders({ replicaMissing: true });

    const res = await fetchCompat(fixture);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
    // 熔断把记录桶排到末尾：先副桶（无对象）再记录桶命中
    expect(calls).toEqual([REPLICA_NAME, PRIMARY_NAME]);
    expect(await ctx.kv.get('pool:down:prov-primary-test')).toBeNull();
    expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();
  });

  it('记录桶重新供数 → 清除指向副桶的位置提示', async () => {
    await ctx.kv.put(`serve:loc:${fixture.fileId}`, JSON.stringify({ p: 'prov-replica-test', k: OBJECT_KEY }));
    spyProviders({ replicaMissing: true });

    const res = await fetchCompat(fixture);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
    expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();
  });

  it('副桶对象与元数据大小不符 → 视作未命中（404），不写提示', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    ctx.db.prepare('UPDATE file_metadata SET size = ? WHERE id = ?').run(CONTENT.length + 99, fixture.fileId);
    try {
      const calls = spyProviders({ primaryMissing: true });
      const res = await fetchCompat(fixture);
      expect(res.status).toBe(404);
      expect(calls).toEqual([PRIMARY_NAME, REPLICA_NAME]);
      expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();
    } finally {
      ctx.db.prepare('UPDATE file_metadata SET size = ? WHERE id = ?').run(CONTENT.length, fixture.fileId);
    }
  });

  it('§32 备用桶仍是读回退候选：标 standby 的池成员照旧参与容灾轮询', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    // 副桶显式标为备用（§32：写入不再落它）——读回退按池成员**全集**轮询（§G），标记不改变读路径
    ctx.db
      .prepare(`UPDATE mount_providers SET standby = 1 WHERE mount_id = ? AND provider_id = ?`)
      .run('mount-vol-test', 'prov-replica-test');
    try {
      const calls = spyProviders({ primaryMissing: true });
      const res = await fetchCompat(fixture);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CONTENT);
      expect(calls).toEqual([PRIMARY_NAME, REPLICA_NAME]);
      // 命中位置提示指向备用桶（回退链路与标记正交）
      const hint = await ctx.kv.get(`serve:loc:${fixture.fileId}`);
      expect(JSON.parse(hint as string)).toEqual({ p: 'prov-replica-test', k: OBJECT_KEY });
    } finally {
      ctx.db
        .prepare(`UPDATE mount_providers SET standby = 0 WHERE mount_id = ? AND provider_id = ?`)
        .run('mount-vol-test', 'prov-replica-test');
      await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    }
  });

  it('§G 镜像豁免：旧对象清理只在文件落桶上执行，副桶不参与删除', async () => {
    const oldKey = 'vol/report-old.txt';
    ctx.r2.putRaw(oldKey, new TextEncoder().encode('old-payload'), { 'Content-Type': 'text/plain' } as never);
    ctx.db
      .prepare('UPDATE file_metadata SET old_object_key = ?, source_cleanup_pending = 1 WHERE id = ?')
      .run(oldKey, fixture.fileId);

    const deleted: Array<{ provider: string; key: string }> = [];
    vi.spyOn(R2BindingProvider.prototype, 'deleteObject').mockImplementation(function (this: R2BindingProvider, key: string) {
      deleted.push({ provider: this.name, key });
      return Promise.resolve();
    });

    expect(await cleanupOldObjects(ctx.env as Env)).toBeGreaterThan(0);
    expect(deleted.filter((d) => d.key === oldKey)).toEqual([{ provider: PRIMARY_NAME, key: oldKey }]);
    expect(deleted.every((d) => d.provider === PRIMARY_NAME)).toBe(true);

    const row = ctx.db
      .prepare('SELECT old_object_key, source_cleanup_pending FROM file_metadata WHERE id = ?')
      .get(fixture.fileId) as { old_object_key: string | null; source_cleanup_pending: number };
    expect(row.old_object_key).toBeNull();
    expect(row.source_cleanup_pending).toBe(0);
  });
});

/** 覆盖副桶的桶级角色矩阵（§31）；传 [] 清空。用于验证读回退逐候选重判 */
function setReplicaMatrix(entries: Array<{ role: string; permissions: string[] }>): Promise<void> {
  return MountProviderRolePermissionsRepo.setForMount(Db.fromSqlite(ctx.db), fixture.mountId, fixture.replicaId, entries);
}

describe('读回退逐候选权限复核（§31/§28）', () => {
  it('普通用户：记录桶读取失败 + 备用桶桶级 deny download → 403（不从备用桶读出）', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    // 备用桶矩阵仅放行 read → download 在封闭集合外 = deny
    await setReplicaMatrix([{ role: 'user', permissions: ['read'] }]);
    try {
      const calls = spyProviders({ primaryFails: true });
      const res = await request(ctx, `${MOUNT_PATH}/report.txt`, { cookie: fixture.authCookie });
      expect(res.status).toBe(403);
      // 记录桶被尝试并失败；备用桶因权限被跳过，未产生任何对象读取
      expect(calls).toEqual([PRIMARY_NAME]);
      expect(await ctx.kv.get(`serve:loc:${fixture.fileId}`)).toBeNull();
    } finally {
      await setReplicaMatrix([]);
    }
  });

  it('普通用户：无矩阵条目时备用桶正常回退（download 动作）', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    const calls = spyProviders({ primaryMissing: true });
    const res = await request(ctx, `${MOUNT_PATH}/report.txt`, { cookie: fixture.authCookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
    expect(calls).toEqual([PRIMARY_NAME, REPLICA_NAME]);
  });

  it('未传 principalRole 的内部调用行为不变：备用桶桶级 deny 也不介入', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    await setReplicaMatrix([{ role: 'user', permissions: ['read'] }]);
    try {
      spyProviders({ primaryMissing: true });
      const db = Db.fromSqlite(ctx.db);
      const mount = await MountRepo.getMountById(db, fixture.mountId);
      expect(mount).toBeTruthy();
      const result = await getFileObject({
        db,
        env: ctx.env as Env,
        mount: mount!,
        ref: {
          fileId: fixture.fileId,
          mountId: fixture.mountId,
          providerId: fixture.primaryId,
          physicalKey: OBJECT_KEY,
          size: CONTENT.length,
        },
      });
      expect(result.providerId).toBe(fixture.replicaId);
      expect(await new Response(result.object.body).text()).toBe(CONTENT);
    } finally {
      await setReplicaMatrix([]);
    }
  });
});

describe('回退 sha256 元数据比对', () => {
  it('备用桶对象 sha256 与文件 blobHash 不符 → 404；一致 → 命中', async () => {
    await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
    const hash = 'a'.repeat(64);
    const withMeta = (sha256: string): void =>
      ctx.r2.putRaw(OBJECT_KEY, new TextEncoder().encode(CONTENT), {
        httpMetadata: { contentType: 'text/plain' },
        customMetadata: { sha256 },
      });
    ctx.db.prepare('UPDATE file_metadata SET blob_hash = ? WHERE id = ?').run(hash, fixture.fileId);
    try {
      spyProviders({ primaryMissing: true });
      withMeta('b'.repeat(64));
      expect((await fetchCompat(fixture)).status).toBe(404);

      // 元数据与文件哈希一致 → 该候选通过校验，正常回退命中
      await ctx.kv.delete(`serve:loc:${fixture.fileId}`);
      withMeta(hash);
      const ok = await fetchCompat(fixture);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe(CONTENT);
    } finally {
      ctx.db.prepare('UPDATE file_metadata SET blob_hash = NULL WHERE id = ?').run(fixture.fileId);
      ctx.r2.putRaw(OBJECT_KEY, new TextEncoder().encode(CONTENT), { 'Content-Type': 'text/plain' } as never);
    }
  });
});
