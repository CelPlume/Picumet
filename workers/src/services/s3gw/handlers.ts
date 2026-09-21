// S3 兼容网关（P2-2，docs/PICLIST_COMPAT_CN.md）：SigV4 验签 → 网关密钥 → 统一权限/配额/审计
// 产品定位：Picumet 作为 R2/S3/Oracle/MinIO 的"中转"，对外提供 S3 兼容协议面
//（图床上传只是用途之一）。密钥 pk_*/sk_* 即 AccessKeyId/SecretAccessKey。
// 路由（路径式寻址，endpoint = https://host/s3）：
//   GET  /s3                      → ListBuckets（密钥可达挂载的一级目录名）
//   PUT  /s3/{bucket}/{key}       → PutObject（整包 hex payload 校验；元数据/配额/目录行走统一写入）
//   GET  /s3/{bucket}             → ListObjectsV2（prefix/delimiter/max-keys）
//   GET  /s3/{bucket}/{key}       → GetObject（Range 支持，经 serveObject）
//   HEAD /s3/{bucket}/{key}       → HeadObject
//   DEL  /s3/{bucket}/{key}       → DeleteObject（元数据+配额+对象清理一致）
//   POST /s3/{bucket}?delete      → DeleteObjects（批量）
// 未实现（S3 语义返回 501 NotImplemented）：CopyObject / multipart / DeleteBucket。
// 数据层所有者隔离：对象键/目录行为挂载内全局命名空间，跨属主一律 404/409。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo, ApiKeyRepo, LogRepo } from '../../db';
import { getDb, getClientIp, applyApiKeyContext, assertApiKeyProtocol } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { requirePermission } from '../permissions/principal';
import { deleteFileInternal } from '../files/remove';
import { upsertFileObject } from '../files/write';
import { serveObject } from '../storage/serve';
import { verifySigV4, SigV4Error, parseSigV4Request } from './sigv4';
import type { SigV4ErrorCode } from './sigv4';
import { decryptSecret } from '../../utils/crypto';
import { normalizePath, isPathWithinBoundary } from '../../utils/path';
import type { ApiKey, Mount } from '@shared/types';

type Ctx = Context<AppBindings>;

export const s3gwRoutes = new Hono<AppBindings>();

// ============ XML 工具 ============

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[m] as string);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function s3XmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

function s3ErrorResponse(status: number, code: string, message: string, resource: string): Response {
  const xml = `${XML_HEADER}<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message><Resource>${escapeXml(resource)}</Resource><RequestId>picumet</RequestId></Error>`;
  return s3XmlResponse(status, xml);
}

const SIGV4_ERROR_STATUS: Record<SigV4ErrorCode, { status: number; code: string }> = {
  InvalidRequest: { status: 400, code: 'InvalidRequest' },
  AuthorizationQueryParametersError: { status: 400, code: 'AuthorizationQueryParametersError' },
  SignatureDoesNotMatch: { status: 403, code: 'SignatureDoesNotMatch' },
  AccessDenied: { status: 403, code: 'AccessDenied' },
  NotImplemented: { status: 501, code: 'NotImplemented' },
};

// ============ 认证中间件 ============

