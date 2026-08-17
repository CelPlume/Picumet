// WebDAV 兼容协议：PicGo/PicList（Basic Auth：keyId:secret）
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import {
  FileRepo, QuotaRepo, MountRepo, ProviderRepo, LogRepo,
} from '../db';
import { getDb, getClientIp } from '../middleware/auth';
import { apiKeyAuthMiddleware } from '../middleware/auth';
import { getProvider } from '../providers';
import { ApiError } from '../utils/errors';
import { normalizePath, objectKeyFromPath, isValidFileName } from '../utils/path';
import { uuid } from '../utils/crypto';
import type { Env } from '../types';

export const webdavRoutes = new Hono<AppBindings>();

webdavRoutes.use('*', apiKeyAuthMiddleware);

function davPath(p: string): string {
  return normalizePath(p);
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

function makeMultistatus(items: Array<{ href: string; status: string; props?: string }>): string {
  const body = items
    .map(
      (it) =>
        `  <d:response>\n    <d:href>${it.href}</d:href>\n    <d:status>HTTP/1.1 ${it.status}</d:status>${it.props ? `\n${it.props}` : ''}\n  </d:response>`
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
  if (!apiKey.permissions.includes('write')) throw new ApiError(403, 'FORBIDDEN', '密钥无上传权限');
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

  const reserved = await QuotaRepo.reserve(db, userId, size);
  if (!reserved) throw new ApiError(413, 'QUOTA_EXCEEDED', '存储配额不足');

  try {
    const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
    if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
    const provider = await getProvider(db, providerRow, c.env as Env);
    const objectKey = objectKeyFromPath(mount.mountPath, providerRow.pathPrefix, targetPath);

    await provider.putObject(objectKey, bytes, mimeType);
    const head = await provider.headObject(objectKey);

    const existing = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
    let file;
    if (existing && existing.type === 'file') {
      await FileRepo.updateFile(db, existing.id, { object_key: objectKey, size, etag: head?.etag, mime_type: mimeType, path: parentPath });
      file = existing;
    } else {
      file = await FileRepo.createFile(db, {
        mountId: mount.id,
        objectKey,
        path: parentPath,
        name,
        type: 'file',
        mimeType,
        size,
        etag: head?.etag,
        ownerId: userId,
      });
    }

    await db.transaction(async (tx) => {
      if (existing && existing.type === 'file') {
        await tx.query(
          `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ? + ?), quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE user_id = ?`,
          [existing.size, size, size, Date.now(), userId]
        );
      } else {
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

    return xmlResponse(201, { ETag: head?.etag ? `"${head.etag}"` : undefined });
  } catch (err) {
    await QuotaRepo.releaseReservation(db, userId, size);
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
  if (!apiKey.permissions.includes('delete')) throw new ApiError(403, 'FORBIDDEN', '密钥无删除权限');

  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const targetPath = davPath(rawPath);
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');

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

  try {
    const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
    const provider = await getProvider(db, providerRow!, c.env as Env);
    for (const k of keys) {
      if (!k.startsWith('folder:')) await provider.deleteObject(k);
    }
  } catch {
    // 清理失败由对账任务处理
  }
  return xmlResponse(204);
});

// ============ MOVE：移动/重命名 ============
webdavRoutes.on(['MOVE'], '*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const dest = c.req.header('destination');
  if (!dest) throw new ApiError(400, 'VALIDATION_ERROR', '缺少 Destination 头');

  const rawPath = c.req.path.replace(/^\/webdav/, '') || '/';
  const sourcePath = davPath(rawPath);
  const destPath = davPath(decodeURIComponent(dest.split('/webdav').pop() ?? ''));

  const name = sourcePath.split('/').filter(Boolean).pop() ?? '';
  const sourceParent = sourcePath.slice(0, -(name.length + 1)) || '/';
  const destName = destPath.split('/').filter(Boolean).pop() ?? name;
  const destParent = destPath.slice(0, -(destName.length + 1)) || '/';

  const mount = await MountRepo.findMountForPath(db, sourcePath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  const file = await FileRepo.getFileAtPath(db, mount.id, sourceParent, name);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');

  await FileRepo.updateFile(db, file.id, { name: destName, path: destParent });
  await db.run(
    `UPDATE file_metadata SET path = ? || substr(path, ?), updated_at = ? WHERE path LIKE ?`,
    [destPath, sourcePath.length + 1, Date.now(), `${sourcePath}/%`]
  );
  return xmlResponse(201, { Location: dest });
});

// XML 解析器（禁用实体，防 XXE）——当前仅生成 XML，不解析外部输入
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[m] as string);
}
