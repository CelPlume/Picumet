// §C 游客可见性继承（用户实测：文件夹设「游客仅可下载」后，网关新上传对象匿名 403）：
// ① 新上传文件继承最近祖先的非 NULL guest_visibility；
// ② 上传自愈创建的中间目录行同样继承（深层路径一次到位）；
// ③ 文件夹级联设置把子树（含既有行）收敛到同一语义；
// ④ 无祖先设置时新建行 guest_visibility 为 NULL（不额外开放游客）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, registerAndLogin, getCsrf, json, grantApiKeyRule, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

interface Key {
  token: string;
}

async function createKey(username: string, uploadPath: string): Promise<Key> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'k', permissions: ['read', 'write', 'delete'], protocols: ['api'], uploadPath },
  });
  expect(res.status).toBe(201);
  const data = await json(res) as { data: { key: { fullToken: string; id: string } } };
  await grantApiKeyRule(ctx, data.data.key.id, ['read', 'write', 'delete'], `${uploadPath}/**`);
  return { token: data.data.key.fullToken };
}

async function setGuestViaApi(filePath: string): Promise<void> {
  // 直接落库：绕开 web 会话依赖（继承逻辑在写路径，无关设置入口）。
  // 种子库没有 /public 目录行（懒创建），先补齐再设置。
  const name = filePath.split('/').filter(Boolean).pop()!;
  const mount = ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string };
  const owner = ctx.db.prepare(`SELECT id FROM users ORDER BY created_at LIMIT 1`).get() as { id: string };
  ctx.db.exec(`INSERT OR IGNORE INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
    VALUES ('${crypto.randomUUID()}', '${mount.id}', 'folder:${filePath.slice(1)}', '${filePath}', '${name}', 'folder', 0, '${owner.id}', ${Date.now()}, ${Date.now()})`);
  ctx.db.exec(`UPDATE file_metadata SET guest_visibility = 'download' WHERE path = '${filePath}' AND type = 'folder'`);
}

const multipart = (name: string, content: string): FormData => {
  const form = new FormData();
  form.append('file', new File([new Blob([content])], name, { type: 'text/plain' }));
  return form;
};

describe('游客可见性继承', () => {
  it('新上传文件继承祖先目录的 guest_visibility=download，自愈目录同样继承', async () => {
    await setGuestViaApi('/public');
    // 匿名读还需站点级「允许访客」（path-serve 前置门禁）
    ctx.db.exec(`UPDATE system_settings SET value = 'true' WHERE key = 'allow_guest_access'`);
    const key = await createKey('guestinherit', '/public');
    // 深层路径：dire/2026/10 全部为自愈创建的目录行，均应继承 download
    const up = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.token}` },
      body: multipart('dire/2026/10/inherit.txt', 'guest-downloadable'),
    });
    // /public 下的写受 user_space 之外约束？挂载默认 free → 直接可写
    expect(up.status).toBe(200);

    const rows = ctx.db.prepare(
      `SELECT path, type, guest_visibility FROM file_metadata
       WHERE path LIKE '/public/dire%' OR (path = '/public' AND type = 'file') ORDER BY path`
    ).all() as Array<{ path: string; type: string; guest_visibility: string | null }>;
    const byPath = new Map(rows.map((r) => [`${r.type}:${r.path}`, r.guest_visibility]));
    expect(byPath.get('folder:/public/dire')).toBe('download');
    expect(byPath.get('folder:/public/dire/2026')).toBe('download');
    expect(byPath.get('folder:/public/dire/2026/10')).toBe('download');
    expect(byPath.get('file:/public/dire/2026/10')).toBe('download');

    // 匿名下载经 path-serve 判定（合成规则 allow download）
    const anon = await request(ctx, '/public/dire/2026/10/inherit.txt', { headers: { 'User-Agent': 'curl/8.0' } });
    expect(anon.status).toBe(200);
    expect(await anon.text()).toBe('guest-downloadable');
  });

  it('无祖先设置时新建行 guest_visibility 为 NULL', async () => {
    const key = await createKey('guestplain', '/uploads');
    const up = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.token}` },
      body: multipart('noinherit.txt', 'plain'),
    });
    expect(up.status).toBe(200);
    const row = ctx.db.prepare(
      `SELECT guest_visibility FROM file_metadata WHERE path = '/uploads' AND name = 'noinherit.txt'`
    ).get() as { guest_visibility: string | null };
    expect(row.guest_visibility).toBeNull();
  });

  it('文件夹级联设置收敛子树（含既有文件行）', async () => {
    const key = await createKey('guestcascade', '/uploads');
    await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.token}` },
      body: multipart('casc/casc.txt', 'casc'),
    });
    // 既有行 guest_visibility 均为 NULL；级联设置 /uploads/casc → download
    ctx.db.exec(`UPDATE file_metadata SET guest_visibility = 'download' WHERE path = '/uploads/casc' AND type = 'folder'`);
    const { authCookie } = await registerAndLogin(ctx, 'guestsetter');
    const csrf = await getCsrf(ctx, authCookie);
    // 走管理面改属性太重：直接调 PUT /api/files/:id 需要文件 id——用管理员 session 简化
    await ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'guestsetter'`);
    const login = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'guestsetter', password: 'password123' } });
    const cookie = `auth_token=${(login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
    const csrf2 = await getCsrf(ctx, cookie);
    const folder = ctx.db.prepare(`SELECT id FROM file_metadata WHERE path = '/uploads/casc' AND type = 'folder'`).get() as { id: string };
    const res = await request(ctx, `/api/files/${folder.id}`, {
      method: 'PUT',
      cookie,
      headers: { 'X-CSRF-Token': csrf2 },
      body: { guestVisibility: 'view' },
    });
    expect(res.status).toBe(200);
    const rows = ctx.db.prepare(
      `SELECT path, type, guest_visibility FROM file_metadata WHERE path LIKE '/uploads/casc%' ORDER BY path`
    ).all() as Array<{ path: string; type: string; guest_visibility: string | null }>;
    for (const r of rows) expect(r.guest_visibility).toBe('view');
  });
});
