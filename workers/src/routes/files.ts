// 文件路由 A：列表、文件夹、详情、元数据更新、密码验证、下载链接
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { z } from 'zod';
import { FileRepo, MountRepo, ProviderRepo, LogRepo } from '../db';
import { getDb } from '../middleware/auth';
import { requirePermission, can } from '../services/principal';
import { getProvider } from '../providers';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import {
  normalizePath,
  objectKeyFromPath,
  isValidFileName,
  validateFileType,
} from '../utils/path';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { toFileListItem } from '../db/repos/files';
import type { Env } from '../types';
import { decideAccessMode, createDownloadToken, buildGatewayUrl } from '../services/gateway';

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  customTitle: z.string().max(200).nullable().optional(),
  customColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  coverUrl: z.string().max(1000).nullable().optional(),
  iconEmoji: z.string().max(16).nullable().optional(),
  accessPassword: z.string().min(1).max(128).nullable().optional(),
  manualPosition: z.number().int().nullable().optional(),
});

const folderSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(255),
});

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
  const q = c.req.query();
  const targetPath = normalizePath(q.path ?? '/');
  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');

  await requirePermission(c, mount, targetPath, 'read');

  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(1000, Math.max(1, Number(q.limit ?? 100) || 100));
  const sortBy = (['name', 'time', 'size', 'manual'].includes(q.sort ?? '') ? q.sort : mount.sortBy) as string;
  const sortOrder = q.order === 'desc' ? 'desc' : 'asc';
  const typeFilter = q.type === 'file' || q.type === 'folder' ? q.type : undefined;

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
  const parsed = folderSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('文件夹参数无效');
  const { path, name } = parsed.data;
  if (!isValidFileName(name)) throw ApiError.badRequest('文件夹名包含非法字符');
  const targetPath = normalizePath(path);
  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标路径不存在');

  await requirePermission(c, mount, targetPath, 'write');

  const existing = await FileRepo.getFileAtPath(db, mount.id, targetPath, name);
  if (existing) throw new ApiError(409, 'ALREADY_EXISTS', '同名文件或文件夹已存在');

  const folderPath = targetPath === '/' ? `/${name}` : `${targetPath}/${name}`;
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

// ============ 文件详情 ============
filesRoutes.get('/:id', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  await requirePermission(c, mount, file.path, 'read', file.ownerId);

  const provider = await providerFor(c, mount.id);
  const accessMode = decideAccessMode(file, provider, false);

  const perms = (
    await Promise.all(
      (['read', 'write', 'update', 'delete', 'share', 'download'] as const).map(async (p) => {
        const allowed = await can(c, mount, file.path, p, file.ownerId);
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
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '参数无效');

  const { name, accessPassword, ...rest } = parsed.data;
  if (name) {
    if (!isValidFileName(name)) throw ApiError.badRequest('文件名包含非法字符');
    validateFileType(name, file.mimeType);
    await requirePermission(c, mount, file.path, 'update', file.ownerId);
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
    await requirePermission(c, mount, file.path, 'update', file.ownerId);
    fields.access_password = accessPassword ? hashPassword(accessPassword) : null;
  }
  if (Object.keys(fields).length > 0) {
    await requirePermission(c, mount, file.path, 'update', file.ownerId);
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
  await requirePermission(c, mount, file.path, 'download', file.ownerId);
  if (file.accessPassword) {
    throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护，请先验证密码');
  }
  const token = await createDownloadToken(db, {
    fileId: file.id,
    mountId: file.mountId,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    passwordVerified: false,
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

// ============ 复制链接（多种格式） ============
filesRoutes.get('/:id/copy-links', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  await requirePermission(c, mount, file.path, 'download', file.ownerId);
  const provider = await providerFor(c, mount.id);
  const accessMode = decideAccessMode(file, provider, false);

  let baseUrl: string;
  if (accessMode === 'public_cdn') {
    baseUrl = provider.getPublicUrl(file.objectKey) as string;
  } else {
    const token = await createDownloadToken(db, {
      fileId: file.id,
      mountId: file.mountId,
      objectKey: file.objectKey,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      passwordVerified: false,
    });
    baseUrl = buildGatewayUrl(c, token);
  }

  const direct = baseUrl;
  const html = `<img src="${direct}" alt="${escapeHtml(file.name)}">`;
  const markdown = `![${escapeMd(file.name)}](${direct})`;
  const bbcode = `[img]${direct}[/img]`;

  void db;
  return ok(c, {
    formats: { direct, html, markdown, bbcode },
    accessMode,
    needsPassword: !!file.accessPassword,
  });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m] as string);
}
function escapeMd(s: string): string {
  return s.replace(/[\\[\]()]/g, '\\$&');
}

export { ipOf };
