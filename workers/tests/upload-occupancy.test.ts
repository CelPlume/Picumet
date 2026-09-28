// LAB F-02/F-03/F-05/F-06/H3 回归：上传会话路径与直写路径的语义对齐——
// 占用判定（他人 409/目录 409）、同属主覆盖（保留 id、配额差值）、内容索引登记（去重/回收）、
// flat 挂载根不再误 403、读时惰性补登记。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';
import { Db, ProviderRepo, MountRepo } from '../src/db';

let ctx: TestContext;
let db: Db;
const MOUNT_PATH = '/pubocc';
let publicMountId = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  const provider = (await ProviderRepo.listProviders(db))[0];
  await MountRepo.createMount(db, { providerId: provider.id, mountPath: MOUNT_PATH, name: '占用回归', priority: 300 });
  publicMountId = (await MountRepo.listMounts(db)).find((m) => m.mountPath === MOUNT_PATH)!.id;
});

/** 建带 API Key 的用户（上传根 = 测试挂载），并放开读写删规则 */
async function createKeyedUser(username: string): Promise<{ authCookie: string; fullToken: string }> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'up', permissions: ['read', 'write', 'delete'], protocols: ['api'], uploadPath: MOUNT_PATH },
  });
  expect(res.status).toBe(201);
  const data = (await json<{ data: { key: { keyId: string; fullToken: string } } }>(res)).data;
  await grantApiKeyRule(ctx, data.key.keyId, ['read', 'write', 'delete'], `${MOUNT_PATH}/**`);
  return { authCookie, fullToken: data.key.fullToken };
}

interface SessionResult {
  init: Response;
  raw: Response | null;
  complete: Response | null;
  file?: { id: string; path: string; size: number };
  /** raw 阶段响应体（body 只能读一次，sessionUpload 内捕获） */
  rawEtag?: string;
  rawDeduped?: boolean;
}

