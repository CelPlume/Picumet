// CSRF 防护：Cookie 认证的写操作需携带 X-CSRF-Token（API Key 认证不受影响）
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { sha256Hex } from '../utils/crypto';

export async function issueCsrfToken(kv: KVNamespace | unknown, userId: string, encryptionKey = ''): Promise<string> {
  // 基于 ENCRYPTION_KEY 与 userId 的无状态确定性 Token：零 KV 读写消耗，完全免疫 KV 写配额超限
  if (encryptionKey) {
    const raw = await sha256Hex(`csrf:${userId}:${encryptionKey}`);
    return raw.slice(0, 32);
  }
  return (await sha256Hex(`csrf:${userId}`)).slice(0, 32);
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
  const encKey = (c.env.ENCRYPTION_KEY as string) ?? '';
  const expected = await issueCsrfToken(null, userId, encKey);
  if (token === expected) {
    await next();
    return;
  }
  // 兼容存量已在 KV 中签发的老 token（平滑过渡）
  try {
    const stored = await (c.env.KV as KVNamespace)?.get(`csrf:${userId}`);
    if (stored && token === stored) {
      await next();
      return;
    }
  } catch {
    // 忽略 KV 异常
  }
  return fail(c, new ApiError(403, 'INVALID_CSRF', 'CSRF 校验失败，请刷新页面重试'));
});
