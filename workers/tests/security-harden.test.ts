// 安全加固约束：
//   注册 OTP 必须来自 CSPRNG（6 位、调用间不同）
//   AList fs/get 直链签名 24h 过期；过期签名被 verifyPathSign 拒绝
//   分享密码验证严格限流（5 次/分钟/分享/IP）+ 失败冷却（9 次/10 分钟）+ 成功后清零
//   S3 网关 UNSIGNED-PAYLOAD 体积策略（>100MiB → 400 / 缺 Content-Length → 411 / 0 → 放行）
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import * as smtp from '../src/utils/smtp';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';
import { checkLimit } from '../src/middleware/rate-limit';
import { signPath, verifyPathSign } from '../src/utils/crypto';
import type { Env } from '../src/shared/types';

const { sendMailMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn(async (_config: smtp.SmtpConfig, _to: string, _subject: string, _html: string) => undefined),
}));

vi.mock('../src/utils/smtp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/smtp')>();
  return { ...actual, sendMail: sendMailMock };
});

interface ApiFail {
  error: { code: string; message: string };
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockImplementation(async () => undefined);
});

function setSetting(key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now());
}

// ============ 注册验证码 CSPRNG ============

describe('注册验证码 CSPRNG', () => {
  it('下发的验证码为 6 位数字，且多次调用取值不同', async () => {
    setSetting('smtp_host', '"smtp.test"');
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const email = `otp-sec-${i}-${Date.now()}@test.local`;
      const res = await request(ctx, '/api/auth/register/send-otp', { method: 'POST', body: { email } });
      expect(res.status).toBe(200);
      const code = await ctx.kv.get(`email:otp:register:${email}`);
      expect(code).toMatch(/^\d{6}$/);
      if (code === null) throw new Error('未写入验证码');
      codes.push(code);
    }
    // 4 次独立采样全部相同的概率约 1e-24，可忽略
    expect(new Set(codes).size).toBeGreaterThan(1);
    expect(sendMailMock).toHaveBeenCalledTimes(4);
  });
});

// ============ AList 直链签名 24h 过期 ============

describe('AList 直链签名有效期', () => {
  it('fs/get 签名 expiresAt 落在 24h 内；过期签名被 verifyPathSign 拒绝', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'alistseckey');
    const csrf = await getCsrf(ctx, authCookie);
    const keyRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'alist-sec', permissions: ['read', 'write', 'delete'], protocols: ['api'], uploadPath: '/uploads' },
    });
    expect(keyRes.status).toBe(201);
    const keyData = await json<{ data: { key: { keyId: string; secret: string } } }>(keyRes);
    const keyId = keyData.data.key.keyId;
    const token = `${keyId}.${keyData.data.key.secret}`;
    await grantApiKeyRule(ctx, keyId, ['read', 'write', 'delete'], '/uploads/**');

    const filePath = '/uploads/alist-sec/pic.png';
    const form = new FormData();
    form.append('file', new File([new Blob(['alist-sec-content'])], 'pic.png', { type: 'image/png' }));
    const upload = await request(ctx, '/openlist/api/fs/form', {
      method: 'PUT',
      headers: { Authorization: token, 'File-Path': encodeURIComponent(filePath) },
      body: form,
    });
    expect(upload.status).toBe(200);

    const before = Date.now();
    const getRes = await request(ctx, '/openlist/api/fs/get', {
      method: 'POST',
      headers: { Authorization: token },
      body: { path: filePath },
    });
    const getData = await json<{ code: number; data: { sign: string } }>(getRes);
    expect(getData.code).toBe(200);
    const expiresAt = Number(getData.data.sign.slice(0, getData.data.sign.indexOf('.')));
    // 非长期有效（0），且不超过 24h（留 1 分钟时钟余量）
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(before + 24 * 3600 * 1000 + 60_000);

    // 过期签名（expiresAt 在过去）必须被拒绝
    const secret = ctx.env.ENCRYPTION_KEY;
    const expired = await signPath(filePath, secret, Date.now() - 1000);
    expect(await verifyPathSign(filePath, secret, expired)).toBe(false);
  });
});

// ============ 分享密码验证限流 + 失败冷却 ============

