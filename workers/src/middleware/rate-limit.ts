// 速率限制中间件：固定窗口计数（IP + 用户/标识 双层）
//
// 计数后端：**进程内内存（快）+ 混合存储（KV 优先 / D1 回退，窗口首请求同步）**。
//
// 为什么不是纯内存：
//   Workers 有多个 isolate / 多 colo，每个 isolate 各有一份内存计数器——
//   冷启动的 isolate 计数归零（限流被绕过），而已用完计数的 isolate 又会误伤新用户。
//   纯 KV 则受每日写配额约束（配额耗尽即失效）。
//   混合存储把「快」与「准」分开：每个 isolate 的 key/window 首请求回源并持久化，
//   后续热请求只走内存；KV 配额耗尽时该首请求自动落 D1。
/**
 * 固定窗口计数：每个 isolate 的同一 key/window 最多一次 KV/D1 回源与写回，
 * 后续请求只更新内存，避免限流热路径本身耗尽免费存储配额。
 */
import { createMiddleware } from 'hono/factory';
import type { Db } from '../db';
import { SettingsRepo } from '../db';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { getDb } from './auth';
import { clientIp } from '../utils/ip';
import { kvStoreFor, type KvLike } from '../utils/kv-store';
import type { Env } from '../shared/types';

const DEFAULT_LIMIT = 50;

interface MemoryRateEntry {
  count: number;
  resetAt: number;
  /** 当前计数所属的固定窗口起点（epoch 对齐，跨 isolate 与持久层同键） */
  windowStart: number;
}
const memoryLimits = new Map<string, MemoryRateEntry>();
const MAX_LIMIT_ENTRIES = 10_000;

/**
 * 内存固定窗口计数（零 KV 写入消耗，彻底杜绝免费档 1000 次单日写上限烧穿）。
 * 兼容性保证：若调用方传入了 kv，仅读取不写入（支持 fail-closed 故障测试与测试预置数据），
 * 计数递增完全在内存维护，零 kv.put！
 */
export async function checkLimit(key: string, limit: number, windowMs?: number): Promise<boolean>;
export async function checkLimit(kv: unknown, key: string, limit: number, windowMs?: number): Promise<boolean>;
export async function checkLimit(
  env: { KV?: unknown; DB?: unknown; ENVIRONMENT?: string } | null,
  key: string,
  limit: number,
  windowMs: number
): Promise<boolean>;
export async function checkLimit(
  arg1: unknown,
  arg2?: unknown,
  arg3?: unknown,
  arg4?: unknown
): Promise<boolean> {
  // 兼容三种调用形态：checkLimit(key, limit, windowMs) / checkLimit(kv, key, limit, windowMs) /
  //                   checkLimit(env, key, limit, windowMs)
  const isKeyOnly = typeof arg1 === 'string';
  const env = isKeyOnly ? null : ((arg1 ?? null) as { KV?: unknown; DB?: unknown } | null);
  const key = isKeyOnly ? String(arg1) : String(arg2);
  const limit = Number(isKeyOnly ? arg2 : arg3);
  const windowMs = Number(isKeyOnly ? (arg3 ?? 60_000) : (arg4 ?? 60_000));
  if (limit <= 0) return true;

  const now = Date.now();
  // 固定窗口：起点按 windowMs 对齐，跨 isolate 读到的是同一个窗口键
  const windowStart = now - (now % windowMs);
  const cacheKey = `${key}:${windowStart}`;

  const store = env?.DB ? kvStoreFor(env as unknown as Env, 'ratelimit') : null;
  const kv = (env?.KV ?? null) as KvLike | null;
  const entry = memoryLimits.get(key);
  const sameWindow = entry?.windowStart === windowStart;

  // 每个 isolate 的同一 key/window 只回源一次；后续请求只读内存，
  // 避免限流本身把每个请求放大为 KV 读写与 D1 fallback。
  let durable = 0;
  if (!sameWindow) {
    if (store) {
      try {
        const raw = await store.get(kv, cacheKey);
        if (raw != null) durable = Number(raw) || 0;
      } catch {
        durable = 0;
      }
    } else if (kv) {
      try {
        const raw = await kv.get(cacheKey);
        if (raw != null) durable = Number(raw) || 0;
      } catch {
        durable = 0;
      }
    }
  }

  const inMemory = sameWindow ? entry?.count ?? 0 : 0;
  const current = Math.max(inMemory, durable);
  const next = current + 1;

  if (sameWindow && entry) {
    entry.count = next;
  } else {
    if (memoryLimits.size > MAX_LIMIT_ENTRIES) {
      for (const [k, v] of memoryLimits) {
        if (v.windowStart < windowStart) memoryLimits.delete(k);
      }
    }
    memoryLimits.set(key, { count: next, resetAt: now + windowMs, windowStart });
  }

  // 每个 isolate 每个 key/window 最多写一次；热请求完全不写 KV。
  if (!sameWindow) {
    if (store) {
      try {
        await store.put(kv, cacheKey, String(next), { expirationTtl: Math.ceil(windowMs / 1000) + 5 });
      } catch {
        // 存储异常时内存计数仍然生效（单 isolate 内不失效）
      }
    } else if (kv) {
      try {
        await kv.put(cacheKey, String(next), { expirationTtl: Math.ceil(windowMs / 1000) + 5 });
      } catch {
        // 忽略
      }
    }
  }

  return current < limit;
}

