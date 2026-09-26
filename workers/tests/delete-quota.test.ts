// 单点 DELETE 的权限路径基准 = 文件全路径（文件级精确 deny 规则才能命中）
// 目录删除按文件行属主分组扣减用户配额；mounts.used_storage 仍按全部文件总扣
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext,
  initSeeded,
  request,
  json,
  registerAndLogin,
  getCsrf,
  type TestContext,
} from './helpers';
import { Db, RuleRepo } from '../src/db';

let ctx: TestContext;
let db: Db;

async function mkFolder(cookie: string, csrf: string, path: string, name: string): Promise<string> {
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { file: { id: string } } }>(res)).data.file.id;
}

async function uploadFile(cookie: string, csrf: string, dir: string, fileName: string, content: string): Promise<string> {
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
  return (await json<{ data: { file: { id: string } } }>(completeRes)).data.file.id;
}

function quotaOf(userId: string): { storage: number; files: number } {
  const row = ctx.db
    .prepare('SELECT used_storage, used_files FROM user_quotas WHERE user_id = ?')
    .get(userId) as { used_storage: number; used_files: number };
  return { storage: Number(row.used_storage), files: Number(row.used_files) };
}

function rootMountId(): string {
  const row = ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string };
  return row.id;
}

function mountUsed(mountId: string): number {
  const row = ctx.db.prepare('SELECT used_storage FROM mounts WHERE id = ?').get(mountId) as { used_storage: number };
  return Number(row.used_storage);
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
});

describe('共享目录删除按属主分组扣减配额', () => {
  it('两属主共同内容的目录被删除：双方各扣自己的文件，挂载总量一致', async () => {
    const a = await registerAndLogin(ctx, 'dq_a');
    const b = await registerAndLogin(ctx, 'dq_b');
    const aCsrf = await getCsrf(ctx, a.authCookie);
    const bCsrf = await getCsrf(ctx, b.authCookie);

    const rootId = rootMountId();
    const mountBefore = mountUsed(rootId);
    const aBefore = quotaOf(a.userId);
    const bBefore = quotaOf(b.userId);

    // A 建共享目录，两属主分别上传（free 模式下允许写入他人目录）
    const folderId = await mkFolder(a.authCookie, aCsrf, '/', 'shared-dq');
    await uploadFile(a.authCookie, aCsrf, '/shared-dq', 'a1.txt', 'aaa'); // 3
    await uploadFile(a.authCookie, aCsrf, '/shared-dq', 'a2.txt', 'aa'); // 2
    await uploadFile(b.authCookie, bCsrf, '/shared-dq', 'b1.txt', 'bbbbb'); // 5

    // 上传后：各自记账，挂载总量含全部 10 字节
    expect(quotaOf(a.userId).storage - aBefore.storage).toBe(5);
    expect(quotaOf(a.userId).files - aBefore.files).toBe(2);
    expect(quotaOf(b.userId).storage - bBefore.storage).toBe(5);
    expect(quotaOf(b.userId).files - bBefore.files).toBe(1);
    expect(mountUsed(rootId) - mountBefore).toBe(10);

    // A（目录属主）删除整个目录
    const del = await request(ctx, `/api/files/${folderId}`, {
      method: 'DELETE',
      cookie: a.authCookie,
      headers: { 'X-CSRF-Token': aCsrf },
    });
    expect(del.status).toBe(200);

    // B 的文件也要从 B 自己的配额里扣（旧实现只扣目录属主 A → B 虚高、A 多扣）
    expect(quotaOf(a.userId)).toEqual(aBefore);
    expect(quotaOf(b.userId)).toEqual(bBefore);
    // 挂载总量按全部文件扣减，回到上传前
    expect(mountUsed(rootId)).toBe(mountBefore);

    const remaining = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM file_metadata WHERE path = '/shared-dq' OR path LIKE '/shared-dq/%'`)
      .get() as { c: number };
    expect(Number(remaining.c)).toBe(0);
  });
});

describe('单点 DELETE 使用文件全路径基准', () => {
  it('非属主 + 精确文件级 deny delete 规则 → 403（父目录基准匹配不到该规则）', async () => {
    const owner = await registerAndLogin(ctx, 'dq_owner');
    const mover = await registerAndLogin(ctx, 'dq_mover');
    const ownerCsrf = await getCsrf(ctx, owner.authCookie);
    const moverCsrf = await getCsrf(ctx, mover.authCookie);

    const fileId = await uploadFile(owner.authCookie, ownerCsrf, '/', 'top04.txt', 'abcd');
    // 精确路径 deny（role=user）：只有以文件全路径为基准才能命中
    await RuleRepo.createRule(db, {
      pathPattern: '/top04.txt',
      effect: 'deny',
      role: 'user',
      permissions: ['delete'],
      requirePassword: false,
      priority: 0,
      mountId: rootMountId(),
    });

    const denied = await request(ctx, `/api/files/${fileId}`, {
      method: 'DELETE',
      cookie: mover.authCookie,
      headers: { 'X-CSRF-Token': moverCsrf },
    });
    expect(denied.status).toBe(403);
    expect((await json<{ error: { code: string } }>(denied)).error.code).toBe('FORBIDDEN');
    expect(ctx.db.prepare('SELECT id FROM file_metadata WHERE id = ?').get(fileId)).toBeTruthy();

    // 对照：同目录另一文件无精确规则 → 非属主删除放行（默认姿态），证明拒绝来自路径基准命中规则
    const otherId = await uploadFile(owner.authCookie, ownerCsrf, '/', 'top04-ok.txt', 'xy');
    const allowed = await request(ctx, `/api/files/${otherId}`, {
      method: 'DELETE',
      cookie: mover.authCookie,
      headers: { 'X-CSRF-Token': moverCsrf },
    });
    expect(allowed.status).toBe(200);
    expect(ctx.db.prepare('SELECT id FROM file_metadata WHERE id = ?').get(otherId)).toBeUndefined();
  });
});
