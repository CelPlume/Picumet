import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext,
  initSeeded,
  registerAndLogin,
  getCsrf,
  request,
  json,
  type TestContext,
} from './helpers';
import { DirectoryStateRepo, PermissionRevisionRepo, Db } from '../src/db';
import type { FileListItem } from '@shared/types';

let ctx: TestContext;
let db: Db;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  const auth = await registerAndLogin(ctx, 'dir_user');
  cookie = auth.authCookie;
  csrf = await getCsrf(ctx, cookie);
});

describe('目录 Revision 与 ETag 条件请求', () => {
  it('DirectoryStateRepo：初始不存在时 bump 生成 revision=1，再次 bump 递增', async () => {
    const mountRow = await db.first('SELECT id FROM mounts LIMIT 1');
    const mountId = String(mountRow?.id ?? 'default');
    await DirectoryStateRepo.bumpRevision(db, mountId, '/test-dir');
    const state1 = await DirectoryStateRepo.get(db, mountId, '/test-dir');
    expect(state1).not.toBeNull();
    expect(state1?.revision).toBe(1);

    await DirectoryStateRepo.bumpRevision(db, mountId, '/test-dir');
    const state2 = await DirectoryStateRepo.get(db, mountId, '/test-dir');
    expect(state2?.revision).toBe(2);
  });

  it('PermissionRevisionRepo：bump 递增全局权限版本', async () => {
    const rev1 = await PermissionRevisionRepo.get(db);
    expect(rev1).toBeGreaterThanOrEqual(1);

    const rev2 = await PermissionRevisionRepo.bump(db);
    expect(rev2).toBe(rev1 + 1);
  });

  it('文件列表 /api/files 返回 revision 与 ETag，带 If-None-Match 命中 notModified', async () => {
    const res = await request(ctx, '/api/files?path=/', {
      cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        items: FileListItem[];
        revision: number;
        etag: string;
      };
    }>(res);

    expect(body.data.revision).toBeDefined();
    expect(body.data.etag).toMatch(/^W\/"[a-f0-9]{24}"$/);
    const etag = res.headers.get('ETag');
    expect(etag).toBe(body.data.etag);

    // 默认（未声明 conditional）即便带 If-None-Match 也必须回完整数据：
    // 浏览器 HTTP 缓存再验证会自动带该头，回空 items 会让前端把目录覆盖成空列表。
    const plainRes = await request(ctx, '/api/files?path=/', {
      cookie,
      headers: { 'If-None-Match': body.data.etag },
    });
    expect(plainRes.status).toBe(200);
    const plainBody = await json<{ data: { notModified?: boolean; items: FileListItem[] } }>(plainRes);
    expect(plainBody.data.notModified).toBeUndefined();
    expect(Array.isArray(plainBody.data.items)).toBe(true);

    // 显式声明条件请求 -> 命中 ETag 回轻量 notModified
    const condRes = await request(ctx, '/api/files?path=/&conditional=1', {
      cookie,
      headers: {
        'If-None-Match': body.data.etag,
      },
    });
    expect(condRes.status).toBe(200);
    const condBody = await json<{
      data: {
        notModified?: boolean;
        etag: string;
        revision: number;
      };
    }>(condRes);
    expect(condBody.data.notModified).toBe(true);
  });

  it('轻量目录接口 /api/files/directories 仅返回子文件夹且支持 ETag', async () => {
    // 先建一个文件夹
    const createRes = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: 'sub-folder-test' },
    });
    expect(createRes.status).toBe(201);

    const res = await request(ctx, '/api/files/directories?path=/', {
      cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        items: FileListItem[];
        revision: number;
        etag: string;
      };
    }>(res);

    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items.every((i) => i.type === 'folder')).toBe(true);
    expect(body.data.items.some((i) => i.name === 'sub-folder-test')).toBe(true);
    expect(body.data.etag).toBeDefined();

    // 命中 ETag
    const condRes = await request(ctx, '/api/files/directories?path=/&conditional=1', {
      cookie,
      headers: {
        'If-None-Match': body.data.etag,
      },
    });
    expect(condRes.status).toBe(200);
    const condBody = await json<{ data: { notModified?: boolean } }>(condRes);
    expect(condBody.data.notModified).toBe(true);
  });
});

// 回归：版本表缺失（存量库未补齐迁移）时，文件列表这类核心读取路径**不得** 500。
// revision 只服务缓存失效与 ETag，属优化项；读不到就降级为常量版本。
describe('版本表缺失时的降级行为', () => {
  it('/api/files 与 /api/files/directories 在 directory_states / permission_revisions 缺失时仍返回 200', async () => {
    const localCtx = createTestContext();
    await initSeeded(localCtx);
    const auth = await registerAndLogin(localCtx, 'norev_user');
    const localCookie = auth.authCookie;

    localCtx.db.exec('DROP TABLE IF EXISTS directory_states');
    localCtx.db.exec('DROP TABLE IF EXISTS permission_revisions');

    const list = await request(localCtx, '/api/files?path=/', { cookie: localCookie });
    expect(list.status).toBe(200);
    const listBody = await json<{ data: { revision: number; etag: string } }>(list);
    expect(listBody.data.revision).toBe(1);
    expect(listBody.data.etag).toMatch(/^W\/"[a-f0-9]{24}"$/);

    const dirs = await request(localCtx, '/api/files/directories?path=/', { cookie: localCookie });
    expect(dirs.status).toBe(200);
    const dirsBody = await json<{ data: { revision: number } }>(dirs);
    expect(dirsBody.data.revision).toBe(1);
  });
});
