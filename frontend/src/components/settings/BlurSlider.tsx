// 离散档位滑块（外观设置-模糊强度）：参考 dsh-effort-slider / dsh-reasoning-slider ——
// 原生 range 透明化（appearance:none）承担拖拽与键盘交互；胶囊轨道 + 半透明到强调色的
// 渐变填充 + 白色圆形滑块（hover 放大）+ 切到最高档那一刻的单次粒子迸发
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { BlurLevel } from '@/stores/theme';

const LEVELS: BlurLevel[] = ['off', 'default', 'frosted'];

const LABEL_KEYS: Record<BlurLevel, string> = {
  off: 'common.blurOff',
  default: 'common.blurDefault',
  frosted: 'common.blurFrosted',
};

const DESCRIPTION_KEYS: Record<BlurLevel, string> = {
  off: 'common.blurDescOff',
  default: 'common.blurDescDefault',
  frosted: 'common.blurDescFrosted',
};

/** 滑块直径 24px：轨道 36px 胶囊，圆心两端内缩 12px，刻度点/标签严格对齐圆心 */
const KNOB = 24;

function stopLeft(index: number): string {
  return `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${index / (LEVELS.length - 1)})`;
}

/** 填充条最右侧与滑块圆心对齐（圆心 = 12px + (100% - 24px) × 档位比），高度固定不变 */
function fillWidth(index: number): string {
  return stopLeft(index);
}

/** 粒子：位置/速度/寿命/大小/RGB 颜色 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

const PARTICLE_COLORS = ['96,165,250', '139,92,246', '168,85,247', '255,255,255'];

/** 单次粒子迸发：burstSignal 递增触发一刻喷洒一圈粒子，自然衰减后停帧 */
function useBurstParticles(canvasRef: React.RefObject<HTMLCanvasElement | null>, burstSignal: number, originRef: { current: () => { x: number; y: number } }): void {
  useEffect(() => {
    if (!burstSignal) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const { x, y } = originRef.current();
    const particles: Particle[] = [];
    for (let i = 0; i < 26; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 2;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.6,
        life: 0,
        maxLife: 45 + Math.random() * 40,
        size: 1.5 + Math.random() * 2,
        color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      });
    }
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life++;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.04;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }
        const alpha = 1 - p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color},${(alpha * 0.8).toFixed(3)})`;
        ctx.fill();
      }
      if (particles.length > 0) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [burstSignal, canvasRef, originRef]);
}

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
  const idx = Math.max(LEVELS.indexOf(value), 0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<() => { x: number; y: number }>(() => ({ x: 0, y: 0 }));
  // 滑块圆心的画布坐标：轨道右端内缩 20px，叠加画布相对轨道的负偏移
  originRef.current = () => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) return { x: 0, y: 0 };
    const cr = canvas.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    return { x: tr.width - KNOB / 2 - (cr.left - tr.left), y: tr.height / 2 - (cr.top - tr.top) };
  };
  // 切到最高档的那一刻触发一次粒子迸发；初始就处于最高档不触发
  const [burstCount, setBurstCount] = useState(0);
  const prevIdxRef = useRef(idx);
  useEffect(() => {
    if (idx === LEVELS.length - 1 && prevIdxRef.current !== idx) setBurstCount((c) => c + 1);
    prevIdxRef.current = idx;
  }, [idx]);
  useBurstParticles(canvasRef, burstCount, originRef);

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
      <div ref={trackRef} className="discrete-slider-track relative h-9 rounded-full border border-border/70 bg-muted/60 shadow-inner">
        {/* 填充条（胶囊裁剪）：高度与滑块一致并垂直居中（与滑块同心），半透明渐入强调色 */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
          <div
            className="discrete-slider-fill absolute left-0 top-1/2 h-6 -translate-y-1/2 rounded-full transition-[width] duration-200"
            style={{ width: fillWidth(idx) }}
          />
          {/* 刻度点：已过档位浅色（压在主色填充上），未到档位灰色 */}
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
        {/* 滑块：白色圆形；hover 放大、按下缩小 */}
        <div
          aria-hidden
          className="discrete-slider-thumb pointer-events-none absolute top-1/2 h-6 w-6 rounded-full bg-white"
          style={{ left: stopLeft(idx) }}
        />
        {/* 粒子迸发画布（仅切到最高档那一刻绘制） */}
        <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute -inset-x-4 -inset-y-6 h-[calc(100%+3rem)] w-[calc(100%+2rem)]" />
        <input
          type="range"
          min={0}
          max={LEVELS.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(LEVELS[Number(e.target.value)])}
          aria-label={t('common.blurStrength')}
          aria-valuetext={t(LABEL_KEYS[LEVELS[idx]])}
          className="discrete-slider absolute inset-0 h-full w-full cursor-pointer bg-transparent"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t(DESCRIPTION_KEYS[LEVELS[idx]])}</p>
    </div>
  );
}
