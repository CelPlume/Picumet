// WebDAV 兼容协议：PicGo/PicList（Basic Auth：keyId:secret）
// 审计 H-3/H-4：全部方法接入统一路径级权限服务；MOVE 复用移动 Saga，不再直接改 file_metadata。
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  FileRepo, QuotaRepo, MountRepo, ProviderRepo, LogRepo, ReconciliationRepo,
} from '../db';
import { getDb, getClientIp } from '../middleware/auth';
import { apiKeyAuthMiddleware } from '../middleware/auth';
import { getProvider } from '../providers';
import { requirePermission } from '../services/principal';
import { moveWithSaga, cleanupObjects } from '../services/move';
import { ApiError } from '../utils/errors';
import { normalizePath, objectKeyFromPath, isValidFileName, isPathWithinBoundary } from '../utils/path';
import { uuid } from '../utils/crypto';
import type { Env } from '../types';

export const webdavRoutes = new Hono<AppBindings>();

webdavRoutes.use('*', apiKeyAuthMiddleware);

function davPath(p: string): string {
  return normalizePath(p);
}

/** M-3：WebDAV 写目标必须位于密钥配置的上传根目录内 */
function assertWithinUploadRoot(apiKey: { uploadPath: string }, targetPath: string): void {
  const root = normalizePath(apiKey.uploadPath || '/');
  if (!isPathWithinBoundary(targetPath, root)) {
    throw new ApiError(403, 'FORBIDDEN', '目标路径超出密钥上传根目录');
  }
}

function xmlResponse(status: number, headers: Record<string, string | undefined> = {}, body?: string): Response {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) clean[k] = v;
  }
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', ...clean },
  });
}

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>\n';

// XML 转义（L-1）：href 与所有文本节点统一转义，防注入/破坏 XML
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[m] as string);
}

function makeMultistatus(items: Array<{ href: string; status: string; props?: string }>): string {
  const body = items
    .map(
      (it) =>
        `  <d:response>\n    <d:href>${escapeXml(it.href)}</d:href>\n    <d:status>HTTP/1.1 ${it.status}</d:status>${it.props ? `\n${it.props}` : ''}\n  </d:response>`
    )
    .join('\n');
  return `${XML_HEADER}<d:multistatus xmlns:d="DAV:" xmlns:ns0="DAV:">\n${body}\n</d:multistatus>`;
}

// ============ OPTIONS：声明 WebDAV 能力 ============
webdavRoutes.options('*', (c) => {
  c.header('DAV', '1,2');
  c.header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, MOVE, COPY');
  c.header('MS-Author-Via', 'DAV');
  return c.body(null, 204);
});

// ============ PROPFIND：列出目录 ============
webdavRoutes.on(['PROPFIND'], '*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');

  const depth = c.req.header('depth') ?? '1';
  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const targetPath = davPath(rawPath);

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // H-3：读操作走统一路径级权限
  await requirePermission(c, mount, targetPath, 'read');

  const { rows } = await FileRepo.listChildren(db, mount.id, targetPath, {});
  const items: Array<{ href: string; status: string; props?: string }> = [];

  const mkProps = (name: string, isFolder: boolean, size: number, mtime: number) => {
    const href = `/webdav${targetPath === '/' ? '' : targetPath}/${name}`;
    return { href, status: '200 OK', props: `<d:propstat>\n<d:prop>\n<d:displayname>${escapeXml(name)}</d:displayname>\n<d:resourcetype>${isFolder ? '<d:collection/>' : ''}</d:resourcetype>\n<d:getcontentlength>${size}</d:getcontentlength>\n<d:getlastmodified>${new Date(mtime).toUTCString()}</d:getlastmodified>\n</d:prop>\n<d:status>HTTP/1.1 200 OK</d:status>\n</d:propstat>` };
  };

  // 自身
  items.push(mkProps('', true, 0, Date.now()));

  if (depth !== '0') {
    for (const r of rows) {
      items.push(mkProps(r.name, r.type === 'folder', r.size, r.updatedAt));
    }
  }

  return xmlResponse(207, {}, makeMultistatus(items));
});

