// 客户端图片缓存（lib/image-cache.ts）：首帧同步直出 + URL 变更失效 + 自家中转 + 体积/异常兜底
// 覆盖的不变量：
// - assetProxyUrl：外链改走自家 Worker 中转（同源 + 边缘缓存），站内相对地址与 data: URL 原样返回
// - getCachedAsset：URL 变动即失效（不得拿旧图当新图直出），脏 localStorage 不抛错
// - cacheAsset：经中转端点拉取、2MB 上限拒收且不落盘、写入被拒（隐私模式/配额满）仍返回可用 Data URL
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { assetProxyUrl, getCachedAsset, cacheAsset, DEFAULT_FAVICON_DATA_URL } from './image-cache';

const LOGO = 'https://cdn.example.com/brand/logo.png';
const OTHER_LOGO = 'https://cdn.example.com/brand/logo-v2.png';

const CACHE_KEY = 'picumet:asset:logo';

/** 写一条缓存记录（与实现同构，避免测试替实现兜底） */
function seedCache(kind: 'logo' | 'favicon' | 'avatar', entry: unknown): void {
  localStorage.setItem(`picumet:asset:${kind}`, typeof entry === 'string' ? entry : JSON.stringify(entry));
}

function readCacheUrl(kind: 'logo' | 'favicon' | 'avatar'): string | null {
  const raw = localStorage.getItem(`picumet:asset:${kind}`);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !('url' in parsed)) return null;
  return typeof parsed.url === 'string' ? parsed.url : null;
}

/** fetch 桩：只提供 cacheAsset 用到的两个成员（ok / blob） */
interface StubbedFetch {
  (input: string): Promise<{ ok: boolean; blob: () => Promise<Blob> }>;
  mock: { calls: unknown[][] };
}

/** 构造 fetch 桩：按字节数返回 PNG Blob，ok 可控 */
function stubFetch(bytes: number, ok = true): StubbedFetch {
  const fn = vi.fn(async () => ({
    ok,
    blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
  }));
  vi.stubGlobal('fetch', fn);
  return fn as unknown as StubbedFetch;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('assetProxyUrl', () => {
  it('外链 http(s) 改走自家 Worker 中转端点（kind 参与路径、地址做 URL 编码）', () => {
    expect(assetProxyUrl('logo', LOGO)).toBe(`/api/public/site-asset/logo?u=${encodeURIComponent(LOGO)}`);
    expect(assetProxyUrl('favicon', 'http://cdn.example.com/f.ico')).toBe(
      `/api/public/site-asset/favicon?u=${encodeURIComponent('http://cdn.example.com/f.ico')}`
    );
    expect(assetProxyUrl('avatar', LOGO)).toContain('/api/public/site-asset/avatar?u=');
  });

  it('站内相对地址、data: URL 原样返回（不套中转，中转端点只放行已登记地址）', () => {
    expect(assetProxyUrl('logo', '/brand/logo.png')).toBe('/brand/logo.png');
    expect(assetProxyUrl('favicon', DEFAULT_FAVICON_DATA_URL)).toBe(DEFAULT_FAVICON_DATA_URL);
  });

  it('未配置地址返回 undefined', () => {
    expect(assetProxyUrl('logo')).toBeUndefined();
    expect(assetProxyUrl('avatar', '')).toBeUndefined();
  });
});

describe('getCachedAsset', () => {
  it('未缓存 / 无地址 → undefined', () => {
    expect(getCachedAsset('logo', LOGO)).toBeUndefined();
    expect(getCachedAsset('logo')).toBeUndefined();
  });

  it('URL 与缓存一致时同步返回 Data URL（首帧零网络请求）', () => {
    seedCache('logo', { url: LOGO, dataUrl: 'data:image/png;base64,AAAA', savedAt: 1 });
    expect(getCachedAsset('logo', LOGO)).toBe('data:image/png;base64,AAAA');
  });

  it('管理员改了地址 → 旧缓存立即失效（不得拿旧图当新图直出）', () => {
    seedCache('logo', { url: LOGO, dataUrl: 'data:image/png;base64,AAAA', savedAt: 1 });
    expect(getCachedAsset('logo', OTHER_LOGO)).toBeUndefined();
  });

  it('data: 地址直接透传，不查缓存', () => {
    seedCache('favicon', { url: DEFAULT_FAVICON_DATA_URL, dataUrl: 'stale', savedAt: 1 });
    expect(getCachedAsset('favicon', DEFAULT_FAVICON_DATA_URL)).toBe(DEFAULT_FAVICON_DATA_URL);
  });

  it('缓存记录脏值 / 截断 JSON → undefined 而非抛错', () => {
    seedCache('logo', '{not json');
    expect(() => getCachedAsset('logo', LOGO)).not.toThrow();
    expect(getCachedAsset('logo', LOGO)).toBeUndefined();

    seedCache('logo', { url: LOGO, savedAt: 1 });
    expect(getCachedAsset('logo', LOGO)).toBeUndefined();
  });
});

describe('cacheAsset', () => {
  it('经中转端点拉取成功后返回 Data URL，并以原配置地址为键落盘（可被同步读取）', async () => {
    const fetchStub = stubFetch(8);
    const dataUrl = await cacheAsset('logo', LOGO);

    expect(fetchStub).toHaveBeenCalledWith(assetProxyUrl('logo', LOGO));
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    // 落盘的是「管理员配置的地址」而非中转地址：否则换 kind 后互相串图
    expect(readCacheUrl('logo')).toBe(LOGO);
    expect(getCachedAsset('logo', LOGO)).toBe(dataUrl);
  });

  it('data: 地址与空地址不发起网络请求', async () => {
    const fetchStub = stubFetch(8);
    await cacheAsset('logo', DEFAULT_FAVICON_DATA_URL);
    expect(fetchStub).not.toHaveBeenCalled();
    await cacheAsset('logo');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('上游非 2xx → 返回 null 且不落盘（保留旧缓存供下次拉取时覆盖）', async () => {
    stubFetch(8, false);
    expect(await cacheAsset('logo', LOGO)).toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('超过 2MB 上限 → 拒收且不落盘（防止撑爆 localStorage）', async () => {
    stubFetch(2 * 1024 * 1024 + 1);
    expect(await cacheAsset('logo', LOGO)).toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('网络异常 → 返回 null 而不抛出（缓存永远不影响业务动作）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(cacheAsset('logo', LOGO)).resolves.toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('写入被拒（隐私模式 / 配额满）→ 仍返回可用 Data URL，只是不缓存', async () => {
    stubFetch(8);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const dataUrl = await cacheAsset('logo', LOGO);
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
