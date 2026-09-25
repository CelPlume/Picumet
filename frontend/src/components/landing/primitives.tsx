// 落地页专用原语：滚动入场、区块标题、数字滚动、轮播节拍、地球。
// 与 components/ui/reveal.tsx 无关——落地页不参与个性化动画档位，只尊重系统 prefers-reduced-motion。
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import createGlobe, { type Arc, type Marker } from 'cobe';
import { cn } from '@/lib/utils';

export const REPO_URL = 'https://github.com/CelPlume/Picumet';

/** CelPlume 文档站与品牌站（中文 /zh/picumet/，英文 /picumet/） */
export const BRAND_URL = 'https://celplume.hxcn.space/';
export function docsUrl(zh: boolean, page?: 'deployment'): string {
  return `${BRAND_URL}${zh ? 'zh/' : ''}picumet/${page ? `dev/${page}/` : ''}`;
}

/** 系统级减少动态偏好（实时响应系统设置变化） */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (): void => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** 当前是否深色：观察 <html> 的 dark 类（theme store 负责在系统主题变化时切换它） */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(() => setDark(root.classList.contains('dark')));
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** 单调递增节拍：active 时每 interval 毫秒 +1；减少动态时恒为 0（用于多阶段演示动画） */
export function useTicker(interval: number, active: boolean): number {
  const [n, setN] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) return;
    const id = window.setInterval(() => setN((v) => v + 1), interval);
    return () => window.clearInterval(id);
  }, [active, reduced, interval]);
  return n;
}

/** 发丝网格四角的 + 号装饰（容器需 relative） */
export function Corners(): JSX.Element {
  return (
    <>
      <span className="lp-plus -left-[6px] -top-[6px]" aria-hidden />
      <span className="lp-plus -right-[6px] -top-[6px]" aria-hidden />
      <span className="lp-plus -bottom-[6px] -left-[6px]" aria-hidden />
      <span className="lp-plus -bottom-[6px] -right-[6px]" aria-hidden />
    </>
  );
}

/** 根容器挂一个 IntersectionObserver：子树里的 [data-reveal] 进入视口即打上 data-shown（一次性）。
 *  整页只一个 observer，不逐元素挂 hook；样式在 landing.css。 */
export function useRevealRoot(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const targets = root.querySelectorAll<HTMLElement>('[data-reveal]');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.shown = '';
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ref]);
}

/** 元素首次进入视口（用于驱动只在可见时运行的循环/计数） */
export function useInView<T extends HTMLElement>(margin = '0px'): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: margin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin, seen]);
  return [ref, seen];
}

/** 元素当前是否在视口内（循环动画离屏即暂停） */
export function useVisible<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

/** 离散节拍：active 时每 interval 毫秒 +1（取模 length）；减少动态时停在 0 */
export function useCycle(length: number, interval: number, active: boolean): number {
  const [i, setI] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced || length < 2) return;
    const id = window.setInterval(() => setI((v) => (v + 1) % length), interval);
    return () => window.clearInterval(id);
  }, [active, reduced, length, interval]);
  return i;
}

/** 入场延迟（CSS 变量 --lp-d，由 .lp-rise / [data-reveal] / .lp-fill 等消费） */
export function lpDelay(ms: number): CSSProperties {
  return { '--lp-d': `${ms}ms` } as CSSProperties;
}

/** 区块标题：左对齐眉标 + 大标题 + 说明；aside 放在大屏右侧（与 agenforce 基线对齐的双栏标题） */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  aside,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end', className)}>
      <div>
        <p className="lp-eyebrow" data-reveal>
          {eyebrow}
        </p>
        <h2 className="lp-title mt-5 max-w-3xl" data-reveal style={lpDelay(60)}>
          {title}
        </h2>
        {lede && (
          <p className="lp-lede mt-5" data-reveal style={lpDelay(120)}>
            {lede}
          </p>
        )}
      </div>
      {aside && (
        <div data-reveal style={lpDelay(180)}>
          {aside}
        </div>
      )}
    </div>
  );
}

/** 数字滚动：进入视口后 ease-out 从 0 数到 to（减少动态直接显示终值） */
export function CountUp({ to, duration = 1400, decimals = 0 }: { to: number; duration?: number; decimals?: number }): JSX.Element {
  const [ref, seen] = useInView<HTMLSpanElement>('-10% 0px');
  const reduced = useReducedMotion();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!seen) return;
    if (reduced) {
      setValue(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / duration);
      setValue(to * (1 - Math.pow(1 - p, 4)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced, to, duration]);
  return (
    <span ref={ref} className="lp-num">
      {value.toFixed(decimals)}
    </span>
  );
}

// ============ 地球（cobe v2：width/height 为 CSS 像素，渲染循环由调用方驱动） ============

const GLOBE_MARKERS: Marker[] = [
  { location: [37.77, -122.42], size: 0.05 },
  { location: [40.71, -74.01], size: 0.05 },
  { location: [51.51, -0.13], size: 0.05 },
  { location: [50.11, 8.68], size: 0.04 },
  { location: [35.68, 139.69], size: 0.05 },
  { location: [1.35, 103.82], size: 0.05 },
  { location: [22.32, 114.17], size: 0.04 },
  { location: [-33.87, 151.21], size: 0.04 },
  { location: [-23.55, -46.63], size: 0.04 },
  { location: [19.08, 72.88], size: 0.04 },
];

const GLOBE_ARCS: Arc[] = [
  { from: [37.77, -122.42], to: [35.68, 139.69] },
  { from: [40.71, -74.01], to: [51.51, -0.13] },
  { from: [51.51, -0.13], to: [1.35, 103.82] },
  { from: [22.32, 114.17], to: [-33.87, 151.21] },
];

export function EdgeGlobe({ dark, className }: { dark: boolean; className?: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wrapRef, visible] = useVisible<HTMLDivElement>();
  const reduced = useReducedMotion();
  const phiRef = useRef(0.6);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible) return;
    const side = canvas.offsetWidth;
    if (side === 0) return;
    const accent: [number, number, number] = dark ? [0.98, 0.49, 0.2] : [0.92, 0.36, 0.05];
    const globe = createGlobe(canvas, {
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      width: side,
      height: side,
      phi: phiRef.current,
      theta: 0.28,
      dark: dark ? 1 : 0,
      diffuse: dark ? 1.4 : 1.2,
      mapSamples: 16000,
      mapBrightness: dark ? 5 : 1.5,
      mapBaseBrightness: dark ? 0 : 0.05,
      baseColor: dark ? [0.26, 0.26, 0.28] : [1, 1, 1],
      markerColor: accent,
      glowColor: dark ? [0.12, 0.12, 0.13] : [0.94, 0.94, 0.95],
      markers: GLOBE_MARKERS,
      arcs: GLOBE_ARCS,
      arcColor: accent,
      arcWidth: 0.6,
      arcHeight: 0.28,
      markerElevation: 0.02,
      opacity: dark ? 0.9 : 0.85,
    });
    let raf = 0;
    const loop = (): void => {
      phiRef.current += 0.0028;
      globe.update({ phi: phiRef.current });
      raf = requestAnimationFrame(loop);
    };
    if (reduced) globe.update({ phi: phiRef.current });
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      globe.destroy();
    };
  }, [visible, dark, reduced]);

  return (
    <div ref={wrapRef} className={cn('relative aspect-square', className)}>
      <canvas ref={canvasRef} className="size-full" />
    </div>
  );
}