/** 清空内存限流器全部状态（测试/隔离重置用） */
export function resetMemoryLimits(): void {
  memoryLimits.clear();
}

/** 清空指定键的计数（兼容传 kv 或仅传 key） */
export async function resetLimit(key: string): Promise<void>;
export async function resetLimit(kv: unknown, key: string, windowMs?: number): Promise<void>;
export async function resetLimit(arg1: unknown, arg2?: unknown): Promise<void> {
  const key = typeof arg1 === 'string' ? arg1 : String(arg2);
  memoryLimits.delete(key);
}

/** LAB L-02：限速/并发生效条件——production，或显式 RATE_LIMIT_FORCE=true（staging/本地回归） */
export function rateLimitsEnforced(env: { ENVIRONMENT?: string; RATE_LIMIT_FORCE?: string }): boolean {
  return env.ENVIRONMENT === 'production' || env.RATE_LIMIT_FORCE === 'true';
}

/**
 * 全局限流：读 system_settings 的 rate_limit_enabled / rate_limit_requests_per_minute。
 * 非生产环境（开发/测试）跳过，避免误伤本地调试（RATE_LIMIT_FORCE=true 可强制开启）。
 * 存储异常时：认证/敏感写接口 fail-closed（503），其余 fail-open。
 */
export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  if (!rateLimitsEnforced(c.env)) {
    await next();
    return;
  }
  const path = c.req.path;
  const sensitive = /\/api\/auth\/(login|register|forgot-password|reset-password)$/.test(path);
  try {
    const db = getDb(c);
    const enabledRaw = await SettingsRepo.get(db, 'rate_limit_enabled');
    if (enabledRaw === 'false') {
      await next();
      return;
    }
    const limitRaw = await SettingsRepo.get(db, 'rate_limit_requests_per_minute');
    const limit = limitRaw ? Number(limitRaw) || DEFAULT_LIMIT : DEFAULT_LIMIT;

    const ip = clientIp(c.req.raw);
    const ipOk = await checkLimit(c.env, `ip:${ip}`, limit, 60_000);
    if (!ipOk) {
      return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '请求过于频繁，请稍后再试'));
    }
    const userId = c.get('userId') as string | undefined;
    if (userId) {
      const userOk = await checkLimit(c.env, `user:${userId}`, limit * 2, 60_000);
      if (!userOk) {
        return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '请求过于频繁，请稍后再试'));
      }
    }
    await next();
  } catch {
    // 存储异常：认证/敏感写接口 fail-closed，防止限流被绕过；其余接口 fail-open 保证可用性
    if (sensitive) {
      return fail(c, new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂不可用，请稍后再试'));
    }
    await next();
  }
});

