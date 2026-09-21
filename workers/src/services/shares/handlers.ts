// 分享路由：创建（多项目）、列表、公开访问、目录浏览、密码验证、下载、撤销
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import type { FileMetadata, Share } from '@shared/types';
import type { Context } from 'hono';
import { ShareRepo, FileRepo, MountRepo, LogRepo, UserRepo, toShareItemView } from '../../db';
import { getDb } from '../../middleware/auth';
import { requirePermission } from '../permissions/principal';
import { getFileObject } from '../storage/failover';
import { physicalObjectKey } from '../storage/keys';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { hashPassword, verifyPassword, randomString, encryptSecret, decryptSecret } from '../../utils/crypto';
import { basename, isPathWithinBoundary, normalizePath, PathError, safeDecodePath } from '../../utils/path';
import { createDownloadToken, buildGatewayUrl } from '../shares/tokens';
import { assertNotBanned } from '../files/ban';
import { CreateShareSchema } from './schemas';

export const shareRoutes = new Hono<AppBindings>();

/** 分享密码授权 cookie 名（M-02：密码不入 URL，验证后短期授权） */
const shareAuthCookie = (shareId: string) => `share_auth_${shareId}`;
const SHARE_AUTH_TTL = 15 * 60; // 15 分钟

/** 密文前缀：与存储凭据 / API Key secret 同一套 AES-GCM 约定 */
const CIPHER_PREFIX = 'enc:';

/**
 * 分享密码密文封装（创建者回看用）：`enc:` + AES-GCM。
 * ENCRYPTION_KEY 缺失 → undefined（降级为仅存哈希，不阻断写入，也不回看密码）。
 */
export async function encipherSharePassword(password: string, encryptionKey: string | undefined): Promise<string | undefined> {
  if (!encryptionKey) return undefined;
  return CIPHER_PREFIX + (await encryptSecret(password, encryptionKey));
}

/**
 * 创建者回看分享密码：解密 `enc:` 密文。
 * 无密文 / 密钥缺失 / 密文非法（历史脏数据或换钥）→ undefined，调用方省略该字段，绝不阻断列表接口。
 */
async function revealSharePassword(cipher: string | undefined, encryptionKey: string | undefined): Promise<string | undefined> {
  if (!cipher || !encryptionKey) return undefined;
  try {
    return await decryptSecret(cipher.startsWith(CIPHER_PREFIX) ? cipher.slice(CIPHER_PREFIX.length) : cipher, encryptionKey);
  } catch {
    return undefined;
  }
}

