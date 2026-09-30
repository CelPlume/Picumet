// 统一滑块：保留原生 range 的键盘/读屏语义，自绘 Breno Lasserre pill slider 的视觉层。
// 拇指交互（静止缩小半透明、hover/拖动/键盘聚焦弹至全尺寸不透明）复刻 ReactBits Customize 面板 scrubber。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { BlurLevel, MotionLevel } from '@/stores/theme';

const BLUR_LEVELS: BlurLevel[] = ['off', 'default', 'frosted'];
const MOTION_LEVELS: MotionLevel[] = ['off', 'default', 'all'];

const BLUR_LABEL_KEYS: Record<BlurLevel, string> = {
  off: 'common.blurOff',
  default: 'common.blurDefault',
  frosted: 'common.blurFrosted',
};

const BLUR_DESCRIPTION_KEYS: Record<BlurLevel, string> = {
  off: 'common.blurDescOff',
  default: 'common.blurDescDefault',
  frosted: 'common.blurDescFrosted',
};

const MOTION_LABEL_KEYS: Record<MotionLevel, string> = {
  off: 'common.motionOff',
  default: 'common.motionDefault',
  all: 'common.motionAll',
};

const MOTION_DESCRIPTION_KEYS: Record<MotionLevel, string> = {
  off: 'common.motionDescOff',
  default: 'common.motionDescDefault',
  all: 'common.motionDescAll',
};

type PillSliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  ariaLabel: string;
  ariaValueText?: string;
  className?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeStops(min: number, max: number, step: number): number[] {
  const count = Math.floor((max - min) / step);
  if (count < 1 || count > 12) return [];

  const stops = Array.from({ length: count + 1 }, (_, index) => min + index * step);
  if (stops[stops.length - 1] !== max) stops.push(max);
  return stops;
}

/* 超出回弹（复刻 ReactBits ElasticSlider）：拖出端点时按 sigmoid 衰减的阻尼跟随指针，
   松手后以 bounce 0.5 的欠阻尼弹簧振荡归零。MAX_OVERFLOW 与 decay 逐字取自其源码。 */
const MAX_OVERFLOW = 50;

function decay(value: number, max: number): number {
  if (max === 0) {
    return 0;
  }

  const entry = value / max;
  const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);

  return sigmoid * max;
}

/** 用解析解复刻 motion/react 的 spring bounce 0.5：framer 默认 stiffness 100 / damping 10
 *  即 ω₀=10、ζ=1-bounce=0.5，数值积分会自带额外阻尼（回弹被吃掉），故直接用欠阻尼振子闭式解。
 *  返回停止函数供中断/卸载清理。 */
