// S3 SigV4 验签（AWS Signature Version 4，S3 flavor）
// 与通用 SigV4 的差异：CanonicalURI 使用客户端发送的原始路径（不做二次编码/规范化）；
// payload hash 取自 x-amz-content-sha256（整包 hex / UNSIGNED-PAYLOAD）；
// region 不做已知白名单校验（PicList 使用字面量 'auto'）。
// 支持两种形态：Authorization 头（PutObject/GetObject/…）与 query 预签名（GET 下载直链）。
import { hmacSha256Raw, hmacSha256Hex, sha256HexBytes, timingSafeEqualStr } from '../../utils/crypto';

const encoder = new TextEncoder();

export type SigV4ErrorCode =
  | 'InvalidRequest'
  | 'AuthorizationQueryParametersError'
  | 'SignatureDoesNotMatch'
  | 'AccessDenied'
  | 'NotImplemented';

export class SigV4Error extends Error {
  constructor(
    public readonly code: SigV4ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SigV4Error';
  }
}

export interface SigV4Credential {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  terminal: string;
}

export interface SigV4HeaderAuth {
  kind: 'header';
  credential: SigV4Credential;
  signedHeaders: string[];
  signature: string;
  amzDate: string;
  payloadHash: string;
}

export interface SigV4QueryAuth {
  kind: 'query';
  credential: SigV4Credential;
  signedHeaders: string[];
  signature: string;
  amzDate: string;
  expiresInSeconds: number;
}

export type SigV4Request = SigV4HeaderAuth | SigV4QueryAuth;

export interface SigV4Verification {
  auth: SigV4Request;
  /** payload hash 为整包 hex 时已读取的请求体（供 PUT 处理器直接使用，避免二次读取） */
  payloadBytes?: Uint8Array;
}

function pctDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%2B'));
  } catch {
    return s;
  }
}

function rfc3986Encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 保留字面 '+' 的原始 query 解析（URLSearchParams 会把 '+' 当空格，破坏 continuation-token 等） */
function parseRawQuery(rawQuery: string): Array<{ key: string; value: string }> {
  if (!rawQuery || rawQuery === '?') return [];
  return rawQuery
    .replace(/^\?/, '')
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
      const rawValue = eq >= 0 ? pair.slice(eq + 1) : '';
      return { key: pctDecode(rawKey), value: pctDecode(rawValue) };
    });
}

function canonicalQueryString(pairs: Array<{ key: string; value: string }>): string {
  const encoded = pairs.map(({ key, value }) => ({ k: rfc3986Encode(key), v: rfc3986Encode(value) }));
  encoded.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
  return encoded.map(({ k, v }) => `${k}=${v}`).join('&');
}

function canonicalHeaders(req: Request, signedHeaders: string[]): string {
  return signedHeaders
    .map((name) => {
      const value = (req.headers.get(name) ?? '').replace(/\s+/g, ' ').trim();
      return `${name}:${value}\n`;
    })
    .join('');
}

function amzDateToMs(amzDate: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function parseCredential(credential: string, errorCode: SigV4ErrorCode): SigV4Credential {
  const segs = credential.split('/');
  if (segs.length !== 5 || segs.some((s) => s.length === 0)) {
    throw new SigV4Error(errorCode, 'Credential 格式无效');
  }
  return { accessKeyId: segs[0], date: segs[1], region: segs[2], service: segs[3], terminal: segs[4] };
}

/**
 * 从请求解析 SigV4 认证信息；无认证信息返回 null（中间件按匿名拒绝）。
 * 认证头存在但格式损坏 / 预签名参数不完整 → 抛 SigV4Error。
 */
export function parseSigV4Request(req: Request): SigV4Request | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const m = /^AWS4-HMAC-SHA256\s+(.+)$/.exec(authHeader.trim());
    if (!m) return null; // 非 SigV4 认证头（如 Bearer）→ 按无 S3 认证处理
    const parts: Record<string, string> = {};
    for (const kv of m[1].split(',')) {
      const eq = kv.indexOf('=');
      if (eq > 0) parts[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
    const credential = parts['Credential'];
    const signed = parts['SignedHeaders'];
    const signature = parts['Signature'];
    if (!credential || !signed || !signature) {
      throw new SigV4Error('InvalidRequest', 'Authorization 头格式无效');
    }
    const payloadHash = req.headers.get('x-amz-content-sha256');
    if (!payloadHash) {
      throw new SigV4Error('InvalidRequest', '缺少 x-amz-content-sha256 头');
    }
    return {
      kind: 'header',
      credential: parseCredential(credential, 'InvalidRequest'),
      signedHeaders: signed.split(';').map((s) => s.trim().toLowerCase()),
      signature,
      amzDate: req.headers.get('x-amz-date') ?? '',
      payloadHash,
    };
  }

  const url = new URL(req.url);
  const algorithm = url.searchParams.get('X-Amz-Algorithm');
  if (!algorithm) return null;
  if (algorithm !== 'AWS4-HMAC-SHA256') {
    throw new SigV4Error('AuthorizationQueryParametersError', 'X-Amz-Algorithm 仅支持 AWS4-HMAC-SHA256');
  }
  const credential = url.searchParams.get('X-Amz-Credential');
  const signature = url.searchParams.get('X-Amz-Signature');
  const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
  const expiresRaw = url.searchParams.get('X-Amz-Expires');
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
  if (!credential || !signature || !amzDate || !expiresRaw || !signedHeaders) {
    throw new SigV4Error('AuthorizationQueryParametersError', '预签名查询参数不完整');
  }
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires < 1 || expires > 604800) {
    throw new SigV4Error('AuthorizationQueryParametersError', 'X-Amz-Expires 无效（1~604800 秒）');
  }
  return {
    kind: 'query',
    credential: parseCredential(credential, 'AuthorizationQueryParametersError'),
    signedHeaders: signedHeaders.split(';').map((s) => s.trim().toLowerCase()),
    signature,
    amzDate,
    expiresInSeconds: expires,
  };
}

