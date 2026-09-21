// Select 下拉选择器（shadcn 风格，替换原生 select）
// 菜单与 Dropdown 一样通过 Portal 渲染到 document.body 并复用统一菜单表面类：
// 脱离弹窗/面板等 backdrop-filter 祖先（嵌套会建立 backdrop root 使模糊失效），
// 任何场景（弹窗内、抽屉内、面板内）都与主页下拉菜单完全一致。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DROPDOWN_ITEM_CLASS, DROPDOWN_MENU_CLASS } from './dropdown';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // 展开时测量触发器位置与宽度（Portal 用 fixed 定位，菜单与触发器等宽对齐）
  useLayoutEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || portalRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-[color,box-shadow] outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
          open && 'border-ring ring-[3px] ring-ring/50'
        )}
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected?.label ?? placeholder ?? t('common.selectPlaceholder')}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={portalRef}
            className={cn(DROPDOWN_MENU_CLASS, 'mt-1')}
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            onClick={(e) => e.stopPropagation()}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={opt.disabled}
                onClick={() => {
                  onValueChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  DROPDOWN_ITEM_CLASS,
                  'justify-between',
                  'hover:bg-accent hover:text-accent-foreground',
                  'disabled:pointer-events-none disabled:opacity-50',
                  value === opt.value && 'bg-accent text-accent-foreground'
                )}
              >
                <span className="truncate">{opt.label}</span>
                {value === opt.value && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

// ============ 组合式 API（兼容 shadcn 命名） ============
const SelectContext = (() => null) as unknown as ReactNode;

export function SelectTrigger({ children, className, ...rest }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-[color,box-shadow] outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
        className
      )}
    >
      {children}
      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function SelectValue({ placeholder, children }: { placeholder?: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  return <span className={cn(!children && 'text-muted-foreground')}>{children ?? placeholder ?? t('common.select')}</span>;
}

export function SelectContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(DROPDOWN_MENU_CLASS, 'mt-1 min-w-[8rem]', className)}>{children}</div>
  );
}

export function SelectItem({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  void value;
  return (
    <button
      type="button"
      className={cn(DROPDOWN_ITEM_CLASS, 'hover:bg-accent hover:text-accent-foreground', className)}
    >
      {children}
    </button>
  );
}

export { SelectContext };
