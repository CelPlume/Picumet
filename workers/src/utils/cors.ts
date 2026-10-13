// CORS 来源白名单：解析、通配匹配与设置加载
//
// 白名单来源（并集）：环境变量 ALLOWED_ORIGINS + system_settings.allowed_origins
// （逗号分隔）。条目形态：
//   https://picumet.pages.dev     精确匹配（scheme + host[:port] 全等）
//   https://*.example.com         通配：匹配任意层级子域与裸域（*.example.com 命中
//                                 a.example.com / a.b.example.com / example.com）
// 条目缺省 scheme 时按 https 处理；通配符只允许出现在主机名首段（`*.example.com`），
// 端口严格匹配（条目未写端口时，来源也不得带非默认端口）。
import type { Db } from '../db';
import { SettingsRepo } from '../db';

/** 解析逗号/换行分隔的来源列表（去空、去重、保序） */
export function parseOriginList(raw: string | undefined | null): string[] {
  return Array.from(
    new Set(
      (raw ?? '')
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

/**
 * 单条白名单匹配。非法条目（URL 解析失败、通配符不在首段）恒不匹配——
 * 白名单语义下宁可拒配错项，不做宽松兜底。
 */
export function originMatches(origin: string, entry: string): boolean {
  let o: URL;
  let e: URL;
  try {
    o = new URL(origin);
    e = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`);
  } catch {
    return false;
  }
  if (o.protocol !== e.protocol) return false;
  // 端口严格：条目未写端口时，来源也不得带显式端口（https 默认 443 → URL.port 为空串）
  if (e.port === '' ? o.port !== '' : o.port !== e.port) return false;
  const eHost = e.hostname.toLowerCase();
  const oHost = o.hostname.toLowerCase();
  if (eHost.startsWith('*.')) {
    const suffix = eHost.slice(2);
    return oHost === suffix || oHost.endsWith(`.${suffix}`);
  }
  return oHost === eHost;
}

interface CorsCache {
  at: number;
  origins: string[];
}

/** 进程内缓存：设置保存主动失效；跨 isolate 最迟 60s 收敛（CORS 非鉴权面，可容忍） */
let corsCache: CorsCache | null = null;
const CORS_CACHE_TTL = 60_000;

/** 生效白名单 = 设置表 allowed_origins ∪ 环境变量 ALLOWED_ORIGINS（两者始终叠加） */
export async function loadCorsOrigins(db: Db, env: { ALLOWED_ORIGINS?: string }): Promise<string[]> {
  if (corsCache && Date.now() - corsCache.at < CORS_CACHE_TTL) return corsCache.origins;
  let raw = '';
  try {
    raw = (await SettingsRepo.get(db, 'allowed_origins')) ?? '';
  } catch {
    raw = '';
  }
  const origins = Array.from(
    new Set([...parseOriginList(raw), ...parseOriginList(env.ALLOWED_ORIGINS)])
  );
  corsCache = { at: Date.now(), origins };
  return origins;
}

/** 设置保存后调用：同 isolate 立即生效（跨 isolate 最迟 60s） */
export function invalidateCorsCache(): void {
  corsCache = null;
}