/** 上传一个文件，返回文件行（仅取测试用到的字段） */
async function uploadFile(cookie: string, fileName: string, content: string): Promise<{ id: string }> {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(ctx, cookie);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: '/', fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initData = await json<{ data: { sessionId: string } }>(initRes);
  await request(ctx, `/api/files/upload/raw/${initData.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.data.sessionId, etag: 'etag' },
  });
  const complete = await json<{ data: { file: { id: string } } }>(completeRes);
  return complete.data.file;
}

/** 属主创建分享，返回 shareId */
async function createShare(cookie: string, body: Record<string, unknown>): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const res = await request(ctx, '/api/shares', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body,
  });
  expect(res.status).toBe(201);
  const created = await json<{ data: { share: { id: string } } }>(res);
  return created.data.share.id;
}

/** 生产环境下的直接 fetch（其余并发 slice 不改本文件，环境切换仅在请求级生效） */
async function prodFetch(path: string, payload: unknown): Promise<Response> {
  return await ctx.app.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { ...ctx.env, ENVIRONMENT: 'production' } as unknown as Env,
    {} as ExecutionContext
  );
}

describe('分享密码验证限流与失败冷却', () => {
  it('非生产环境：连续错误密码不会被分享级限流拦截', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'svdev');
    const file = await uploadFile(authCookie, 'svdev.txt', 'x');
    const shareId = await createShare(authCookie, { fileIds: [file.id], password: 'correct-pw' });
    for (let i = 0; i < 6; i++) {
      const res = await request(ctx, `/api/shares/${shareId}/verify`, { method: 'POST', body: { password: 'wrong' } });
      expect(res.status).toBe(401);
    }
  });

  it('生产环境：同一分享+IP 超出 5 次/分钟 → 429', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'svlimit');
    const file = await uploadFile(authCookie, 'svlimit.txt', 'x');
    const shareId = await createShare(authCookie, { fileIds: [file.id], password: 'correct-pw' });
    for (let i = 0; i < 5; i++) {
      const res = await prodFetch(`/api/shares/${shareId}/verify`, { password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const sixth = await prodFetch(`/api/shares/${shareId}/verify`, { password: 'wrong' });
    expect(sixth.status).toBe(429);
    expect((await json<ApiFail>(sixth)).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('生产环境：累计 9 次失败后第 10 次进入冷却 → 429（即使密码正确）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'svcooldown');
    const file = await uploadFile(authCookie, 'svcooldown.txt', 'x');
    const shareId = await createShare(authCookie, { fileIds: [file.id], password: 'correct-pw' });
    const failKey = `svfail:${shareId}:127.0.0.1`;
    for (let i = 0; i < 9; i++) {
      expect(await checkLimit(ctx.env.KV, failKey, 9, 600_000)).toBe(true);
    }
    const res = await prodFetch(`/api/shares/${shareId}/verify`, { password: 'correct-pw' });
    expect(res.status).toBe(429);
    expect((await json<ApiFail>(res)).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('生产环境：成功验证清零失败冷却计数', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'svreset');
    const file = await uploadFile(authCookie, 'svreset.txt', 'x');
    const shareId = await createShare(authCookie, { fileIds: [file.id], password: 'correct-pw' });
    const failKey = `svfail:${shareId}:127.0.0.1`;
    for (let i = 0; i < 8; i++) {
      expect(await checkLimit(ctx.env.KV, failKey, 9, 600_000)).toBe(true);
    }
    const ok = await prodFetch(`/api/shares/${shareId}/verify`, { password: 'correct-pw' });
    expect(ok.status).toBe(200);
    // 清零后应能重新累计满 9 次（未清零时第 2 次即被拒）
    for (let i = 0; i < 9; i++) {
      expect(await checkLimit(ctx.env.KV, failKey, 9, 600_000)).toBe(true);
    }
  });

  it('生产环境：verify-file 同样受分享级 5 次/分钟限流', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'svfilelimit');
    const file = await uploadFile(authCookie, 'svfilelimit.txt', 'x');
    const csrf = await getCsrf(ctx, authCookie);
    const setPwd = await request(ctx, `/api/files/${file.id}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { accessPassword: 'file-pw' },
    });
    expect(setPwd.status).toBe(200);
    const shareId = await createShare(authCookie, { fileIds: [file.id] });
    for (let i = 0; i < 5; i++) {
      const res = await prodFetch(`/api/shares/${shareId}/verify-file`, { itemId: file.id, password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const sixth = await prodFetch(`/api/shares/${shareId}/verify-file`, { itemId: file.id, password: 'wrong' });
    expect(sixth.status).toBe(429);
  });
});

