// 文件路由 A：列表、文件夹、详情、元数据更新、密码验证、下载链接
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo, LogRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { requirePermission, can, getPrincipal } from '../permissions/principal';
import { isPasswordExempt } from '../permissions/check';
import { getProvider } from '../storage/providers';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import {
  normalizePath,
  objectKeyFromPath,
  isValidFileName,
  validateFileType,
} from '../../utils/path';
import { hashPassword, verifyPassword } from '../../utils/crypto';
import { toFileListItem } from '../../db/repos/files';
import type { Env } from '../../shared/types';
import { CAPABILITIES, type Visibility } from '@shared/types';
import { decideAccessMode, createDownloadToken, buildGatewayUrl } from '../shares/tokens';
import { UpdateFileSchema, CreateFolderSchema, VerifyPasswordSchema, ListQuerySchema } from './schemas';

export const filesRoutes = new Hono<AppBindings>();

async function resolveFile(c: Parameters<typeof ok>[0]) {
  const db = getDb(c);
  const id = c.req.param('id') as string;
  const file = await FileRepo.getFileById(db, id);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  const mount = await MountRepo.getMountById(db, file.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  return { file, mount, db };
}

async function providerFor(c: Parameters<typeof ok>[0], mountId: string) {
  const db = getDb(c);
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const p = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!p) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return getProvider(db, p, c.env as Env);
}

function ipOf(c: Parameters<typeof ok>[0]): string | undefined {
  const cf = (c.req.raw as Request & { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? undefined;
}

// ============ 列出文件 ============
filesRoutes.get('/', async (c) => {
  const db = getDb(c);
  // 审计 M-05：query 统一 Zod 校验
  const qParse = ListQuerySchema.safeParse(c.req.query());
  if (!qParse.success) throw ApiError.badRequest('查询参数无效');
  const q = qParse.data;
  const targetPath = normalizePath(q.path ?? '/');
  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');

  // §4.4a：目录列表受目标文件夹自身可见性门控（users/public 文件夹可被其他用户列出）
  const segs = targetPath.split('/').filter(Boolean);
  const folderName = segs.pop();
  let folderVisibility: Visibility | undefined;
  if (folderName) {
    const folderParent = '/' + segs.join('/');
    const folderRow = await FileRepo.getFileAtPath(db, mount.id, folderParent, folderName);
    if (folderRow?.type === 'folder') folderVisibility = folderRow.visibility;
  }

  await requirePermission(c, mount, targetPath, 'read', undefined, undefined, folderVisibility);

  const page = q.page ?? 1;
  const limit = q.limit ?? 100;
  const sortBy = (q.sort ?? mount.sortBy) as string;
  const sortOrder = q.order ?? 'asc';
  const typeFilter = q.type;

  const { rows, total } = await FileRepo.listChildren(db, mount.id, targetPath, {
    sortBy,
    sortOrder,
    search: q.search,
    type: typeFilter,
    limit,
    offset: (page - 1) * limit,
  });

  return ok(c, {
    items: rows.map(toFileListItem),
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    mount: {
      id: mount.id,
      name: mount.name,
      sortBy: mount.sortBy,
      sortOrder: mount.sortOrder,
    },
  });
});

// ============ 创建文件夹 ============
filesRoutes.post('/folder', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = CreateFolderSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('文件夹参数无效');
  const { path, name } = parsed.data;
  if (!isValidFileName(name)) throw ApiError.badRequest('文件夹名包含非法字符');
  const targetPath = normalizePath(path);
  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标路径不存在');

  await requirePermission(c, mount, targetPath, 'write');

  const folderPath = targetPath === '/' ? `/${name}` : `${targetPath}/${name}`;

  // 重复检测：文件行 path=父目录；文件夹行 path=自身全路径 → 两处都要查
  const existingFile = await FileRepo.getFileAtPath(db, mount.id, targetPath, name);
  const existingFolder = await FileRepo.getFileAtPath(db, mount.id, folderPath, name);
  if (existingFile || existingFolder) {
    throw new ApiError(409, 'ALREADY_EXISTS', '同名文件或文件夹已存在');
  }

  const objectKey = objectKeyFromPath(mount.mountPath, '', folderPath);
  const folder = await FileRepo.createFile(db, {
    mountId: mount.id,
    objectKey: `folder:${objectKey}`,
    path: folderPath,
    name,
    type: 'folder',
    size: 0,
    ownerId: userId,
  });
  return ok(c, { file: toFileListItem(folder) }, undefined, 201);
});

// 文件域权限检查路径：文件行 path=父目录，但规则粒度需要文件全路径
// （pattern=父目录的规则经 pathMatches 继承仍匹配；pattern=文件自身的规则获得精确粒度）
function filePermPath(f: { path: string; name: string; type: 'file' | 'folder' }): string {
  if (f.type === 'folder') return f.path;
  return f.path === '/' ? `/${f.name}` : `${f.path}/${f.name}`;
}

// ============ 文件详情 ============
filesRoutes.get('/:id', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  const permPath = filePermPath(file);
  await requirePermission(c, mount, permPath, 'read', file.ownerId, undefined, file.visibility);

  const provider = await providerFor(c, mount.id);
  const accessMode = decideAccessMode(file, provider, false);

  const perms = (
    await Promise.all(
      (['read', 'write', 'update', 'delete', 'share', 'download'] as const).map(async (p) => {
        const allowed = await can(c, mount, permPath, p, file.ownerId);
        return allowed ? p : null;
      })
    )
  ).filter(Boolean) as string[];

  void db;
  return ok(c, {
    file: toFileListItem(file),
    mount: { id: mount.id, name: mount.name, sortBy: mount.sortBy, sortOrder: mount.sortOrder },
    permissions: perms,
    accessMode,
    hasPassword: !!file.accessPassword,
  });
});

