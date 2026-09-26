// API 客户端：统一请求、CSRF、错误处理
import type { ApiResponse, SuccessResponse, ErrorResponse } from '@shared/types';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken: string | null = null;

export async function getCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const res = await apiFetch<{ token: string }>('/api/auth/csrf-token');
  csrfToken = res.data.token;
  return csrfToken;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {}
): Promise<SuccessResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string' || options.body instanceof FormData || options.body instanceof Blob) {
      body = options.body as BodyInit;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }

  const method = options.method ?? 'GET';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !(body instanceof FormData)) {
    // CSRF token：FormData 走兼容/上传接口（API Key 认证，无需 CSRF）
    try {
      const token = await getCsrfToken();
      headers['X-CSRF-Token'] = token;
    } catch {
      // 未登录时忽略
    }
  }

  // 默认 30s 超时只兜底元数据/JSON 请求；上传大文件走 XHR/rawRequest 不受影响。
  // 调用方显式传 signal 时合并（AbortSignal.any），不改变现有可取消语义。
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const res = await fetch(path, { method, headers, body, credentials: 'include', signal });
  let json: ApiResponse<T>;
  try {
    json = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', `服务器返回异常（${res.status}）`);
  }

  if (!json.success) {
    const err = json as ErrorResponse;
    // 401 时清空 CSRF，便于重新登录
    if (res.status === 401) csrfToken = null;
    throw new ApiError(res.status, err.error.code, err.error.message, err.error.details);
  }
  return json as SuccessResponse<T>;
}

/** 直接上传/下载（返回原始 Response） */
export async function rawRequest(
  path: string,
  options: {
    method?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  return fetch(path, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    credentials: 'include',
  });
}
