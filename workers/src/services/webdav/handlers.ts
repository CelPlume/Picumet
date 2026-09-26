// WebDAV 兼容协议：PicGo/PicList（Basic Auth：keyId:secret）
// 审计 H-3/H-4：全部方法接入统一路径级权限服务；MOVE 复用移动 Saga，不再直接改 file_metadata。
// 网关密钥数据层所有者隔离：文件行查询全部限定属主（check.ts + repos ownerId 过滤）。
// P1-3（docs/PICLIST_COMPAT_CN.md）：href 逐段 URI 编码、PROPFIND 自项真实属性、
// getcontenttype/getetag、OPTIONS 不再宣告未实现的 COPY、MOVE Overwrite 头、MKCOL/PUT 递归建父。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import type { FileMetadata } from '@shared/types';
import {
  FileRepo, MountRepo, ProviderRepo, LogRepo,
} from '../../db';
import { getDb, apiKeyAuthMiddleware, assertApiKeyProtocol } from '../../middleware/auth';
import { requestIp } from '../../utils/ip';
import { getProvider } from '../storage/providers';
import { getProviderForFile } from '../storage/pool';
import { serveFileObject } from '../storage/failover';
import { physicalObjectKey } from '../storage/keys';
import { requirePermission, assertBucketPermission } from '../permissions/principal';
import { moveWithSaga } from '../files/move';
import { deleteFileInternal } from '../files/remove';
import { ensureFolders, upsertFileObject } from '../files/write';
import { serveObject } from '../storage/serve';
import type { StorageProviderInterface } from '../storage/types';
import { ApiError } from '../../shared/errors';
import { normalizePath, isValidFileName, isPathWithinBoundary } from '../../utils/path';
import { assertWritable, assertFolderCreateAllowed } from '../files/upload-mode';

export const webdavRoutes = new Hono<AppBindings>();

webdavRoutes.use('*', apiKeyAuthMiddleware);

// P1-2：protocols 非空的密钥必须声明 webdav 面
webdavRoutes.use('*', async (c, next) => {
  assertApiKeyProtocol(c.get('apiKey'), 'webdav');
  await next();
});

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

function makeMultistatus(items: DavItem[]): string {
  const body = items
    .map(
      (it) =>
        `  <d:response>\n    <d:href>${escapeXml(it.href)}</d:href>\n    <d:status>HTTP/1.1 ${it.status}</d:status>${it.props ? `\n${it.props}` : ''}\n  </d:response>`
    )
    .join('\n');
  return `${XML_HEADER}<d:multistatus xmlns:d="DAV:" xmlns:ns0="DAV:">\n${body}\n</d:multistatus>`;
}

interface DavItem {
  href: string;
  status: string;
  props?: string;
}

/** P1-3.1：href 逐路径段 encodeURIComponent（整体 encodeURI 不转义 `#`，`%` 会炸 decodeURIComponent） */
function davHrefFor(fullPath: string): string {
  const segs = fullPath.split('/').filter(Boolean).map(encodeURIComponent);
  return `/webdav/${segs.join('/')}`;
}

interface DavPropsInput {
  name: string;
  fullPath: string;
  isFolder: boolean;
  size: number;
  mtime: number;
  mime?: string;
  etag?: string;
}

/** P1-3.2：自项按真实类型返回；文件补 getcontenttype / getetag */
function davProps(item: DavPropsInput): DavItem {
  const parts = [
    `<d:displayname>${escapeXml(item.name)}</d:displayname>`,
    `<d:resourcetype>${item.isFolder ? '<d:collection/>' : ''}</d:resourcetype>`,
    `<d:getcontentlength>${item.size}</d:getcontentlength>`,
    `<d:getlastmodified>${new Date(item.mtime).toUTCString()}</d:getlastmodified>`,
  ];
  if (!item.isFolder && item.mime) parts.push(`<d:getcontenttype>${escapeXml(item.mime)}</d:getcontenttype>`);
  if (!item.isFolder && item.etag) parts.push(`<d:getetag>${escapeXml(`"${item.etag}"`)}</d:getetag>`);
  return {
    href: davHrefFor(item.fullPath),
    status: '200 OK',
    props: `<d:propstat>\n<d:prop>\n${parts.join('\n')}\n</d:prop>\n<d:status>HTTP/1.1 200 OK</d:status>\n</d:propstat>`,
  };
}

