// 错误类型与错误码

import { ErrorCode } from '@shared/types';

export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = '请求无效', details?: unknown) {
    return new ApiError(400, ErrorCode.VALIDATION_ERROR, message, details);
  }
  static unauthorized(message = '未认证') {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }
  static forbidden(message = '无权访问') {
    return new ApiError(403, ErrorCode.FORBIDDEN, message);
  }
  static notFound(message = '资源不存在') {
    return new ApiError(404, ErrorCode.NOT_FOUND, message);
  }
  static conflict(message = '资源已存在') {
    return new ApiError(409, ErrorCode.ALREADY_EXISTS, message);
  }
  static tooManyRequests(message = '请求过于频繁') {
    return new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, message);
  }
  static internal(message = '服务器内部错误') {
    return new ApiError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** 日志脱敏：过滤敏感字段 */
export function sanitizeForLog(data: unknown): unknown {
  const sensitive = ['password', 'token', 'secret', 'key', 'authorization', 'cookie'];
  if (typeof data !== 'object' || data === null) return data;
  if (Array.isArray(data)) return data.map((d) => sanitizeForLog(d));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (sensitive.some((s) => k.toLowerCase().includes(s))) {
      out[k] = '***REDACTED***';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeForLog(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
