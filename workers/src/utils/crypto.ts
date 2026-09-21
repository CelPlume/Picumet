// 加密与令牌工具：JWT、哈希、AES-GCM、随机字符串

import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';

const encoder = new TextEncoder();

/** 测试注入点：覆盖全局 crypto（用于验证 WebCrypto 缺失时 fail-closed），生产路径不受影响 */
let testCryptoOverride: Crypto | undefined;
export function __setCryptoOverrideForTests(c: Crypto | undefined): void {
  testCryptoOverride = c;
}

function webCrypto(): Crypto {
  if (testCryptoOverride !== undefined) return testCryptoOverride;
  return (globalThis as unknown as { crypto?: Crypto }).crypto as Crypto;
}

/** 异步 SHA-256 十六进制（WebCrypto，Workers/Node 均可用）。
 * 审计 M-4：WebCrypto 不可用时 fail-closed（抛错），不使用非密码学降级。 */
export async function sha256Hex(input: string): Promise<string> {
  const cryptoApi = webCrypto();
  if (!cryptoApi?.subtle?.digest) {
    throw new Error('WebCrypto unavailable: SHA-256 requires a secure runtime');
  }
  const buf = await cryptoApi.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
  /** 会话版本（审计 H-05）：登出/改密/禁用时递增，旧 JWT 立即失效 */
  sv?: number;
  iat: number;
  exp: number;
  jti: string;
}

export async function signJwt(
  payload: { sub: string; username: string; role: string; sv?: number },
  secret: string,
  expiresInSeconds: number
): Promise<string> {
  return new SignJWT({ username: payload.username, role: payload.role, type: 'access', sv: payload.sv ?? 0 })
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

// 审计 M-4：用 HKDF-SHA256 从 ENCRYPTION_KEY 派生 32 字节 AES 密钥（标准 KDF，替换自定义 FNV 派生）。
const HKDF_SALT = 'picumet-encryption-v1';
const HKDF_INFO = 'picumet-aes-gcm-key';

type AesKeyUsage = 'encrypt' | 'decrypt';

async function deriveAesKey(encryptionKey: string, usages: AesKeyUsage[]): Promise<CryptoKey> {
  const cryptoApi = webCrypto();
  if (!cryptoApi?.subtle) {
    throw new Error('WebCrypto unavailable: AES-GCM requires a secure runtime');
  }
  const ikm = await cryptoApi.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    'HKDF',
    false,
    ['deriveKey']
  );
  return cryptoApi.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

export async function encryptSecret(plaintext: string, encryptionKey: string): Promise<string> {
  const cryptoApi = webCrypto();
  const key = await deriveAesKey(encryptionKey, ['encrypt']);
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
  const key = await deriveAesKey(encryptionKey, ['decrypt']);
  const decrypted = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ============ HMAC-SHA256 与常量时间比较（S3 SigV4 网关 / 路径直链签名） ============

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 常量时间字符串比较（签名比对防时序侧信道） */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function importHmacKey(key: Uint8Array | string): Promise<CryptoKey> {
  const cryptoApi = webCrypto();
  if (!cryptoApi?.subtle) {
    throw new Error('WebCrypto unavailable: HMAC requires a secure runtime');
  }
  const raw = typeof key === 'string' ? encoder.encode(key) : key;
  return cryptoApi.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** HMAC-SHA256 → 原始字节（SigV4 密钥派生链需要逐级 HMAC 字节输出） */
export async function hmacSha256Raw(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const cryptoApi = webCrypto();
  const k = await importHmacKey(key);
  const sig = await cryptoApi.subtle.sign('HMAC', k, encoder.encode(message));
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(key: Uint8Array | string, message: string): Promise<string> {
  return toHex(await hmacSha256Raw(key, message));
}

/** 任意字节流的 SHA-256 十六进制（SigV4 payload 完整性校验） */
export async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const cryptoApi = webCrypto();
  if (!cryptoApi?.subtle?.digest) {
    throw new Error('WebCrypto unavailable: SHA-256 requires a secure runtime');
  }
  const buf = await cryptoApi.subtle.digest('SHA-256', data as BufferSource);
  return toHex(new Uint8Array(buf));
}

// ============ 路径直链签名（P0-1：私有挂载的持久可嵌 URL 能力令牌） ============
// sign = `${expiresAt}.${hmacHex(secret, `${path}:${expiresAt}`)}`；expiresAt=0 表示长期有效。
// 能力范围：仅该精确路径的匿名 GET（与 AList sign 语义对齐）。

export async function signPath(path: string, secret: string, expiresAt = 0): Promise<string> {
  const sig = await hmacSha256Hex(secret, `${path}:${expiresAt}`);
  return `${expiresAt}.${sig}`;
}

export async function verifyPathSign(path: string, secret: string, sign: string): Promise<boolean> {
  const dot = sign.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(sign.slice(0, dot));
  const sig = sign.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < 0) return false;
  if (expiresAt !== 0 && Date.now() > expiresAt) return false;
  const expected = await hmacSha256Hex(secret, `${path}:${expiresAt}`);
  return timingSafeEqualStr(expected, sig);
}