s3gwRoutes.use('*', async (c, next) => {
  const db = getDb(c);
  const env = c.env;
  const path = c.req.path;

  let apiKey: ApiKey;
  let payloadBytes: Uint8Array | undefined;
  try {
    const parsed = parseSigV4Request(c.req.raw);
    if (!parsed) {
      return s3ErrorResponse(403, 'AccessDenied', '匿名访问被拒绝：需要 SigV4 签名', path);
    }
    // AccessKeyId = keyId（pk_*）；SecretAccessKey = sk_*（AES-GCM 加密落库 'enc:' 前缀，创建密钥时写入）
    const found = await ApiKeyRepo.getKeyByKeyId(db, parsed.credential.accessKeyId);
    if (!found) {
      return s3ErrorResponse(403, 'InvalidAccessKeyId', 'AWS Access Key ID 不存在', path);
    }
    apiKey = found;
    if (!apiKey.secretCipher) {
      return s3ErrorResponse(403, 'InvalidAccessKeyId', '该密钥创建于 S3 网关启用前，请重建密钥', path);
    }
    const cipher = apiKey.secretCipher.startsWith('enc:') ? apiKey.secretCipher.slice(4) : apiKey.secretCipher;
    const secret = await decryptSecret(cipher, env.ENCRYPTION_KEY);
    const verification = await verifySigV4(c.req.raw, secret);
    payloadBytes = verification.payloadBytes;
  } catch (err) {
    if (err instanceof SigV4Error) {
      const mapped = SIGV4_ERROR_STATUS[err.code];
      return s3ErrorResponse(mapped.status, mapped.code, err.message, path);
    }
    throw err;
  }

  // 密钥可用性：状态 / 过期 / IP 白名单（与 apiKeyAuthMiddleware 同语义，S3 XML 错误形态）
  if (apiKey.status !== 'active') {
    return s3ErrorResponse(403, 'AccessDenied', 'API 密钥无效或已撤销', path);
  }
  if (apiKey.expiresAt && Date.now() > apiKey.expiresAt) {
    return s3ErrorResponse(403, 'AccessDenied', 'API 密钥已过期', path);
  }
  if (apiKey.allowedIps && apiKey.allowedIps.length > 0) {
    const ip = getClientIp(c);
    if (!apiKey.allowedIps.includes(ip)) {
      return s3ErrorResponse(403, 'AccessDenied', '该 API 密钥不允许从当前 IP 使用', path);
    }
  }
  try {
    assertApiKeyProtocol(apiKey, 's3');
  } catch {
    return s3ErrorResponse(403, 'AccessDenied', '该密钥未授权 s3 协议', path);
  }
  const applied = await applyApiKeyContext(c, db, apiKey);
  if (applied) return applied;
  c.set('s3Payload', payloadBytes);
  await next();
});

// ============ 路径与作用域工具 ============

function pctDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 从原始 pathname 解析 bucket/key（按 '/' 切分后逐段解码，key 内可含字面 '/'） */
function parseS3RequestPath(c: Ctx): { bucket: string; key: string } {
  const raw = c.req.path.replace(/^\/s3\/?/, '');
  if (!raw) return { bucket: '', key: '' };
  const slash = raw.indexOf('/');
  if (slash < 0) return { bucket: pctDecode(raw), key: '' };
  return { bucket: pctDecode(raw.slice(0, slash)), key: pctDecode(raw.slice(slash + 1)) };
}

/** 网关密钥作用域：对象操作必须落在密钥上传根内；目录列表允许上传根的祖先（到达根目录） */
function assertKeyScope(apiKey: { uploadPath: string }, virtualPath: string, exact: boolean): Response | null {
  const uploadRoot = normalizePath(apiKey.uploadPath || '/');
  if (isPathWithinBoundary(virtualPath, uploadRoot)) return null;
  if (!exact && isPathWithinBoundary(uploadRoot, virtualPath)) return null;
  return s3ErrorResponse(403, 'AccessDenied', '目标超出密钥上传根目录', virtualPath);
}

async function guardPermission(
  c: Ctx,
  mount: Mount,
  virtualPath: string,
  action: 'read' | 'write' | 'delete',
  fileOwnerId?: string
): Promise<Response | null> {
  try {
    await requirePermission(c, mount, virtualPath, action, fileOwnerId);
    return null;
  } catch {
    return s3ErrorResponse(403, 'AccessDenied', '无权执行此操作', virtualPath);
  }
}

async function resolveMountAndProvider(
  c: Ctx,
  db: ReturnType<typeof getDb>,
  virtualPath: string
): Promise<{ mount: Mount; provider: Awaited<ReturnType<typeof getProvider>>; pathPrefix: string } | Response> {
  const mount = await MountRepo.findMountForPath(db, virtualPath);
  if (!mount) return s3ErrorResponse(404, 'NoSuchBucket', '目标挂载点不存在', virtualPath);
  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) return s3ErrorResponse(404, 'NoSuchBucket', '存储提供商不存在', virtualPath);
  const provider = await getProvider(db, providerRow, c.env);
  return { mount, provider, pathPrefix: providerRow.pathPrefix };
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ============ ListBuckets ============

