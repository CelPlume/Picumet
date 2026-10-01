// 第三方登录（SSO / OIDC）服务内部类型
import type { SsoProviderKind } from '@shared/types';

/** 提供商下发的身份档案（已归一化：OIDC claims / GitHub /user+/user/emails 收敛到同一形状） */
export interface SsoProfile {
  /** OIDC `sub` / GitHub 用户 id —— 身份识别主键（不用邮箱，邮箱可改可空） */
  subject: string;
  email: string | null;
  /** 提供方是否**已验证**该邮箱（决定能否自动关联既有账号、能否免验证码） */
  emailVerified: boolean;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** 归一化后的令牌集合（仓储层负责加密落库） */
export interface SsoTokens {
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string | null;
  scope: string | null;
  /** 过期时间点（毫秒）；上游未给 expires_in 时为 null */
  expiresAt: number | null;
}

/** 一次回调解析结果 */
export interface SsoAuthResult {
  profile: SsoProfile;
  tokens: SsoTokens;
}

/** OIDC discovery 文档中本服务消费的字段（其余字段忽略） */
export interface SsoDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  /** token 端点客户端认证方式偏好；null = 上游未声明（按 client_secret_post 处理） */
  tokenAuthMethods: string[] | null;
  kind: SsoProviderKind;
}

/** 授权请求上下文（KV `sso:state:<state>`）：回调时用于校验 state/PKCE/nonce */
export interface SsoStateEntry {
  providerId: string;
  /** PKCE code_verifier（S256） */
  verifier: string;
  /** OIDC nonce（GitHub 无 id_token，仅 state 校验） */
  nonce: string;
}

/** 待完成注册的暂存上下文（KV `sso:pending:<token>`），TTL 15 分钟、一次性消费 */
export interface SsoPendingEntry {
  providerId: string;
  providerName: string;
  kind: SsoProviderKind;
  profile: SsoProfile;
  tokens: SsoTokens;
}
