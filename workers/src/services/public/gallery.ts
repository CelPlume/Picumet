// 公开空间 gallery（§4.2）：匿名可访问的显式列表接口，非池子非掩码。
// 查询直接按 visibility + review_status 过滤，不经过 path_rules/checkPermission（公开面与授权面分离）。
// 下载/预览复用 shares 下载令牌 + 网关（D1 原子消费 + 流式代理），不新建第二个鉴权面。
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { FileRepo, LogRepo, UserRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { createDownloadToken, buildGatewayUrl } from '../shares/tokens';
import { physicalObjectKey } from '../storage/keys';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { verifyPassword } from '../../utils/crypto';
import { requestIp } from '../../utils/ip';

export const galleryRoutes = new Hono<AppBindings>();

// ============ 公开列表（匿名可访问） ============
galleryRoutes.get('/', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

  const { rows, total } = await FileRepo.listPublic(db, { page, limit });
  const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
  const owners = await Promise.all(ownerIds.map((id) => UserRepo.getUserById(db, id)));
  const nameById = new Map<string, string>();
  for (const u of owners) {
    if (u) nameById.set(u.id, u.displayName || u.username);
  }

  return ok(c, {
    items: rows.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      type: f.type,
      size: f.size,
      mimeType: f.mimeType,
      coverUrl: f.coverUrl,
      hasPassword: !!f.accessPassword,
      ownerName: nameById.get(f.ownerId) ?? '未知',
      visibility: f.visibility,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

async function loadGalleryFile(c: Parameters<typeof ok>[0], id: string) {
  const db = getDb(c);
  const file = await FileRepo.getFileById(db, id);
  // 公开面准入：visibility=public 且审核通过
  if (!file || file.visibility !== 'public' || file.reviewStatus !== 'approved' || file.type !== 'file') {
    throw new ApiError(404, 'NOT_FOUND', '文件不存在或未公开');
  }
  return { db, file };
}

// ============ 预览/下载链接（复用网关令牌） ============
galleryRoutes.get('/:id/download', async (c) => {
  const { db, file } = await loadGalleryFile(c, c.req.param('id'));
  // 带密码的公开文件不允许匿名绕过：走 /verify-password
  if (file.accessPassword) {
    throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护，请先验证密码');
  }
  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: physicalObjectKey(file),
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    passwordVerified: false,
  });
  await LogRepo.create(db, {
    action: 'gallery_download',
    path: file.path,
    metadata: JSON.stringify({ fileName: file.name }),
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
    bytesTransferred: file.size,
  });
  return ok(c, { url: buildGatewayUrl(c, token), expiresIn: 900 });
});

// ============ 密码验证（匿名） ============
galleryRoutes.post('/:id/verify-password', async (c) => {
  const { db, file } = await loadGalleryFile(c, c.req.param('id'));
  if (!file.accessPassword) throw ApiError.badRequest('该文件无需密码');
  const body = await c.req.json().catch(() => null);
  const password = body?.password as string | undefined;
  if (!password) throw ApiError.badRequest('请输入密码');
  if (!verifyPassword(password, file.accessPassword)) {
    throw new ApiError(401, 'INVALID_PASSWORD', '密码错误');
  }
  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: physicalObjectKey(file),
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    passwordVerified: true,
  });
  await LogRepo.create(db, {
    action: 'gallery_password_verify',
    path: file.path,
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });
  return ok(c, { url: buildGatewayUrl(c, token), expiresIn: 900 });
});
