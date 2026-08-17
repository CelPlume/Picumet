// 自由模式：用户自带对象存储凭据的临时会话（凭据仅存 KV，TTL 自动清理）
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import type { Context } from 'hono';
import { z } from 'zod';
import { UserRepo, LogRepo } from '../db';
import { getDb } from '../middleware/auth';
import { S3Provider } from '../providers';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import { hashPassword, randomString, signJwt } from '../utils/crypto';
import { isPrivateHost } from '../utils/ssrf';
import type { Env, FreeModeSession } from '../types';

const initSchema = z.object({
  type: z.enum(['r2', 's3', 'oracle']),
  endpoint: z.string().min(1).max(500),
  region: z.string().max(100).optional(),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(500),
  secretAccessKey: z.string().min(1).max(500),
  sessionHours: z.number().int().min(1).max(8).default(1),
});

export const freeModeRoutes = new Hono<AppBindings>();

const FM_COOKIE = 'fm_token';
const JWT_TTL = 7 * 24 * 3600;

async function buildProvider(session: FreeModeSession) {
  return new S3Provider({
    name: 'free-mode',
    bucket: session.provider.bucket,
    endpoint: session.provider.endpoint,
    region: session.provider.region || 'auto',
    accessKeyId: session.provider.accessKeyId,
    secretAccessKey: session.provider.secretAccessKey,
  });
}

// ============ 初始化自由模式 ============
freeModeRoutes.post('/init', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = initSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '存储配置无效');

  const host = new URL(parsed.data.endpoint).hostname;
  if (isPrivateHost(host)) throw ApiError.badRequest('不允许使用内网/本地地址');

  // 连通性验证
  const probe = new S3Provider({
    name: 'probe',
    bucket: parsed.data.bucket,
    endpoint: parsed.data.endpoint,
    region: parsed.data.region || 'auto',
    accessKeyId: parsed.data.accessKeyId,
    secretAccessKey: parsed.data.secretAccessKey,
  });
  const test = await probe.testConnection();
  if (!test.connected) {
    throw new ApiError(400, 'OPERATION_FAILED', `存储连接失败：${test.message}`);
  }

  // 创建临时用户（凭据不落库）
  const username = `fm_${randomString(8).toLowerCase()}`;
  const password = randomString(16);
  const user = await UserRepo.createUser(db, {
    username,
    email: `${username}@free.local`,
    passwordHash: hashPassword(password),
    role: 'user',
  });

  const session: FreeModeSession = {
    userId: user.id,
    provider: {
      type: parsed.data.type,
      endpoint: parsed.data.endpoint,
      region: parsed.data.region || 'auto',
      bucket: parsed.data.bucket,
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
    },
    mountPath: '/',
    createdAt: Date.now(),
    expiresAt: Date.now() + parsed.data.sessionHours * 3600 * 1000,
    ip: ipOf(c),
  };

  const ttl = parsed.data.sessionHours * 3600;
  await c.env.KV.put(`fm:${user.id}`, JSON.stringify(session), { expirationTtl: ttl });

  // 签发 JWT + free-mode cookie
  const token = await signJwt({ sub: user.id, username: user.username, role: user.role }, c.env.JWT_SECRET as string, JWT_TTL);
  c.header('Set-Cookie', [
    `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${JWT_TTL}`,
    `${FM_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}`,
  ].join(', '));

  await LogRepo.create(db, {
    userId: user.id,
    action: 'free_mode_init',
    path: '/',
    ipAddress: ipOf(c),
    userAgent: c.req.header('user-agent'),
  });

  return ok(c, {
    user: { id: user.id, username: user.username, role: user.role, defaultPath: '/' },
    expiresAt: session.expiresAt,
    sessionHours: parsed.data.sessionHours,
    provider: { type: parsed.data.type, bucket: parsed.data.bucket },
  }, undefined, 201);
});

