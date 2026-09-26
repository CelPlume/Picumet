// S3 兼容网关端到端回归：真实 @aws-sdk/client-s3 通过本地 HTTP 桥接打到 app.fetch
// 验证 SigV4（整包 hex payload / UNSIGNED-PAYLOAD 预签名 / 签名篡改）、对象 CRUD、列举、协议面。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
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

  // SEC-09：content-length 超限在读取 body 之前拒绝。真实 AWS SDK 会把 content-length 签入
  // SignedHeaders 且 HTTP 桥接服务端会完整缓冲 body（声明 200MB 只发几十字节会让桥接挂起），
  // 因此这里按 sigv4.ts 的 canonical request 规则手工构造最小签名（仅 x-amz-content-sha256/x-amz-date），
  // 直接调用 app.fetch 发送伪造 content-length 的签名 PUT。
  it('SEC-09：签名 PUT 声明超大 content-length → 400 InvalidRequest 且不读 body', async () => {
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

  // SEC-09：整包校验算出的哈希经 s3PayloadHash 复用为 contentHash → 小签名 PUT 仍走内容寻址去重
  it('SEC-09：小签名 PUT 上传后内容寻址去重仍命中（同内容跨 key 共享对象）', async () => {
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
