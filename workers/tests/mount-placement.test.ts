// 挂载放置统一校验（Provider 一步创建 / POST /mounts / PATCH|PUT /mounts/:id）：
//   · 同规范化路径 → 400 ALREADY_EXISTS；
//   · 嵌套不变量（非严格）：祖先 priority <= 后代 priority（等值合法、深度决胜）；
//     只禁止「祖先优先级严格高于后代」的遮蔽组合；
//   · 缺省 priority = 覆盖路径的最近祖先优先级（保证默认管理流程可用、新建挂载不被遮蔽）；
//   · 数据遮蔽守卫：新/改路径被祖先挂载覆盖且祖先命名空间下已有目标子树行 → 409。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

interface ErrorBody {
  error: { code: string; message: string };
}
interface MountListBody {
  data: { mounts: Array<{ id: string; mountPath: string; priority: number }> };
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'mp_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'mp_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'mp_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  adminCookie = `auth_token=${setCookie.match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'mp-bucket' },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { provider: { id: string } } }>(res)).data.provider.id;
}

function postMount(body: Record<string, unknown>): Promise<Response> {
  return request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

function patchMount(mountId: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/mounts/${mountId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

async function mounts(): Promise<MountListBody['data']['mounts']> {
  return (await json<MountListBody>(await request(ctx, '/api/admin/mounts', { cookie: adminCookie }))).data.mounts;
}

async function mountIdOf(mountPath: string): Promise<string> {
  const mount = (await mounts()).find((m) => m.mountPath === mountPath);
  expect(mount).toBeTruthy();
  return mount!.id;
}

/** 测试夹具：单列查询的已知列形状 */
function scalarId(sql: string, ...params: (string | number)[]): string {
  const row = ctx.db.prepare(sql).get(...params) as { id: string } | undefined;
  if (!row) throw new Error(`expected a row for: ${sql}`);
  return row.id;
}

describe('挂载放置统一校验', () => {
  it('同路径 POST 拒绝（400 ALREADY_EXISTS）', async () => {
    const providerId = await createProvider('mp-place-1');
    expect((await postMount({ providerId, mountPath: '/mp-dup', name: '首个', priority: 150 })).status).toBe(201);
    const dup = await postMount({ providerId, mountPath: '/mp-dup', name: '重复', priority: 150 });
    expect(dup.status).toBe(400);
    expect((await json<ErrorBody>(dup)).error.code).toBe('ALREADY_EXISTS');
  });

  it('同路径 PATCH/PUT 改路径拒绝', async () => {
    const providerId = await createProvider('mp-place-2');
    expect((await postMount({ providerId, mountPath: '/mp-a', name: 'a', priority: 150 })).status).toBe(201);
    expect((await postMount({ providerId, mountPath: '/mp-b', name: 'b', priority: 150 })).status).toBe(201);
    const a = await mountIdOf('/mp-a');
    const moved = await patchMount(a, { mountPath: '/mp-b' });
    expect(moved.status).toBe(400);
    expect((await json<ErrorBody>(moved)).error.code).toBe('ALREADY_EXISTS');
  });

  it('优先级遮蔽组合拒绝：祖先优先级高于子挂载', async () => {
    const providerId = await createProvider('mp-place-3');
    // 等值嵌套（祖先 100 = 子 100）合法：深度决胜
    expect((await postMount({ providerId, mountPath: '/mp-parent', name: '父', priority: 100 })).status).toBe(201);
    expect((await postMount({ providerId, mountPath: '/mp-parent/child', name: '子', priority: 100 })).status).toBe(201);
    // 子挂载优先级低于祖先 → 遮蔽 → 400
    const shadowed = await postMount({ providerId, mountPath: '/mp-shadow', name: '被遮蔽', priority: 50 });
    expect(shadowed.status).toBe(400);
    expect((await json<ErrorBody>(shadowed)).error.message).toContain('优先级遮蔽');
  });

  it('优先级遮蔽组合拒绝：祖先优先级高于现存后代', async () => {
    const providerId = await createProvider('mp-place-4');
    expect((await postMount({ providerId, mountPath: '/mp-dd', name: '祖先', priority: 200 })).status).toBe(201);
    expect((await postMount({ providerId, mountPath: '/mp-dd/x', name: '后代', priority: 300 })).status).toBe(201);
    const dd = await mountIdOf('/mp-dd');
    const raised = await patchMount(dd, { priority: 400 });
    expect(raised.status).toBe(400);
    expect((await json<ErrorBody>(raised)).error.message).toContain('优先级遮蔽');
    // 等值/中间值合法：>= 祖先且 <= 后代
    expect((await patchMount(dd, { priority: 300 })).status).toBe(200);
    expect((await patchMount(dd, { priority: 250 })).status).toBe(200);
  });

  it('缺省 priority 取祖先优先级：默认管理流程（无 priority 建子挂载）可用', async () => {
    const providerId = await createProvider('mp-place-5');
    expect((await postMount({ providerId, mountPath: '/mp-default', name: '默认优先级' })).status).toBe(201);
    // = 种子根挂载 priority 100
    expect((await mounts()).find((m) => m.mountPath === '/mp-default')?.priority).toBe(100);
  });

  it('父挂载已有目标子树数据 → 409（无 overlay 合并语义）', async () => {
    const providerId = await createProvider('mp-place-6');
    const rootId = scalarId(`SELECT id FROM mounts WHERE mount_path = '/'`);
    const owner = scalarId(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'folder', 0, ?, ?, ?)`
      )
      .run('mp-occupied-row', rootId, 'folder:/mp-occupied', '/mp-occupied', 'mp-occupied', owner, now, now);

    const res = await postMount({ providerId, mountPath: '/mp-occupied', name: '覆盖', priority: 200 });
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.message).toContain('目标路径已有父挂载数据');
  });
});
