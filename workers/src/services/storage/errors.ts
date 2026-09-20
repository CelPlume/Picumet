// 存储层错误分类（对照报告 P0-2）：
// 停止把 404 / 403（密钥错）/ 5xx / 网络错折叠为「对象不存在」——
// not-found 才代表对象确实没有；其余类别调用方（move Saga / 删除对账 / 下载网关）按 kind 分支处理。

export type ProviderErrorKind = 'not-found' | 'auth' | 'throttled' | 'other';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  static notFound(key: string): ProviderError {
    return new ProviderError('not-found', `对象不存在: ${key}`);
  }
}

/** 运行时收窄：错误对象的 name 字段（AWS SDK 错误携带 S3 错误码） */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err && typeof err === 'object' && 'name' in err) {
    const name = err.name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** 运行时收窄：AWS SDK 错误的 $metadata.httpStatusCode */
function errorHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('$metadata' in err)) return undefined;
  const meta = err.$metadata;
  if (!meta || typeof meta !== 'object' || !('httpStatusCode' in meta)) return undefined;
  const status = meta.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

const NOT_FOUND_NAMES = new Set(['NoSuchKey', 'NoSuchBucket', 'NotFound']);
const AUTH_NAMES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidClientTokenId',
  'ExpiredToken',
  'SecurityTokenDenied',
]);
const THROTTLED_NAMES = new Set(['SlowDown', 'ServiceUnavailable', 'RequestTimeout', 'InternalError']);

/**
 * AWS SDK S3 错误 → ProviderErrorKind。
 * 依据 err.name（S3 错误码）与 $metadata.httpStatusCode 双重判定。
 */
export function classifyS3Error(err: unknown): ProviderErrorKind {
  const name = errorName(err);
  const status = errorHttpStatus(err);

  if (NOT_FOUND_NAMES.has(name) || status === 404) return 'not-found';
  if (AUTH_NAMES.has(name) || status === 401 || status === 403) return 'auth';
  if (THROTTLED_NAMES.has(name) || status === 429 || status === 503 || status === 507) return 'throttled';
  return 'other';
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(classifyS3Error(err), err instanceof Error ? err.message : '存储请求失败', err);
}
