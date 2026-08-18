// API 密钥路由：创建（仅显示一次）、列表、撤销
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { ApiKeyRepo, RuleRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { randomString, sha256Hex } from '../../utils/crypto';
import { normalizePath } from '../../utils/path';
import { CreateKeySchema } from './schemas';

export const keyRoutes = new Hono<AppBindings>();

// ============ 创建 API 密钥 ============
keyRoutes.post('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = CreateKeySchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '密钥参数无效');

  const activeCount = await ApiKeyRepo.countActiveByUser(db, userId);
  if (activeCount >= 20) throw new ApiError(403, 'FORBIDDEN', 'API 密钥数量已达上限（20）');

  // M-3：uploadPath 规范化（拒绝 .. / ~ 逃逸），作为密钥上传根边界
  let uploadPath = '/uploads';
  if (parsed.data.uploadPath !== undefined) {
    try {
      uploadPath = normalizePath(parsed.data.uploadPath);
    } catch {
      throw ApiError.badRequest('uploadPath 必须是合法路径（不允许 .. 或 ~）');
    }
  }

  const keyId = 'pk_' + randomString(24);
  const secret = 'sk_' + randomString(48);
  const fullToken = `${keyId}.${secret}`;
  const tokenHash = await sha256Hex(fullToken);

  await ApiKeyRepo.createKey(db, {
    userId,
    name: parsed.data.name,
    keyId,
    tokenHash,
    permissions: parsed.data.permissions,
    protocols: parsed.data.protocols,
    uploadPath,
    allowedIps: parsed.data.allowedIps,
    expiresAt: parsed.data.expiresIn ? Date.now() + parsed.data.expiresIn * 1000 : undefined,
  });

  const base = c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  return ok(c, {
    key: {
      id: keyId,
      keyId,
      secret,
      fullToken,
      name: parsed.data.name,
      permissions: parsed.data.permissions,
      protocols: parsed.data.protocols,
      uploadPath,
      createdAt: Date.now(),
      expiresAt: parsed.data.expiresIn ? Date.now() + parsed.data.expiresIn * 1000 : undefined,
    },
    configs: {
      bearer: {
        url: base,
        header: `Authorization: Bearer ${fullToken}`,
      },
      webdav: {
        url: `${base}/webdav`,
        username: keyId,
        password: secret,
      },
    },
  }, undefined, 201);
});

// ============ 列表 API 密钥 ============
keyRoutes.get('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const keys = await ApiKeyRepo.listKeysByUser(db, userId);
  return ok(c, {
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyId: k.keyId,
      permissions: k.permissions,
      protocols: k.protocols,
      uploadPath: k.uploadPath,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      status: k.status,
    })),
  });
});

// ============ 撤销 API 密钥 ============
keyRoutes.delete('/:id', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const okRevoked = await ApiKeyRepo.revokeKey(db, c.req.param('id'), userId);
  if (!okRevoked) throw new ApiError(404, 'NOT_FOUND', '密钥不存在');
  return ok(c, null);
});

// ============ 权限规则查询（密钥可用规则，用于展示/调试） ============
keyRoutes.get('/rules', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const rules = await RuleRepo.findCandidates(db, { id: userId, role: c.get('userRole') });
  return ok(c, { rules });
});
