// 下载网关路由：/api/gateway/download/:token → 流式代理对象
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import type { Context } from 'hono';
import { FileRepo, MountRepo, ProviderRepo, LogRepo, ShareRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { getProviderForFile } from '../storage/pool';
import { assertBucketPermission } from '../permissions/principal';
import { ApiError } from '../../shared/errors';
import { consumeDownloadToken } from '../shares/tokens';
import { assertNotBanned } from '../files/ban';
import { serveObject } from '../storage/serve';
import { serveFileObject } from '../storage/failover';
import type { Env } from '../../shared/types';

export const gatewayRoutes = new Hono<AppBindings>();

gatewayRoutes.get('/download/:token', async (c) => {
  const db = getDb(c);
  const token = c.req.param('token');
  const payload = await consumeDownloadToken(db, token);
  if (!payload) throw new ApiError(401, 'INVALID_TOKEN', '下载链接无效或已过期');

  const file = await FileRepo.getFileById(db, payload.fileId);
  const mount = await MountRepo.getMountById(db, payload.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '文件不存在或已删除');

  // §E 存储池 + §G 读容灾：按文件落桶定位，取不到时轮询池内其余桶
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在或已删除');

  // §26 违规封禁：下载网关内容出口门禁（令牌签发后文件被封禁也在此拦截）
  await assertNotBanned(db, [file.id]);
  // §31 桶级矩阵：下载网关凭令牌放行（含分享令牌），此处按文件实际落桶补判下载权限，
  // 桶级条目明确禁止该角色下载 → 403（无桶级条目时与既有令牌语义一致）
  await assertBucketPermission(c, mount.id, file.providerId, 'download');

  // 文件设置了密码但 token 未验证 → 拒绝
  if (file?.accessPassword && !payload.passwordVerified) {
    throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护');
  }

  // 审计 H-04：网关消费令牌成功后计数一次（下载次数在令牌消费阶段绑定）；
  // 超限则拒绝本次下载，避免先拉对象浪费资源。
  if (payload.shareId) {
    const share = await ShareRepo.getShare(db, payload.shareId);
    if (!share) throw new ApiError(410, 'SHARE_REVOKED', '分享已被撤销或删除');
    if (share.status !== 'active') throw new ApiError(410, 'SHARE_REVOKED', '分享不可用');
    if (share.expiresAt && Date.now() > share.expiresAt) {
      await ShareRepo.updateShare(db, payload.shareId, { status: 'expired' });
      throw new ApiError(410, 'SHARE_EXPIRED', '分享已过期');
    }
    // 访问策略实时校验（仅登录 / 指定用户）：令牌签发后的权限修改与撤销立即生效
    const uid = c.get('userId') as string | undefined;
    if (share.requireLogin && !uid) {
      throw new ApiError(401, 'LOGIN_REQUIRED', '该分享仅登录用户可下载');
    }
    if (share.allowedUserIds && share.allowedUserIds.length > 0) {
      if (!uid) throw new ApiError(401, 'LOGIN_REQUIRED', '该分享仅指定用户可下载，请先登录');
      if (!share.allowedUserIds.includes(uid)) {
        throw new ApiError(403, 'FORBIDDEN', '你不在该分享的指定用户范围内');
      }
    }
    const ok = await ShareRepo.incrementDownload(db, payload.shareId, share.maxDownloads);
    if (!ok) {
      throw new ApiError(410, 'SHARE_LIMIT_REACHED', '下载次数已达上限');
    }
  }

  const response = await serveFileObject({
    db,
    env: c.env as Env,
    mount,
    ref: {
      fileId: file.id,
      mountId: payload.mountId,
      providerId: file.providerId,
      physicalKey: payload.objectKey,
      size: payload.size,
    },
    name: payload.name,
    mimeType: payload.mimeType,
    rangeHeader: c.req.header('range'),
    totalSize: payload.size || undefined,
  });

  // 记录下载日志（统一下载出口：直链 token 与分享 token 同记 action='download'，
  // 分享来源由 metadata.shareId 区分——趋势 metric=downloads 直接按动作聚合）
  try {
    await LogRepo.create(db, {
      userId: c.get('userId') as string | undefined,
      action: 'download',
      path: file?.path ?? payload.objectKey,
      metadata: JSON.stringify({ fileName: payload.name, shareId: payload.shareId, via: 'gateway' }),
      ipAddress: ipOf(c),
      userAgent: c.req.header('user-agent'),
      bytesTransferred: payload.size,
      statusCode: 200,
    });
  } catch {
    // 埋点失败不阻断下载（对象已取回，响应照常返回）
  }

  return response;
});

function ipOf(c: Context): string | undefined {
  const raw = c.req.raw as Request & { cf?: { connectingIp?: string } };
  if (raw.cf?.connectingIp) return raw.cf.connectingIp;
  return raw.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? raw.headers.get('x-real-ip') ?? undefined;
}
