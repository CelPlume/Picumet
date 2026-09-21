// 复选框组件（shadcn 风格）
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Checkbox({
  checked,
  onChange,
  indeterminate = false,
  disabled = false,
  className,
  label,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-sm transition-[color,box-shadow]',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked || indeterminate
          ? 'border-primary bg-primary text-primary-foreground'
          : 'glass-control bg-card/[var(--glass-alpha,0.72)] hover:bg-foreground/10',
        className
      )}
      id={id}
    >
      {indeterminate ? (
        <Minus className="h-3 w-3" />
      ) : checked ? (
        <Check className="h-3 w-3" strokeWidth={3} />
      ) : null}
    </button>
  );
}

export function CheckboxWithLabel({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={label} />
      <div className="grid gap-0.5 leading-none">
        <span
          className={cn(
            'cursor-pointer select-none text-sm font-medium',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          onClick={() => !disabled && onChange(!checked)}
        >
          {label}
        </span>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