async function listBuckets(c: Ctx): Promise<Response> {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) return s3ErrorResponse(403, 'AccessDenied', '未认证', '/');
  const uploadRoot = normalizePath(apiKey.uploadPath || '/');
  const mounts = await MountRepo.listMounts(db);
  const names = new Set<string>();
  for (const m of mounts) {
    const overlap = isPathWithinBoundary(uploadRoot, m.mountPath) || isPathWithinBoundary(m.mountPath, uploadRoot);
    if (!overlap) continue;
    if (m.mountPath === '/') {
      // 根挂载：属主范围内的一级文件夹名即 bucket
      const { rows } = await FileRepo.listChildren(db, m.id, '/', { type: 'folder' }, apiKey.userId);
      for (const r of rows) names.add(r.name);
      if (uploadRoot !== '/') names.add(uploadRoot.split('/').filter(Boolean)[0] ?? '');
    } else {
      names.add(m.mountPath.split('/').filter(Boolean)[0] ?? '');
    }
  }
  const buckets = [...names].filter(Boolean).sort();
  const xml = `${XML_HEADER}<ListAllMyBucketsResult xmlns="${XMLNS}"><Owner><ID>picumet</ID><DisplayName>picumet</DisplayName></Owner><Buckets>${buckets
    .map((b) => `<Bucket><Name>${escapeXml(b)}</Name><CreationDate>1970-01-01T00:00:00.000Z</CreationDate></Bucket>`)
    .join('')}</Buckets></ListAllMyBucketsResult>`;
  return s3XmlResponse(200, xml);
}

s3gwRoutes.get('/', (c) => listBuckets(c));

// ============ PUT（PutObject） ============

s3gwRoutes.put('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const { bucket, key } = parseS3RequestPath(c);
  if (!bucket || !key) {
    return s3ErrorResponse(400, 'InvalidRequest', '无效的对象路径（需 /s3/{bucket}/{key}）', c.req.path);
  }
  if (c.req.header('x-amz-copy-source')) {
    return s3ErrorResponse(501, 'NotImplemented', 'CopyObject 暂未实现（上传/下载/列举不受影响）', c.req.path);
  }
  const virtualPath = normalizePath(`/${bucket}/${key}`);
  const denied = assertKeyScope(apiKey, virtualPath, true);
  if (denied) return denied;
  const resolved = await resolveMountAndProvider(c, db, virtualPath);
  if (resolved instanceof Response) return resolved;
  const { mount, provider, pathPrefix } = resolved;
  const guard = await guardPermission(c, mount, virtualPath, 'write');
  if (guard) return guard;

  const mimeType = c.req.header('content-type') ?? 'application/octet-stream';
  const metadata: Record<string, string> = {};
  c.req.raw.headers.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value;
  });

  const payloadBytes = c.get('s3Payload');
  const contentLength = Number(c.req.header('content-length') ?? '');
  let size = 0;
  let body: ReadableStream<Uint8Array>;
  if (payloadBytes) {
    size = payloadBytes.byteLength;
    body = streamFromBytes(payloadBytes);
  } else if (Number.isFinite(contentLength) && contentLength > 0) {
    size = contentLength;
    body = c.req.raw.body as ReadableStream<Uint8Array>;
  } else {
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    size = bytes.byteLength;
    body = streamFromBytes(bytes);
  }

  const result = await upsertFileObject(c, {
    mount,
    provider,
    pathPrefix,
    targetPath: virtualPath,
    mimeType,
    size,
    body,
    ownerId: apiKey.userId,
    via: 's3',
    metadata,
  });
  return new Response(null, {
    status: 200,
    headers: result.etag ? { ETag: `"${result.etag}"` } : {},
  });
});

// ============ GET（ListObjectsV2 / GetObject） ============

s3gwRoutes.get('*', async (c) => {
  const { bucket, key } = parseS3RequestPath(c);
  if (!bucket) return listBuckets(c);
  if (!key || c.req.query('list-type') === '2') {
    return listObjectsV2(c, bucket);
  }
  return getObjectOrHead(c, bucket, key, false);
});

// ============ HEAD（HeadObject） ============

s3gwRoutes.on(['HEAD'], '*', async (c) => {
  const { bucket, key } = parseS3RequestPath(c);
  if (!bucket || !key) return s3ErrorResponse(400, 'InvalidRequest', '无效的对象路径', c.req.path);
  return getObjectOrHead(c, bucket, key, true);
});