// ============ MKCOL：创建文件夹 ============
webdavRoutes.on(['MKCOL'], '*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const targetPath = davPath(rawPath);
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';
  if (!isValidFileName(name)) throw new ApiError(400, 'VALIDATION_ERROR', '文件夹名非法');

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // H-3：写操作走统一路径级权限；M-3：目标位于密钥上传根内
  assertWithinUploadRoot(apiKey, targetPath);
  await requirePermission(c, mount, targetPath, 'write');

  const existing = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  if (existing) return xmlResponse(405);

  const objectKey = objectKeyFromPath(mount.mountPath, '', targetPath);
  await FileRepo.createFile(db, {
    mountId: mount.id,
    objectKey: `folder:${objectKey}`,
    path: targetPath,
    name,
    type: 'folder',
    size: 0,
    ownerId: apiKey.userId,
  });
  return xmlResponse(201);
});

// ============ PUT：上传 ============
webdavRoutes.put('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const userId = c.get('userId');

  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const targetPath = davPath(rawPath);
  const name = targetPath.split('/').filter(Boolean).pop() ?? 'file';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';
  if (!isValidFileName(name)) throw new ApiError(400, 'VALIDATION_ERROR', '文件名非法');

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const mimeType = c.req.header('content-type') ?? 'application/octet-stream';
  const size = bytes.byteLength;

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标挂载点不存在');
  // H-3：写操作走统一路径级权限；M-3：目标位于密钥上传根内
  assertWithinUploadRoot(apiKey, targetPath);
  await requirePermission(c, mount, targetPath, 'write');

  const reserved = await QuotaRepo.reserve(db, userId, size);
  if (!reserved) throw new ApiError(413, 'QUOTA_EXCEEDED', '存储配额不足');

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const provider = await getProvider(db, providerRow, c.env as Env);
  const objectKey = objectKeyFromPath(mount.mountPath, providerRow.pathPrefix, targetPath);

  const existing = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  const fileId = existing?.id ?? uuid();

  try {
    await provider.putObject(objectKey, bytes, mimeType);
    const head = await provider.headObject(objectKey);
    if (!head) throw new ApiError(422, 'OPERATION_FAILED', '对象写入失败');

    // H-5：元数据 + 配额 + 日志在同一批提交（对象失败不影响元数据原子性）
    await db.transaction(async (tx) => {
      if (existing && existing.type === 'file') {
        await FileRepo.updateFileTx(tx, existing.id, {
          object_key: objectKey, size, etag: head.etag, mime_type: mimeType, path: parentPath,
        });
        await tx.query(
          `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ? + ?), quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE user_id = ?`,
          [existing.size, size, size, Date.now(), userId]
        );
      } else {
        await FileRepo.createFileTx(tx, {
          id: fileId,
          mountId: mount.id,
          objectKey,
          path: parentPath,
          name,
          type: 'file',
          mimeType,
          size,
          etag: head.etag,
          ownerId: userId,
        });
        await tx.query(
          `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
          [size, size, Date.now(), userId]
        );
      }
      await tx.query(
        `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 201, ?)`,
        [uuid(), userId, targetPath, JSON.stringify({ fileName: name, via: 'webdav' }), getClientIp(c), c.req.header('user-agent'), size, Date.now()]
      );
    });

    return xmlResponse(201, { ETag: head.etag ? `"${head.etag}"` : undefined });
  } catch (err) {
    // 补偿：释放预留；尽力删除已写对象，失败记录孤儿供对账
    await QuotaRepo.releaseReservation(db, userId, size);
    try {
      await provider.deleteObject(objectKey);
    } catch (cleanupErr) {
      await ReconciliationRepo.createOrphanObject(db, {
        mountId: mount.id,
        objectKey,
        reason: 'upload_db_failed',
        error: cleanupErr instanceof Error ? cleanupErr.message : 'unknown',
      });
    }
    throw err;
  }
});

// ============ GET：下载 ============
webdavRoutes.get('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const targetPath = davPath(rawPath);
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // H-3：读操作走统一路径级权限
  await requirePermission(c, mount, targetPath, 'read');
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  if (!file || file.type === 'folder') throw new ApiError(404, 'NOT_FOUND', '文件不存在');

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  const provider = await getProvider(db, providerRow!, c.env as Env);
  const obj = await provider.getObject(file.objectKey);
  if (!obj) throw new ApiError(404, 'NOT_FOUND', '对象不存在');

  await LogRepo.create(db, {
    userId: apiKey.userId,
    action: 'download',
    path: file.path,
    metadata: JSON.stringify({ via: 'webdav' }),
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent'),
    bytesTransferred: file.size,
  });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': file.mimeType ?? 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename="${name.replace(/["\\]/g, '_')}"`,
    },
  });
});

