// 文件页卡片视图「每行卡片数」滑块（4–8，默认 6）：
// 与 BlurSlider 共用同一套视觉配方与 CSS 类（`.discrete-slider-*`：胶囊轨道 + 半透明渐入强调色填充 +
// 刻度点 + 白色圆形滑块 + 顶部标签与描述），仅把离散档位换成连续整数区间，故不含粒子迸发。
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const DEFAULT_MIN = 4;
const DEFAULT_MAX = 8;

/** 滑块直径 24px：轨道 36px 胶囊，圆心两端内缩 12px，标签/刻度点按圆心对齐 */
const KNOB = 24;

export function FilesPerRowSlider({
  value,
  onChange,
  className,
  min = DEFAULT_MIN,
  max = DEFAULT_MAX,
}: {
  value: number;
  onChange: (n: number) => void;
  className?: string;
  /** 离散区间（桌面 4–8 / 手机 2–5） */
  min?: number;
  max?: number;
}) {
  const { t } = useTranslation();
  const STEPS = max - min;
  const VALUES = Array.from({ length: STEPS + 1 }, (_, i) => min + i);
  const stopLeft = (index: number): string => `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${index / STEPS})`;
  const current = Math.min(max, Math.max(min, Math.round(value)));
  const index = current - min;

  return (
    <div className={cn('select-none', className)}>
      <div className="relative mb-2 h-5">
        {VALUES.map((v, i) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              'absolute top-0 -translate-x-1/2 cursor-pointer text-xs font-medium transition-colors duration-200',
              i === index ? 'text-primary' : 'text-muted-foreground/80 hover:text-foreground'
            )}
            style={{ left: stopLeft(i) }}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="discrete-slider-track relative h-9 rounded-full border border-border/70 bg-muted/60 shadow-inner">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
          <div
            className="discrete-slider-fill absolute left-0 top-1/2 h-6 -translate-y-1/2 rounded-full transition-[width] duration-200"
            style={{ width: stopLeft(index) }}
          />
          <div className="pointer-events-none absolute inset-y-0 left-[9px] right-[9px] flex items-center justify-between">
            {VALUES.map((v, i) => (
              <span
                key={v}
                className={cn(
                  'h-1.5 w-1.5 rounded-full transition-colors duration-200',
                  i <= index ? 'bg-white/70' : 'bg-muted-foreground/35'
                )}
              />
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className="discrete-slider-thumb pointer-events-none absolute top-1/2 h-6 w-6 rounded-full bg-white"
          style={{ left: stopLeft(index) }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={current}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={t('settings.filesPerRow')}
          aria-valuetext={`${current}`}
          className="discrete-slider absolute inset-0 h-full w-full cursor-pointer bg-transparent"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('settings.filesPerRowHint')}</p>
    </div>
  );
}