// ============ OPTIONS：声明 WebDAV 能力（不再宣告未实现的 COPY，P1-3.3） ============
webdavRoutes.options('*', (c) => {
  c.header('DAV', '1,2');
  c.header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, MOVE');
  c.header('MS-Author-Via', 'DAV');
  return c.body(null, 204);
});

// ============ PROPFIND：列出目录/文件 ============
webdavRoutes.on(['PROPFIND'], '*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');

  const depth = c.req.header('depth') ?? '1';
  const targetPath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // H-3：读操作走统一路径级权限
  await requirePermission(c, mount, targetPath, 'read');

  const segs = targetPath.split('/').filter(Boolean);
  const selfName = segs.pop() ?? '';
  const selfParent = '/' + segs.join('/');
  const isRoot = targetPath === '/';
  const isMountRoot = targetPath === mount.mountPath;
  // 路径约定：文件夹行 path=自身全路径，文件行 path=父目录 → 双形态查询
  let selfRow: FileMetadata | null = isRoot ? null : await FileRepo.getFileAtPath(db, mount.id, selfParent, selfName);
  if (!selfRow && !isRoot) selfRow = await FileRepo.getFolderAtPath(db, mount.id, targetPath, selfName);
  if (selfRow && selfRow.type === 'file' && selfRow.ownerId !== apiKey.userId) {
    throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  }
  // 自项不存在且非挂载根 → 404（此前对不存在路径返回空列表，客户端会误判）
  if (!selfRow && !isRoot && !isMountRoot) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // §31 桶级矩阵：自项为文件时按文件实际落桶补判读权限（初检早于行解析，不含落桶）
  if (selfRow?.type === 'file') await assertBucketPermission(c, mount.id, selfRow.providerId, 'read');
  const selfIsFolder = isRoot || isMountRoot || selfRow!.type === 'folder';

  const items: DavItem[] = [];
  items.push(davProps({
    name: isRoot ? '' : selfName,
    fullPath: targetPath,
    isFolder: selfIsFolder,
    size: selfRow?.size ?? 0,
    mtime: selfRow?.updatedAt ?? Date.now(),
    mime: selfRow?.mimeType,
    etag: selfRow?.etag,
  }));

  if (selfIsFolder && depth !== '0') {
    // 所有者隔离：仅列出属主自己的子项
    const { rows } = await FileRepo.listChildren(db, mount.id, targetPath, {}, apiKey.userId);
    for (const r of rows) {
      items.push(davProps({
        name: r.name,
        fullPath: r.type === 'folder' ? r.path : r.path === '/' ? `/${r.name}` : `${r.path}/${r.name}`,
        isFolder: r.type === 'folder',
        size: r.size,
        mtime: r.updatedAt,
        mime: r.mimeType,
        etag: r.etag,
      }));
    }
  }

  return xmlResponse(207, {}, makeMultistatus(items));
});

// ============ MKCOL：创建文件夹（递归补齐缺失祖先，P1-3.5） ============
webdavRoutes.on(['MKCOL'], '*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const targetPath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';
  if (!isValidFileName(name)) throw new ApiError(400, 'VALIDATION_ERROR', '文件夹名非法');

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // H-3：写操作走统一路径级权限；M-3：目标位于密钥上传根内
  assertWithinUploadRoot(apiKey, targetPath);
  await requirePermission(c, mount, targetPath, 'write');

  // §28 写入口模式：user_space 要求落在自身用户空间；flat 禁止新建文件夹
  await assertWritable(db, mount, apiKey.userId, targetPath);
  assertFolderCreateAllowed(mount);

  // 目录名占用检查（双形态：文件行 / 目录行）；被任何用户占用即 405
  const asFile = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  const asFolder = asFile ?? await FileRepo.getFolderAtPath(db, mount.id, targetPath, name);
  if (asFolder) return xmlResponse(405);

  await ensureFolders(db, mount, targetPath, apiKey.userId);
  return xmlResponse(201);
});

