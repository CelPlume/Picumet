// RadioGroup（shadcn 风格：选项行 = radio 圆点 + 标签，选中高亮）
import type React from 'react';
import { cn } from '@/lib/utils';

export interface RadioGroupOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}

export function RadioGroup({
  value,
  onChange,
  options,
  className,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  options: RadioGroupOption[];
  className?: string;
  /** 入场动画延迟（--reveal-delay）等内联样式 */
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn('grid gap-2', className)} style={style} role="radiogroup">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
              active
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-foreground/5'
            )}
          >
            <span
              className={cn(
                'flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border shadow-sm transition-colors',
                active ? 'border-primary text-primary' : 'border-input'
              )}
            >
              {active && <span className="block size-2 rounded-full bg-primary" />}
            </span>
            <span className="min-w-0">
              <span className={cn('block font-medium', active ? 'text-primary' : 'text-foreground')}>{opt.label}</span>
              {opt.description && <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
