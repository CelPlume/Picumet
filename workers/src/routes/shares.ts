// 分享路由：创建、列表、公开访问、密码验证、下载、撤销
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import type { Context } from 'hono';
import { z } from 'zod';
import { ShareRepo, FileRepo, MountRepo, ProviderRepo, LogRepo } from '../db';
import { getDb } from '../middleware/auth';
import { requirePermission } from '../services/principal';
import { getProvider } from '../providers';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import { hashPassword, verifyPassword, randomString } from '../utils/crypto';
import { toFileListItem } from '../db/repos/files';
import { createDownloadToken, buildGatewayUrl } from '../services/gateway';
import type { Env } from '../types';

const createSchema = z.object({
  fileId: z.string().min(1),
  title: z.string().max(200).optional(),
  password: z.string().min(1).max(128).optional(),
  expiresIn: z.number().int().min(60).max(365 * 24 * 3600).optional(),
  maxViews: z.number().int().min(1).optional(),
  maxDownloads: z.number().int().min(1).optional(),
  allowPreview: z.boolean().optional(),
  allowDownload: z.boolean().optional(),
});

export const shareRoutes = new Hono<AppBindings>();

// ============ 创建分享 ============
shareRoutes.post('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '分享参数无效');

  const file = await FileRepo.getFileById(db, parsed.data.fileId);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  const mount = await MountRepo.getMountById(db, file.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');

  await requirePermission(c, mount, file.path, 'share', file.ownerId);

  const shareId = randomString(8).toLowerCase();
  const share = await ShareRepo.createShare(db, {
    fileId: file.id,
    creatorId: userId,
    title: parsed.data.title ?? file.name,
    passwordHash: parsed.data.password ? hashPassword(parsed.data.password) : undefined,
    expiresAt: parsed.data.expiresIn ? Date.now() + parsed.data.expiresIn * 1000 : undefined,
    maxViews: parsed.data.maxViews,
    maxDownloads: parsed.data.maxDownloads,
    allowPreview: parsed.data.allowPreview ?? true,
    allowDownload: parsed.data.allowDownload ?? true,
  });

  await LogRepo.create(db, {
    userId,
    action: 'share',
    path: file.path,
    metadata: JSON.stringify({ shareId }),
    ipAddress: ipOf(c),
    userAgent: c.req.header('user-agent'),
  });

  const base = c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  return ok(c, {
    share: {
      id: share.id,
      url: `${base}/share/${share.id}`,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      passwordProtected: !!share.passwordHash,
      allowPreview: share.allowPreview,
      allowDownload: share.allowDownload,
    },
  }, undefined, 201);
});

// ============ 我的分享列表 ============
shareRoutes.get('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await ShareRepo.listSharesByUser(db, userId, {
    page,
    limit,
    status: (['active', 'expired', 'revoked'].includes(q.status ?? '') ? q.status : undefined) as never,
  });

  const items = await Promise.all(
    rows.map(async (s) => {
      const file = await FileRepo.getFileById(db, s.fileId);
      return {
        id: s.id,
        title: s.title,
        file: file ? toFileListItem(file) : null,
        expiresAt: s.expiresAt,
        viewCount: s.viewCount,
        maxViews: s.maxViews,
        downloadCount: s.downloadCount,
        maxDownloads: s.maxDownloads,
        allowPreview: s.allowPreview,
        allowDownload: s.allowDownload,
        status: s.status,
        createdAt: s.createdAt,
      };
    })
  );

  return ok(c, { items, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
});

