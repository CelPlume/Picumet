// S3 兼容网关端到端回归：真实 @aws-sdk/client-s3 通过本地 HTTP 桥接打到 app.fetch
// 验证 SigV4（整包 hex payload / UNSIGNED-PAYLOAD 预签名 / 签名篡改）、对象 CRUD、列举、协议面。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';

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

    // 元数据行 + 祖先目录行（P0-3 约定）
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
});
