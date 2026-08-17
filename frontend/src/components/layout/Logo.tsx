// 品牌 Logo
export function Logo({ size = 32 }: { size?: number }) {
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
