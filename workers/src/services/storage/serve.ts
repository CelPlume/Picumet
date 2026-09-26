// 对象 HTTP 响应构建器：网关 / 公开路径 / WebDAV 共用（Range → 206）
import { ApiError } from '../../shared/errors';
import type { ObjectBody, StorageProviderInterface } from './types';
import { parseRangeHeader } from './range';
import { ProviderError } from './errors';

const FORCE_DOWNLOAD_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml', '.md', '.json']);

export interface ServeObjectOptions {
  provider: StorageProviderInterface;
  objectKey: string;
  name: string;
  mimeType?: string;
  /** 原始 Range 请求头；调用方已知全对象大小时传入 totalSize 才启用区间服务 */
  rangeHeader?: string | null;
  /** 全对象大小（已知时启用 Range 支持；未知则忽略 Range 头返回 200） */
  totalSize?: number;
  /** 强制 attachment（如 WebDAV） */
  forceAttachment?: boolean;
  cacheControl?: string;
  /**
   * 命中后的对象内容校验（如回退候选的 sha256 元数据比对）：返回 false 视为该对象不可用，
   * 抛 404 交由上层（failover 候选循环）继续回退。缺省不校验（既有调用点行为不变）。
   */
  verifyObject?: (obj: ObjectBody) => boolean;
}

function contentDisposition(name: string, mimeType: string | undefined, forceAttachment?: boolean): string {
  const safeName = name.replace(/["\\\r\n]/g, '_');
  const ext = safeName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  const forceDownload = forceAttachment || FORCE_DOWNLOAD_EXTENSIONS.has(ext) || !mimeType;
  return `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`;
}

/**
 * 读取对象并构建 HTTP 响应。
 * - 404（对象确实不存在）→ 404
 * - ProviderError（auth/throttled/other，上游故障）→ 502 UPSTREAM_ERROR（不伪装成 404）
 * - Range 合法 → 206 + Content-Range；非法不可满足 → 416；语法非法 → 200 全量
 */
export async function serveObject(opts: ServeObjectOptions): Promise<Response> {
  const { provider, objectKey, name, mimeType } = opts;
  const knownTotal = opts.totalSize;
  const parsed = knownTotal == null ? { type: 'none' as const } : parseRangeHeader(opts.rangeHeader, knownTotal);

  if (parsed.type === 'unsatisfiable') {
    throw new ApiError(416, 'RANGE_NOT_SATISFIABLE', '请求区间不满足', {
      contentRange: `bytes */${knownTotal}`,
    });
  }
  const range = parsed.type === 'range' ? parsed.range : undefined;

  let obj;
  try {
    obj = await provider.getObject(objectKey, range ? { range } : undefined);
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new ApiError(502, 'UPSTREAM_ERROR', `存储上游错误（${err.kind}）`);
    }
    throw err;
  }
  if (!obj) throw new ApiError(404, 'NOT_FOUND', '文件对象不存在或已被删除');
  if (opts.verifyObject && !opts.verifyObject(obj)) {
    throw new ApiError(404, 'NOT_FOUND', '对象内容校验失败');
  }

  const effectiveTotal = knownTotal ?? obj.totalSize ?? obj.size;
  const headers = new Headers();
  headers.set('Content-Type', mimeType || obj.contentType || 'application/octet-stream');
  headers.set('Content-Length', String(obj.size));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', opts.cacheControl ?? 'private, max-age=300');
  headers.set('Content-Disposition', contentDisposition(name, mimeType, opts.forceAttachment));
  if (obj.etag) headers.set('ETag', obj.etag);
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${effectiveTotal}`);
  }

  return new Response(obj.body, { status: range ? 206 : 200, headers });
}
