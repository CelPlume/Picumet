// 网关密钥兼容面回归：P0-1 直链 / P0-2 覆盖 / P0-3 目录行 / P1-2 协议面 / P1-1 Lsky 壳 / 所有者隔离
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

interface KeyBundle {
  authCookie: string;
  csrf: string;
  fullToken: string;
  keyId: string;
  secret: string;
  configs: { s3?: { endpoint: string; bucketHint?: string }; openlist?: { url: string; token: string }; webdav: { url: string } };
}

async function createKey(username: string, opts: { protocols?: string[]; uploadPath?: string } = {}): Promise<KeyBundle> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: {
      name: 'gw',
      permissions: ['read', 'write', 'delete'],
      protocols: opts.protocols ?? ['webdav', 'api', 's3'],
      uploadPath: opts.uploadPath ?? '/uploads',
    },
  });
  expect(res.status).toBe(201);
  const data = await json(res) as { data: KeyBundle & { key: { fullToken: string; keyId: string; secret: string } } };
  await grantApiKeyRule(ctx, data.data.key.keyId, ['read', 'write', 'delete'], '/uploads/**');
  return {
    authCookie, csrf,
    fullToken: data.data.key.fullToken,
    keyId: data.data.key.keyId,
    secret: data.data.key.secret,
    configs: data.data.configs,
  };
}

