// S3 兼容网关端到端验证：真实 @aws-sdk/client-s3 通过本地 HTTP 桥接打到 app.fetch
// 验证 SigV4（整包 hex payload / UNSIGNED-PAYLOAD 预签名 / 签名篡改）、对象 CRUD、列举、协议面。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, GetObjectAclCommand, PutObjectAclCommand,
  DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';
import { invalidateSettingsCache } from '../src/db/repos/system';

let ctx: TestContext;
let server: http.Server;
let port: number;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }
    const fetchReq = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
      method: req.method,
      headers,
      body: bodyBuf,
    });
    const fetchRes = await ctx.app.fetch(fetchReq, ctx.env, {} as ExecutionContext);
    res.statusCode = fetchRes.status;
    fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await fetchRes.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface S3KeyBundle {
  client: S3Client;
  keyId: string;
  secret: string;
}

async function createS3Key(username: string, protocols: string[] = ['s3']): Promise<S3KeyBundle> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 's3gw', permissions: ['read', 'write', 'delete'], protocols, uploadPath: '/uploads' },
  });
  expect(res.status).toBe(201);
  const data = await json(res) as { data: { key: { keyId: string; secret: string } } };
  const keyId = data.data.key.keyId;
  const secret = data.data.key.secret;
  await grantApiKeyRule(ctx, keyId, ['read', 'write', 'delete'], '/uploads/**');
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}/s3`,
    region: 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
  });
  return { client, keyId, secret };
}

describe('S3 兼容网关（真实 AWS SDK，SigV4）', () => {
  it('PutObject → 元数据/目录行落库 → GetObject/HeadObject 内容一致', async () => {
    const { client } = await createS3Key('s3gwcrud');
    const body = Buffer.from('s3gw-object-content');
    const put = await client.send(new PutObjectCommand({
      Bucket: 'uploads', Key: '2024/09/s3 pic.png', Body: body, ContentType: 'image/png',
    }));
    expect(put.$metadata.httpStatusCode).toBe(200);

    const get = await client.send(new GetObjectCommand({ Bucket: 'uploads', Key: '2024/09/s3 pic.png' }));
    expect(get.Body).toBeDefined();
    expect(Buffer.from(await get.Body!.transformToByteArray()).toString()).toBe('s3gw-object-content');
    expect(get.ContentType).toBe('image/png');

    const head = await client.send(new HeadObjectCommand({ Bucket: 'uploads', Key: '2024/09/s3 pic.png' }));
    expect(head.ContentLength).toBe(body.byteLength);
    expect(head.ETag).toBeTruthy();

    // 元数据行 + 祖先目录行（缺目录行的文件在列表/PROPFIND 中不可见）
    const rows = ctx.db.prepare(
      `SELECT path, name, type FROM file_metadata WHERE name IN ('2024', '09', 's3 pic.png') ORDER BY path`
    ).all() as Array<{ name: string; type: string }>;
    expect(rows.map((r) => `${r.type}:${r.name}`)).toEqual(['folder:2024', 'folder:09', 'file:s3 pic.png']);
    client.destroy();
  });

  it('ListBuckets / ListObjectsV2（delimiter） / DeleteObjects / DeleteObject', async () => {
    const { client } = await createS3Key('s3gwlist');
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'a/one.txt', Body: 'one' }));
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'a/two.txt', Body: 'two' }));

    const buckets = await client.send(new ListBucketsCommand({}));
    expect((buckets.Buckets ?? []).map((b) => b.Name)).toContain('uploads');

    const list = await client.send(new ListObjectsV2Command({ Bucket: 'uploads', Prefix: 'a/', Delimiter: '/' }));
    expect((list.Contents ?? []).map((o) => o.Key)).toEqual(['a/one.txt', 'a/two.txt']);

    const multi = await client.send(new DeleteObjectsCommand({
      Bucket: 'uploads',
      Delete: { Objects: [{ Key: 'a/one.txt' }, { Key: 'a/two.txt' }] },
    }));
    expect((multi.Deleted ?? []).length).toBe(2);

    // 删除不存在的 key 仍 204（S3 语义）
    const single = await client.send(new DeleteObjectCommand({ Bucket: 'uploads', Key: 'a/one.txt' }));
    expect(single.$metadata.httpStatusCode).toBe(204);
    client.destroy();
  });

  it('预签名 GET 可匿名下载（query 验签）；篡改签名被拒', async () => {
    const { client } = await createS3Key('s3gwpresign');
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'presign.txt', Body: 'presigned!' }));
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'uploads', Key: 'presign.txt' }), { expiresIn: 60 });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('presigned!');

    const bad = new URL(url);
    bad.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    const badRes = await fetch(bad);
    expect(badRes.status).toBe(403);
    client.destroy();
  });

  it('错误 secret → 拒绝；未授权 s3 协议的密钥 → AccessDenied', async () => {
    const { keyId } = await createS3Key('s3gwbad');
    const badClient = new S3Client({
      endpoint: `http://127.0.0.1:${port}/s3`,
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: keyId, secretAccessKey: 'sk_wrongsecret' },
    });
    await expect(badClient.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'x.txt', Body: 'x' }))).rejects.toThrow();
    badClient.destroy();

    const noS3 = await createS3Key('s3gwnos3', ['api']);
    await expect(noS3.client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'y.txt', Body: 'y' }))).rejects.toThrow();
    noS3.client.destroy();
  });

  // content-length 超限在读取 body 之前拒绝。真实 AWS SDK 会把 content-length 签入
  // SignedHeaders 且 HTTP 桥接服务端会完整缓冲 body（声明 200MB 只发几十字节会让桥接挂起），
  // 因此这里按 sigv4.ts 的 canonical request 规则手工构造最小签名（仅 x-amz-content-sha256/x-amz-date），
  // 直接调用 app.fetch 发送伪造 content-length 的签名 PUT。
  it('签名 PUT 声明超大 content-length → 400 InvalidRequest 且不读 body', async () => {
    const { keyId, secret } = await createS3Key('s3gwoversize');
    const body = Buffer.from('tiny-payload');
    const path = '/s3/uploads/2024/09/oversize.bin';
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/auto/s3/aws4_request`;
    const canonicalRequest = [
      'PUT',
      path,
      '',
      `x-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
      'x-amz-content-sha256;x-amz-date',
      payloadHash,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
    const kRegion = createHmac('sha256', kDate).update('auto').digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const req = new Request(`http://localhost:8787${path}`, {
      method: 'PUT',
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=x-amz-content-sha256;x-amz-date, Signature=${signature}`,
        'content-length': '209715200', // 声明 200MB，实际 body 极小
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      },
      body,
    });
    const res = await ctx.app.fetch(req, ctx.env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const xml = await res.text();
    expect(xml).toContain('<Code>InvalidRequest</Code>');
    expect(xml).toContain('请求体过大，请使用 UNSIGNED-PAYLOAD 或 multipart 上传');
    // 上限在读取 body 前生效：请求体未被消耗
    expect(req.bodyUsed).toBe(false);
  });

  // 整包校验算出的哈希经 s3PayloadHash 复用为 contentHash → 小签名 PUT 仍走内容寻址去重
  it('小签名 PUT 上传后内容寻址去重仍命中（同内容跨 key 共享对象）', async () => {
    const { client } = await createS3Key('s3gwdedup');
    const body = Buffer.from('dedup-content-payload');
    const first = await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'dup/a.bin', Body: body }));
    expect(first.$metadata.httpStatusCode).toBe(200);
    const second = await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'dup/b.bin', Body: body }));
    expect(second.$metadata.httpStatusCode).toBe(200);

    // 第二次上传的访问日志记录 deduped=true（已知哈希 → 去重命中，未写对象）
    const logs = ctx.db.prepare(
      `SELECT path, metadata FROM access_logs WHERE action = 'upload' AND path IN ('/uploads/dup/a.bin', '/uploads/dup/b.bin') ORDER BY path`
    ).all() as Array<{ path: string; metadata: string }>;
    expect(logs.map((l) => JSON.parse(l.metadata).deduped)).toEqual([false, true]);

    // 两个文件行共享同一内容键（blob_hash 相同）
    const files = ctx.db.prepare(
      `SELECT name, blob_hash FROM file_metadata WHERE path = '/uploads/dup' AND type = 'file' ORDER BY name`
    ).all() as Array<{ name: string; blob_hash: string | null }>;
    expect(files.map((f) => f.name)).toEqual(['a.bin', 'b.bin']);
    expect(files[0].blob_hash).toBeTruthy();
    expect(files[0].blob_hash).toBe(files[1].blob_hash);

    const get = await client.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'dup/b.bin' }));
    expect(get.Body).toBeDefined();
    expect(Buffer.from(await get.Body!.transformToByteArray()).toString()).toBe('dedup-content-payload');
    client.destroy();
  });
});

// MinIO 式根路径入口：minio-go 只接受 host[:port]（无路径前缀），S3 API 挂在站点根，
// 以 SigV4 签名（Authorization 头 / X-Amz-Signature 预签名参数）判别，其余请求走常规路由
describe('S3 根路径入口（MinIO 式，无 /s3 前缀）', () => {
  const createRootClient = async (username: string): Promise<S3KeyBundle> => {
    const bundle = await createS3Key(username);
    bundle.client.destroy();
    bundle.client = new S3Client({
      endpoint: `http://127.0.0.1:${port}`, // 无 /s3 前缀
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: bundle.keyId, secretAccessKey: bundle.secret },
    });
    return bundle;
  };

  it('签名 PUT/GET/HEAD/ListBuckets 全部走根路径（bucket 即路径首段）', async () => {
    const { client } = await createRootClient('s3rootcrud');
    const body = Buffer.from('s3root-object');
    const put = await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'root/x.txt', Body: body }));
    expect(put.$metadata.httpStatusCode).toBe(200);

    const get = await client.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'root/x.txt' }));
    expect(Buffer.from(await get.Body!.transformToByteArray()).toString()).toBe('s3root-object');

    const head = await client.send(new HeadObjectCommand({ Bucket: 'uploads', Key: 'root/x.txt' }));
    expect(head.ContentLength).toBe(body.byteLength);

    const buckets = await client.send(new ListBucketsCommand({}));
    expect((buckets.Buckets ?? []).map((b) => b.Name)).toContain('uploads');
    client.destroy();
  });

  it('根路径预签名 GET 可匿名下载', async () => {
    const { client } = await createRootClient('s3rootpresign');
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'root/presign.txt', Body: 'root-presigned!' }));
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'uploads', Key: 'root/presign.txt' }), { expiresIn: 60 });
    expect(url).not.toContain('/s3');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('root-presigned!');
    client.destroy();
  });

  it('占用冲突（他人文件）→ 409 OperationAborted XML（业务异常经 onError 映射，非裸 500）', async () => {
    const a = await createRootClient('s3rootowner');
    const b = await createRootClient('s3rootintruder');
    await a.client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'conf/owner.bin', Body: 'owner-a' }));
    await expect(b.client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'conf/owner.bin', Body: 'intruder' })))
      .rejects.toThrow(/409|OperationAborted|已被其他用户占用/);
    // a 的对象完好
    const get = await a.client.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'conf/owner.bin' }));
    expect(Buffer.from(await get.Body!.transformToByteArray()).toString()).toBe('owner-a');
    a.client.destroy();
    b.client.destroy();
  });

  it('未签名的根路径请求不进入 S3 网关（保持常规路由语义）', async () => {
    const res = await ctx.app.fetch(new Request('http://localhost:8787/uploads'), ctx.env, {} as ExecutionContext);
    const text = await res.text();
    // S3 匿名错误形如 <Error><Code>AccessDenied</Code>…匿名访问被拒绝 —— 不应出现
    expect(text).not.toContain('匿名访问被拒绝');
    expect(res.headers.get('content-type')).not.toContain('xml');
  });
});

