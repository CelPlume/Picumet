// Hono 响应辅助：统一响应格式
import type { Context } from 'hono';
import type { SuccessResponse, ErrorResponse } from '@shared/types';
import { ApiError, isApiError } from './errors';

export function ok<T>(c: Context, data: T, message?: string, status = 200) {
  const body: SuccessResponse<T> = {
    success: true,
    data,
    ...(message ? { message } : {}),
    timestamp: Date.now(),
  };
  return c.json(body, status as never);
}

export function fail(c: Context, err: unknown) {
  const isDev = c.env?.ENVIRONMENT === 'development';
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = '服务器内部错误';
  let details: unknown;

  if (isApiError(err)) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof Error) {
    // SEC-08（审计 §SEC-08）：生产环境不回传底层异常消息（可能含数据库/Provider/网络内部细节），
    // 固定通用文案并写入受控日志留痕；开发环境维持 message + stack details 便于排查。
    if (isDev) {
      message = err.message;
      details = err.stack;
    } else {
      console.error('[api-error]', err);
    }
  }

  const body: ErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(isDev && details !== undefined ? { details } : {}),
    },
    timestamp: Date.now(),
  };
  return c.json(body, statusCode as never);
}

export { ApiError };