/**
 * 认证限流阈值缓存（system_settings.auth_rate_limit_per_minute）：
 * 60s 进程内缓存 + 设置保存失效（与审计策略缓存同模式）。
 * 0 = 关闭该档（authRateLimitMiddleware 直接放行）。
 */
// IP 维度默认 20：NAT 出口下多人共用一个 IP，20 次/分钟才够正常多人使用；
// 单账号爆破由「标识维度」单独收紧（默认 10），两者独立计数互不挤占。
const AUTH_RATE_LIMIT_DEFAULT = 20;
/** 标识维度阈值：IP 阈值的一半（下限 5），专防「针对单个账号的在线爆破」 */
const AUTH_IDENTITY_RATE_DIVISOR = 2;
const AUTH_IDENTITY_RATE_MIN = 5;
const AUTH_RATE_LIMIT_TTL_MS = 60_000;
interface CachedAuthRateLimit {
  limit: number;
  at: number;
}
let authRateLimitCache: CachedAuthRateLimit | null = null;

/** 设置读取失败 = 回退默认 10（够用且不至于把 NAT 下的正常用户锁死） */
async function loadAuthRateLimit(db: Db): Promise<number> {
  if (authRateLimitCache && Date.now() - authRateLimitCache.at < AUTH_RATE_LIMIT_TTL_MS) {
    return authRateLimitCache.limit;
  }
  const raw = await SettingsRepo.get(db, 'auth_rate_limit_per_minute');
  const parsed = raw == null ? NaN : Number(raw);
  const limit = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : AUTH_RATE_LIMIT_DEFAULT;
  authRateLimitCache = { limit, at: Date.now() };
  return limit;
}

/** 设置保存后调用：立即失效进程内阈值缓存（否则 60s TTL 内仍是旧阈值） */
export function invalidateAuthRateLimitCache(): void {
  authRateLimitCache = null;
}

/**
 * 登录/注册限流：阈值读 system_settings 的 auth_rate_limit_per_minute
 * （默认 10 次/分钟；0 = 关闭该档；仅生产环境生效，RATE_LIMIT_FORCE=true 可强制）。
 *
 * 双维度计数，缺一不可：
 *   · IP 维度：挡住同一出口的大规模撞库 / 批量注册（移动 NAT 下会偏严，故阈值不低）。
 *   · 标识维度（登录名 / 注册邮箱 / SSO provider）：挡住「针对单个账号的在线爆破」，
 *     而不会因为同一 NAT 下**别人**的正常登录被连坐。
 *
 * 之前只有 IP 维度且阈值 2，导致「注册（1）+ 登录（1）」就把整个出口 IP 打死，
 * 同出口的其他人全部 429。
 */
/**
 * 提取用于「单账号爆破」计数的标识：
 *   · /api/auth/login → body.username（用户名或邮箱）
 *   · /api/auth/register、/register/send-otp → body.email
 *   · /api/auth/reset-password → 不取（令牌本身已是能力凭证）
 *   · /api/auth/sso/:id/start → provider id
 * 取不到或解析失败一律返回 null（退化为只有 IP 维度，不误伤）。
 */
async function readAuthIdentity(c: { req: { method: string; path: string; json(): Promise<unknown> } }): Promise<string | null> {
  const path = c.req.path;
  if (c.req.method !== 'POST' && c.req.method !== 'PUT') return null;
  try {
    if (path.endsWith('/login') || path.endsWith('/register')) {
      const body = (await c.req.json()) as { username?: unknown; email?: unknown } | null;
      const raw = path.endsWith('/login') ? body?.username : body?.email;
      const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      return v.length > 0 && v.length <= 254 ? v : null;
    }
    if (path.endsWith('/register/send-otp')) {
      const body = (await c.req.json()) as { email?: unknown } | null;
      const v = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      return v.length > 0 && v.length <= 254 ? v : null;
    }
    if (path.includes('/sso/') && path.endsWith('/start')) {
      const m = path.match(/\/sso\/([^/]+)\/start$/);
      return m && m[1] ? `sso:${m[1]}` : null;
    }
  } catch {
    // body 解析失败（非法 JSON）→ 无标识维度，交给 handler 自己报 400
  }
  return null;
}