// ============ 更新元数据 / 重命名 / 设置密码 ============
filesRoutes.put('/:id', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = UpdateFileSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '参数无效');

  const { name, accessPassword, visibility, ...rest } = parsed.data;

  // §4.4a：可见性变更（能力位门禁 + 审核状态 + folder 级联）
  // 已是 public/pending 时重新提交允许升级审核状态（如获得 can_publish 后直接 approved）
  if (visibility !== undefined) {
    const principal = await getPrincipal(c);
    const canPublish =
      principal.role === 'admin' || (principal.capabilities ?? []).includes(CAPABILITIES.publish);
    // users：全部登录用户可读（需求③，无需能力位）；
    // public：can_publish 直接 approved；否则提交进入审核（§4.2.2），管理员批准后进 gallery
    const reviewStatus = visibility === 'public' ? (canPublish ? 'approved' : 'pending') : 'approved';
    if (visibility !== file.visibility || reviewStatus !== file.reviewStatus) {
      await requirePermission(c, mount, filePermPath(file), 'update', file.ownerId);
      if (file.type === 'folder') {
        // 级联子树：公开相册场景一次置可见
        await db.run(
          `UPDATE file_metadata SET visibility = ?, review_status = ?, updated_at = ?
           WHERE mount_id = ? AND (path = ? OR path LIKE ?)`,
          [visibility, reviewStatus, Date.now(), mount.id, file.path, `${file.path}/%`]
        );
      }
      await LogRepo.create(db, {
        userId: c.get('userId') as string,
        action: 'visibility_change',
        path: file.path,
        metadata: JSON.stringify({ from: file.visibility, to: visibility, reviewStatus }),
        ipAddress: ipOf(c),
        userAgent: c.req.header('user-agent'),
      });
      // 级联后仍需更新自身行（folder 行 path=自身；file 行在下方 fields 统一更新）
      await FileRepo.updateFile(db, file.id, { visibility, review_status: reviewStatus });
      await FileRepo.updateVersion(db, file.id);
    }
  }

  if (name) {
    if (!isValidFileName(name)) throw ApiError.badRequest('文件名包含非法字符');
    validateFileType(name, file.mimeType);
    await requirePermission(c, mount, filePermPath(file), 'update', file.ownerId);
    const parentPath = file.path.length > file.name.length
      ? file.path.slice(0, -(file.name.length + 1)) || '/'
      : '/';
    const conflict = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
    if (conflict && conflict.id !== file.id) throw new ApiError(409, 'ALREADY_EXISTS', '同名文件已存在');
    const newPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
    await FileRepo.updateFile(db, file.id, { name, path: newPath });
  }

  const fields: Record<string, unknown> = {};
  const colMap: Record<string, string> = {
    customTitle: 'custom_title',
    customColor: 'custom_color',
    coverUrl: 'cover_url',
    iconEmoji: 'icon_emoji',
    manualPosition: 'manual_position',
  };
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    fields[colMap[k] ?? k] = v;
  }
  if (accessPassword !== undefined) {
    await requirePermission(c, mount, filePermPath(file), 'update', file.ownerId);
    fields.access_password = accessPassword ? hashPassword(accessPassword) : null;
  }
  if (Object.keys(fields).length > 0) {
    await requirePermission(c, mount, filePermPath(file), 'update', file.ownerId);
    await FileRepo.updateFile(db, file.id, fields);
    await FileRepo.updateVersion(db, file.id);
  }

  const updated = await FileRepo.getFileById(db, file.id);
  return ok(c, { file: updated ? toFileListItem(updated) : null });
});

