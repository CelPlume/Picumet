// Tooltip 组件（hover 显示，独立组件）
// 气泡 Portal 到 document.body 并以 fixed 定位：脱离 overflow-hidden / 滚动容器 /
// transform 祖先的裁切。打开时按锚点矩形测量，做视口碰撞翻转 + 夹紧，箭头跟随锚点中心。
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';

/** 气泡与锚点的间距（对应原 mt-1.5 / mb-1.5 等 6px） */
const GAP = 6;
/** 视口边缘最小留白 */
const EDGE = 8;
/** 箭头偏移的夹紧边界：保证箭头不越过气泡圆角 */
const ARROW_INSET = 12;

/** 箭头定位类：top/bottom 用内联 left 定水平偏移，left/right 用内联 top 定垂直偏移；
    另一轴保持居中，并让箭头骑在气泡对应边缘上（half in / half out，与原实现一致） */
const ARROW_SIDE_CLASS: Record<Side, string> = {
  top: 'left-0 top-full -translate-x-1/2 -translate-y-1',
  bottom: 'left-0 top-0 -translate-x-1/2 -translate-y-1',
  left: 'left-full top-0 -translate-x-1 -translate-y-1/2',
  right: 'left-0 top-0 -translate-x-1 -translate-y-1/2',
};

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
  const [pos, setPos] = useState<{ left: number; top: number; side: Side; arrow: number } | null>(null);

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
  // 再夹紧进视口；箭头偏移 = 锚点中心 - 夹紧后的气泡边，夹紧在 [12, 尺寸-12] 内。
  // 关闭时气泡卸载，滚动/缩放沿用原有「直接关闭」策略，因此无需持续重定位。
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
    const arrow = horizontal
      ? Math.min(
          Math.max(anchor.left + anchor.width / 2 - clampLeft, ARROW_INSET),
          Math.max(ARROW_INSET, bw - ARROW_INSET)
        )
      : Math.min(
          Math.max(anchor.top + anchor.height / 2 - clampTop, ARROW_INSET),
          Math.max(ARROW_INSET, bh - ARROW_INSET)
        );

    setPos({ left: clampLeft, top: clampTop, side: s, arrow });
  }, [open, side]);

  const arrowSide = pos?.side ?? side;
  const arrowOffset = pos
    ? arrowSide === 'top' || arrowSide === 'bottom'
      ? { left: pos.arrow }
      : { top: pos.arrow }
    : undefined;

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
              'animate-fade-in pointer-events-none fixed z-50 w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal break-words rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-sm',
              className
            )}
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
          >
            {content}
            <span
              aria-hidden
              className={cn('absolute h-2 w-2 rotate-45 rounded-[2px] bg-foreground', ARROW_SIDE_CLASS[arrowSide])}
              style={arrowOffset}
            />
          </span>,
          document.body
        )}
    </span>
  );
}