/** 从请求解析分享密码授权：cookie 优先（KV 校验），query 兼容（审计 M-02） */
async function sharePasswordAuthorized(c: Context, shareId: string, sharePasswordHash?: string): Promise<boolean> {
  const cookie = c.req.header('cookie') ?? '';
  const cookieValue = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${shareAuthCookie(shareId)}=`))
    ?.slice(`${shareAuthCookie(shareId)}=`.length);
  if (cookieValue) {
    // 有授权 cookie → 校验 KV 中是否存在（防伪造）
    const stored = await c.env.KV.get(`share:auth:${shareId}:${cookieValue}`);
    if (stored) return true;
  }
  // 兼容 query password（旧客户端/测试）：校验后不种 cookie（不改变传输面）
  const queryPwd = c.req.query('password');
  if (!sharePasswordHash || !queryPwd) return false;
  return verifyPassword(queryPwd, sharePasswordHash);
}

/**
 * 分享访问策略闸门（§B）：仅登录 / 指定用户。
 * 在密码校验之前执行——未授权访客不应探测到密码的存在。
 */
function assertShareAccess(c: Context, share: { requireLogin: boolean; allowedUserIds: string[] | null }): void {
  const userId = c.get('userId') as string | undefined;
  if (share.requireLogin && !userId) {
    throw new ApiError(401, 'LOGIN_REQUIRED', '该分享仅登录用户可见');
  }
  if (share.allowedUserIds && share.allowedUserIds.length > 0) {
    if (!userId) throw new ApiError(401, 'LOGIN_REQUIRED', '该分享仅指定用户可见，请先登录');
    if (!share.allowedUserIds.includes(userId)) {
      throw new ApiError(403, 'FORBIDDEN', '你不在该分享的指定用户范围内');
    }
  }
}

/** 分享读取闸门结果：passwordRequired 时 items 被遮蔽（不下发项目） */
interface ShareReadGate {
  share: Share;
  creatorName: string;
  items: FileMetadata[];
  passwordRequired: boolean;
  /** 本次请求是否真正计入浏览数（KV 60s 同 IP 去重后的首次） */
  viewCounted: boolean;
}

/**
 * 公开读取闸门（GET /:id 与 GET /:id/list 共用）：撤销 → 过期 → 访问策略 → 密码 → 次数限制。
 * 密码未通过时不抛错，交调用方决定遮蔽（GET /:id）还是 401（/:id/list）。
 * 次数限制：countView 时按 KV 去重后自增；目录浏览只校验不计数（列目录不算一次浏览）。
 */
async function gateShareRead(c: Context, shareId: string, opts: { countView?: boolean } = {}): Promise<ShareReadGate> {
  const db = getDb(c);
  const info = await ShareRepo.getShareWithItems(db, shareId);
  if (!info) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  const { share, creatorName, items } = info;

  if (share.status === 'revoked') throw new ApiError(410, 'SHARE_REVOKED', '分享已被撤销');
  if (share.expiresAt && Date.now() > share.expiresAt) {
    await ShareRepo.updateShare(db, shareId, { status: 'expired' });
    throw new ApiError(410, 'SHARE_EXPIRED', '分享已过期');
  }

  // 访问策略闸门（仅登录 / 指定用户），先于密码校验
  assertShareAccess(c, share);

  if (share.passwordHash && !(await sharePasswordAuthorized(c, shareId, share.passwordHash))) {
    return { share, creatorName, items: [], passwordRequired: true, viewCounted: false };
  }

  let viewCounted = false;
  if (opts.countView) {
    // 次数限制（防刷：同一 IP 60s 内重复打开只计一次浏览，KV 去重标记）
    const dedupeKey = `share:view:${shareId}:${ipOf(c) ?? 'unknown'}`;
    const alreadyCounted = (await c.env.KV.get(dedupeKey)) !== null;
    if (!alreadyCounted) {
      const canView = await ShareRepo.incrementView(db, shareId, share.maxViews);
      if (!canView) throw new ApiError(410, 'SHARE_LIMIT_REACHED', '分享访问次数已达上限');
      await c.env.KV.put(dedupeKey, '1', { expirationTtl: 60 });
      viewCounted = true;
    } else if (share.maxViews && share.viewCount >= share.maxViews) {
      throw new ApiError(410, 'SHARE_LIMIT_REACHED', '分享访问次数已达上限');
    }
  } else if (share.maxViews && share.viewCount >= share.maxViews) {
    throw new ApiError(410, 'SHARE_LIMIT_REACHED', '分享访问次数已达上限');
  }

  return { share, creatorName, items, passwordRequired: false, viewCounted };
}

// ============ 创建分享（1..50 个项目，文件与文件夹混合） ============
shareRoutes.post('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = CreateShareSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '分享参数无效');

  // 去重且保持请求顺序
  const fileIds = [...new Set(parsed.data.fileIds)];
  if (fileIds.length === 0 || fileIds.length > 50) throw ApiError.badRequest('分享项目数量必须在 1..50 之间');

  // 逐个项目校验存在性与 share 权限（任一失败整体拒绝）
  const files: FileMetadata[] = [];
  for (const fileId of fileIds) {
    const file = await FileRepo.getFileById(db, fileId);
    if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
    const mount = await MountRepo.getMountById(db, file.mountId);
    if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
    await requirePermission(c, mount, file.path, 'share', file.ownerId);
    files.push(file);
  }

  // 授权时间：相对 expiresIn 或绝对 expiresAt 二选一（schema 已校验互斥），缺省 = 永久
  const expiresAt = parsed.data.expiresAt ?? (parsed.data.expiresIn ? Date.now() + parsed.data.expiresIn * 1000 : undefined);

  // 指定用户：用户名列表 → 用户 id 白名单（未知用户名直接拒绝，避免静默漏配）
  let allowedUserIds: string[] | null = null;
  if (parsed.data.allowedUsers && parsed.data.allowedUsers.length > 0) {
    const ids: string[] = [];
    for (const username of parsed.data.allowedUsers) {
      const target = await UserRepo.getUserByUsername(db, username);
      if (!target) throw ApiError.badRequest(`用户不存在：${username}`);
      if (!ids.includes(target.id)) ids.push(target.id);
    }
    allowedUserIds = ids.length > 0 ? ids : null;
  }

  // 标题缺省：单项目 = 该项展示名；多项目 = "N 个项目"
  const title = parsed.data.title ?? (files.length === 1 ? files[0].name : `${files.length} 个项目`);
  // 密码可逆密文（创建者回看用）：ENCRYPTION_KEY 缺失时降级为仅存哈希，不阻断创建
  const password = parsed.data.password;
  const passwordCipher = password ? await encipherSharePassword(password, c.env.ENCRYPTION_KEY) : undefined;
  const share = await ShareRepo.createShare(db, {
    fileIds,
    creatorId: userId,
    title,
    passwordHash: password ? hashPassword(password) : undefined,
    passwordCipher,
    expiresAt,
    maxViews: parsed.data.maxViews,
    maxDownloads: parsed.data.maxDownloads,
    allowPreview: parsed.data.allowPreview ?? true,
    allowDownload: parsed.data.allowDownload ?? true,
    requireLogin: parsed.data.requireLogin,
    allowedUserIds,
  });

  await LogRepo.create(db, {
    userId,
    action: 'share',
    path: files[0].path,
    metadata: JSON.stringify({ shareId: share.id, itemCount: files.length }),
    ipAddress: ipOf(c),
    userAgent: c.req.header('user-agent'),
  });

  const base = c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  return ok(c, {
    share: {
      id: share.id,
      url: `${base}/share/${share.id}`,
      title: share.title,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      passwordProtected: !!share.passwordHash,
      allowPreview: share.allowPreview,
      allowDownload: share.allowDownload,
      requireLogin: share.requireLogin,
      allowedUserCount: share.allowedUserIds?.length ?? 0,
      items: files.map((f) => toShareItemView(f, f.id)),
    },
  }, undefined, 201);
});

// ============ 密码验证（M-02：POST 提交密码，成功后种短期授权 cookie） ============
shareRoutes.post('/:id/verify', async (c) => {
  const db = getDb(c);
  const shareId = c.req.param('id');
  const info = await ShareRepo.getShareWithFile(db, shareId);
  if (!info) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  const { share } = info;
  if (share.status !== 'active' || (share.expiresAt && Date.now() > share.expiresAt)) {
    throw new ApiError(410, 'SHARE_EXPIRED', '分享不可用');
  }
  assertShareAccess(c, share);
  const body = await c.req.json().catch(() => null);
  const password = body?.password as string | undefined;
  if (!share.passwordHash) {
    // 无密码分享：直接授权
    c.header('Set-Cookie', `${shareAuthCookie(shareId)}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SHARE_AUTH_TTL}`);
    return ok(c, { authorized: true });
  }
  if (!password || !verifyPassword(password, share.passwordHash)) {
    throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');
  }
  // 签发短期授权 cookie（值随机，仅作已验证标记；密码不落 URL/日志）
  const value = randomString(32);
  await c.env.KV.put(`share:auth:${shareId}:${value}`, '1', { expirationTtl: SHARE_AUTH_TTL });
  c.header('Set-Cookie', `${shareAuthCookie(shareId)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SHARE_AUTH_TTL}`);
  return ok(c, { authorized: true });
});

// ============ 我的分享列表 ============
shareRoutes.get('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await ShareRepo.listSharesWithSummary(db, userId, {
    page,
    limit,
    status: (['active', 'expired', 'revoked'].includes(q.status ?? '') ? q.status : undefined) as never,
  });

  const items = await Promise.all(rows.map(async ({ share: s, itemCount, totalSize, firstItem }) => {
    // 仅创建者本人可见的列表：解密回看自己设置的密码；失败/无密文 → 省略字段（不返回 null/空串）
    const password = await revealSharePassword(s.passwordCipher, c.env.ENCRYPTION_KEY);
    return {
      id: s.id,
      title: s.title,
      expiresAt: s.expiresAt,
      viewCount: s.viewCount,
      maxViews: s.maxViews,
      downloadCount: s.downloadCount,
      maxDownloads: s.maxDownloads,
      allowPreview: s.allowPreview,
      allowDownload: s.allowDownload,
      passwordProtected: !!s.passwordHash,
      ...(password !== undefined ? { password } : {}),
      requireLogin: s.requireLogin,
      allowedUserCount: s.allowedUserIds?.length ?? 0,
      status: s.status,
      createdAt: s.createdAt,
      itemCount,
      totalSize,
      firstItem,
    };
  }));

  return ok(c, { items, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
});

// ============ 公开分享信息（无需登录） ============
shareRoutes.get('/:id', async (c) => {
  const gate = await gateShareRead(c, c.req.param('id'), { countView: true });
  const { share, creatorName, items, passwordRequired, viewCounted } = gate;

  // 创建者本人或管理员：回传明文密码（仅用于分享页的「查看密码 / 附带密码的链接」；公开访客永不返回）
  const viewerId = c.get('userId') as string | undefined;
  const sharePassword =
    share.passwordCipher && viewerId && (viewerId === share.creatorId || c.get('user')?.role === 'admin')
      ? await revealSharePassword(share.passwordCipher, c.env.ENCRYPTION_KEY)
      : undefined;

  if (passwordRequired) {
    // 带参数直进：显式提供 ?password= 但校验失败 → 401（docs/API：密码错误返回 INVALID_PASSWORD）；
    // 未提供密码时保持遮蔽（不抛错），避免匿名访客通过错误码探测分享状态。
    if (c.req.query('password') !== undefined) throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');
    return ok(c, {
      share: {
        id: share.id,
        title: share.title,
        creatorName,
        password: sharePassword,
        items: [],
        allowPreview: false,
        allowDownload: false,
        expiresAt: share.expiresAt,
        requiresPassword: true,
        viewCount: share.viewCount,
        maxViews: share.maxViews,
        downloadCount: share.downloadCount,
        maxDownloads: share.maxDownloads,
      },
    });
  }

  return ok(c, {
    share: {
      id: share.id,
      title: share.title,
      creatorName,
      password: sharePassword,
      items: items.map((f) => toShareItemView(f, f.id)),
      allowPreview: share.allowPreview,
      allowDownload: share.allowDownload,
      expiresAt: share.expiresAt,
      requiresPassword: !!share.passwordHash,
      viewCount: share.viewCount + (viewCounted ? 1 : 0),
      maxViews: share.maxViews,
      downloadCount: share.downloadCount,
      maxDownloads: share.maxDownloads,
    },
  });
});

// ============ 分享内目录浏览（root = 文件夹项目 id，sub = 根内相对路径） ============
shareRoutes.get('/:id/list', async (c) => {
  const db = getDb(c);
  const shareId = c.req.param('id');
  const gate = await gateShareRead(c, shareId);
  if (gate.passwordRequired) throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');

  const rootId = c.req.query('root');
  if (!rootId) throw ApiError.badRequest('缺少 root 参数');
  const rootFile = gate.items.find((f) => f.id === rootId);
  if (!rootFile) throw new ApiError(403, 'FORBIDDEN', '项目不在该分享范围内');
  if (rootFile.type !== 'folder') throw ApiError.badRequest('该项目不是文件夹');

  // 相对路径规范化：safeDecodePath 宽容解码 → normalizePath 拒绝 .. 逃逸
  let sub: string;
  try {
    sub = normalizePath(safeDecodePath(c.req.query('sub') ?? '/'));
  } catch (err) {
    if (err instanceof PathError) throw new ApiError(403, 'FORBIDDEN', '路径越界');
    throw err;
  }
  const absPath = sub === '/' ? rootFile.path : `${rootFile.path === '/' ? '' : rootFile.path}${sub}`;
  if (!isPathWithinBoundary(absPath, rootFile.path)) throw new ApiError(403, 'FORBIDDEN', '路径越界');

  // 根目录本身即 rootFile；子目录需存在对应 folder 行
  if (absPath !== rootFile.path) {
    const folder = await FileRepo.getFolderAtPath(db, rootFile.mountId, absPath, basename(absPath));
    if (!folder) throw new ApiError(404, 'NOT_FOUND', '目录不存在');
  }

  const { rows } = await FileRepo.listChildren(
    db,
    rootFile.mountId,
    absPath,
    { sortBy: 'name', sortOrder: 'asc', limit: 500, offset: 0 },
    rootFile.ownerId
  );

  return ok(c, {
    shareId,
    rootId,
    path: sub,
    items: rows.map((f) => toShareItemView(f, rootId)),
  });
});

// ============ 分享下载链接 ============
shareRoutes.get('/:id/download', async (c) => {
  const db = getDb(c);
  const shareId = c.req.param('id');
  const gate = await gateShareRead(c, shareId);
  if (gate.passwordRequired) throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');
  const { share } = gate;
  if (!share.allowDownload) throw new ApiError(403, 'FORBIDDEN', '分享不允许下载');

  // itemId 缺省 = 第一个项目；作用域 = 项目自身或任一文件夹项目的后代
  const itemId = c.req.query('itemId') ?? gate.items[0]?.id;
  const file = itemId ? await ShareRepo.resolveShareFile(db, share, itemId) : null;
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  if (file.type === 'folder') throw ApiError.badRequest('文件夹不能直接下载');
  // §26 违规封禁：内容出口门禁（多项目分享解析出的每个文件在此统一拦截）
  await assertNotBanned(db, [file.id]);

  // 审计 H-04：签发下载令牌阶段不计数（防止攻击者反复签发不消费、先耗尽额度）。
  // 下载计数仅在网关实际消费令牌、开始返回对象时增加一次。
  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: physicalObjectKey(file),
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
  const gate = await gateShareRead(c, shareId);
  if (gate.passwordRequired) throw new ApiError(401, 'INVALID_PASSWORD', '分享密码错误');
  const { share } = gate;
  if (!share.allowPreview) throw new ApiError(403, 'FORBIDDEN', '分享不允许预览');

  const itemId = c.req.query('itemId') ?? gate.items[0]?.id;
  const file = itemId ? await ShareRepo.resolveShareFile(db, share, itemId) : null;
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  if (file.type === 'folder') throw ApiError.badRequest('文件夹不能预览');
  // §26 违规封禁：内容出口门禁（多项目分享解析出的每个文件在此统一拦截）
  await assertNotBanned(db, [file.id]);

  const mount = await MountRepo.getMountById(db, file.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  // §G：预览读取带池内回退（落桶取不到时轮询其余桶）
  const { object: obj } = await getFileObject({
    db,
    env: c.env as Env,
    mount,
    ref: { fileId: file.id, mountId: file.mountId, providerId: file.providerId, physicalKey: physicalObjectKey(file), size: file.size },
  });
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
