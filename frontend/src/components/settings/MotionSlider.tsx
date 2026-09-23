// 离散档位滑块（外观设置-动画效果）：与 BlurSlider 同一套滑杆配方（原生 range 透明化承担
// 拖拽与键盘交互；胶囊轨道 + 渐变填充 + 白色圆形滑块），但不带粒子迸发——动画关闭档下
// 粒子本身就是被禁掉的那类装饰。三档语义见 stores/theme.ts 的 MotionLevel：
// off 全部没有动画 / default 仅保留图表、tab 等必要动画 / all 页面切换等入场效果全开
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { MotionLevel } from '@/stores/theme';

const LEVELS: MotionLevel[] = ['off', 'default', 'all'];

const LABEL_KEYS: Record<MotionLevel, string> = {
  off: 'common.motionOff',
  default: 'common.motionDefault',
  all: 'common.motionAll',
};

const DESCRIPTION_KEYS: Record<MotionLevel, string> = {
  off: 'common.motionDescOff',
  default: 'common.motionDescDefault',
  all: 'common.motionDescAll',
};

/** 滑块直径 24px：轨道 36px 胶囊，圆心两端内缩 12px，刻度点/标签严格对齐圆心（同 BlurSlider） */
const KNOB = 24;

function stopLeft(index: number): string {
  return `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${index / (LEVELS.length - 1)})`;
}

export function MotionSlider({
  value,
  onChange,
  className,
}: {
  value: MotionLevel;
  onChange: (level: MotionLevel) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const idx = Math.max(LEVELS.indexOf(value), 0);

  return (
    <div className={cn('select-none', className)}>
      <div className="relative mb-2 h-5">
        {LEVELS.map((level, i) => (
          <button
            key={level}
            type="button"
            onClick={() => onChange(level)}
            className={cn(
              'absolute top-0 -translate-x-1/2 cursor-pointer whitespace-nowrap text-xs font-medium transition-colors duration-200',
              i === idx ? 'text-primary' : 'text-muted-foreground/80 hover:text-foreground'
            )}
            style={{ left: stopLeft(i) }}
          >
            {t(LABEL_KEYS[level])}
          </button>
        ))}
      </div>
      <div className="discrete-slider-track relative h-9 rounded-full border border-border/70 bg-muted/60 shadow-inner">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
          <div
            className="discrete-slider-fill absolute left-0 top-1/2 h-6 -translate-y-1/2 rounded-full transition-[width] duration-200"
            style={{ width: stopLeft(idx) }}
          />
          <div className="pointer-events-none absolute inset-y-0 left-[9px] right-[9px] flex items-center justify-between">
            {LEVELS.map((level, i) => (
              <span
                key={level}
                className={cn(
                  'h-1.5 w-1.5 rounded-full transition-colors duration-200',
                  i <= idx ? 'bg-white/70' : 'bg-muted-foreground/35'
                )}
              />
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className="discrete-slider-thumb pointer-events-none absolute top-1/2 h-6 w-6 rounded-full bg-white"
          style={{ left: stopLeft(idx) }}
        />
        <input
          type="range"
          min={0}
          max={LEVELS.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(LEVELS[Number(e.target.value)])}
          aria-label={t('common.motionLevel')}
          aria-valuetext={t(LABEL_KEYS[LEVELS[idx]])}
          className="discrete-slider absolute inset-0 h-full w-full cursor-pointer bg-transparent"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t(DESCRIPTION_KEYS[LEVELS[idx]])}</p>
    </div>
  );
}
