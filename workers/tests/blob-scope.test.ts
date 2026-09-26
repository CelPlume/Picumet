// 内容对象索引按 (hash, mount_id) 隔离：跨挂载同内容各写一份、各自索引行独立；同挂载内仍去重；
// 释放判定保持全局按 hash（不缩小到挂载），本挂载已无引用的陈旧索引行由 reconcileBlobs 清理；
// 回收只作用于索引队列登记的那一个物理落点。
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
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
import { Sha256 } from '../src/utils/sha256';
import { blobObjectKey } from '../src/services/storage/keys';
import { reconcileBlobs, cleanupBlobObjects } from '../src/services/cleanup';

const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };

let ctx: TestContext;
let auth: Record<string, string>;
let rootMountId = '';
let mountB = '';

interface FileRow {
  mount_id: string;
  provider_id: string | null;
  physical_key: string | null;
  blob_hash: string | null;
}

interface BlobRow {
  mount_id: string;
  object_key: string;
}

interface CountRow {
  c: number;
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'scope_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'scope_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'scope_admin', password: 'password123' },
  });
  const adminCookie = `auth_token=${(relogin.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  const adminCsrf = await getCsrf(ctx, adminCookie);

  // 测试库直读：形状由本文件的 SQL 决定
  const rootMount = ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string } | undefined;
  rootMountId = String(rootMount?.id ?? '');

  // 第二个挂载：独立 provider + 独立 pathPrefix（内容键因此不同）
  const providerRes = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name: 'scope-b', bucket: 'scope-bucket', pathPrefix: 'scope-b/' },
  });
  expect(providerRes.status).toBe(201);
  const providerPayload = (await json(providerRes)).data as { provider: { id: string } };
  const providerB = providerPayload.provider.id;
  const mountRes = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    // priority 高于种子根挂载（100），确保 /mnt-b/* 解析到本挂载而非被根遮蔽
    body: { providerId: providerB, mountPath: '/mnt-b', name: 'scope-b', priority: 300 },
  });
  expect(mountRes.status).toBe(201);
  const mountPayload = (await json(mountRes)).data as { mount: { id: string } };
  mountB = mountPayload.mount.id;

  const member = await registerAndLogin(ctx, 'scope' + Math.random().toString(36).slice(2, 7));
  const csrf = await getCsrf(ctx, member.authCookie);
  const keyRes = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: member.authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'scope', permissions: ['write', 'read', 'delete'], protocols: ['webdav'], uploadPath: '/' },
  });
  expect(keyRes.status).toBe(201);
  const keyPayload = (await json(keyRes)).data as { key: { keyId: string; secret: string } };
  await grantApiKeyRule(ctx, keyPayload.key.keyId, ['write', 'read', 'delete'], '/');
  auth = { Authorization: 'Basic ' + Buffer.from(`${keyPayload.key.keyId}:${keyPayload.key.secret}`).toString('base64') };
});

function sha256(content: string): string {
  const hasher = new Sha256();
  hasher.update(new TextEncoder().encode(content));
  return hasher.digestHex();
}

async function upload(path: string, content: string): Promise<Response> {
  return request(ctx, `/webdav/${path}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body: content,
  });
}

async function removeFile(path: string): Promise<Response> {
  return request(ctx, `/webdav/${path}`, { method: 'DELETE', headers: auth });
}

function fileRow(mountId: string, name: string): FileRow {
  // 测试库直读：列集由本函数的 SQL 固定
  const row = ctx.db
    .prepare('SELECT mount_id, provider_id, physical_key, blob_hash FROM file_metadata WHERE mount_id = ? AND name = ?')
    .get(mountId, name) as FileRow | undefined;
  if (!row) throw new Error(`file row not found: ${name}`);
  return row;
}

function blobRows(hash: string): BlobRow[] {
  const rows = ctx.db.prepare('SELECT mount_id, object_key FROM blob_objects WHERE hash = ? ORDER BY mount_id').all(hash);
  return rows.map((r) => ({ mount_id: String(r.mount_id), object_key: String(r.object_key) }));
}

function blobGcCount(hash: string): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM blob_gc WHERE hash = ?').get(hash) as CountRow | undefined;
  return Number(row?.c ?? 0);
}

