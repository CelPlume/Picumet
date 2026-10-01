// 客户端持久化图片缓存（localStorage Data URL 存储）：
// Logo、Favicon、用户头像拉取成功一次后以 Data URL (base64) 存入本地。
// 后续刷新页面时首帧直接同步读取缓存渲染，避免重复发起网络下载；
// 仅当配置的 URL 改变时才拉取新图并替换缓存。
// 外链经自家 Worker 中转（/api/public/site-asset/:kind），同源拉取避免跨域与防盗链拦截。
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

if (typeof Promise.withResolvers === 'undefined') {
  Promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}


export const DEFAULT_FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="4" y="8" width="40" height="28" rx="6" fill="#D8632B"/><path d="M16 20 L24 30 L32 20" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 40 H34" stroke="#D8632B" stroke-width="3" stroke-linecap="round"/></svg>`;

export const DEFAULT_FAVICON_DATA_URL =
  'data:image/svg+xml,' + encodeURIComponent(DEFAULT_FAVICON_SVG);

const CACHE_PREFIX = 'picumet:asset:';

interface CacheEntry {
  url: string;
  dataUrl: string;
  savedAt: number;
}

/** 外部图片地址改走自家 Worker 中转（同源请求 + 边缘缓存 7 天 + 服务端跟随重定向） */
export function assetProxyUrl(kind: 'logo' | 'favicon' | 'avatar', url?: string): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/public/site-asset/${kind}?u=${encodeURIComponent(url)}`;
}

/** 同步读取已缓存的 Data URL：首帧零网络请求直出；URL 变动或未缓存返回 undefined */
export function getCachedAsset(kind: 'logo' | 'favicon' | 'avatar', url?: string): string | undefined {
  if (!url || typeof window === 'undefined') return undefined;
  if (url.startsWith('data:')) return url;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + kind);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry && entry.url === url && entry.dataUrl) {
      return entry.dataUrl;
    }
  } catch {
    /* 格式解析异常忽略 */
  }
  return undefined;
}

/** 异步拉取图片并存入 localStorage（Data URL） */
export async function cacheAsset(kind: 'logo' | 'favicon' | 'avatar', url?: string): Promise<string | null> {
  if (!url || typeof window === 'undefined' || url.startsWith('data:')) return url ?? null;
  try {
    // 外部外链经自家中转端点拉取（同源请求，避免 CORS 拦截并利用边缘缓存）
    const fetchTarget = assetProxyUrl(kind, url) || url;
    const res = await fetch(fetchTarget);
    if (!res.ok) return null;
    const blob = await res.blob();
    // 2MB 上限防御，防止超大图撑爆 localStorage
    if (blob.size > 2 * 1024 * 1024) return null;

    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
    const dataUrl = await promise;

    try {
      const entry: CacheEntry = { url, dataUrl, savedAt: Date.now() };
      localStorage.setItem(CACHE_PREFIX + kind, JSON.stringify(entry));
    } catch {
      /* 存储满或隐私模式失败忽略 */
    }
    return dataUrl;
  } catch {
    return null;
  }
}
