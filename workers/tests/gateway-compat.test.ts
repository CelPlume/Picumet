// 网关密钥兼容面：嵌套路径直链 / 同名覆盖 / 祖先目录行补齐 / 协议面限制 / Lsky 壳 / 所有者隔离
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

describe('网关密钥兼容面', () => {
  it('嵌套路径自动补齐祖先目录行（含特殊字符文件名）', async () => {
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

  it('同名重传覆盖成功，对象未丢、used_files 只加一次', async () => {
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

  it('X-File-Name 携带嵌套路径段可拆分；签名直链可匿名取回，无签名直取需登录', async () => {
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
    // 无签名直取 → 匿名游客闸门：站点未开放游客访问时 401 引导登录（签名是能力令牌，不受此限）
    const noSign = await fetchDirect('/uploads/2024/09/nested%20raw.txt');
    expect(noSign.status).toBe(401);
    expect((await json(noSign)).error.code).toBe('LOGIN_REQUIRED');
  });

  it('protocols 不含 api 的密钥上传被 403 拒绝', async () => {
    const k = await createKey('gwproto', { protocols: ['webdav'] });
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(k.fullToken),
      body: multipart('x.png', 'x'),
    });
    expect(res.status).toBe(403);
  });

  it('Lsky V2 壳：Bearer 与裸 token 皆可；返回 data.links.url 与 key', async () => {
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
    // MinIO/minio-go 只接受 host[:port]（路径前缀无法通过 SigV4 验签）→ endpoint = 裸基址
    expect(k.configs.s3?.endpoint).toBe('http://localhost:8787');
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

  // UI 创建的密钥没有任何路径规则：权限引擎第 9 步按属主 defaultPath/defaultPermissions 兜底
  // （第 4 步密钥权限交集 + 各入口 assertKeyScope 上传根），无需管理员手工建规则即可用
  it('无路径规则的密钥：属主 defaultPath 内可读写（引擎属主兜底），范围外仍 403', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'norule');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'k', permissions: ['read', 'write', 'delete'], protocols: ['api', 's3'], uploadPath: '/uploads' },
    });
    expect(res.status).toBe(201);
    const data = await json(res) as { data: { key: { fullToken: string } } };
    const token = data.data.key.fullToken;

    // compat 上传不建规则直接可用
    const up = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(token),
      body: multipart('norule.txt', 'no-rule-upload'),
    });
    expect(up.status).toBe(200);

    // 密钥上传根之外 → assertKeyScope 403（引擎兜底不放大密钥作用域）
    const outside = await request(ctx, '/api/compat/file?path=/etc', { headers: bearer(token) });
    expect([403, 404]).toContain(outside.status);

    // S3 网关同语义（根路径入口）：无规则密钥 PUT 200
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/auto/s3/aws4_request`;
    const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('s3-norule'));
    const hashHex = [...new Uint8Array(payloadHash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const { createHash, createHmac } = await import('node:crypto');
    const canonicalRequest = ['PUT', '/uploads/s3-norule.txt', '', `x-amz-content-sha256:${hashHex}\nx-amz-date:${amzDate}\n`, 'x-amz-content-sha256;x-amz-date', hashHex].join('\n');
    const secret = (data.data as { key: { fullToken: string } }).key.fullToken.split('.')[1];
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
    const kRegion = createHmac('sha256', kDate).update('auto').digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const keyId = token.split('.')[0];
    const s3res = await ctx.app.fetch(new Request('http://localhost:8787/uploads/s3-norule.txt', {
      method: 'PUT',
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=x-amz-content-sha256;x-amz-date, Signature=${signature}`,
        'x-amz-content-sha256': hashHex,
        'x-amz-date': amzDate,
      },
      body: 's3-norule',
    }), ctx.env, {} as ExecutionContext);
    expect(s3res.status).toBe(200);
  });


  it('user_space 挂载：普通用户密钥默认上传根 = 用户空间目录，越界 uploadPath 400', async () => {
    await ctx.db.exec(`UPDATE mounts SET upload_mode = 'user_space' WHERE mount_path = '/'`);
    try {
      const { authCookie } = await registerAndLogin(ctx, 'spacedef');
      await ctx.db.exec(`UPDATE users SET default_path = '/public' WHERE username = 'spacedef'`);
      const csrf = await getCsrf(ctx, authCookie);
      // 不传 uploadPath → 默认落到用户空间目录
      const res = await request(ctx, '/api/keys', {
        method: 'POST',
        cookie: authCookie,
        headers: { 'X-CSRF-Token': csrf },
        body: { name: 'k1', permissions: ['read', 'write'], protocols: ['api'] },
      });
      expect(res.status).toBe(201);
      const data = await json(res) as { data: { key: { uploadPath: string }; configs: { s3?: { keyPrefixHint?: string }; bearer?: { pathHint?: string } } } };
      expect(data.data.key.uploadPath).toBe('/public/spacedef');
      expect(data.data.configs.bearer?.pathHint).toBe('/public/spacedef/');
      expect(data.data.configs.s3?.keyPrefixHint).toBe('spacedef/');

      // 显式越界 → 400
      const bad = await request(ctx, '/api/keys', {
        method: 'POST',
        cookie: authCookie,
        headers: { 'X-CSRF-Token': csrf },
        body: { name: 'k2', permissions: ['read', 'write'], protocols: ['api'], uploadPath: '/somewhere' },
      });
      expect(bad.status).toBe(400);
    } finally {
      await ctx.db.exec(`UPDATE mounts SET upload_mode = 'free' WHERE mount_path = '/'`);
    }
  });

  // 对话框默认模板 `/uploads/{year}/{month}/`：渲染后的目标必须落进「渲染后的上传根」，
  // 且对象真实落在 /uploads/<年>/<月>/ 下（回归：此前拿未渲染模板做边界，模板密钥全部 403）
  it('模板上传根（{year}/{month}）真实落到 /uploads/<年>/<月>/', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'tplscope');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'k', permissions: ['read', 'write'], protocols: ['api'], uploadPath: '/uploads/{year}/{month}/' },
    });
    expect(res.status).toBe(201);
    const data = await json(res) as { data: { key: { fullToken: string } } };
    const up = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: bearer(data.data.key.fullToken),
      body: multipart('tpl.png', 'template-payload'),
    });
    expect(up.status).toBe(200);
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const data2 = await json(up) as { data: { path: string } };
    expect(data2.data.path).toBe(`/uploads/${now.getFullYear()}/${mm}/tpl.png`);
  });
});