async function getObjectOrHead(c: Ctx, bucket: string, key: string, head: boolean): Promise<Response> {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const virtualPath = normalizePath(`/${bucket}/${key}`);
  const scopeDenied = assertKeyScope(apiKey, virtualPath, true);
  if (scopeDenied) return scopeDenied;
  const resolved = await resolveMountAndProvider(c, db, virtualPath);
  if (resolved instanceof Response) return resolved;
  const { mount, provider } = resolved;

  const segs = virtualPath.split('/').filter(Boolean);
  const name = segs.pop()!;
  const parent = '/' + segs.join('/');
  // 所有者隔离：他人文件按不存在处理（不泄露存在性）
  const file = await FileRepo.getFileAtPath(db, mount.id, parent, name, apiKey.userId);
  if (!file || file.type === 'folder') {
    return s3ErrorResponse(404, 'NoSuchKey', '对象不存在', virtualPath);
  }
  const guard = await guardPermission(c, mount, virtualPath, 'read', file.ownerId);
  if (guard) return guard;

  if (!head) {
    await LogRepo.create(db, {
      userId: apiKey.userId,
      action: 'download',
      path: file.path,
      metadata: JSON.stringify({ fileName: file.name, via: 's3' }),
      ipAddress: getClientIp(c),
      userAgent: c.req.header('user-agent'),
      bytesTransferred: file.size,
    });
  }
  const res = await serveObject({
    provider,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    rangeHeader: c.req.header('range'),
    totalSize: file.size,
  });
  if (head) return new Response(null, { status: res.status, headers: res.headers });
  return res;
}

async function listObjectsV2(c: Ctx, bucket: string): Promise<Response> {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const uploadRoot = normalizePath(apiKey.uploadPath || '/');
  const prefix = c.req.query('prefix') ?? '';
  const delimiter = c.req.query('delimiter') ?? '';
  const maxKeys = Math.min(Math.max(Number(c.req.query('max-keys') ?? '1000') || 1000, 1), 1000);
  const virtualDir = normalizePath(`/${bucket}/${prefix}`);

  if (!isPathWithinBoundary(virtualDir, uploadRoot) && !isPathWithinBoundary(uploadRoot, virtualDir)) {
    return s3ErrorResponse(403, 'AccessDenied', '列举范围超出密钥上传根目录', virtualDir);
  }
  const resolved = await resolveMountAndProvider(c, db, virtualDir === '/' ? `/${bucket}` : virtualDir);
  if (resolved instanceof Response) return resolved;
  const { mount } = resolved;
  const guard = await guardPermission(c, mount, virtualDir, 'read');
  if (guard) return guard;

  const bucketBase = `/${bucket}`;
  const toRelKey = (fullPath: string): string =>
    fullPath === bucketBase ? '' : fullPath.startsWith(bucketBase + '/') ? fullPath.slice(bucketBase.length + 1) : fullPath;

  const contents: Array<{ key: string; size: number; etag?: string; mtime: number }> = [];
  const prefixes = new Set<string>();
  if (delimiter === '/') {
    const { rows } = await FileRepo.listChildren(db, mount.id, virtualDir, { limit: maxKeys }, apiKey.userId);
    for (const r of rows) {
      if (r.type === 'folder') prefixes.add(`${toRelKey(r.path)}/`);
      else contents.push({ key: toRelKey(`${r.path}/${r.name}`), size: r.size, etag: r.etag, mtime: r.updatedAt });
    }
  } else {
    const rows = await FileRepo.listDescendants(db, mount.id, virtualDir, apiKey.userId);
    for (const r of rows) {
      if (r.type !== 'file') continue;
      contents.push({ key: toRelKey(`${r.path}/${r.name}`), size: r.size, etag: r.etag, mtime: r.updatedAt });
      if (contents.length >= maxKeys) break;
    }
  }
  contents.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const xml = `${XML_HEADER}<ListBucketResult xmlns="${XMLNS}">`
    + `<Name>${escapeXml(bucket)}</Name>`
    + `<Prefix>${escapeXml(prefix)}</Prefix>`
    + `<MaxKeys>${maxKeys}</MaxKeys>`
    + `<KeyCount>${contents.length + prefixes.size}</KeyCount>`
    + `<IsTruncated>false</IsTruncated>`
    + contents.map((it) =>
      `<Contents><Key>${escapeXml(it.key)}</Key><LastModified>${new Date(it.mtime).toISOString()}</LastModified>`
      + `<ETag>${escapeXml(`"${it.etag ?? ''}"`)}</ETag><Size>${it.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
    ).join('')
    + [...prefixes].sort().map((p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`).join('')
    + `</ListBucketResult>`;
  return s3XmlResponse(200, xml);
}