describe('§F 内容对象按挂载隔离', () => {
  it('跨挂载同内容各写一份、索引行独立；同挂载内仍去重', async () => {
    const content = 'cross-mount-same-bytes';
    const hash = sha256(content);
    const keyRoot = blobObjectKey('', hash);
    const keyB = blobObjectKey('scope-b/', hash);

    expect((await upload('scope/same.txt', content)).status).toBe(201);
    expect((await upload('mnt-b/scope/same.txt', content)).status).toBe(201);

    const rootRow = fileRow(rootMountId, 'same.txt');
    const bRow = fileRow(mountB, 'same.txt');
    expect(rootRow.blob_hash).toBe(hash);
    expect(bRow.blob_hash).toBe(hash);
    // 两次上传落在不同挂载/不同桶，物理键各自独立（不再跨挂载复用历史落点）
    expect(rootRow.mount_id).not.toBe(bRow.mount_id);
    expect(rootRow.physical_key).toBe(keyRoot);
    expect(bRow.physical_key).toBe(keyB);
    expect(rootRow.provider_id).not.toBe(bRow.provider_id);

    // 索引行按 (hash, mount_id) 各一条，指向本挂载的对象
    const rows = blobRows(hash);
    expect(rows.length).toBe(2);
    const objectKeyByMount: Record<string, string> = {};
    for (const r of rows) objectKeyByMount[String(r.mount_id)] = String(r.object_key);
    expect(objectKeyByMount[rootMountId]).toBe(keyRoot);
    expect(objectKeyByMount[mountB]).toBe(keyB);

    // 物理对象也是两份
    expect(await ctx.r2.head(keyRoot)).not.toBeNull();
    expect(await ctx.r2.head(keyB)).not.toBeNull();

    // 同一挂载内再上传同内容：仍然去重（不新增对象、共享本挂载落点）
    const before = (await ctx.r2.list({ prefix: '' })).objects.length;
    expect((await upload('scope/same-copy.txt', content)).status).toBe(201);
    expect((await ctx.r2.list({ prefix: '' })).objects.length).toBe(before);
    expect(fileRow(rootMountId, 'same-copy.txt').physical_key).toBe(keyRoot);
  });

  it('释放按全局 hash 保守判定；本挂载陈旧索引行由对账清理', async () => {
    const content = 'cross-mount-release';
    const hash = sha256(content);
    const keyRoot = blobObjectKey('', hash);
    const keyB = blobObjectKey('scope-b/', hash);

    expect((await upload('release/same.txt', content)).status).toBe(201);
    expect((await upload('mnt-b/release/same.txt', content)).status).toBe(201);

    // 删除根挂载的文件：另一挂载仍引用同一 hash → 不入回收队列、两份索引行都保留
    expect((await removeFile('release/same.txt')).status).toBe(204);
    expect(blobGcCount(hash)).toBe(0);
    expect(blobRows(hash).length).toBe(2);

    // 对账：根挂载已无同挂载引用 → 陈旧索引行出队；全局仍有引用 → 仍不入 blob_gc
    await reconcileBlobs(ctx.env, Date.now() + 120_000);
    expect(blobRows(hash).map((r) => String(r.mount_id))).toEqual([mountB]);
    expect(blobGcCount(hash)).toBe(0);
    expect(await ctx.r2.head(keyB)).not.toBeNull();

    // 另一侧也删除 → 全局无引用 → 入回收队列 + 索引行清空
    expect((await removeFile('mnt-b/release/same.txt')).status).toBe(204);
    expect(blobGcCount(hash)).toBe(1);
    expect(blobRows(hash).length).toBe(0);

    await cleanupBlobObjects(ctx.env, Date.now() + 180_000);
    expect(blobGcCount(hash)).toBe(0);
    // 回收只作用于队列登记的那一个落点；另一份跨挂载物理对象保持不动（不误删）
    const survived: string[] = [];
    if (await ctx.r2.head(keyRoot)) survived.push(keyRoot);
    if (await ctx.r2.head(keyB)) survived.push(keyB);
    expect(survived.length).toBe(1);
  });

  it('迁移 0007 回填：有引用的存量索引取首个引用挂载，无引用置空串哨兵，主键为复合键', () => {
    // 生产库存量数据迁移：helpers 的全新库不会走到回填分支，这里单独跑 0001 + 0007 验证
    const db = new DatabaseSyncCtor(':memory:');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    db.exec(readFileSync(join(dir, '0001_initial.sql'), 'utf-8'));
    const now = Date.now();
    db.prepare(
      `INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, created_at, updated_at, status)
       VALUES ('p1', 'p1', 'r2', '', 'auto', 'bucket', '', '', ?, ?, 'active')`
    ).run(now, now);
    db.prepare(
      `INSERT INTO mounts (id, provider_id, mount_path, name, priority, created_at, updated_at, status)
       VALUES ('m1', 'p1', '/', 'root', 100, ?, ?, 'active')`
    ).run(now, now);
    db.prepare(
      `INSERT INTO users (id, username, email, email_verified, password_hash, role, default_path, created_at, updated_at)
       VALUES ('u1', 'u1', 'u1@test.local', 0, 'x', 'user', '/', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, blob_hash, physical_key, created_at, updated_at)
       VALUES ('f1', 'm1', 'v1', '/', 'a.txt', 'file', 1, 'u1', 'h-ref', 'k-ref', ?, ?)`
    ).run(now, now);
    // 一条有引用的存量索引 + 一条已无引用的历史孤儿索引
    db.prepare(
      `INSERT INTO blob_objects (hash, provider_id, object_key, size, etag, created_at, updated_at) VALUES
         ('h-ref', 'p1', 'k-ref', 1, NULL, ?, ?),
         ('h-orphan', 'p1', 'k-orphan', 2, NULL, ?, ?)`
    ).run(now, now, now, now);

    db.exec(readFileSync(join(dir, '0007_blob_mount_scope.sql'), 'utf-8'));

    const backfilled: Record<string, string> = {};
    for (const row of db.prepare('SELECT hash, mount_id FROM blob_objects').all()) {
      backfilled[String(row.hash)] = String(row.mount_id);
    }
    expect(backfilled['h-ref']).toBe('m1');
    expect(backfilled['h-orphan']).toBe('');

    // 复合主键：同一 hash 可再登记另一个挂载；重复的 (hash, mount) 由 INSERT OR IGNORE 忽略
    db.prepare(
      `INSERT OR IGNORE INTO blob_objects (hash, mount_id, provider_id, object_key, size, created_at, updated_at)
       VALUES ('h-ref', 'm2', 'p1', 'k-ref-2', 1, ?, ?), ('h-ref', 'm1', 'p1', 'dup', 1, ?, ?)`
    ).run(now, now, now, now);
    const scoped = db.prepare('SELECT COUNT(*) AS c FROM blob_objects WHERE hash = ?').get('h-ref') as CountRow | undefined;
    expect(Number(scoped?.c ?? 0)).toBe(2);

    // orphan_objects 已补 provider_id 列
    expect(db.prepare('SELECT provider_id FROM orphan_objects LIMIT 1').all()).toEqual([]);
  });
});