// ============ PUT：上传（统一走 upsertFileObject：覆盖语义/配额/目录行/补偿一致） ============
// §28 写入口模式在 upsertFileObject 内统一校验（user_space 强制自身用户空间），
// 此处不重复判断——PUT 永远产出文件行（key 尾部的 `/` 被 normalizePath 归一掉，不构成建目录语义），
// 故 flat 档的「禁止新建文件夹」不适用于本入口。
webdavRoutes.put('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const userId = c.get('userId');

  const targetPath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');
  const name = targetPath.split('/').filter(Boolean).pop() ?? 'file';
  if (!isValidFileName(name)) throw new ApiError(400, 'VALIDATION_ERROR', '文件名非法');

  // 审计 H-03：WebDAV PUT 流式转发请求体（不整包读入内存）。
  // Content-Length 已知时流式 + 前置拒绝；缺失（chunked）时回退读取以确定大小。
  const rawLength = Number(c.req.header('content-length') ?? '');
  const hasLength = Number.isFinite(rawLength) && rawLength > 0;
  const mimeType = c.req.header('content-type') ?? 'application/octet-stream';

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标挂载点不存在');
  assertWithinUploadRoot(apiKey, targetPath);
  await requirePermission(c, mount, targetPath, 'write');

  let size = hasLength ? rawLength : 0;
  let body: ReadableStream<Uint8Array>;
  if (hasLength) {
    const stream = c.req.raw.body as ReadableStream<Uint8Array> | null;
    if (!stream) throw ApiError.badRequest('请求体为空');
    body = stream;
  } else {
    // 无 Content-Length（chunked）：回退读取以确定大小（保留兼容，硬上限仍生效）
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    size = bytes.byteLength;
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  const result = await upsertFileObject(c, {
    mount,
    targetPath,
    mimeType,
    size,
    body,
    ownerId: userId,
    via: 'webdav',
  });

  return xmlResponse(201, { ETag: result.etag ? `"${result.etag}"` : undefined });
});

// ============ GET/HEAD：下载（Range 走 serveObject，206） ============
async function resolveDavFile(c: Context<AppBindings>, targetPath: string): Promise<{ file: FileMetadata; provider: StorageProviderInterface }> {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // H-3：读操作走统一路径级权限
  await requirePermission(c, mount, targetPath, 'read');
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, name, apiKey.userId);
  if (!file || file.type === 'folder') throw new ApiError(404, 'NOT_FOUND', '文件不存在');

  // §31 桶级矩阵：读路径初检早于文件行解析，此处按文件实际落桶补判（桶级明确禁止 → 403）
  await assertBucketPermission(c, mount.id, file.providerId, 'read');

  const provider = await getProviderForFile(db, file, mount, c.env as Env);
  return { file, provider };
}

webdavRoutes.get('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');
  const targetPath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');
  const { file } = await resolveDavFile(c, targetPath);

  await LogRepo.create(db, {
    userId: apiKey.userId,
    action: 'download',
    path: file.path,
    metadata: JSON.stringify({ fileName: file.name, via: 'webdav' }),
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
    bytesTransferred: file.size,
  });

  return serveFileObject({
    db,
    env: c.env as Env,
    ref: { fileId: file.id, mountId: file.mountId, providerId: file.providerId, physicalKey: physicalObjectKey(file), size: file.size },
    name: file.name,
    mimeType: file.mimeType,
    rangeHeader: c.req.header('range'),
    totalSize: file.size,
    forceAttachment: true,
  });
});

webdavRoutes.on(['HEAD'], '*', async (c) => {
  const db = getDb(c);
  const targetPath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');
  const { file } = await resolveDavFile(c, targetPath);
  const res = await serveFileObject({
    db,
    env: c.env as Env,
    ref: { fileId: file.id, mountId: file.mountId, providerId: file.providerId, physicalKey: physicalObjectKey(file), size: file.size },
    name: file.name,
    mimeType: file.mimeType,
    rangeHeader: c.req.header('range'),
    totalSize: file.size,
  });
  return new Response(null, { status: res.status, headers: res.headers });
});

