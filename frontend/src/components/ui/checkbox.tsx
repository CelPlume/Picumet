// 复选框：基准对齐 shadcn——size-4 / rounded-[4px] / 边框与底色 transition-colors /
// focus-visible ring-3 / after 伪元素把命中区放大到 40×32 / 指示器自身无动画（transition-none）。
// 「全部动画」档的勾选动效纯 CSS 驱动（组件零档位分支）：进度量 --cb-t（0 = 未勾选 → 1 = 勾选，
// 带弹簧过冲）经 @property 注册后可直接参与过渡，由它推导四路读数：填充涨出（可过冲过 1）、
// 盒体随过冲微涨、对勾描边绘出、文字明暗。
//   文字明暗按「开关」语义反向：**未勾选变淡、勾选恢复正常**，两个方向都不画删除线。
import { cn } from '@/lib/utils';

/** 对勾与半选短横的描边路径：pathLength=1 归一化，stroke-dashoffset 1→0 即「画出」 */
const CHECK_PATH = 'M20 6 9 17l-5-5';
const MINUS_PATH = 'M6 12h12';

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
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      data-slot="checkbox"
      data-checked={indeterminate ? 'mixed' : checked ? 'true' : 'false'}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        // shadcn 基准：尺寸 / 圆角 / 边框 / 颜色过渡 / 焦点环 / 命中区扩展
        // （颜色与 --cb-t 过渡统一在 index.css `.cb` 段声明：不写 Tailwind transition-*
        //   类，否则 utilities 层同优先级规则会覆盖掉 --cb-t 的过渡）
        'cb relative flex size-4 shrink-0 items-center justify-center rounded-[4px] outline-none',
        // 命中区扩展（shadcn 同款）：after 伪元素四周外扩
        'after:absolute after:-inset-x-3 after:-inset-y-2',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // 选中态：纯色无外层白边轮廓（边框与底色同为 primary 一体化，消除内衬缝隙）；未选态为标准 1px input 边框 + 玻璃
        on
          ? 'border border-primary bg-primary text-primary-foreground'
          : 'border border-input glass-control bg-card/[var(--glass-alpha,0.72)] hover:bg-foreground/10',
        className
      )}
      id={id}
    >
      <span className="cb-box">
        <svg aria-hidden className="cb-tick" viewBox="0 0 24 24">
          <path
            d={indeterminate ? MINUS_PATH : CHECK_PATH}
            pathLength={1}
            className="cb-tick-path"
          />
        </svg>
      </span>
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
  const toggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    // data-checked 落在包裹层：--cb-t 继承给复选框与文字，两者同源同步
    <div
      data-checked={checked ? 'true' : 'false'}
      className={cn('cb-group flex items-start gap-2', className)}
    >
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={label} />
      <div className="grid gap-0.5 leading-none">
        <span
          className={cn(
            'cb-group-word cursor-pointer select-none text-sm font-medium',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          onClick={toggle}
        >
          {label}
        </span>
        {description && (
          <p
            className="cursor-pointer text-xs text-muted-foreground"
            onClick={toggle}
          >
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
