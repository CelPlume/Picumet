// 下拉菜单（点击展开，支持分组与菜单项）
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './core';

export function Dropdown({
  trigger,
  children,
  align = 'start',
  triggerClass,
}: {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  triggerClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)} className={cn('cursor-pointer', triggerClass)}>
        {trigger}
      </div>
      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 min-w-[160px] rounded-md border bg-card p-1 shadow-lg',
            align === 'end' ? 'right-0' : 'left-0'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
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
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
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
  return <div className="my-1 h-px bg-border" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{children}</div>;
}

export { ChevronDown, Button };