// ============ DELETE：删除（复用共享删除实现） ============
webdavRoutes.delete('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 WebDAV 认证');

  const targetPath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');
  const name = targetPath.split('/').filter(Boolean).pop() ?? '';
  const parentPath = targetPath.slice(0, -(name.length + 1)) || '/';

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  // 双形态：文件行 (parent,name) / 目录行 (targetPath,name)
  let file = await FileRepo.getFileAtPath(db, mount.id, parentPath, name);
  file = file ?? await FileRepo.getFolderAtPath(db, mount.id, targetPath, name);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  // 数据层所有者隔离：他人文件按不存在处理；目录行为共享命名空间，仅清理属主自己的行
  if (file.type === 'file' && file.ownerId !== apiKey.userId) {
    throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  }
  // H-3：删除操作走统一路径级权限
  await requirePermission(c, mount, targetPath, 'delete', file.ownerId, undefined, undefined, undefined, file.providerId ?? undefined);

  await deleteFileInternal(c, mount, file, apiKey.userId);
  return xmlResponse(204);
});

// ============ MOVE：移动/重命名（复用移动 Saga，H-4；处理 Overwrite 头，P1-3.4） ============
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

  const sourcePath = davPath(c.req.path.replace(/^\/webdav/, '') || '/');
  const destPath = davPath(destUrl.pathname.replace(/^\/webdav/, '') || '/');

  const name = sourcePath.split('/').filter(Boolean).pop() ?? '';

  const mount = await MountRepo.findMountForPath(db, sourcePath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在');
  const sourceParent = sourcePath.slice(0, -(name.length + 1)) || '/';
  // 双形态：文件行 / 目录行（目录移动仍受 moveWithSaga 属主校验约束）
  let file = await FileRepo.getFileAtPath(db, mount.id, sourceParent, name);
  file = file ?? await FileRepo.getFolderAtPath(db, mount.id, sourcePath, name);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  // 数据层所有者隔离：他人文件按不存在处理
  if (file.type === 'file' && file.ownerId !== apiKey.userId) {
    throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  }

  const destName = destPath.split('/').filter(Boolean).pop() ?? name;
  const destParent = destPath.slice(0, -(destName.length + 1)) || '/';
  if (!isValidFileName(destName)) throw new ApiError(400, 'VALIDATION_ERROR', '目标名非法');
  // M-3：目标位于密钥上传根内
  assertWithinUploadRoot(apiKey, destPath);

  // P1-3.4：RFC 4918 默认 Overwrite: T；F 时目标已存在 → 412
  const overwrite = (c.req.header('overwrite') ?? 'T').trim().toUpperCase() !== 'F';
  const destMount = await MountRepo.findMountForPath(db, destPath);
  if (destMount) {
    const destExisting = await FileRepo.getFileAtPath(db, destMount.id, destParent, destName);
    if (destExisting) {
      if (destExisting.type === 'file' && destExisting.ownerId !== apiKey.userId) {
        // 他人文件视为存在但不能覆盖：T → 403（由权限服务裁决）、F → 412
        if (!overwrite) return xmlResponse(412);
        await requirePermission(c, destMount, destPath, 'delete', destExisting.ownerId, undefined, undefined, undefined, destExisting.providerId ?? undefined);
        return xmlResponse(403);
      }
      if (!overwrite) return xmlResponse(412);
      await requirePermission(c, destMount, destPath, 'delete', destExisting.ownerId, undefined, undefined, undefined, destExisting.providerId ?? undefined);
      await deleteFileInternal(c, destMount, destExisting, apiKey.userId);
    }
  }

  // H-4：完整 Saga（源 delete + 目标 write 双重权限、冲突/循环、复制校验、原子切换、异步清理）
  await moveWithSaga(c, { fileId: file.id, targetDir: destParent, targetName: destName });
  return xmlResponse(201, { Location: dest });
});
