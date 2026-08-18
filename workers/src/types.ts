import type { Role } from '@shared/types';

// Cloudflare Workers 运行时绑定
export interface Env {
  // 必需绑定
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;

  // 环境变量
  ENVIRONMENT: string;
  APP_BASE_URL: string;
  ALLOWED_ORIGINS: string;

  // Secrets
  JWT_SECRET: string;
  JWT_SECRET_OLD?: string;
  ENCRYPTION_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
}

// Hono 上下文变量
import type { Db } from './db';

export type AppBindings = { Bindings: Env; Variables: AppVariables };

export interface AppVariables {
  db: Db;
  userId: string;
  userRole: Role;
  user: {
    id: string;
    username: string;
    email: string;
    emailVerified: boolean;
    role: Role;
    defaultPath: string;
    locale: string;
    theme: string;
    displayName?: string;
    avatarUrl?: string;
    status: string;
  };
  apiKey?: {
    id: string;
    keyId: string;
    userId: string;
    permissions: string[];
    protocols: string[];
    uploadPath: string;
    allowedIps?: string[];
    expiresAt?: number;
  };
  // 自由模式（用户自带凭据的临时 Provider）
  freeMode?: {
    provider: {
      type: string;
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };
    mountPath: string;
    expiresAt: number;
  };
  /** 自由模式已解密会话（由 freeModeSessionGuard 注入） */
  freeModeSession?: FreeModeSession;
  requestId: string;
}

export interface FreeModeSession {
  userId: string;
  provider: {
    type: 'r2' | 's3' | 'oracle';
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  mountPath: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
}