function multipart(name: string, content: string, type = 'image/png'): FormData {
  const form = new FormData();
  form.append('file', new File([new Blob([content])], name, { type }));
  return form;
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function fetchDirect(pathAndQuery: string): Promise<Response> {
  return request(ctx, pathAndQuery);
}

describe('网关密钥兼容面（P0/P1 修复）', () => {
  it('P0-3：嵌套路径自动补齐祖先目录行（含特殊字符文件名）', async () => {
    const k = await createKey('gwfolder');
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(k.fullToken),
      body: multipart('2024/06/pic #1.png', 'imgdata'),
    });
    expect(res.status).toBe(200);
    const data = await json(res) as { data: { path: string; url: string } };
    expect(data.data.path).toBe('/uploads/2024/06/pic #1.png');
    const rows = ctx.db.prepare(
      `SELECT path, name FROM file_metadata WHERE type = 'folder' AND path IN ('/uploads', '/uploads/2024', '/uploads/2024/06')`
    ).all() as Array<{ path: string; name: string }>;
    expect(rows.length).toBe(3);
    // 直链可匿名取回
    const u = new URL(data.data.url);
    const direct = await fetchDirect(u.pathname + u.search);
    expect(direct.status).toBe(200);
  });

  it('P0-2：同名重传覆盖成功，对象未丢、used_files 只加一次', async () => {
    const k = await createKey('gwoverwrite');
    const headers = bearer(k.fullToken);
    const r1 = await request(ctx, '/api/upload', { method: 'POST', headers, body: multipart('same.png', 'first') });
    expect(r1.status).toBe(200);
    const d1 = await json(r1) as { data: { url: string } };
    const r2 = await request(ctx, '/api/upload', { method: 'POST', headers, body: multipart('same.png', 'second') });
    expect(r2.status).toBe(200);
    const d2 = await json(r2) as { data: { url: string } };
    expect(d2.data.url).toBe(d1.data.url);
    const u = new URL(d2.data.url);
    const dl = await fetchDirect(u.pathname + u.search);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('second');
    const q = ctx.db.prepare(
      `SELECT u.used_files FROM user_quotas u JOIN users us ON us.id = u.user_id WHERE us.username = 'gwoverwrite'`
    ).get() as { used_files: number };
    expect(Number(q.used_files)).toBe(1);
  });

  it('P0-1 + P1-3.6：X-File-Name 携带嵌套路径段可拆分；私有挂载直链可匿名访问', async () => {
    const k = await createKey('gwnested');
    const content = 'raw-nested-body';
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { ...bearer(k.fullToken), 'Content-Type': 'text/plain', 'X-File-Name': '2024/09/nested raw.txt' },
      body: content,
    });
    expect(res.status).toBe(200);
    const data = await json(res) as { data: { path: string; url: string } };
    expect(data.data.path).toBe('/uploads/2024/09/nested raw.txt');
    expect(data.data.url).toContain('/uploads/2024/09/nested%20raw.txt?sign=');
    const u = new URL(data.data.url);
    const dl = await fetchDirect(u.pathname + u.search);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(content);
    // 无签名直取 → 403（签名是能力令牌）
    const noSign = await fetchDirect('/uploads/2024/09/nested%20raw.txt');
    expect(noSign.status).toBe(403);
  });

  it('P1-2：protocols 不含 api 的密钥被 403 拒绝上传', async () => {
    const k = await createKey('gwproto', { protocols: ['webdav'] });
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(k.fullToken),
      body: multipart('x.png', 'x'),
    });
    expect(res.status).toBe(403);
  });

  it('P1-1：Lsky V2 壳（Bearer 与裸 token 皆可；data.links.url + key）', async () => {
    const k = await createKey('gwlsky');
    const res = await request(ctx, '/api/v1/upload', {
      method: 'POST',
      headers: bearer(k.fullToken),
      body: multipart('lsky.png', 'lsky-content'),
    });
    expect(res.status).toBe(200);
    const data = await json(res) as { status: boolean; data: { key: string; links: { url: string } } };
    expect(data.status).toBe(true);
    expect(data.data.links.url).toContain('/uploads/lsky.png?sign=');
    expect(data.data.key).toBeTruthy();
    const u = new URL(data.data.links.url);
    const dl = await fetchDirect(u.pathname + u.search);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('lsky-content');

    // 裸 token（无 Bearer 前缀，用户自填风格）
    const raw = await request(ctx, '/api/v1/upload', {
      method: 'POST',
      headers: { Authorization: k.fullToken },
      body: multipart('lsky2.png', 'lsky2'),
    });
    expect(raw.status).toBe(200);
    const rawData = await json(raw) as { status: boolean };
    expect(rawData.status).toBe(true);

    // 缺 file 字段 → status:false
    const emptyForm = new FormData();
    const bad = await request(ctx, '/api/v1/upload', { method: 'POST', headers: bearer(k.fullToken), body: emptyForm });
    const badData = await json(bad) as { status: boolean; message: string };
    expect(badData.status).toBe(false);
  });

  it('创建密钥返回 S3 / OpenList 速配信息', async () => {
    const k = await createKey('gwconfigs');
    expect(k.configs.s3?.endpoint).toBe('http://localhost:8787/s3');
    expect(k.configs.s3?.bucketHint).toBe('uploads');
    expect(k.configs.openlist?.url).toBe('http://localhost:8787/openlist');
    expect(k.configs.openlist?.token).toBe(k.fullToken);
  });

  it('数据层所有者隔离：他人同名路径 409 且对象未受影响；互不可见', async () => {
    const a = await createKey('gwownera');
    const b = await createKey('gwownerb');
    const upA = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(a.fullToken),
      body: multipart('owner.png', 'a-content'),
    });
    expect(upA.status).toBe(200);

    // b 覆盖 a 的路径 → 409（冲突在写对象之前判定，a 的对象完好）
    const upB = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(b.fullToken),
      body: multipart('owner.png', 'b-intruder'),
    });
    expect(upB.status).toBe(409);

    // b 读 a 的文件 → 404（不泄露存在性）
    const readB = await request(ctx, `/api/compat/file?path=${encodeURIComponent('/uploads/owner.png')}`, {
      headers: bearer(b.fullToken),
    });
    expect(readB.status).toBe(404);

    // a 自己可读且内容未被破坏
    const readA = await request(ctx, `/api/compat/file?path=${encodeURIComponent('/uploads/owner.png')}`, {
      headers: bearer(a.fullToken),
    });
    expect(readA.status).toBe(200);
    expect(await readA.text()).toBe('a-content');
  });
});
