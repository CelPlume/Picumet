// 自由模式：用户自带对象存储凭据的临时会话（凭据加密写入 KV，短 TTL 自动清理）
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import type { Context } from 'hono';
import { UserRepo, LogRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { S3Provider } from '../storage/providers';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { hashPassword, randomString, encryptSecret } from '../../utils/crypto';
import { clientIp, requestIp } from '../../utils/ip';
import { isPrivateHost, validateEndpoint } from '../../utils/ssrf';
import { normalizePath, isPathWithinBoundary, isValidFileName, validateFileType } from '../../utils/path';
import { freeModeOriginGuard, freeModeInitGuard, freeModeSessionGuard } from '../../middleware/free-mode';
import type { FreeModeSession } from '../../shared/types';
import { FreeModeInitSchema } from './schemas';

/** 单次上传大小上限（1GB，防止无配额场景的资源耗尽） */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export const freeModeRoutes = new Hono<AppBindings>();

const FM_COOKIE = 'fm_token';

// 会话守卫：/files、/upload、/object、/logout 需要有效会话
freeModeRoutes.use('*', freeModeOriginGuard);
freeModeRoutes.use('/files', freeModeSessionGuard);
freeModeRoutes.use('/upload', freeModeSessionGuard);
freeModeRoutes.use('/object', freeModeSessionGuard);
freeModeRoutes.use('/logout', freeModeSessionGuard);

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

/** 读取中间件注入的会话 */
function requireSession(c: Context): FreeModeSession {
  const s = c.get('freeModeSession');
  if (!s) throw new ApiError(401, 'UNAUTHORIZED', '自由模式会话不存在');
  return s;
}

/**
 * 审计 H-2：校验并规范化对象键。
 * 拒绝父级片段（.. / ~）、控制字符、反斜杠；结果必须落在会话根目录边界内。
 */
function validateFreeModeKey(rawKey: string, mountPath: string): string {
  if (!rawKey || rawKey.length > 2048) throw ApiError.badRequest('key 缺失或过长');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawKey);
  } catch {
    throw ApiError.badRequest('key 解码失败');
  }
  decoded = decoded.normalize('NFC');
  if (decoded.includes('..') || decoded.includes('~')) {
    throw ApiError.badRequest('key 包含非法路径片段');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F\\]/.test(decoded)) {
    throw ApiError.badRequest('key 包含非法字符');
  }
  const normalized = decoded.replace(/^\/+/, '');
  const asPath = `/${normalized}`;
  if (!isPathWithinBoundary(asPath, normalizePath(mountPath))) {
    throw new ApiError(403, 'FORBIDDEN', 'key 超出会话根目录');
  }
  return normalized;
}

/** 校验并规范化上传目录前缀（会话根边界内） */
function validateFreeModeDir(dir: string | undefined | null, mountPath: string): string {
  const p = normalizePath(dir ?? '/');
  if (!isPathWithinBoundary(p, normalizePath(mountPath))) {
    throw new ApiError(403, 'FORBIDDEN', '上传路径超出会话根目录');
  }
  return p === '/' ? '' : p.replace(/^\/+/, '') + '/';
}

// ============ 初始化自由模式 ============
freeModeRoutes.post('/init', freeModeInitGuard, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = FreeModeInitSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '存储配置无效');

  // M-1：endpoint 校验（scheme/端口白名单 + 私网黑名单）
  if (!validateEndpoint(parsed.data.endpoint)) {
    throw ApiError.badRequest('不允许使用内网/本地地址或非法 endpoint');
  }
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
      endpoint: parsed.data.endpoint,
      region: parsed.data.region || 'auto',
      bucket: parsed.data.bucket,
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
    },
    mountPath: '/',
    createdAt: Date.now(),
    expiresAt: Date.now() + parsed.data.sessionHours * 3600 * 1000,
    // SEC-03（审计 §SEC-03）：会话 IP 绑定属安全判定，用 clientIp（cf.connectingIp 优先）
    ip: clientIp(c.req.raw),
  };

  const ttl = parsed.data.sessionHours * 3600;
  // 凭据不以明文落盘：加密后写入 KV（短 TTL），仅 Workers 内存中可解密使用
  const sealed = await encryptSecret(JSON.stringify(session), c.env.ENCRYPTION_KEY as string);
  const sid = randomString(24);
  await c.env.KV.put(`fm:${sid}`, sealed, { expirationTtl: ttl });

  // M-2：自由模式仅使用不可复用 sid（不再签发 7 天 JWT 的 auth_token）；
  // 会话级 CSRF token 一并下发（写操作需携带 X-CSRF-Token）
  const csrfToken = randomString(32);
  await c.env.KV.put(`fm:csrf:${sid}`, csrfToken, { expirationTtl: ttl });
  c.header('Set-Cookie', `${FM_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}`);

  await LogRepo.create(db, {
    userId: user.id,
    action: 'free_mode_init',
    path: '/',
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });

  return ok(c, {
    user: { id: user.id, username: user.username, role: user.role, defaultPath: '/' },
    expiresAt: session.expiresAt,
    sessionHours: parsed.data.sessionHours,
    provider: { bucket: parsed.data.bucket },
    csrfToken,
  }, undefined, 201);
});