// ============ S3 UNSIGNED-PAYLOAD 体积策略 ============

async function createS3Key(username: string): Promise<{ keyId: string; secret: string }> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 's3-sec', permissions: ['read', 'write', 'delete'], protocols: ['s3'], uploadPath: '/uploads' },
  });
  expect(res.status).toBe(201);
  const data = await json<{ data: { key: { keyId: string; secret: string } } }>(res);
  await grantApiKeyRule(ctx, data.data.key.keyId, ['read', 'write', 'delete'], '/uploads/**');
  return data.data.key;
}

/**
 * 手工构造 SigV4 头签名请求（仅签 x-amz-content-sha256;x-amz-date，规则与 sigv4.ts 的
 * canonical request 一致）。content-length 不参与签名，便于覆盖 UNSIGNED-PAYLOAD 分支。
 */
function signedS3Request(opts: {
  method: string;
  path: string;
  keyId: string;
  secret: string;
  payloadHash: string;
  headers?: Record<string, string>;
}): Request {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const canonicalRequest = [
    opts.method,
    opts.path,
    '',
    `x-amz-content-sha256:${opts.payloadHash}\nx-amz-date:${amzDate}\n`,
    'x-amz-content-sha256;x-amz-date',
    opts.payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const kDate = createHmac('sha256', `AWS4${opts.secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update('auto').digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return new Request(`http://localhost:8787${opts.path}`, {
    method: opts.method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${opts.keyId}/${scope}, SignedHeaders=x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      'x-amz-content-sha256': opts.payloadHash,
      'x-amz-date': amzDate,
      ...(opts.headers ?? {}),
    },
  });
}

describe('S3 UNSIGNED-PAYLOAD 体积策略', () => {
  it('Content-Length > 100 MiB → 400 InvalidRequest 且不读 body', async () => {
    const { keyId, secret } = await createS3Key('s3secbig');
    const req = signedS3Request({
      method: 'PUT',
      path: '/s3/uploads/2025/big.bin',
      keyId,
      secret,
      payloadHash: 'UNSIGNED-PAYLOAD',
      headers: { 'content-length': '209715200' },
    });
    const res = await ctx.app.fetch(req, ctx.env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const xml = await res.text();
    expect(xml).toContain('<Code>InvalidRequest</Code>');
    expect(xml).toContain('对象超过 100 MiB 上限，请使用分片上传');
    expect(req.bodyUsed).toBe(false);
  });

  it('缺少 Content-Length（无界/分块）→ 411 MissingContentLength', async () => {
    const { keyId, secret } = await createS3Key('s3secchunked');
    const req = signedS3Request({
      method: 'PUT',
      path: '/s3/uploads/2025/chunked.bin',
      keyId,
      secret,
      payloadHash: 'UNSIGNED-PAYLOAD',
    });
    const res = await ctx.app.fetch(req, ctx.env, {} as ExecutionContext);
    expect(res.status).toBe(411);
    expect(await res.text()).toContain('<Code>MissingContentLength</Code>');
  });

  it('Content-Length: 0 的空对象仍可上传并读回', async () => {
    const { keyId, secret } = await createS3Key('s3seczero');
    const put = await ctx.app.fetch(
      signedS3Request({
        method: 'PUT',
        path: '/s3/uploads/2025/empty.bin',
        keyId,
        secret,
        payloadHash: 'UNSIGNED-PAYLOAD',
        headers: { 'content-length': '0' },
      }),
      ctx.env,
      {} as ExecutionContext
    );
    expect(put.status).toBe(200);

    const get = await ctx.app.fetch(
      signedS3Request({
        method: 'GET',
        path: '/s3/uploads/2025/empty.bin',
        keyId,
        secret,
        payloadHash: 'UNSIGNED-PAYLOAD',
      }),
      ctx.env,
      {} as ExecutionContext
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('');
  });
});