// ============ 验证密码 ============
filesRoutes.post('/:id/verify-password', async (c) => {
  const { file, db } = await resolveFile(c);
  const body = await c.req.json().catch(() => null);
  const password = body?.password as string | undefined;
  if (!file.accessPassword) throw ApiError.badRequest('该文件无需密码');
  if (!password) throw ApiError.badRequest('请输入密码');
  if (!verifyPassword(password, file.accessPassword)) {
    throw new ApiError(401, 'INVALID_PASSWORD', '密码错误');
  }
  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    passwordVerified: true,
  });
  await LogRepo.create(db, {
    userId: c.get('userId') as string | undefined,
    action: 'password_verify',
    path: file.path,
    ipAddress: ipOf(c),
    userAgent: c.req.header('user-agent'),
  });
  return ok(c, { url: buildGatewayUrl(c, token), expiresIn: 900 });
});

// ============ 获取下载链接 ============
filesRoutes.get('/:id/download', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  await requirePermission(c, mount, filePermPath(file), 'download', file.ownerId, undefined, file.visibility);
  // §4.4c：密码门禁统一豁免判定——admin 不受限、owner 跳过；其余主体需先验证密码
  const principal = await getPrincipal(c);
  const passwordExempt = isPasswordExempt(principal, file.ownerId);
  if (file.accessPassword && !passwordExempt) {
    throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护，请先验证密码');
  }
  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    passwordVerified: passwordExempt,
  });
  const url = buildGatewayUrl(c, token);
  await LogRepo.create(db, {
    userId: c.get('userId') as string | undefined,
    action: 'download',
    path: file.path,
    metadata: JSON.stringify({ fileName: file.name }),
    ipAddress: ipOf(c),
    userAgent: c.req.header('user-agent'),
    bytesTransferred: file.size,
  });
  return ok(c, { url, expiresAt: Date.now() + 900 * 1000 });
});

// ============ 复制链接（多种格式，支持签名） ============
filesRoutes.get('/:id/copy-links', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  await requirePermission(c, mount, filePermPath(file), 'download', file.ownerId, undefined, file.visibility);
  const provider = await providerFor(c, mount.id);

  const q = c.req.query();
  const signed = q.signed === 'true';
  const expiresIn = Math.min(Math.max(parseInt(q.expiresIn ?? '3600', 10) || 3600, 60), 604800);

  const gatewayUrl = async () => {
    const token = await createDownloadToken(db, {
      fileId: file.id,
      mountId: file.mountId,
      objectKey: file.objectKey,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      passwordVerified: false,
    });
    return buildGatewayUrl(c, token);
  };

  // 公开直链：{origin}{虚拟路径}（文件 path 已含挂载点前缀，如 /drive/text/x.txt）
  const baseOrigin = c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  const fullVirtualPath = file.path === '/' ? `/${file.name}` : `${file.path}/${file.name}`;
  const publicUrl = `${baseOrigin}${fullVirtualPath}`;

  let baseUrl: string;
  if (signed) {
    // 签名直链：优先 provider 预签名 URL，否则回退网关 token
    const presigned = await provider.getDownloadUrl(file.objectKey, expiresIn);
    baseUrl = presigned ?? (await gatewayUrl());
  } else {
    baseUrl = publicUrl;
  }

  const direct = baseUrl;
  const html = `<img src="${direct}" alt="${escapeHtml(file.name)}">`;
  const markdown = `![${escapeMd(file.name)}](${direct})`;
  const bbcode = `[img]${direct}[/img]`;

  void db;
  return ok(c, {
    formats: { direct, html, markdown, bbcode },
    accessMode: signed ? 'signed' : 'public_path',
    needsPassword: !!file.accessPassword,
    expiresIn: signed ? expiresIn : undefined,
  });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m] as string);
}
function escapeMd(s: string): string {
  return s.replace(/[\\[\]()]/g, '\\$&');
}

export { ipOf };