// ============ 自由模式文件列表 ============
freeModeRoutes.get('/files', async (c) => {
  const session = requireSession(c);
  const provider = await buildProvider(session);
  // 列表前缀同样走规范化（拒绝 .. 逃逸）
  const prefix = validateFreeModeDir(c.req.query('path'), session.mountPath);
  // P1-5：Delimiter 折叠出目录结构，用户自带桶不再 flat 平铺
  const res = await provider.listObjects(prefix, { delimiter: '/' });

  type FreeModeItem = {
    key: string;
    name: string;
    path: string;
    type: 'file' | 'folder';
    size: number;
    etag?: string;
  };

  const items: FreeModeItem[] = [];
  const folderNames = new Set<string>();

  // 公共前缀 → 虚拟目录行
  for (const p of res.prefixes ?? []) {
    if (!p.startsWith(prefix) || p === prefix) continue;
    const rel = p.slice(prefix.length).replace(/\/+$/, '');
    if (!rel) continue;
    folderNames.add(rel);
    items.push({
      key: p,
      name: decodeURIComponent(rel),
      path: `/${p}`,
      type: 'folder',
      size: 0,
    });
  }

  // 对象行：跳过目录占位（已由前缀表达或单独成行）与前缀本身
  for (const k of res.keys) {
    if (!k.key.startsWith(prefix) || k.key === prefix) continue;
    const rel = k.key.slice(prefix.length);
    if (!rel) continue;
    const isFolder = rel.endsWith('/');
    if (isFolder) {
      const folderRel = rel.replace(/\/+$/, '');
      if (folderRel && folderNames.has(folderRel)) continue;
      if (folderRel) folderNames.add(folderRel);
      items.push({
        key: k.key,
        name: decodeURIComponent(folderRel || k.key),
        path: `/${k.key}`,
        type: 'folder',
        size: 0,
        etag: k.etag,
      });
      continue;
    }
    items.push({
      key: k.key,
      name: decodeURIComponent(k.key.split('/').filter(Boolean).pop() ?? k.key),
      path: `/${k.key}`,
      type: 'file',
      size: k.size,
      etag: k.etag,
    });
  }

  return ok(c, {
    items,
    mount: { id: 'free', name: '自由模式', mountPath: '/', sortBy: 'name', sortOrder: 'asc' },
  });
});

// ============ 自由模式上传 ============
freeModeRoutes.post('/upload', async (c) => {
  const session = requireSession(c);
  const provider = await buildProvider(session);
  const contentType = c.req.header('content-type') ?? '';
  let fileName = c.req.header('x-file-name') ?? '';
  let body: ReadableStream<Uint8Array>;
  let size: number;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw ApiError.badRequest('缺少 file 字段');
    fileName = file.name;
    // 审计 H-03：multipart 用 file.stream() 流式写入
    body = file.stream();
    size = file.size;
  } else {
    if (!fileName) throw ApiError.badRequest('缺少文件名（X-File-Name）');
    // 审计 H-03：raw body 流式转发；Content-Length 已知则流式，缺失（chunked）回退读取
    const rawLength = Number(c.req.header('content-length') ?? '');
    const hasLength = Number.isFinite(rawLength) && rawLength > 0;
    if (hasLength) {
      size = rawLength;
      const stream = c.req.raw.body as ReadableStream<Uint8Array> | null;
      if (!stream) throw ApiError.badRequest('请求体为空');
      body = stream;
    } else {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      size = bytes.byteLength;
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
  }

  // H-2：文件名 + 类型 + 大小校验
  if (!isValidFileName(fileName)) throw ApiError.badRequest('文件名包含非法字符');
  validateFileType(fileName, contentType);
  if (size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '单次上传超过大小上限');
  }

  // H-2：目录前缀 + 最终 key 必须落在会话根目录内
  const prefix = validateFreeModeDir(c.req.query('path'), session.mountPath);
  const targetKey = validateFreeModeKey(prefix + fileName, session.mountPath);

  await provider.putObject(targetKey, body, contentType || undefined);
  const head = await provider.headObject(targetKey);
  return ok(c, { key: targetKey, size: head?.size ?? size }, undefined, 201);
});

// ============ 自由模式删除对象 ============
freeModeRoutes.delete('/object', async (c) => {
  const session = requireSession(c);
  const provider = await buildProvider(session);
  const rawKey = c.req.query('key');
  const key = validateFreeModeKey(rawKey ?? '', session.mountPath);
  await provider.deleteObject(key);
  return ok(c, null);
});

// ============ 自由模式退出 ============
freeModeRoutes.post('/logout', async (c) => {
  // 会话守卫已校验会话与 CSRF；此处按 sid 撤销 KV 状态
  const cookie = c.req.raw.headers.get('cookie') ?? '';
  const match = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${FM_COOKIE}=`));
  const sidValue = match ? match.slice(`${FM_COOKIE}=`.length) : null;
  if (sidValue) {
    await c.env.KV.delete(`fm:${sidValue}`);
    await c.env.KV.delete(`fm:csrf:${sidValue}`);
  }
  c.header('Set-Cookie', `${FM_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return ok(c, null);
});
