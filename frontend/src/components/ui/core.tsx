// 基础 UI 原语（Tailwind 风格，shadcn 美学）
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { Loader2, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============ Button ============
type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const btnVariants: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'glass-control bg-secondary/[var(--glass-alpha,0.72)] text-secondary-foreground hover:bg-secondary/80',
  outline: 'glass-control border border-input bg-card/[var(--glass-alpha,0.72)] hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline',
};

const btnSizes: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-10 px-6 text-base',
  icon: 'h-9 w-9',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', loading, icon, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(
        'button-press inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        btnVariants[variant],
        btnSizes[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ============ Input ============
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** 项目级统一搜索框玻璃处理（文件页与管理后台共用，避免各自写 bg 造成不统一）：
    透明度随 --glass-alpha 三档门控（与大表面同值），
    tw-merge 会覆盖 Input 基类的 bg-transparent 与 dark:bg-input/30 */
export const SEARCH_INPUT_GLASS =
  'glass-control bg-card/[var(--glass-alpha,0.72)] dark:bg-card/[var(--glass-alpha,0.72)]';

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground',
        'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className
      )}
      {...props}
    />
  );
});

// ============ Textarea ============
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
});

// ============ Label ============
export function Label({ className, children, htmlFor }: { className?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-sm font-medium leading-none text-foreground', className)}>
      {children}
    </label>
  );
}

// ============ Card ============
export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cn('glass-surface glass-blur flex flex-col gap-4 rounded-xl border py-5 text-card-foreground shadow-sm', className)}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1.5 px-5', className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={cn('text-base font-semibold leading-none', className)}>{children}</h3>;
}

export function CardDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>;
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div data-slot="card-content" className={cn('px-5', className)}>{children}</div>;
}

// ============ Badge ============
type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
export function Badge({ className, variant = 'default', children }: { className?: string; variant?: BadgeVariant; children: ReactNode }) {
  const variants: Record<BadgeVariant, string> = {
    default: 'bg-primary text-primary-foreground',
    secondary: 'bg-secondary text-secondary-foreground',
    destructive: 'bg-destructive text-white',
    outline: 'border-border text-foreground',
    success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  };
  return (
    <span className={cn('inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow]', variants[variant], className)}>
      {children}
    </span>
  );
}

// ============ Spinner ============
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-muted-foreground', className)} />;
}

export function FullPageSpinner() {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

// ============ Skeleton ============
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

// ============ Progress ============
export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

// ============ Switch ============
export function Switch({
  checked,
  onChange,
  disabled,
  loading,
  size = 'default',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'default' | 'lg';
}) {
  const sizes = {
    sm: { container: 'h-3.5 w-6', thumb: 'size-3', translate: 'translate-x-[calc(100%-2px)]' },
    default: { container: 'h-[1.15rem] w-8', thumb: 'size-4', translate: 'translate-x-[calc(100%-2px)]' },
    lg: { container: 'h-6 w-11', thumb: 'size-5', translate: 'translate-x-[calc(100%-2px)]' },
  };
  const s = sizes[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border border-transparent shadow-sm transition-all outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        s.container,
        checked
          ? 'glass-control bg-primary/[var(--glass-alpha,0.72)]'
          : 'glass-control bg-input/[var(--glass-alpha,0.72)] dark:bg-input/[var(--glass-alpha,0.72)]'
      )}
    >
      <span
        className={cn(
          'pointer-events-none block rounded-full bg-background ring-0 transition-transform',
          s.thumb,
          checked ? s.translate : 'translate-x-0.5'
        )}
      >
        {loading && (
          <span className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
          </span>
        )}
      </span>
    </button>
  );
}

// ============ EmptyState ============
export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  /** 紧凑档：统计卡/列表内嵌的小尺寸空态 */
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 text-center', compact ? 'py-6' : 'py-16')}>
      <div className={cn('flex items-center justify-center rounded-full bg-muted text-muted-foreground', compact ? 'h-9 w-9' : 'h-14 w-14')}>
        {icon ?? <Inbox className={compact ? 'h-4 w-4' : 'h-7 w-7'} />}
      </div>
      <h3 className={cn('mt-2 font-medium', compact ? 'text-xs' : 'text-sm')}>{title}</h3>
      {description && <p className={cn('max-w-sm text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ============ Divider ============
export function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-border', className)} />;
}

export { Dialog, ConfirmDialog } from './dialog';
