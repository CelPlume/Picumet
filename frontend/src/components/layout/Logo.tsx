// 品牌 Logo（支持站点自定义 Logo 图片与标题；左上角标题独立于标签页标题，
// 未设置时跟随站点标题，显式清空则只显示 Logo 不出文字）
// Logo 图高度固定（默认 size=32）、宽度随图片自身比例自适应：宽长 logo 不被压成小方块，标题紧随其后。
// 客户端持久化缓存（lib/image-cache.ts）：成功拉取一次后存入 localStorage（Data URL），
// 除非配置的 URL 改变，后续页面刷新首帧直接消费缓存渲染，避免重复发起网络下载。
// 加载失败或未配置时回落默认 Picumet 矢量图标（左上角 Logo 去掉文字）。
import { useEffect, useState } from 'react';
import { getCachedAsset, cacheAsset } from '@/lib/image-cache';

export function Logo({
  size = 32,
  siteLogo,
  siteTitle = 'Picumet',
  siteHeaderTitle,
}: {
  size?: number;
  siteLogo?: string;
  siteTitle?: string;
  siteHeaderTitle?: string;
}) {
  const headerTitle = siteHeaderTitle !== undefined ? siteHeaderTitle : siteTitle;
  const [imgError, setImgError] = useState(false);
  // 首帧优先消费已缓存的 Data URL：URL 未变则直接同步渲染，不发网络请求
  const [src, setSrc] = useState(() => getCachedAsset('logo', siteLogo) || siteLogo);

  useEffect(() => {
    setImgError(false);
    if (!siteLogo) {
      setSrc(undefined);
      return;
    }
    const cached = getCachedAsset('logo', siteLogo);
    if (cached) {
      setSrc(cached);
    } else {
      setSrc(siteLogo);
      void cacheAsset('logo', siteLogo).then((dataUrl) => {
        if (dataUrl) setSrc(dataUrl);
      });
    }
  }, [siteLogo]);

  // 自定义 Logo（已缓存或正在加载），加载失败自动切换到默认 SVG 图标
  if (src && !imgError) {
    return (
      <div className="flex select-none items-center gap-2">
        <img
          src={src}
          alt={headerTitle || siteTitle}
          style={{ height: size, width: 'auto' }}
          className="rounded object-contain"
          onError={() => {
            if (src !== siteLogo && siteLogo) {
              setSrc(siteLogo);
            } else {
              setImgError(true);
            }
          }}
        />
        {headerTitle && <span className="text-lg font-bold tracking-tight">{headerTitle}</span>}
      </div>
    );
  }

  // Picumet 默认矢量图标（左上角 Logo 去掉文字）
  return (
    <div className="flex select-none items-center gap-2">
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
        <rect x="4" y="8" width="40" height="28" rx="6" fill="currentColor" className="text-primary" />
        <path d="M16 20 L24 30 L32 20" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 40 H34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-primary" />
      </svg>
      {headerTitle && <span className="text-lg font-bold tracking-tight">{headerTitle}</span>}
    </div>
  );
}