async function computeSignature(
  req: Request,
  secret: string,
  auth: SigV4Request,
  canonicalQuery: string,
  payloadHash: string
): Promise<string> {
  const url = new URL(req.url);
  const canonicalRequest = [
    req.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders(req, auth.signedHeaders),
    auth.signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${auth.credential.date}/${auth.credential.region}/${auth.credential.service}/${auth.credential.terminal}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    auth.amzDate,
    scope,
    await sha256HexBytes(encoder.encode(canonicalRequest)),
  ].join('\n');
  const kDate = await hmacSha256Raw(`AWS4${secret}`, auth.credential.date);
  const kRegion = await hmacSha256Raw(kDate, auth.credential.region);
  const kService = await hmacSha256Raw(kRegion, auth.credential.service);
  const kSigning = await hmacSha256Raw(kService, auth.credential.terminal);
  return hmacSha256Hex(kSigning, stringToSign);
}

/**
 * 完整验签：时效 → canonical request → HMAC 派生链 → 常量时间比对；
 * payload hash 为整包 hex 时读取请求体并校验一致性（返回 payloadBytes 供处理器复用）。
 */
export async function verifySigV4(req: Request, secret: string): Promise<SigV4Verification> {
  const auth = parseSigV4Request(req);
  if (!auth) throw new SigV4Error('AccessDenied', '未提供有效的 S3 签名');
  if (auth.credential.service !== 's3' || auth.credential.terminal !== 'aws4_request') {
    throw new SigV4Error('SignatureDoesNotMatch', 'Credential scope 无效');
  }
  const amzMs = amzDateToMs(auth.amzDate);
  if (amzMs === null) throw new SigV4Error('AccessDenied', '签名日期无效');
  if (!auth.amzDate.startsWith(auth.credential.date)) {
    throw new SigV4Error('SignatureDoesNotMatch', '签名日期与 Credential scope 不一致');
  }
  const now = Date.now();
  if (auth.kind === 'header') {
    if (Math.abs(now - amzMs) > 15 * 60_000) {
      throw new SigV4Error('AccessDenied', '请求时间偏差过大（>15 分钟）');
    }
  } else if (now < amzMs - 15 * 60_000) {
    throw new SigV4Error('AccessDenied', '预签名请求时间偏差过大');
  } else if (now > amzMs + auth.expiresInSeconds * 1000) {
    throw new SigV4Error('AccessDenied', '预签名请求已过期');
  }

  let payloadHash: string;
  let payloadBytes: Uint8Array | undefined;
  if (auth.kind === 'query') {
    payloadHash = 'UNSIGNED-PAYLOAD';
  } else if (/^[0-9a-fA-F]{64}$/.test(auth.payloadHash)) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    const actual = await sha256HexBytes(bytes);
    if (actual !== auth.payloadHash.toLowerCase()) {
      throw new SigV4Error('SignatureDoesNotMatch', 'x-amz-content-sha256 与请求体不一致');
    }
    payloadHash = actual;
    payloadBytes = bytes;
  } else if (auth.payloadHash === 'UNSIGNED-PAYLOAD') {
    payloadHash = auth.payloadHash;
  } else {
    throw new SigV4Error('NotImplemented', `不支持的 payload 形态：${auth.payloadHash}`);
  }

  const url = new URL(req.url);
  let pairs = parseRawQuery(url.search);
  if (auth.kind === 'query') {
    pairs = pairs.filter((p) => p.key !== 'X-Amz-Signature');
  }
  const signature = await computeSignature(req, secret, auth, canonicalQueryString(pairs), payloadHash);
  if (!timingSafeEqualStr(signature, auth.signature.toLowerCase())) {
    throw new SigV4Error('SignatureDoesNotMatch', '签名不匹配');
  }
  return { auth, payloadBytes };
}