// ============ DELETE：删除 ============
webdavRoutes.delete('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');

  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const targetPath = davPath(rawPath);
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  // H-3：删除操作走统一路径级权限
  await requirePermission(c, mount, targetPath, 'delete', file.ownerId);

  let keys: string[] = [];
  let totalSize = file.size;
  let count = 1;
  if (file.type === 'folder') {
    const desc = await FileRepo.listDescendants(db, mount.id, file.path);
    keys = desc.filter((d) => d.type === 'file').map((d) => d.objectKey);
    totalSize = desc.reduce((s, d) => s + d.size, 0);
    count = desc.length;
  } else {
    keys = [file.objectKey];
  }

  await db.transaction(async (tx) => {
    if (file.type === 'folder') {
      await tx.query(`DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`, [mount.id, file.path, `${file.path}/%`]);
    } else {
      await tx.query(`DELETE FROM file_metadata WHERE id = ?`, [file.id]);
    }
    await tx.query(
      `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?), updated_at = ? WHERE user_id = ?`,
      [totalSize, count, Date.now(), file.ownerId]
    );
    await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
  });

  // 对象清理：失败记录孤儿供对账（H-5 一致性边界）
  await cleanupObjects(c, mount.id, keys);
  return xmlResponse(204);
});

// ============ MOVE：移动/重命名（复用移动 Saga，H-4） ============
webdavRoutes.on(['MOVE'], '*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const dest = c.req.header('destination');
  if (!dest) throw new ApiError(400, 'VALIDATION_ERROR', '缺少 Destination 头');

  // 目标主机必须与本请求同源（禁止跨服务器 MOVE）
  let destUrl: URL;
  try {
    destUrl = new URL(dest);
    const host = c.req.header('host');
    if (host && destUrl.host !== host) {
      throw new ApiError(502, 'BAD_GATEWAY', '不支持跨服务器 MOVE');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'VALIDATION_ERROR', 'Destination 头无效');
  }

  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const sourcePath = davPath(rawPath);
  const destPath = davPath(destUrl.pathname.replace(/^\/webdav/, '') || '/');

  const name = sourcePath.split('/').filter(Boolean).pop() ?? '';
  const sourceParent = sourcePath.slice(0, -(name.length + 1)) || '/';

  const mount = await MountRepo.findMountForPath(db, sourcePath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  const file = await FileRepo.getFileAtPath(db, mount.id, sourceParent, name);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');

  const destName = destPath.split('/').filter(Boolean).pop() ?? name;
  const destParent = destPath.slice(0, -(destName.length + 1)) || '/';
  if (!isValidFileName(destName)) throw new ApiError(400, 'VALIDATION_ERROR', '目标名非法');
  // M-3：目标位于密钥上传根内
  assertWithinUploadRoot(apiKey, destPath);

  // H-4：完整 Saga（源 delete + 目标 write 双重权限、冲突/循环、复制校验、原子切换、异步清理）
  await moveWithSaga(c, { fileId: file.id, targetDir: destParent, targetName: destName });
  return xmlResponse(201, { Location: dest });
});


