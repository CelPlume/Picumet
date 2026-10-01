// 用户公开投影：对外响应中的用户字段白名单（不含密码哈希、会话版本等内部列）。
// 密码登录 / 第三方登录注册完成 / GET /me 三处共用同一投影，避免响应形状漂移。
import type { User } from '@shared/types';

export type PublicUser = {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: string;
  displayName?: string;
  avatarUrl?: string;
  defaultPath: string;
  locale?: string;
  theme?: string;
  createdAt: number;
  lastLoginAt?: number;
};

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    defaultPath: user.defaultPath,
    locale: user.locale,
    theme: user.theme,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}