/** 会话上传全流程（upload-session → raw → complete） */
async function sessionUpload(cookie: string, path: string, fileName: string, content: string): Promise<SessionResult> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const init = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  if (init.status !== 200) return { init, raw: null, complete: null };
  const sessionId = (await json<{ data: { sessionId: string } }>(init)).data.sessionId;
  const raw = await request(ctx, `/api/files/upload/raw/${sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  if (raw.status !== 200) return { init, raw, complete: null };
  const rawBody = (await json<{ data: { etag: string; deduped?: boolean } }>(raw)).data;
  const etag = rawBody.etag;
  const complete = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId, etag },
  });
  if (complete.status !== 200) return { init, raw, complete, rawEtag: etag, rawDeduped: rawBody.deduped };
  const file = (await json<{ data: { file: { id: string; path: string; size: number } } }>(complete)).data.file;
  return { init, raw, complete, rawEtag: etag, rawDeduped: rawBody.deduped, file };
}

async function createSession(cookie: string, path: string, fileName: string, content: string): Promise<Response> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  return request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
}

function fileRow(path: string, name: string): { id: string; size: number; blob_hash: string | null; physical_key: string | null; owner_id: string } | undefined {
  return ctx.db
    .prepare(`SELECT id, size, blob_hash, physical_key, owner_id FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ? AND type = 'file'`)
    .get(publicMountId, path, name) as never;
}

describe('LAB F-05/F-06：会话路径占用与覆盖', () => {
  it('同属主同路径再上传 → 覆盖成功（保留 id、内容/大小更新），不再 500 UNIQUE', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'occ_alice');
    const first = await sessionUpload(authCookie, MOUNT_PATH, 'doc.txt', 'first-body');
    expect(first.complete?.status).toBe(200);
    const row1 = fileRow(MOUNT_PATH, 'doc.txt');
    expect(row1?.size).toBe('first-body'.length);

    const second = await sessionUpload(authCookie, MOUNT_PATH, 'doc.txt', 'second-body-longer');
    expect(second.init.status).toBe(200);
    expect(second.complete?.status).toBe(200);
    const row2 = fileRow(MOUNT_PATH, 'doc.txt');
    expect(row2?.id).toBe(row1?.id); // 覆盖保留文件 id
    expect(row2?.size).toBe('second-body-longer'.length);

    // 下载内容为新内容
    const dl = await request(ctx, `/api/files/${row1!.id}/download`, { cookie: authCookie });
    const dlData = (await json<{ data: { url: string } }>(dl)).data;
    const gw = await request(ctx, dlData.url.replace('http://localhost:8787', ''));
    expect(await gw.text()).toBe('second-body-longer');

    // 配额差值口径：used_storage = 新 − 旧（used_files 不重复 +1）
    const quota = ctx.db.prepare(`SELECT used_storage, used_files FROM user_quotas WHERE user_id = ?`).get(row1!.owner_id) as {
      used_storage: number;
      used_files: number;
    };
    expect(quota.used_storage).toBe('second-body-longer'.length);
    expect(quota.used_files).toBe(1);
  });

  it('他人占用 → 会话创建即 409，不签发 URL；complete 阶段被抢占也 409', async () => {
    const alice = await registerAndLogin(ctx, 'occ_owner');
    const bob = await registerAndLogin(ctx, 'occ_bob');

    await sessionUpload(alice.authCookie, MOUNT_PATH, 'victim.txt', 'alice-content');
    // bob 对 alice 已有路径创建会话 → 409
    const conflict = await createSession(bob.authCookie, MOUNT_PATH, 'victim.txt', 'bob-content');
    expect(conflict.status).toBe(409);
    expect((await json<{ error: { code: string } }>(conflict)).error.code).toBe('CONFLICT');
    // alice 内容未被触碰
    expect(fileRow(MOUNT_PATH, 'victim.txt')?.size).toBe('alice-content'.length);

    // complete 阶段被抢占：bob 先创建会话（路径空闲），alice 先落位，bob 再 complete → 409
    const bobSession = await createSession(bob.authCookie, MOUNT_PATH, 'race.txt', 'bob-race');
    expect(bobSession.status).toBe(200);
    const sessionId = (await json<{ data: { sessionId: string } }>(bobSession)).data.sessionId;
    await sessionUpload(alice.authCookie, MOUNT_PATH, 'race.txt', 'alice-wins');
    const bobRaw = await request(ctx, `/api/files/upload/raw/${sessionId}`, {
      method: 'PUT',
      cookie: bob.authCookie,
      headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': await getCsrf(ctx, bob.authCookie) },
      body: 'bob-race',
    });
    expect(bobRaw.status).toBe(200);
    const bobComplete = await request(ctx, '/api/files/upload-complete', {
      method: 'POST',
      cookie: bob.authCookie,
      headers: { 'X-CSRF-Token': await getCsrf(ctx, bob.authCookie) },
      body: { sessionId, etag: (await json<{ data: { etag: string } }>(bobRaw)).data.etag },
    });
    expect(bobComplete.status).toBe(409);
    // alice 的行未被动
    expect(fileRow(MOUNT_PATH, 'race.txt')?.size).toBe('alice-wins'.length);
  });

  it('目录占用 → 会话创建 409（同路径已是文件夹）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'occ_folder');
    const csrf = await getCsrf(ctx, authCookie);
    const mk = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: MOUNT_PATH, name: 'occdir' },
    });
    expect(mk.status).toBe(201);
    const conflict = await createSession(authCookie, MOUNT_PATH, 'occdir', 'x');
    expect(conflict.status).toBe(409);
  });
});

describe('LAB F-02：会话路径内容索引登记', () => {
  it('raw 上传后 blob_objects 有索引行；同内容第二次上传去重命中；删净入 blob_gc', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'blob_alice');
    const content = 'dedup-payload-0123456789';

    const first = await sessionUpload(authCookie, MOUNT_PATH, 'd1.txt', content);
    expect(first.complete?.status).toBe(200);
    const hash = fileRow(MOUNT_PATH, 'd1.txt')?.blob_hash ?? '';
    expect(hash).not.toBe('');

    // 索引行存在（LAB F-02 ①：旧实现漏登记）
    const indexed = ctx.db.prepare(`SELECT object_key, size FROM blob_objects WHERE hash = ? AND mount_id = ?`).get(hash, publicMountId) as {
      object_key: string;
      size: number;
    } | undefined;
    expect(indexed).toBeTruthy();
    expect(indexed!.size).toBe(content.length);

    // 第二次上传同内容（不同路径）→ raw 阶段去重命中（deduped=true）
    const second = await sessionUpload(authCookie, MOUNT_PATH, 'd2.txt', content);
    expect(second.complete?.status).toBe(200);
    expect(second.rawDeduped).toBe(true);
    // 仍只 1 行索引（同 (hash, mount)）
    const count = ctx.db.prepare(`SELECT COUNT(*) AS c FROM blob_objects WHERE hash = ? AND mount_id = ?`).get(hash, publicMountId) as { c: number };
    expect(count.c).toBe(1);

    // 删净全部引用 → blob_gc 入队（LAB F-02 ③：旧实现无回收条目）
    for (const name of ['d1.txt', 'd2.txt']) {
      const row = fileRow(MOUNT_PATH, name);
      const del = await request(ctx, `/api/files/${row!.id}`, {
        method: 'DELETE',
        cookie: authCookie,
        headers: { 'X-CSRF-Token': await getCsrf(ctx, authCookie) },
      });
      expect(del.status).toBe(200);
    }
    const gc = ctx.db.prepare(`SELECT attempts FROM blob_gc WHERE hash = ? AND mount_id = ?`).get(hash, publicMountId);
    expect(gc).toBeTruthy();
  });

  it('LAB H3：删掉索引行后访问文件 → 读时惰性补登记恢复', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'blob_repair');
    const content = 'repair-payload-9876543210';
    const up = await sessionUpload(authCookie, MOUNT_PATH, 'repair.txt', content);
    const hash = fileRow(MOUNT_PATH, 'repair.txt')?.blob_hash ?? '';
    await db.run(`DELETE FROM blob_objects WHERE hash = ? AND mount_id = ?`, [hash, publicMountId]);

    const detail = await request(ctx, `/api/files/${up.file!.id}`, { cookie: authCookie });
    expect(detail.status).toBe(200);
    const restored = ctx.db.prepare(`SELECT object_key FROM blob_objects WHERE hash = ? AND mount_id = ?`).get(hash, publicMountId);
    expect(restored).toBeTruthy();
  });
});

describe('LAB F-03：flat 语义统一', () => {
  async function setMode(mode: 'free' | 'flat'): Promise<void> {
    await db.run(`UPDATE mounts SET upload_mode = ? WHERE id = ?`, [mode, publicMountId]);
  }

  it('flat：会话创建到嵌套路径 → 403（旧实现 200 并留下不可列出文件行）', async () => {
    await setMode('flat');
    const { authCookie } = await registerAndLogin(ctx, 'flatocc');
    const init = await createSession(authCookie, `${MOUNT_PATH}/sub`, 'nested.txt', 'x');
    expect(init.status).toBe(403);
    const rows = ctx.db.prepare(`SELECT id FROM file_metadata WHERE mount_id = ? AND path = ?`).all(publicMountId, `${MOUNT_PATH}/sub`);
    expect(rows.length).toBe(0);
  });

  it('flat：挂载根上传（compat 与会话通道）→ 200（旧实现误 403）', async () => {
    await setMode('flat');
    const keyed = await createKeyedUser('flatroot');
    // 会话通道到挂载根
    const sess = await sessionUpload(keyed.authCookie, MOUNT_PATH, 'root.txt', 'root-body');
    expect(sess.complete?.status).toBe(200);
    // compat 通道到挂载根（上传根 = 挂载根）：旧 ensureFolders 把挂载根当需新建祖先 → 403
    const form = new FormData();
    form.append('file', new File([new Blob(['compat-body'])], 'compat.txt', { type: 'text/plain' }));
    const compat = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyed.fullToken}` },
      body: form,
    });
    expect(compat.status).toBe(200);
  });

  it('free：会话上传到新子目录自动补祖先目录行（列表可见）', async () => {
    await setMode('free');
    const { authCookie } = await registerAndLogin(ctx, 'freeocc');
    const sess = await sessionUpload(authCookie, `${MOUNT_PATH}/autodir/deeper`, 'deep.txt', 'deep-body');
    expect(sess.complete?.status).toBe(200);
    const folder = ctx.db
      .prepare(`SELECT type FROM file_metadata WHERE mount_id = ? AND path = ? AND name = 'autodir'`)
      .get(publicMountId, `${MOUNT_PATH}/autodir`) as { type?: string } | undefined;
    expect(folder?.type).toBe('folder');
    const list = await request(ctx, `/api/files?path=${MOUNT_PATH}`, { cookie: authCookie });
    const items = (await json<{ data: { items: Array<{ name: string }> } }>(list)).data.items;
    expect(items.some((i) => i.name === 'autodir')).toBe(true);
  });
});
