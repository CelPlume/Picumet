// API 密钥路由：创建（仅显示一次）、列表、撤销
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { ApiKeyRepo, MountRepo, RuleRepo, UserRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { randomString, sha256Hex, encryptSecret } from '../../utils/crypto';
import { isPathWithinBoundary, normalizePath } from '../../utils/path';
import { loadRoutePrefixes } from '../storage/direct-links';
import { resolveUserSpaceRoot } from '../files/upload-mode';
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

  // uploadPath 规范化（拒绝 .. / ~ 逃逸），作为密钥上传根边界。
  // user_space 挂载点上的普通用户：默认上传根 = 其用户空间目录（defaultPath 下的
  // <username> 子目录），且不允许把上传根设到用户空间之外——「设置了用户空间，
  // 密钥就只能在用户空间里上传」，与其余写入通道（assertWritable）同口径。
  let uploadPath = '/uploads';
  if (parsed.data.uploadPath !== undefined) {
    try {
      uploadPath = normalizePath(parsed.data.uploadPath);
    } catch {
      throw ApiError.badRequest('uploadPath 必须是合法路径（不允许 .. 或 ~）');
    }
  }
  const owner = await UserRepo.getUserById(db, userId);
  if (!owner) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (owner.role !== 'admin') {
    const homeMount = await MountRepo.findMountForPath(db, owner.defaultPath || '/');
    if (homeMount?.uploadMode === 'user_space') {
      const spaceRoot = await resolveUserSpaceRoot(db, homeMount, userId);
      if (parsed.data.uploadPath === undefined) {
        uploadPath = spaceRoot;
      } else if (!isPathWithinBoundary(uploadPath, spaceRoot)) {
        throw ApiError.badRequest(`上传根目录必须位于你的用户空间 ${spaceRoot} 内`);
      }
    }
  }

  const keyId = 'pk_' + randomString(24);
  const secret = 'sk_' + randomString(48);
  const fullToken = `${keyId}.${secret}`;
  const tokenHash = await sha256Hex(fullToken);
  // S3 SigV4 网关需要可逆 secret：AES-GCM 加密落库（密钥派生自 ENCRYPTION_KEY），任何响应不回传
  const secretCipher = 'enc:' + (await encryptSecret(secret, c.env.ENCRYPTION_KEY));

  const rowId = await ApiKeyRepo.createKey(db, {
    userId,
    name: parsed.data.name,
    keyId,
    tokenHash,
    permissions: parsed.data.permissions,
    protocols: parsed.data.protocols,
    uploadPath,
    allowedIps: parsed.data.allowedIps,
    expiresAt: parsed.data.expiresIn ? Date.now() + parsed.data.expiresIn * 1000 : undefined,
    secretCipher,
  });

  // 连接地址基址：优先系统设置「上传 URL」（外部工具连接用的对外域名），
  // 未配置时回退 APP_BASE_URL / 请求来源；与「返回 URL」互不干扰（后者只管对外返回的直链）。
  const routePrefs = await loadRoutePrefixes(db);
  const base = routePrefs.uploadUrl || c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  const rootSegment = uploadPath === '/' ? undefined : uploadPath.split('/').filter(Boolean)[0];
  // 完整上传路径提示：bucket = 虚拟路径首段，其余段 = S3 key 前缀（路径式寻址下
  // PutObject(bucket, key) 的 key 必须带上前缀，对象才会落在密钥上传根内）
  const segs = uploadPath.split('/').filter(Boolean);
  const keyPrefix = segs.length > 1 ? `${segs.slice(1).join('/')}/` : '';
  return ok(c, {
    key: {
      // LAB F-11：id 与列表接口同源（数据库行 id），DELETE /api/keys/:id 直接可用；
      // keyId（pk_…）保留原语义（网关用户名 / SigV4 AccessKeyId）
      id: rowId,
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
        // 兼容上传的默认上传目录（PicGo 端「保存路径」填这里，{year}/{month} 由客户端追加）
        pathHint: uploadPath === '/' ? '/' : `${uploadPath}/`,
      },
      webdav: {
        url: `${base}/webdav`,
        // PicList webdavplist 的 imgUrl = (customUrl||host)+webpath+fileName：
        // 不配 customUrl 时公开直链会指向 WebDAV host（带 Basic 认证的 URL 不应外贴）
        username: keyId,
        password: secret,
        customUrlHint: base,
        webpathHint: uploadPath === '/' ? '/' : `${uploadPath}/`,
      },
      s3: {
        // MinIO/minio-go 只接受 host[:port]（路径前缀无法通过 SigV4 验签），根路径入口已内置：
        // endpoint = 站点基址即可；旧 /s3 前缀入口保留兼容
        endpoint: base,
        region: 'auto',
        accessKeyId: keyId,
        secretAccessKey: secret,
        // bucket = 虚拟路径首段（挂载路径首段或密钥上传根首段）；寻址必须用路径式（forcePathStyle）
        bucketHint: rootSegment ?? '(挂载根目录下的一级文件夹名)',
        // 上传根的其余段：PutObject 的 key 前缀（对象完整虚拟路径 = /{bucket}/{keyPrefix}{key}）
        keyPrefixHint: keyPrefix,
        pathStyle: true,
      },
      openlist: {
        url: `${base}/openlist`,
        token: fullToken,
        // AList/OpenList 客户端的默认上传目录
        pathHint: uploadPath === '/' ? '/' : `${uploadPath}/`,
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
  const param = c.req.param('id');
  // LAB F-11：主契约是数据库行 id；兼容 pk_… keyId（创建响应曾把 keyId 当 id 返回）
  let okRevoked = await ApiKeyRepo.revokeKey(db, param, userId);
  if (!okRevoked && param.startsWith('pk_')) {
    const row = await ApiKeyRepo.listKeysByUser(db, userId).then((keys) => keys.find((k) => k.keyId === param));
    if (row) okRevoked = await ApiKeyRepo.revokeKey(db, row.id, userId);
  }
  if (!okRevoked) throw new ApiError(404, 'NOT_FOUND', '密钥不存在');
  return ok(c, null);
});

// ============ 权限规则查询（密钥可用规则，用于展示/调试） ============
keyRoutes.get('/rules', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const rules = await RuleRepo.findCandidates(db, { id: userId, roles: [c.get('userRole')] });
  return ok(c, { rules });
});
