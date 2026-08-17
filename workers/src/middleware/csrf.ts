// CSRF 防护：Cookie 认证的写操作需携带 X-CSRF-Token（API Key 认证不受影响）
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../utils/errors';
import { fail } from '../utils/response';
import { randomString } from '../utils/crypto';

const CSRF_TTL = 7200; // 2 小时

export async function issueCsrfToken(kv: KVNamespace, userId: string): Promise<string> {
  const existing = await kv.get(`csrf:${userId}`);
  if (existing) return existing;
  const token = randomString(32);
  await kv.put(`csrf:${userId}`, token, { expirationTtl: CSRF_TTL });
  return token;
}

export const csrfMiddleware = createMiddleware(async (c, next) => {
  const method = c.req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    await next();
    return;
  }
  // API 密钥认证的请求无需 CSRF Token
  if (c.get('apiKey')) {
    await next();
    return;
  }
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    await next();
    return;
  }
  const token = c.req.header('x-csrf-token');
  const stored = await c.env.KV?.get(`csrf:${userId}`);
  if (!token || !stored || token !== stored) {
    return fail(c, new ApiError(403, 'INVALID_CSRF', 'CSRF 校验失败，请刷新页面重试'));
  }
  await next();
});
