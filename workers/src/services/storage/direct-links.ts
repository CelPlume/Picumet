// 路由前缀设置（direct_prefix / root_target）与公开直链地址生成。
//
// 设计背景见 docs/ROUTING_CN.md §2.1/§2.2（用户裁决：前缀只作用于公开直链，不作用于文件浏览页）：
//   - direct_prefix：公开直链 / 签名直链前缀，决定「虚拟路径挂在哪个命名空间」，
//     '' 表示虚拟路径直接挂在站点根（历史行为，默认）；
//   - root_target：'/' 的语义 —— 落地页 / 直链命名空间，后端只存储/暴露，由前端决定落地页或跳转。
// 分享 URL（/share/:id）、下载网关（/api/gateway/...）、WebDAV/S3/OpenList endpoint
// 与本模块无关，前缀不作用于它们（§2.2 第 1 条），避免已发出的链接失效。
//
// 放在 services/storage 而非 utils：本模块需要读 DB（SettingsRepo），而 utils/ 保持纯函数无 DB 依赖。
import { SettingsRepo } from '../../db';
import type { Db } from '../../db';
import { parseJson } from '../../db';

/** 公开直链前缀允许值；'' = 虚拟路径直接挂在站点根（默认，等价于历史行为） */
export const DIRECT_PREFIX_VALUES = ['', '/d', '/download', '/raw'] as const;
/** '/' 的语义：落地页 / 跳文件页（固定 /files） / 直链命名空间 */
export const ROOT_TARGET_VALUES = ['landing', 'files', 'direct'] as const;

export type DirectPrefix = (typeof DIRECT_PREFIX_VALUES)[number];
export type RootTarget = (typeof ROOT_TARGET_VALUES)[number];

export interface RoutePrefixes {
  directPrefix: DirectPrefix;
  rootTarget: RootTarget;
}

/** 缺省配置 == 历史行为：直链挂站点根、'/' 是落地页 */
export const DEFAULT_ROUTE_PREFIXES: RoutePrefixes = {
  directPrefix: '',
  rootTarget: 'landing',
};

/** 路径前缀归一化：去尾斜杠、补前导斜杠；''（与根别名 '/'）归一为空串 */
export function normalizeRoutePrefix(value: string): string {
  const v = value.trim();
  if (v === '' || v === '/') return '';
  return (v.startsWith('/') ? v : `/${v}`).replace(/\/+$/, '');
}

/** 枚举内取值判定（归一化后）：越界/脏值一律回退默认，避免脏设置把整个站点带偏 */
function pickPrefix<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  const normalized = normalizeRoutePrefix(value);
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

/**
 * 读前缀设置（一次查询，缺省/脏值用默认值兜底）；供 URL 生成与 path-serve 使用。
 * 值按 JSON 存储（迁移写入 `""`），也兼容 SettingsRepo.set 写入的裸字符串。
 */
export async function loadRoutePrefixes(db: Db): Promise<RoutePrefixes> {
  const raw = await SettingsRepo.getAll(db);
  const read = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    const parsed = parseJson<unknown>(v, v);
    return typeof parsed === 'string' ? parsed : undefined;
  };
  const rootTarget = read('root_target');
  return {
    directPrefix: pickPrefix(read('direct_prefix'), DIRECT_PREFIX_VALUES, DEFAULT_ROUTE_PREFIXES.directPrefix),
    rootTarget: (ROOT_TARGET_VALUES as readonly string[]).includes(rootTarget ?? '')
      ? (rootTarget as RootTarget)
      : DEFAULT_ROUTE_PREFIXES.rootTarget,
  };
}

/**
 * 公开直链绝对地址：`${origin}${directPrefix}${encodeURI(虚拟路径)}`（可选 `?sign=`）。
 * directPrefix='' 时形状与历史完全一致（`{origin}{虚拟路径}`）；路径段逐段编码，中文/空格可安全入 URL。
 */
export function directUrl(origin: string, directPrefix: string, virtualPath: string, sign?: string): string {
  const encoded = virtualPath.split('/').map((s) => (s ? encodeURIComponent(s) : '')).join('/');
  const url = `${origin}${normalizeRoutePrefix(directPrefix)}${encoded}`;
  return sign ? `${url}?sign=${sign}` : url;
}