// ============ 公开分享信息（无需登录） ============
shareRoutes.get('/:id', async (c) => {
  const db = getDb(c);
  const shareId = c.req.param('id');
  const info = await ShareRepo.getShareWithFile(db, shareId);
  if (!info) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  const { share, file, creatorName } = info;

  if (share.status === 'revoked') throw new ApiError(410, 'SHARE_REVOKED', '分享已被撤销');
  if (share.expiresAt && Date.now() > share.expiresAt) {
    await ShareRepo.updateShare(db, shareId, { status: 'expired' });
    throw new ApiError(410, 'SHARE_EXPIRED', '分享已过期');
  }

  // 密码验证
  const password = c.req.query('password');
  if (share.passwordHash) {
    const okPass = password ? verifyPassword(password, share.passwordHash) : false;
    if (!okPass) {
      return ok(c, {
        share: {
          id: share.id,
          title: share.title,
          creatorName,
          file: null,
          allowPreview: false,
          allowDownload: false,
          expiresAt: share.expiresAt,
          requiresPassword: true,
          viewCount: share.viewCount,
          maxViews: share.maxViews,
        },
      });
    }
  }

  // 次数限制
  const canView = await ShareRepo.incrementView(db, shareId, share.maxViews);
  if (!canView) {
    throw new ApiError(410, 'SHARE_LIMIT_REACHED', '分享访问次数已达上限');
  }

  return ok(c, {
    share: {
      id: share.id,
      title: share.title,
      creatorName,
      file: toFileListItem(file),
      allowPreview: share.allowPreview,
      allowDownload: share.allowDownload,
      expiresAt: share.expiresAt,
      requiresPassword: !!share.passwordHash,
      viewCount: share.viewCount + 1,
      maxViews: share.maxViews,
      downloadCount: share.downloadCount,
      maxDownloads: share.maxDownloads,
    },
  });
});

// ============ 分享下载链接 ============
shareRoutes.get('/:id/download', async (c) => {
  const db = getDb(c);
  const shareId = c.req.param('id');
  const info = await ShareRepo.getShareWithFile(db, shareId);
  if (!info) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  const { share, file } = info;

  if (share.status !== 'active') throw new ApiError(410, 'SHARE_REVOKED', '分享不可用');
  if (share.expiresAt && Date.now() > share.expiresAt) {
    await ShareRepo.updateShare(db, shareId, { status: 'expired' });
    throw new ApiError(410, 'SHARE_EXPIRED', '分享已过期');
  }
  if (!share.allowDownload) throw new ApiError(403, 'FORBIDDEN', '分享不允许下载');

  const password = c.req.query('password');
  if (share.passwordHash) {
    const okPass = password ? verifyPassword(password, share.passwordHash) : false;
    if (!okPass) throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');
  }

  const canDownload = await ShareRepo.incrementDownload(db, shareId, share.maxDownloads);
  if (!canDownload) throw new ApiError(410, 'SHARE_LIMIT_REACHED', '下载次数已达上限');

  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    passwordVerified: !!share.passwordHash,
    shareId,
  });
  return ok(c, { url: buildGatewayUrl(c, token), expiresIn: 900 });
});

// ============ 分享预览（图片直出） ============
shareRoutes.get('/:id/preview', async (c) => {
  const db = getDb(c);
  const shareId = c.req.param('id');
  const info = await ShareRepo.getShareWithFile(db, shareId);
  if (!info) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  const { share, file } = info;
  if (share.status !== 'active' || (share.expiresAt && Date.now() > share.expiresAt)) {
    throw new ApiError(410, 'SHARE_EXPIRED', '分享不可用');
  }
  if (!share.allowPreview) throw new ApiError(403, 'FORBIDDEN', '分享不允许预览');
  const password = c.req.query('password');
  if (share.passwordHash && !(password && verifyPassword(password, share.passwordHash))) {
    throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');
  }
  const mount = await MountRepo.getMountById(db, file.mountId);
  const providerRow = await ProviderRepo.getProviderById(db, mount!.providerId);
  const provider = await getProvider(db, providerRow!, c.env as Env);
  const obj = await provider.getObject(file.objectKey);
  if (!obj) throw new ApiError(404, 'NOT_FOUND', '文件对象不存在');
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': file.mimeType ?? obj.contentType ?? 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': `inline; filename="${file.name.replace(/["\\]/g, '_')}"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

// ============ 撤销分享 ============
shareRoutes.delete('/:id', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  const shareId = c.req.param('id');
  const share = await ShareRepo.getShare(db, shareId);
  if (!share || share.creatorId !== userId) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  await ShareRepo.revokeShare(db, shareId);
  return ok(c, null);
});

function ipOf(c: Context): string | undefined {
  const raw = c.req.raw as Request & { cf?: { connectingIp?: string } };
  if (raw.cf?.connectingIp) return raw.cf.connectingIp;
  return raw.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? raw.headers.get('x-real-ip') ?? undefined;
}
