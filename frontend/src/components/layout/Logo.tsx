// 品牌 Logo（支持站点自定义 Logo 图片与标题；左上角标题独立于标签页标题，
// 未设置时跟随站点标题，显式清空则只显示 Logo 不出文字）
// Logo 图高度固定（size）、宽度随图片自身比例自适应：宽长 logo 不被压成小方块，标题紧随其后。
// 图片地址由 stores/site.ts 统一中转（外部图床经 /api/public/site-asset 带长缓存头），此处直接消费。
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
  if (siteLogo) {
    return (
      <div className="flex select-none items-center gap-2">
        <img src={siteLogo} alt={headerTitle || siteTitle} style={{ height: size, width: 'auto' }} className="rounded object-contain" />
        {headerTitle && <span className="text-lg font-bold tracking-tight">{headerTitle}</span>}
      </div>
    );
  }
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
