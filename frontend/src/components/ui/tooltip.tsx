// Tooltip 组件（hover 显示，独立组件）
// 气泡 Portal 到 document.body 并以 fixed 定位：脱离 overflow-hidden / 滚动容器 /
// transform 祖先的裁切。打开时按锚点矩形测量，做视口碰撞翻转 + 夹紧。
// 造型：完整圆角玻璃气泡（无楔形箭头）——CSS border 无法跟随 clip-path 轮廓，
// 楔形方案在模糊档下会出现边框断裂 / 圆角被啃 / 菱形叠加等瑕疵，弃用。
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';

/** 气泡与锚点的间距 */
const GAP = 10;
/** 视口边缘最小留白 */
const EDGE = 8;

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: Side;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    const closeOnKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', closeOnKey);
    return () => {
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      document.removeEventListener('keydown', closeOnKey);
    };
  }, [open]);

  // 气泡渲染后定位（首帧先以 visibility:hidden 落位以便测尺寸）：请求方向空间不足则翻到对侧，
  // 再夹紧进视口。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = wrapRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current?.getBoundingClientRect();
    if (!anchor || !bubble) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bubble.width;
    const bh = bubble.height;

    let s: Side = side;
    if (s === 'top' && anchor.top - GAP - bh < EDGE) s = 'bottom';
    else if (s === 'bottom' && anchor.bottom + GAP + bh > vh - EDGE) s = 'top';
    else if (s === 'left' && anchor.left - GAP - bw < EDGE) s = 'right';
    else if (s === 'right' && anchor.right + GAP + bw > vw - EDGE) s = 'left';

    const horizontal = s === 'top' || s === 'bottom';
    const left = horizontal
      ? anchor.left + anchor.width / 2 - bw / 2
      : s === 'left'
        ? anchor.left - GAP - bw
        : anchor.right + GAP;
    const top = horizontal
      ? s === 'top'
        ? anchor.top - GAP - bh
        : anchor.bottom + GAP
      : anchor.top + anchor.height / 2 - bh / 2;

    const clampLeft = Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - bw - EDGE));
    const clampTop = Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - bh - EDGE));

    setPos({ left: clampLeft, top: clampTop });
  }, [open, side]);

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            className={cn(
              'animate-fade-in pointer-events-none fixed z-[130] w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal break-words rounded-lg glass-surface-popover glass-blur border border-border/60 px-3 py-1.5 text-xs text-popover-foreground shadow-md',
              className
            )}
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  );
}
