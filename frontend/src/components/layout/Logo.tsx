// 品牌 Logo（支持站点自定义 Logo 图片与标题）
export function Logo({
  size = 32,
  siteLogo,
  siteTitle = 'Picumet',
}: {
  size?: number;
  siteLogo?: string;
  siteTitle?: string;
}) {
  if (siteLogo) {
    return (
      <div className="flex items-center gap-2 select-none" style={{ width: size + 90 }}>
        <img src={siteLogo} alt={siteTitle} style={{ width: size, height: size }} className="rounded object-contain" />
        <span className="text-lg font-bold tracking-tight">{siteTitle}</span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 select-none"
      style={{ width: size + 90 }}
    >
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
        <rect x="4" y="8" width="40" height="28" rx="6" fill="currentColor" className="text-primary" />
        <path d="M16 20 L24 30 L32 20" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 40 H34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-primary" />
      </svg>
      <span className="text-lg font-bold tracking-tight">Picumet</span>
    </div>
  );
}
