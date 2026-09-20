// 下载网关：签名 Token（D1 原子消费）、访问模式判定、流式代理
import type { Context } from 'hono';
import type { FileMetadata, Mount } from '@shared/types';
import type { StorageProviderInterface } from '../storage/types';
import { randomString } from '../../utils/crypto';
import { ApiError } from '../../shared/errors';
import type { Db } from '../../db';

export interface DownloadTokenPayload {
  fileId: string;
  mountId: string;
  objectKey: string;
  name: string;
  mimeType?: string;
  size: number;
  passwordVerified: boolean;
  shareId?: string;
  expiresAt: number;
  createdAt: number;
}

const TOKEN_TTL = 15 * 60; // 15 分钟

export async function createDownloadToken(db: Db, payload: Omit<DownloadTokenPayload, 'expiresAt' | 'createdAt'>): Promise<string> {
  const token = randomString(48);
  const full: DownloadTokenPayload = {
    ...payload,
    expiresAt: Date.now() + TOKEN_TTL * 1000,
    createdAt: Date.now(),
  };
  await db.run(
    `INSERT INTO download_tokens (token, payload, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    [token, JSON.stringify(full), full.expiresAt, full.createdAt]
  );
  return token;
}

/**
 * 原子消费下载令牌：单条 DELETE ... RETURNING，并发请求下只有一个能取到 payload。
 * 取到即删除，保证一次性令牌不可被并发重复消费。
 */
export async function consumeDownloadToken(db: Db, token: string): Promise<DownloadTokenPayload | null> {
  const row = await db.first(
    `DELETE FROM download_tokens WHERE token = ? AND expires_at > ? RETURNING payload`,
    [token, Date.now()]
  );
  if (!row?.payload) return null;
  try {
    const payload = JSON.parse(String(row.payload)) as DownloadTokenPayload;
    if (Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 访问模式判定：
 * - public_cdn：provider 有公网域名且文件无密码
 * - signed_redirect：provider 支持预签名 URL
 * - private_gateway：其余情况（Workers 代理）
 */
export function decideAccessMode(
  file: FileMetadata,
  provider: StorageProviderInterface,
  _passwordVerified: boolean
): 'private_gateway' | 'signed_redirect' | 'public_cdn' {
  const publicUrl = provider.getPublicUrl(file.objectKey);
  if (publicUrl && !file.accessPassword) return 'public_cdn';
  // R2 绑定等不支持预签名时统一走网关代理
  return 'private_gateway';
}

/** 生成下载 URL（带签名 Token） */
export function buildGatewayUrl(c: Context, token: string): string {
  const origin = c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  return `${origin}/api/gateway/download/${token}`;
}

