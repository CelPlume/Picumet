// 会话签发：JWT Cookie 的统一出口（密码登录、第三方登录回调、SSO 注册完成共用）。
// Cookie 语义与撤销行为集中在此，供各登录入口复用。
import type { Context } from 'hono';
import type { AppBindings } from '../../shared/types';
import { signJwt } from '../../utils/crypto';

export const AUTH_COOKIE = 'auth_token';
export const JWT_TTL = 7 * 24 * 3600; // 7 天

/**
 * 写入登录 Cookie。第三方登录（SSO）与密码登录发放完全相同的凭据：
 * 同一 JWT 载荷（sub/username/role/sv）、同样的 HttpOnly + SameSite=Strict，
 * 因此会话撤销（session_version 递增）对两种登录方式一致生效。
 */
export async function setAuthCookie(
  c: Context<AppBindings>,
  user: { id: string; username: string; role: string; sessionVersion: number }
): Promise<void> {
  const token = await signJwt(
    { sub: user.id, username: user.username, role: user.role, sv: user.sessionVersion },
    c.env.JWT_SECRET as string,
    JWT_TTL
  );
  const isSecure = (c.env.ENVIRONMENT as string) === 'production';
  c.header(
    'Set-Cookie',
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${JWT_TTL}${isSecure ? '; Secure' : ''}`
  );
}