// 对象级 ACL：x-amz-acl / ?acl 子资源映射为行级 guest_visibility（平台语义：匿名读仍由
// guest_visibility + 站点「允许访客」决定，不引入第二套授权模型）
describe('对象级 ACL（x-amz-acl ↔ guest_visibility）', () => {
  const enableGuest = (): void => {
    ctx.db.prepare(`UPDATE system_settings SET value = 'true' WHERE key = 'allow_guest_access'`).run();
    invalidateSettingsCache();
  };

  it('PutObject 带 public-read → 行级 view，匿名 GET 直链 200；private → none 拒绝', async () => {
    enableGuest();
    const { client } = await createS3Key('s3gwacl');
    const put = await client.send(
      new PutObjectCommand({ Bucket: 'uploads', Key: 'acl/pub.txt', Body: 'acl-public', ACL: 'public-read' })
    );
    expect(put.$metadata.httpStatusCode).toBe(200);
    const row = ctx.db
      .prepare(`SELECT guest_visibility FROM file_metadata WHERE path = '/uploads/acl' AND name = 'pub.txt'`)
      .get() as { guest_visibility: string | null };
    expect(row.guest_visibility).toBe('view');

    // 匿名直链（path-serve，非网关）：/uploads/acl/pub.txt
    const anon = await fetch(`http://127.0.0.1:${port}/uploads/acl/pub.txt`);
    expect(anon.status).toBe(200);
    expect(await anon.text()).toBe('acl-public');

    // private 覆盖同一对象 → 匿名 403
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'acl/pub.txt', Body: 'acl-private', ACL: 'private' }));
    const row2 = ctx.db
      .prepare(`SELECT guest_visibility FROM file_metadata WHERE path = '/uploads/acl' AND name = 'pub.txt'`)
      .get() as { guest_visibility: string | null };
    expect(row2.guest_visibility).toBe('none');
    const anon2 = await fetch(`http://127.0.0.1:${port}/uploads/acl/pub.txt`);
    expect(anon2.status).toBe(403);
    client.destroy();
  });

  it('无 ACL 头 → 保持目录继承（祖先 view 时匿名可读）；GetObjectAcl 返回派生的 AllUsers READ', async () => {
    enableGuest();
    const { client } = await createS3Key('s3gwaclinherit');
    // 祖先目录设 view（模拟管理端「游客查看+下载」）
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'inherit/seed.txt', Body: 'seed' }));
    ctx.db.prepare(`UPDATE file_metadata SET guest_visibility = 'view' WHERE path = '/uploads/inherit' AND type = 'folder'`).run();
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'inherit/child.txt', Body: 'inherited' }));
    const row = ctx.db
      .prepare(`SELECT guest_visibility FROM file_metadata WHERE path = '/uploads/inherit' AND name = 'child.txt'`)
      .get() as { guest_visibility: string | null };
    expect(row.guest_visibility).toBe('view');
    const anon = await fetch(`http://127.0.0.1:${port}/uploads/inherit/child.txt`);
    expect(anon.status).toBe(200);

    const acl = await client.send(new GetObjectAclCommand({ Bucket: 'uploads', Key: 'inherit/child.txt' }));
    expect(acl.$metadata.httpStatusCode).toBe(200);
    const grants = acl.Grants ?? [];
    expect(grants.some((g) => g.Grantee?.URI?.includes('AllUsers') && g.Permission === 'READ')).toBe(true);
    expect(grants.some((g) => g.Permission === 'FULL_CONTROL')).toBe(true);
    client.destroy();
  });

  it('PutObjectAcl（?acl，头与 XML）改可见性，之后匿名读放行/拒绝随之变化', async () => {
    enableGuest();
    const { client } = await createS3Key('s3gwaclput');
    await client.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'aclput/a.txt', Body: 'acl-put' }));

    await client.send(new PutObjectAclCommand({ Bucket: 'uploads', Key: 'aclput/a.txt', ACL: 'public-read' }));
    expect((await fetch(`http://127.0.0.1:${port}/uploads/aclput/a.txt`)).status).toBe(200);

    await client.send(
      new PutObjectAclCommand({
        Bucket: 'uploads',
        Key: 'aclput/a.txt',
        AccessControlPolicy: {
          Owner: { ID: 'x' },
          Grants: [{ Grantee: { Type: 'CanonicalUser', ID: 'x' }, Permission: 'FULL_CONTROL' }],
        },
      })
    );
    expect((await fetch(`http://127.0.0.1:${port}/uploads/aclput/a.txt`)).status).toBe(403);
    client.destroy();
  });
});