function springToZero(from: number, apply: (value: number) => void, prefersReducedMotion: boolean): () => void {
  if (prefersReducedMotion || from === 0) {
    apply(0);
    return () => {};
  }

  const omega0 = 10;
  const zeta = 0.5;
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
  const start = performance.now();
  let raf = 0;

  const step = (now: number): void => {
    const t = (now - start) / 1000;
    const envelope = Math.exp(-zeta * omega0 * t);
    const x = from * envelope * (Math.cos(omegaD * t) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * t));
    if (t > 0.12 && Math.abs(x) < 0.1) {
      apply(0);
      return;
    }
    apply(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/** 填充外扩可用空间（px）：向上找到第一个左右都有富余的祖先（即卡片内容盒的 padding 边），
 *  取两侧富余的较小值并留 4px 不贴边 —— 上限由布局本身给出，填充因此永不越过卡片。 */
function availableOvershoot(track: HTMLElement | null): number {
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  for (let node = track.parentElement; node; node = node.parentElement) {
    const box = node.getBoundingClientRect();
    const room = Math.min(box.right - rect.right, rect.left - box.left, MAX_OVERFLOW);
    if (room >= 6) return room - 4;
  }
  return 0;
}

function PillSlider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  ariaLabel,
  ariaValueText,
  className,
}: PillSliderProps) {
  const current = clamp(value, min, max);
  const range = max - min || 1;
  const percent = ((current - min) / range) * 100;
  const display = format ? format(current) : String(current);
  const [pressed, setPressed] = useState(false);
  // 橡皮筋超出量（px，向外为正；弹簧回弹时穿零变负 = 向轨道内回缩）。
  const [overshoot, setOvershoot] = useState(0);
  // 手势侧：拖动方向固定不变，回弹穿零时不换边（否则回缩会从对侧穿出）。
  const [elasticSide, setElasticSide] = useState<1 | -1>(1);
  const [overshootMax, setOvershootMax] = useState(MAX_OVERFLOW);
  const overshootRef = useRef(0);
  const overshootMaxRef = useRef(MAX_OVERFLOW);
  const trackRef = useRef<HTMLDivElement>(null);
  const cancelSpringRef = useRef<() => void>(() => {});

  const stopOvershoot = useCallback((): void => {
    cancelSpringRef.current();
    setOvershoot(0);
    overshootRef.current = 0;
  }, []);

  const releaseOvershoot = useCallback((): void => {
    cancelSpringRef.current();
    const from = overshootRef.current;
    if (from === 0) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cancelSpringRef.current = springToZero(from, (next) => {
      overshootRef.current = next;
      setOvershoot(next);
    }, reduced);
  }, []);

  // 释放路径有两条：指针捕获目标（input）上的显式处理器一定先收到 pointerup；
  // window 监听只兜底「捕获没建立、指针在轨道外抬起」的情况。两者幂等（同在事件
  // 传播内、rAF 未跑，重复调用从同一数值重启弹簧，无视觉差异）。
  const handleRelease = useCallback((): void => {
    setPressed(false);
    releaseOvershoot();
  }, [releaseOvershoot]);

  // Pointer capture keeps the pressed visual until the drag really ends, including when
  // the pointer leaves the input while the user is moving toward an endpoint.
  useEffect(() => {
    if (!pressed) return;
    window.addEventListener('pointerup', handleRelease);
    window.addEventListener('pointercancel', handleRelease);
    return () => {
      window.removeEventListener('pointerup', handleRelease);
      window.removeEventListener('pointercancel', handleRelease);
    };
  }, [pressed, handleRelease]);

  // 卸载时停掉在跑的弹簧：必须读 ref 当前值，直接返回 ref.current 会把挂载时的初始空函数当清理器。
  useEffect(() => () => cancelSpringRef.current(), []);

  const handleScrubMove = useCallback((event: ReactPointerEvent<HTMLInputElement>): void => {
    if (!pressed) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const raw = (event.clientX - rect.left) / rect.width;
    const side = raw < 0 ? -1 : raw > 1 ? 1 : 0;
    const distance = side < 0 ? rect.left - event.clientX : side > 0 ? event.clientX - rect.right : 0;
    cancelSpringRef.current();
    if (side !== 0) setElasticSide(side);
    const next = side === 0 ? 0 : decay(distance, overshootMaxRef.current);
    overshootRef.current = next;
    setOvershoot(next);
  }, [pressed]);

  const stops = makeStops(min, max, step);

  // 橡皮筋形变（复刻 ReactBits ElasticSlider，仅动画档位「最大」启用）：整条滑动条
  // （背景 + 边框 + 填充）与拇指一起被拉出端点 —— 拇指沿拖动方向外移，背景条在拖动侧
  // 向外拉长并轻微压薄，未拖动的一端不动；回弹穿零时同侧回缩，绝不从对侧穿出。
  // 轨道不裁剪，外扩上限由布局量出（见 availableOvershoot）。
  const stretch = Math.abs(overshoot);
  // 上限为 0（非最大动画档）时按住比例写 0，避免 0/0 让 scaleY 变成 NaN。
  const stretchRatio = overshootMax > 0 ? Math.min(stretch / overshootMax, 1) : 0;
  const barSy = 1 - 0.06 * stretchRatio;
  // 拇指与背景条外缘同步：正值向拖动方向外移，回弹穿零后向轨道内回缩。
  const thumbShift = elasticSide < 0 ? -overshoot : overshoot;

  return (
    <div
      ref={trackRef}
      className={cn('pill-slider-track relative h-11 select-none rounded-lg', className)}
      data-pressed={pressed || undefined}
      // 拖动与弹簧回弹全程都置位：拇指的位移缓动在这期间必须关掉，否则逐帧弹簧值被
      // 180ms 追帧拖慢，回弹看起来比背景条晚一拍。
      data-elastic={overshoot !== 0 || undefined}
      data-value={current}
    >
      <div
        aria-hidden
        className="pill-slider-bar absolute inset-y-0 left-0 rounded-lg border shadow-inner"
        style={{
          left: elasticSide < 0 ? `${-overshoot}px` : '0px',
          width: `calc(100% ${overshoot < 0 ? '-' : '+'} ${stretch}px)`,
          transform: `scaleY(${barSy.toFixed(3)})`,
        }}
      >
        <div
          aria-hidden
          className="pill-slider-fill absolute inset-y-0 left-0 rounded-[inherit]"
          style={{ width: `${percent}%` }}
        />
      </div>

      {stops.map((stop) => (
        <span
          key={stop}
          aria-hidden
          className="pill-slider-tick pointer-events-none absolute top-1/2 h-2.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `clamp(1.5px, ${((stop - min) / range) * 100}%, calc(100% - 1.5px))` }}
        />
      ))}

      <span className="pointer-events-none absolute inset-y-0 left-5 z-10 flex items-center whitespace-nowrap text-sm font-medium text-muted-foreground">
        {label}
      </span>
      <span className="pointer-events-none absolute inset-y-0 right-4 z-10 flex items-center whitespace-nowrap text-sm font-medium tabular-nums text-foreground">
        {display}
      </span>

      <span
        aria-hidden
        className="pill-slider-thumb pointer-events-none absolute top-1/2 z-10 h-[26px] w-[5px] rounded-full"
        style={{
          left: `calc(clamp(2.5px, ${percent}%, calc(100% - 2.5px)) ${thumbShift < 0 ? '-' : '+'} ${Math.abs(thumbShift)}px)`,
        }}
      />

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={(event) => {
          stopOvershoot();
          // 超出回弹属于装饰性动效：只有动画档位「最大」（<html data-motion="all">）才启用；
          // 默认/关闭档上限为 0，decay 恒为 0，橡皮筋自然消失，只留拖动柄的 hover/拖动反馈。
          const room = document.documentElement.dataset.motion === 'all' ? availableOvershoot(trackRef.current) : 0;
          overshootMaxRef.current = room;
          setOvershootMax(room);
          setPressed(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={handleScrubMove}
        onPointerUp={handleRelease}
        onPointerCancel={handleRelease}
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText ?? display}
        className="pill-slider absolute inset-0 z-20 h-full w-full cursor-ew-resize bg-transparent"
      />
    </div>
  );
}

/** 离散档位滑块（外观设置-模糊强度）：三档，标签与读屏值内嵌，下方跟随当前档描述。 */
export function BlurSlider({
  value,
  onChange,
  className,
}: {
  value: BlurLevel;
  onChange: (level: BlurLevel) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const index = Math.max(BLUR_LEVELS.indexOf(value), 0);
  const level = BLUR_LEVELS[index];

  return (
    <div className={cn('select-none', className)}>
      <PillSlider
        label={t('common.blurStrength')}
        value={index}
        min={0}
        max={BLUR_LEVELS.length - 1}
        onChange={(next) => onChange(BLUR_LEVELS[clamp(Math.round(next), 0, BLUR_LEVELS.length - 1)])}
        format={(next) => t(BLUR_LABEL_KEYS[BLUR_LEVELS[clamp(Math.round(next), 0, BLUR_LEVELS.length - 1)]])}
        ariaLabel={t('common.blurStrength')}
        ariaValueText={t(BLUR_LABEL_KEYS[level])}
      />
      <p className="mt-2 text-xs text-muted-foreground">{t(BLUR_DESCRIPTION_KEYS[level])}</p>
    </div>
  );
}

/** 离散档位滑块（外观设置-动画效果）：三档，语义见 stores/theme.ts 的 MotionLevel。 */
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
  const index = Math.max(MOTION_LEVELS.indexOf(value), 0);
  const level = MOTION_LEVELS[index];

  return (
    <div className={cn('select-none', className)}>
      <PillSlider
        label={t('common.motionLevel')}
        value={index}
        min={0}
        max={MOTION_LEVELS.length - 1}
        onChange={(next) => onChange(MOTION_LEVELS[clamp(Math.round(next), 0, MOTION_LEVELS.length - 1)])}
        format={(next) => t(MOTION_LABEL_KEYS[MOTION_LEVELS[clamp(Math.round(next), 0, MOTION_LEVELS.length - 1)]])}
        ariaLabel={t('common.motionLevel')}
        ariaValueText={t(MOTION_LABEL_KEYS[level])}
      />
      <p className="mt-2 text-xs text-muted-foreground">{t(MOTION_DESCRIPTION_KEYS[level])}</p>
    </div>
  );
}

const FILES_PER_ROW_DEFAULT_MIN = 4;
const FILES_PER_ROW_DEFAULT_MAX = 8;

/** 文件页卡片视图「每行卡片数」滑块：桌面 4–8 / 手机 2–4。 */
export function FilesPerRowSlider({
  value,
  onChange,
  label,
  className,
  min = FILES_PER_ROW_DEFAULT_MIN,
  max = FILES_PER_ROW_DEFAULT_MAX,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  className?: string;
  min?: number;
  max?: number;
}) {
  const { t } = useTranslation();
  const current = clamp(Math.round(value), min, max);

  return (
    <div className={cn('select-none', className)}>
      <PillSlider
        label={label}
        value={current}
        min={min}
        max={max}
        onChange={(next) => onChange(Math.round(next))}
        ariaLabel={t('settings.filesPerRow')}
        ariaValueText={String(current)}
      />
      <p className="mt-2 text-xs text-muted-foreground">{t('settings.filesPerRowHint')}</p>
    </div>
  );
}
