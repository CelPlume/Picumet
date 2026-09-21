// 下拉菜单（点击展开，支持分组与菜单项）
// 内容通过 Portal 渲染到 document.body：脱离 header/弹窗等带 backdrop-filter 的祖先
// （嵌套 backdrop-filter 会建立 backdrop root，使子元素模糊失效），确保模糊统一生效。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './core';

/** 统一弹出菜单表面类：Dropdown/Select/一切弹出菜单必须复用（Portal 到 body），
    保证任何场景下玻璃质感、圆角、层级完全一致 */
export const DROPDOWN_MENU_CLASS =
  'glass-surface-popover glass-blur animate-dropdown fixed z-[100] max-h-[calc(100vh-4rem)] overflow-y-auto rounded-md border p-1 text-popover-foreground shadow-md';

/** 统一菜单项基础类：与 DROPDOWN_MENU_CLASS 配套复用 */
export const DROPDOWN_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors';

export function Dropdown({
  trigger,
  children,
  align = 'start',
  triggerClass,
  contentClass,
}: {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  triggerClass?: string;
  contentClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; right?: number } | null>(null);
  /** 触发器矩形缓存：内容测厚后用于翻转/夹紧（视口边缘自动判向） */
  const trigRef = useRef<{ top: number; bottom: number; left: number; right: number } | null>(null);

  // 展开时测量触发器位置（Portal 用 fixed 定位）
  useLayoutEffect(() => {
    if (!open) return;
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) {
      trigRef.current = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      // start：菜单左缘对齐触发器左缘；end：菜单右缘对齐触发器右缘
      setPos(
        align === 'end'
          ? { left: r.right - 240, top: r.bottom + 4, right: window.innerWidth - r.right }
          : { left: r.left, top: r.bottom + 4 }
      );
    }
  }, [open, align]);

  // 菜单渲染后实测尺寸：底部放不下且上方有空间 → 翻到触发器上方；否则夹在视口内。水平同样夹紧防截断
  useLayoutEffect(() => {
    if (!open || !pos || !portalRef.current) return;
    const trig = trigRef.current;
    if (!trig) return;
    const m = portalRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === 'end' ? trig.right - m.width : (pos.left ?? 0);
    let top = pos.top ?? 0;
    if (top + m.height > vh - 8 && trig.top - m.height - 12 > 0) top = Math.max(8, trig.top - m.height - 6);
    else if (top + m.height > vh - 8) top = Math.max(8, vh - m.height - 8);
    left = Math.max(8, Math.min(left, vw - m.width - 8));
    if (Math.abs((pos.left ?? 0) - left) > 1 || Math.abs((pos.top ?? 0) - top) > 1) setPos({ left, top });
  }, [open, pos, align]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || portalRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)} className={cn('cursor-pointer', triggerClass)}>
        {trigger}
      </div>
      {open &&
        pos &&
        createPortal(
          <div
            ref={portalRef}
            className={cn(DROPDOWN_MENU_CLASS, 'mt-1 min-w-[8rem]', contentClass)}
            style={{ left: pos.left, top: pos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body
        )}
    </div>
  );
}

export function DropdownItem({
  onClick,
  children,
  danger,
  icon,
  disabled,
}: {
  onClick?: () => void;
  children: ReactNode;
  danger?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        DROPDOWN_ITEM_CLASS,
        danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-accent hover:text-accent-foreground',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function DropdownSeparator() {
  return <div className="-mx-1 my-1 h-px bg-muted" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-sm font-medium text-muted-foreground">{children}</div>;
}

export { ChevronDown, Button };