// ============ DELETE ============

s3gwRoutes.delete('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const { bucket, key } = parseS3RequestPath(c);
  if (!bucket) return s3ErrorResponse(400, 'InvalidRequest', '无效的路径', c.req.path);
  if (!key) return s3ErrorResponse(501, 'NotImplemented', '删除 bucket 暂未实现', c.req.path);

  const virtualPath = normalizePath(`/${bucket}/${key}`);
  const denied = assertKeyScope(apiKey, virtualPath, true);
  if (denied) return denied;
  const mount = await MountRepo.findMountForPath(db, virtualPath);
  if (!mount) return s3ErrorResponse(404, 'NoSuchBucket', '目标挂载点不存在', virtualPath);

  const segs = virtualPath.split('/').filter(Boolean);
  const name = segs.pop()!;
  const parent = '/' + segs.join('/');
  const file = await FileRepo.getFileAtPath(db, mount.id, parent, name)
    ?? await FileRepo.getFolderAtPath(db, mount.id, virtualPath, name);
  // S3 语义：删除不存在的 key 返回 204；他人文件按不存在处理（不泄露存在性）
  if (!file || (file.type === 'file' && file.ownerId !== apiKey.userId)) return new Response(null, { status: 204 });
  const guard = await guardPermission(c, mount, virtualPath, 'delete', file.ownerId);
  if (guard) return guard;
  await deleteFileInternal(c, mount, file, apiKey.userId);
  return new Response(null, { status: 204 });
});

// ============ POST（DeleteObjects 批量删除；multipart 声明 → 501） ============

s3gwRoutes.post('*', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const { bucket } = parseS3RequestPath(c);
  if (!bucket) return s3ErrorResponse(400, 'InvalidRequest', '无效的路径', c.req.path);

  if (c.req.query('uploads') !== undefined) {
    return s3ErrorResponse(501, 'NotImplemented', 'Multipart Upload 暂未实现（PicList 未使用）', c.req.path);
  }
  if (c.req.query('delete') === undefined) {
    return s3ErrorResponse(400, 'InvalidRequest', '不支持的 POST 操作', c.req.path);
  }

  // DeleteObjects：XML body 提取 <Key>（SigV4 整包校验时请求体已在中间件读取，从 s3Payload 复用）
  const payloadBytes = c.get('s3Payload');
  const text = payloadBytes ? new TextDecoder().decode(payloadBytes) : await c.req.raw.text();
  const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unescapeXml(m[1]));
  const deleted: string[] = [];
  const errors: Array<{ key: string; message: string }> = [];
  for (const rawKey of keys.slice(0, 1000)) {
    const virtualPath = normalizePath(`/${bucket}/${rawKey}`);
    try {
      const scopeDenied = assertKeyScope(apiKey, virtualPath, true);
      if (scopeDenied) throw new Error('超出密钥上传根目录');
      const mount = await MountRepo.findMountForPath(db, virtualPath);
      if (!mount) throw new Error('挂载点不存在');
      const segs = virtualPath.split('/').filter(Boolean);
      const name = segs.pop()!;
      const parent = '/' + segs.join('/');
      const file = await FileRepo.getFileAtPath(db, mount.id, parent, name);
      if (!file || (file.type === 'file' && file.ownerId !== apiKey.userId)) {
        deleted.push(rawKey); // S3 语义：删除不存在的 key 视为成功
        continue;
      }
      const guard = await guardPermission(c, mount, virtualPath, 'delete', file.ownerId);
      if (guard) throw new Error('无权删除');
      await deleteFileInternal(c, mount, file, apiKey.userId);
      deleted.push(rawKey);
    } catch (err) {
      errors.push({ key: rawKey, message: err instanceof Error ? err.message : '删除失败' });
    }
  }

  const xml = `${XML_HEADER}<DeleteResult xmlns="${XMLNS}">`
    + deleted.map((k) => `<Deleted><Key>${escapeXml(k)}</Key></Deleted>`).join('')
    + errors.map((e) => `<Error><Key>${escapeXml(e.key)}</Key><Code>AccessDenied</Code><Message>${escapeXml(e.message)}</Message></Error>`).join('')
    + `</DeleteResult>`;
  return s3XmlResponse(200, xml);
});
