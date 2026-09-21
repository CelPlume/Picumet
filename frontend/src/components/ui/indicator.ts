// 滑动选中指示器（navbar / Tabs / 侧边栏共用的测量适配器）：
// 测量容器内 [data-active="true"] 的元素几何，驱动一枚绝对定位色块平滑移动。
// 容器需 position:relative 且为列表项的 offsetParent。
// - axis 'x'：水平（navbar/Tabs，测 offsetLeft/offsetWidth）；'y'：垂直（侧边栏，offsetTop/offsetHeight）
// - persistKey：跨重挂载缓存位置（AppShell 每次换页重挂载，缓存让 transition 从旧位置平滑滑出）
// - 子树变化（Tabs/侧边栏懒加载、展开收起）与窗口尺寸变化自动重测
import { useEffect, useState, type RefObject } from 'react';

export interface IndicatorPos {
  pos: number;
  size: number;
  ready: boolean;
}

// 跨重挂载位置缓存（navbar 用；key → 上次几何）
const persistCache = new Map<string, { pos: number; size: number }>();

export function useIndicator(
  ref: RefObject<HTMLElement | null>,
  dep: unknown,
  opts: { axis?: 'x' | 'y'; persistKey?: string } = {}
): IndicatorPos {
  const { axis = 'y', persistKey } = opts;
  const [pos, setPos] = useState<IndicatorPos>(() => {
    const c = persistKey ? persistCache.get(persistKey) : undefined;
    return c ? { ...c, ready: true } : { pos: 0, size: 0, ready: false };
  });

  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    const measure = () => {
      const el = list.querySelector<HTMLElement>('[data-active="true"]');
      if (!el) return;
      const next =
        axis === 'x'
          ? { pos: el.offsetLeft, size: el.offsetWidth }
          : { pos: el.offsetTop, size: el.offsetHeight };
      if (persistKey) persistCache.set(persistKey, next);
      setPos((p) => (p.pos === next.pos && p.size === next.size ? p : { ...next, ready: true }));
    };
    if (!persistKey || !persistCache.has(persistKey)) {
      // 无缓存：同步校准就位（首帧直接出现在正确位置）
      measure();
    }
    // 有缓存：等浏览器绘制旧位置后再应用新值，transition 才能从旧位置平滑滑出（双向）
    const raf = requestAnimationFrame(measure);
    const mo = new MutationObserver(measure);
    // childList：懒加载/展开收起；characterData：切换语言时标签文本原地更新（宽度变化需重测）
    mo.observe(list, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, dep, axis, persistKey]);

  return pos;
}

/** 侧边栏指示器色块：强调色淡化（固定 10% primary，不随档位/背景漂移——颜色不变），
    blur 随三档门控（.no-blur 关停）。navbar/Tabs 用各自的实底凸起样式，不走此类 */
export const INDICATOR_CLASS =
  'glass-control pointer-events-none absolute inset-x-1 z-0 rounded-md bg-primary/10 transition-[top,height] duration-300 ease-out';
