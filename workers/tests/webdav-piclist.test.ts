// WebDAV P1-3 兼容缝隙回归：href 编码、自项属性、OPTIONS、MOVE Overwrite、MKCOL 递归、所有者隔离
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

interface DavBundle {
  basic: string;
  keyId: string;
  userId: string;
}

async function createDavKey(username: string): Promise<DavBundle> {
  const { authCookie, userId } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'dav', permissions: ['read', 'write', 'delete'], protocols: ['webdav'], uploadPath: '/uploads' },
  });
  expect(res.status).toBe(201);
  const data = await json(res) as { data: { key: { keyId: string; secret: string } } };
  const keyId = data.data.key.keyId;
  await grantApiKeyRule(ctx, keyId, ['read', 'write', 'delete'], '/uploads/**');
  return { basic: `Basic ${btoa(`${keyId}:${data.data.key.secret}`)}`, keyId, userId };
}

const dav = (basic: string): Record<string, string> => ({ Authorization: basic });

describe('WebDAV P1-3（PicList 兼容缝隙）', () => {
  it('OPTIONS 不再宣告未实现的 COPY', async () => {
    const k = await createDavKey('davopts');
    const res = await request(ctx, '/webdav/', { method: 'OPTIONS', headers: dav(k.basic) });
    expect(res.status).toBe(204);
    const allow = res.headers.get('Allow') ?? '';
    expect(allow).not.toContain('COPY');
    expect(allow).toContain('PUT');
  });

  it('%/# 文件名：PUT 成功、PROPFIND href 逐段编码且可解回', async () => {
    const k = await createDavKey('davhref');
    const name = 'a#b%.txt';
    const putUrl = `/webdav/uploads/${encodeURIComponent(name)}`;
    const put = await request(ctx, putUrl, { method: 'PUT', headers: dav(k.basic), body: 'weird-content' });
    expect(put.status).toBe(201);

    // 文件 PROPFIND（Depth 0）：自项为 file 型 + getcontenttype/getetag
    const self = await request(ctx, putUrl, { method: 'PROPFIND', headers: { ...dav(k.basic), Depth: '0' } });
    expect(self.status).toBe(207);
    const selfBody = await self.text();
    expect(selfBody).toContain('/webdav/uploads/a%23b%25.txt');
    expect(selfBody).not.toContain('<d:collection/>');
    expect(selfBody).toContain('getcontenttype');
    expect(selfBody).toContain('getetag');

    // 目录 PROPFIND：子项 href 编码，decodeURIComponent 不抛 URIError
    const list = await request(ctx, '/webdav/uploads/', { method: 'PROPFIND', headers: { ...dav(k.basic), Depth: '1' } });
    expect(list.status).toBe(207);
    const body = await list.text();
    expect(body).toContain('/webdav/uploads/a%23b%25.txt');
    const hrefMatch = body.match(/<d:href>(\/webdav\/uploads\/[^<]+)<\/d:href>/);
    expect(hrefMatch).toBeTruthy();
    expect(() => decodeURIComponent(hrefMatch![1].split('/').pop()!)).not.toThrow();
    expect(decodeURIComponent(hrefMatch![1].split('/').pop()!)).toBe(name);

    // GET 取回
    const get = await request(ctx, putUrl, { headers: dav(k.basic) });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('weird-content');
  });

  it('MKCOL 递归补齐缺失祖先目录行；PUT 也补父（P1-3.5 / P0-3）', async () => {
    const k = await createDavKey('davmkcol');
    const mk = await request(ctx, `/webdav/uploads/${encodeURIComponent('deep')}/${encodeURIComponent('nest')}/${encodeURIComponent('dir')}`, {
      method: 'MKCOL',
      headers: dav(k.basic),
    });
    expect(mk.status).toBe(201);
    const rows = ctx.db.prepare(
      `SELECT path FROM file_metadata WHERE type = 'folder' AND path IN ('/uploads/deep', '/uploads/deep/nest', '/uploads/deep/nest/dir')`
    ).all();
    expect(rows.length).toBe(3);
    // 重复创建 → 405
    const again = await request(ctx, '/webdav/uploads/deep', { method: 'MKCOL', headers: dav(k.basic) });
    expect(again.status).toBe(405);

    // PUT 深路径无需先 MKCOL
    const put = await request(ctx, `/webdav/uploads/${encodeURIComponent('deep')}/${encodeURIComponent('nest')}/auto.txt`, {
      method: 'PUT',
      headers: dav(k.basic),
      body: 'auto-parents',
    });
    expect(put.status).toBe(201);
  });

  it('MOVE Overwrite: T 覆盖目标；Overwrite: F 遇同名 412', async () => {
    const k = await createDavKey('davmove');
    const base = { Authorization: k.basic, Host: 'localhost:8787' };
    await request(ctx, '/webdav/uploads/m-a.txt', { method: 'PUT', headers: base, body: 'a-content' });
    await request(ctx, '/webdav/uploads/m-b.txt', { method: 'PUT', headers: base, body: 'b-content' });

    // 默认 Overwrite: T（RFC 4918）
    const move = await request(ctx, '/webdav/uploads/m-a.txt', {
      method: 'MOVE',
      headers: { ...base, Destination: 'http://localhost:8787/webdav/uploads/m-b.txt' },
    });
    expect(move.status).toBe(201);
    const getB = await request(ctx, '/webdav/uploads/m-b.txt', { headers: base });
    expect(await getB.text()).toBe('a-content');
    const getA = await request(ctx, '/webdav/uploads/m-a.txt', { headers: base });
    expect(getA.status).toBe(404);

    // Overwrite: F + 目标存在 → 412
    await request(ctx, '/webdav/uploads/m-c.txt', { method: 'PUT', headers: base, body: 'c-content' });
    const moveF = await request(ctx, '/webdav/uploads/m-c.txt', {
      method: 'MOVE',
      headers: { ...base, Destination: 'http://localhost:8787/webdav/uploads/m-b.txt', Overwrite: 'F' },
    });
    expect(moveF.status).toBe(412);
  });

  it('数据层所有者隔离：PROPFIND/GET 看不到他人文件', async () => {
    const a = await createDavKey('davownera');
    const b = await createDavKey('davownerb');
    await request(ctx, '/webdav/uploads/only-a.txt', { method: 'PUT', headers: dav(a.basic), body: 'secret-a' });

    const listB = await request(ctx, '/webdav/uploads/', { method: 'PROPFIND', headers: { ...dav(b.basic), Depth: '1' } });
    const bodyB = await listB.text();
    expect(bodyB).not.toContain('only-a.txt');

    const getB = await request(ctx, '/webdav/uploads/only-a.txt', { headers: dav(b.basic) });
    expect(getB.status).toBe(404);

    const getA = await request(ctx, '/webdav/uploads/only-a.txt', { headers: dav(a.basic) });
    expect(getA.status).toBe(200);
    expect(await getA.text()).toBe('secret-a');
  });
});
