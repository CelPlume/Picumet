// 下载网关路由：/api/gateway/download/:token → 流式代理对象
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import type { Context } from 'hono';
import { FileRepo, MountRepo, ProviderRepo, LogRepo, ShareRepo } from '../db';
import { getDb } from '../middleware/auth';
import { getProvider } from '../providers';
import { ApiError } from '../utils/errors';
import { consumeDownloadToken } from '../services/gateway';
import type { Env } from '../types';

export const gatewayRoutes = new Hono<AppBindings>();

gatewayRoutes.get('/download/:token', async (c) => {
  const db = getDb(c);
  const token = c.req.param('token');
  const payload = await consumeDownloadToken(db, token);
  if (!payload) throw new ApiError(401, 'INVALID_TOKEN', '下载链接无效或已过期');

  const file = await FileRepo.getFileById(db, payload.fileId);
  const mount = await MountRepo.getMountById(db, payload.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '文件不存在或已删除');

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');

  // 文件设置了密码但 token 未验证 → 拒绝
  if (file?.accessPassword && !payload.passwordVerified) {
    throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护');
  }

  const provider = await getProvider(db, providerRow, c.env as Env);
  const obj = await provider.getObject(payload.objectKey);
  if (!obj) {
    throw new ApiError(404, 'NOT_FOUND', '文件对象不存在或已被删除');
  }

  const headers = new Headers();
  const mime = payload.mimeType ?? obj.contentType ?? 'application/octet-stream';
  headers.set('Content-Type', mime);
  headers.set('Content-Length', String(payload.size || obj.size));
  headers.set('Cache-Control', 'private, max-age=300');

  const safeName = payload.name.replace(/["\\\r\n]/g, '_');
  const ext = safeName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  const forceDownload =
    ['.html', '.htm', '.svg', '.xml', '.xhtml', '.md', '.json'].includes(ext) ||
    !payload.mimeType;
  headers.set('Content-Disposition', `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`);

  // 记录下载日志
  if (payload.shareId) {
    const share = await ShareRepo.getShare(db, payload.shareId);
    if (share) {
      await ShareRepo.incrementDownload(db, payload.shareId, share.maxDownloads);
    }
  }
  await LogRepo.create(db, {
    userId: c.get('userId') as string | undefined,
    action: payload.shareId ? 'share_download' : 'download',
    path: file?.path ?? payload.objectKey,
    metadata: JSON.stringify({ fileName: payload.name, shareId: payload.shareId }),
    ipAddress: ipOf(c),
    userAgent: c.req.header('user-agent'),
    bytesTransferred: payload.size,
    statusCode: 200,
  });

  return new Response(obj.body, { status: 200, headers });
});

function ipOf(c: Context): string | undefined {
  const raw = c.req.raw as Request & { cf?: { connectingIp?: string } };
  if (raw.cf?.connectingIp) return raw.cf.connectingIp;
  return raw.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? raw.headers.get('x-real-ip') ?? undefined;
}
