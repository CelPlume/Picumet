// 单选组件（shadcn 风格）
import { cn } from '@/lib/utils';

export function Radio({
  checked,
  onChange,
  disabled,
  className,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-primary transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
    >
      {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
    </button>
  );
}

export function RadioGroup({
  value,
  onValueChange,
  options,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; description?: string }[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {options.map((opt) => (
        <div key={opt.value} className="flex items-start gap-2">
          <Radio checked={value === opt.value} onChange={() => onValueChange(opt.value)} label={opt.label} />
          <div className="grid gap-0.5 leading-none">
            <span className="cursor-pointer select-none text-sm font-medium" onClick={() => onValueChange(opt.value)}>
              {opt.label}
            </span>
            {opt.description && <p className="text-xs text-muted-foreground">{opt.description}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