// ============ 自由模式文件列表 ============
freeModeRoutes.get('/files', async (c) => {
  const session = await loadSession(c);
  const provider = await buildProvider(session);
  const prefix = normalizePrefix(c.req.query('path') ?? '/');
  const res = await provider.listObjects(prefix, {});
  return ok(c, {
    items: res.keys
      .filter((k) => k.key.startsWith(prefix) && k.key !== prefix)
      .map((k) => {
        const rel = k.key.slice(prefix.length);
        const isFolder = rel.endsWith('/');
        return {
          key: k.key,
          name: decodeURIComponent(k.key.split('/').filter(Boolean).pop() ?? k.key),
          path: `/${k.key}`,
          type: isFolder ? 'folder' : 'file',
          size: isFolder ? 0 : k.size,
          etag: k.etag,
        };
      }),
    mount: { id: 'free', name: '自由模式', mountPath: '/', sortBy: 'name', sortOrder: 'asc' },
  });
});

// ============ 自由模式上传 ============
freeModeRoutes.post('/upload', async (c) => {
  const session = await loadSession(c);
  const provider = await buildProvider(session);
  const contentType = c.req.header('content-type') ?? '';
  let fileName = c.req.header('x-file-name') ?? '';
  let bytes: Uint8Array;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw ApiError.badRequest('缺少 file 字段');
    fileName = file.name;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    if (!fileName) throw ApiError.badRequest('缺少文件名（X-File-Name）');
    bytes = new Uint8Array(await c.req.arrayBuffer());
  }

  const targetPath = (c.req.query('path') ?? '/') + fileName;
  await provider.putObject(targetPath.replace(/^\//, ''), bytes, contentType || undefined);
  const head = await provider.headObject(targetPath.replace(/^\//, ''));
  return ok(c, { key: targetPath.replace(/^\//, ''), size: head?.size ?? bytes.byteLength }, undefined, 201);
});

// ============ 自由模式删除对象 ============
freeModeRoutes.delete('/object', async (c) => {
  const session = await loadSession(c);
  const provider = await buildProvider(session);
  const key = c.req.query('key');
  if (!key) throw ApiError.badRequest('缺少 key');
  await provider.deleteObject(key);
  return ok(c, null);
});

// ============ 自由模式退出 ============
freeModeRoutes.post('/logout', async (c) => {
  const session = await loadSession(c);
  await c.env.KV.delete(`fm:${session.userId}`);
  c.header('Set-Cookie', [
    `auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    `${FM_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  ].join(', '));
  return ok(c, null);
});

async function loadSession(c: Context): Promise<FreeModeSession> {
  const cookie = c.req.raw.headers.get('cookie') ?? '';
  const match = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${FM_COOKIE}=`));
  const userId = match ? match.slice(`${FM_COOKIE}=`.length) : null;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '自由模式会话不存在');
  const raw = await (c.env as Env).KV.get(`fm:${userId}`);
  if (!raw) throw new ApiError(401, 'UNAUTHORIZED', '自由模式会话已过期');
  const session = JSON.parse(raw) as FreeModeSession;
  if (Date.now() > session.expiresAt) {
    await (c.env as Env).KV.delete(`fm:${userId}`);
    throw new ApiError(401, 'UNAUTHORIZED', '自由模式会话已过期');
  }
  if (session.ip && session.ip !== ipOf(c)) {
    throw new ApiError(403, 'FORBIDDEN', '会话 IP 不匹配');
  }
  return session;
}

function normalizePrefix(p: string): string {
  const s = p.replace(/^\//, '');
  return s === '' ? '' : s.endsWith('/') ? s : s + '/';
}

function ipOf(c: Context): string {
  const raw = c.req.raw as Request & { cf?: { connectingIp?: string } };
  if (raw.cf?.connectingIp) return raw.cf.connectingIp;
  return raw.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? raw.headers.get('x-real-ip') ?? '127.0.0.1';
}
