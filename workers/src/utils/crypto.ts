// 加密与令牌工具：JWT、哈希、AES-GCM、随机字符串

import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';

const encoder = new TextEncoder();

function webCrypto(): Crypto {
  return (globalThis as unknown as { crypto?: Crypto }).crypto as Crypto;
}

/** 异步 SHA-256 十六进制（WebCrypto，Workers/Node 均可用） */
export async function sha256Hex(input: string): Promise<string> {
  const cryptoApi = webCrypto();
  if (cryptoApi?.subtle?.digest) {
    const buf = await cryptoApi.subtle.digest('SHA-256', encoder.encode(input));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 兜底：FNV-1a 双哈希（仅测试环境退化）
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function randomString(length: number, charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'): string {
  const bytes = new Uint8Array(length);
  webCrypto().getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i] % charset.length];
  return out;
}

export function uuid(): string {
  return webCrypto()?.randomUUID?.() ?? `${Date.now().toString(36)}-${randomString(16).toLowerCase()}`;
}

// ============ JWT ============

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  type: 'access';
  iat: number;
  exp: number;
  jti: string;
}

export async function signJwt(
  payload: { sub: string; username: string; role: string },
  secret: string,
  expiresInSeconds: number
): Promise<string> {
  return new SignJWT({ username: payload.username, role: payload.role, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setJti(uuid())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(encoder.encode(secret));
}

export async function verifyJwt(token: string, secrets: string[]): Promise<JwtPayload | null> {
  for (const secret of secrets) {
    if (!secret) continue;
    try {
      const { payload } = await jwtVerify(token, encoder.encode(secret), { algorithms: ['HS256'] });
      return payload as unknown as JwtPayload;
    } catch {
      // try next secret
    }
  }
  return null;
}

// ============ bcrypt ============

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

// ============ AES-GCM 密钥加密（存储凭据） ============

function deriveKeyBytes(secret: string): Uint8Array {
  let key = '';
  // 无异步依赖的伪随机派生（仅用于本地密钥派生）
  let h = 0x811c9dc5;
  const str = secret + secret + secret;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  key = h.toString(16).padStart(8, '0').repeat(4) + secret;
  return new Uint8Array(encoder.encode(key.slice(0, 32)));
}

export async function encryptSecret(plaintext: string, encryptionKey: string): Promise<string> {
  const cryptoApi = webCrypto();
  const key = await cryptoApi.subtle.importKey(
    'raw',
    deriveKeyBytes(encryptionKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const encrypted = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptSecret(payload: string, encryptionKey: string): Promise<string> {
  const cryptoApi = webCrypto();
  const combined = new Uint8Array(Buffer.from(payload, 'base64'));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const key = await cryptoApi.subtle.importKey(
    'raw',
    deriveKeyBytes(encryptionKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const decrypted = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