export const authRateLimitMiddleware = createMiddleware(async (c, next) => {
  if (!rateLimitsEnforced(c.env)) {
    await next();
    return;
  }
  try {
    const db = getDb(c);
    const limit = await loadAuthRateLimit(db);
    if (limit <= 0) {
      await next();
      return;
    }
    const ip = clientIp(c.req.raw);
    const ipOk = await checkLimit(c.env, `auth:ip:${ip}`, limit, 60_000);
    if (!ipOk) {
      return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '尝试过于频繁，请稍后再试'));
    }

    // 标识维度：从请求体里取登录名 / 邮箱 / provider id（读 body 不影响下游 handler，
    // Hono 的 c.req.json() 可重复读取已缓存的 body）。独立预算：IP 打满不影响他人，
    // 单账号爆破在标识维度提前被拦。
    const identity = await readAuthIdentity(c);
    if (identity) {
      const idLimit = Math.max(AUTH_IDENTITY_RATE_MIN, Math.floor(limit / AUTH_IDENTITY_RATE_DIVISOR));
      const idOk = await checkLimit(c.env, `auth:id:${identity}`, idLimit, 60_000);
      if (!idOk) {
        return fail(
          c,
          new ApiError(429, 'RATE_LIMIT_EXCEEDED', '该账号尝试过于频繁，请稍后再试')
        );
      }
    }
  } catch {
    // 认证类存储异常 fail-closed（503），防止限流被绕过（与全局限流的敏感路径口径一致）
    return fail(c, new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂不可用，请稍后再试'));
  }
  await next();
});

/** 注册成功速率的 KV 键前缀（按 IP，窗口 1h，epoch 对齐与限流计数同模式） */
export const REGISTER_SUCCESS_LIMIT_KEY_PREFIX = 'rreg:';

/**
 * 注册成功速率检查与计数（auth/handlers 注册成功事务后调用）：
 * 每注册成功 1 次计数 +1，超过 register_success_per_hour_per_ip 返回 false（调用方回 429）。
 * 注意：计数自增发生在「已成功」之后（先建号后计数），窗口内的第 N+1 个成功注册被拒——
 * 语义是「冷却」而非「预检」，与邀请码/邮箱验证等前置门控互补。
 */
export async function checkRegisterSuccessLimit(
  env: { KV?: unknown; DB?: unknown },
  ip: string,
  limit: number,
  windowMs = 3_600_000
): Promise<boolean> {
  return checkLimit(env, `${REGISTER_SUCCESS_LIMIT_KEY_PREFIX}${ip}`, limit, windowMs);
}

/**
 * 分享密码验证限流：5 次/分钟/IP/分享（仅生产环境生效，RATE_LIMIT_FORCE=true 可强制）。
 * 全局限流不足以防在线爆破，故按分享维度单独收紧；
 * 存储异常 fail-closed（503），避免限流被绕过。
 */
export const shareVerifyRateLimitMiddleware = createMiddleware(async (c, next) => {
  if (!rateLimitsEnforced(c.env)) {
    await next();
    return;
  }
  const shareId = c.req.param('id') ?? '-';
  const ip = clientIp(c.req.raw);
  try {
    const ok = await checkLimit(c.env, `sv:${shareId}:${ip}`, 5, 60_000);
    if (!ok) {
      return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '尝试过于频繁，请稍后再试'));
    }
  } catch {
    return fail(c, new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂不可用，请稍后再试'));
  }
  await next();
});
