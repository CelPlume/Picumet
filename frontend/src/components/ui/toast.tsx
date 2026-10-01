// Toast：右下角横幅堆叠。底部锚定、新 toast 从下方升起、折叠态展示最多 3 层露沿且
// 后方层隐藏内容（半透明玻璃叠半透明玻璃时渲染文字会重影），悬停展开展示全部并暂停自动关闭计时。
// 动画档位：default/all 走堆叠；off 不堆叠（竖直静态列表，立即移除）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { create } from 'zustand';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/stores/theme';
import { cn } from '@/lib/utils';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  type: ToastType;
  /** 可选标题（加粗首行）；message 为正文 */
  title?: string;
  message: string;
  action?: ToastAction;
  duration?: number;
  leaving?: boolean;
  /** 新入栈标记：首帧挂 is-enter 预置姿态，同任务强制 reflow 后由 settleEntering 清除 */
  entering?: boolean;
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  remove: (id: number) => void;
  markLeaving: (id: number) => void;
  settleEntering: () => void;
  clearAll: () => void;
}

let toastSeq = 0;

// 时序与 index.css「Toast 堆叠」对齐：进入 350ms、退出 250ms、默认 4s 自动关闭
const LEAVE_MS = 250;
const DEFAULT_DURATION = 4000;

// 计时器登记表：悬停/展开时暂停全部倒计时（记录剩余时间，移出后恢复）
const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; remaining: number; started: number }>();

function schedule(id: number, duration: number): void {
  const entry = { timer: setTimeout(() => useToastStore.getState().markLeaving(id), duration), remaining: duration, started: Date.now() };
  timers.set(id, entry);
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id, entering: true }] }));
    schedule(id, t.duration ?? DEFAULT_DURATION);
  },
  markLeaving: (id) => {
    const entry = timers.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      timers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) }));
    // 动画关闭档不堆叠：立即移除；否则等 250ms 退场动画播完
    const motionOff = document.documentElement.getAttribute('data-motion') === 'off';
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), motionOff ? 0 : LEAVE_MS);
  },
  settleEntering: () => set((s) => ({ toasts: s.toasts.map((x) => (x.entering ? { ...x, entering: false } : x)) })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  // 路由切换时清空全部 toast（逐条走退场动画）
  clearAll: () => {
    for (const t of useToastStore.getState().toasts) {
      if (!t.leaving) useToastStore.getState().markLeaving(t.id);
    }
  },
}));

/** 暂停/恢复全部倒计时（悬停/展开时暂停，移出恢复） */
export function pauseToastTimers(): void {
  const now = Date.now();
  for (const [, entry] of timers) {
    clearTimeout(entry.timer);
    entry.remaining = Math.max(0, entry.remaining - (now - entry.started));
  }
}

export function resumeToastTimers(): void {
  for (const [id, entry] of timers) {
    entry.started = Date.now();
    entry.timer = setTimeout(() => useToastStore.getState().markLeaving(id), entry.remaining);
  }
}

export function toast(
  type: ToastType,
  message: string,
  opts?: { title?: string; action?: ToastAction; duration?: number }
) {
  useToastStore.getState().push({ type, message, title: opts?.title, action: opts?.action, duration: opts?.duration });
}

/** Toast 卡片内容（图标 + 标题/正文 + 可选操作按钮 + 悬停浮现的右上角关闭钮）。
 *  折叠态后方层通过 reveal=false 隐藏正文（opacity-0），只露磨砂上沿，绝不透出文字脏影！
 *  悬停展开时全部内容淡入可见。
 *  外层容器直接承载 glass-surface glass-blur：带 transform 的父级会让 backdrop-filter
 *  只采样自身背景，磨砂失效退化为平涂半透明。 */
function ToastCardContent({
  t,
  onClose,
  isFront = true,
  spread = false,
}: {
  t: ToastItem;
  onClose: () => void;
  isFront?: boolean;
  spread?: boolean;
}) {
  const { t: translate } = useTranslation();
  const reveal = isFront || spread;
  return (
    <>
      <div
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2.5 px-4 py-3 transition-opacity duration-200',
          reveal ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        {t.type === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
        {t.type === 'error' && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
        {t.type === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1">
          {t.title && <p className="text-sm font-semibold leading-5">{t.title}</p>}
          <p className={cn('text-sm leading-5', !t.title && 'font-medium', t.type === 'success' && 'text-emerald-600 dark:text-emerald-400', t.type === 'error' && 'text-destructive')}>
            {t.message}
          </p>
          {t.action && (
            <button
              onClick={() => {
                t.action?.onClick();
                onClose();
              }}
              className="mt-2 text-sm font-medium text-primary hover:underline"
            >
              {t.action.label}
            </button>
          )}
        </div>
      </div>
      {/* 关闭按钮：仅在内容可见时悬停浮现 */}
      <button
        onClick={onClose}
        className={cn(
          'absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-opacity duration-150 hover:text-foreground',
          reveal && !t.leaving ? 'opacity-0 group-hover:opacity-100' : 'pointer-events-none opacity-0'
        )}
        aria-label={translate('common.close')}
      >
        <X className="h-3 w-3" />
      </button>
    </>
  );
}

const STACK_WIDTH = 'w-[356px] max-w-[calc(100vw-2rem)]';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const markLeaving = useToastStore((s) => s.markLeaving);
  // 动画关闭档：不堆叠，渲染竖直静态列表（functional 过渡也被全局关停）
  const motionOff = useTheme((s) => s.motionLevel === 'off');
  const location = useLocation();
  const [hovered, setHovered] = useState(false);
  const [spread, setSpread] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const stackRef = useRef<HTMLDivElement | null>(null);
  const els = useRef(new Map<number, HTMLElement>());
  const prevPathRef = useRef(location.pathname);

  // 路由切换（页面跳转）即清空全部 toast：逐条播放退场动画后移除
  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      prevPathRef.current = location.pathname;
      useToastStore.getState().clearAll();
    }
  }, [location.pathname]);

  // 新 toast 入场：首帧挂 is-enter 预置姿态，强制一次布局把姿态钉进计算值后同任务清除
  const entering = toasts.filter((t) => t.entering);
  useLayoutEffect(() => {
    if (entering.length === 0) return;
    if (stackRef.current) void stackRef.current.getBoundingClientRect();
    useToastStore.getState().settleEntering();
  }, [entering.length]);

  // 高度测量：内容随文案/操作按钮变化，用 ResizeObserver 保持堆叠盒高度与展开几何准确
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = prev;
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset.toastId);
          if (!Number.isFinite(id)) continue;
          const h = Math.round((e.target as HTMLElement).offsetHeight);
          if (prev[id] !== h) {
            if (next === prev) next = { ...prev };
            next[id] = h;
          }
        }
        return next;
      });
    });
    for (const [, el] of els.current) ro.observe(el);
    return () => ro.disconnect();
  }, [toasts.length, motionOff]);

  const visible = toasts.filter((t) => !t.leaving);
  const stackList = [...visible].reverse();
  const front = stackList[0];
  const frontH = front ? heights[front.id] ?? 56 : 0;

  // 展开位移计算：逐条累加各自高度 + 8px 间隙
  let acc = 0;
  const spreadOffsets = stackList.map((t) => {
    const off = acc;
    acc += (heights[t.id] ?? 56) + 8;
    return off;
  });
  const totalSpreadHeight = Math.max(acc, (frontH + 8) * 2);

  // 悬停展开（spread）：指针落入折叠堆叠盒即展开，保持到离开「展开列」总高度为止
  useEffect(() => {
    if (motionOff || visible.length < 2) return;
    const onPointerMove = (e: PointerEvent) => {
      const el = stackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const inX = e.clientX >= r.left && e.clientX <= r.right;
      const inCollapsed = inX && e.clientY >= r.top && e.clientY <= r.bottom;
      const inSpreadColumn = inX && e.clientY >= r.top - totalSpreadHeight && e.clientY <= r.bottom;
      if (spread) {
        if (!inSpreadColumn) setSpread(false);
      } else if (inCollapsed) {
        setSpread(true);
      }
    };
    const onLeaveDoc = () => setSpread(false);
    window.addEventListener('pointermove', onPointerMove);
    document.addEventListener('mouseleave', onLeaveDoc);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('mouseleave', onLeaveDoc);
    };
  }, [visible.length, spread, motionOff, totalSpreadHeight]);

  // 悬停/展开期间暂停全部自动关闭倒计时（离开/收起恢复）
  const paused = hovered || spread;
  const wasPaused = useRef(false);
  useEffect(() => {
    if (paused && !wasPaused.current) {
      pauseToastTimers();
      wasPaused.current = true;
    } else if (!paused && wasPaused.current) {
      resumeToastTimers();
      wasPaused.current = false;
    }
  }, [paused]);

  // 动画关闭档：竖直静态列表（新到在下），不做任何堆叠/进出场动画
  if (motionOff) {
    return (
      <div className={`pointer-events-none fixed bottom-4 right-4 z-[100] ${STACK_WIDTH}`}>
        <div className="flex flex-col-reverse gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="group glass-surface glass-blur pointer-events-auto relative flex w-full items-start gap-2.5 rounded-2xl border border-border/60 text-card-foreground shadow-lg"
            >
              <ToastCardContent t={t} onClose={() => markLeaving(t.id)} isFront spread />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 堆叠渲染：最新在底（depth 0），折叠态展示最多 3 层露沿（超出隐藏），展开展示全部
  // .toast-banner 本身直接承载 glass-surface 与 glass-blur：外层 transform 容器会截断背景采样
  return (
    <div className={`pointer-events-none fixed bottom-4 right-4 z-[100] ${STACK_WIDTH}`}>
      <div
        ref={stackRef}
        className={cn('toast-stack pointer-events-auto w-full', spread && 'is-spread')}
        style={{ height: frontH }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {stackList.map((t, i) => {
          const isFront = i === 0;
          return (
            <div
              key={t.id}
              data-toast-id={t.id}
              data-depth={i}
              role="status"
              ref={(el) => {
                if (el) els.current.set(t.id, el);
                else els.current.delete(t.id);
              }}
              className={cn(
                'toast-banner group glass-surface glass-blur w-full rounded-2xl border border-border/60 text-card-foreground transition-[box-shadow] duration-200',
                isFront || spread ? 'shadow-lg' : 'shadow-none',
                t.entering && 'is-enter'
              )}
              style={{
                transform: spread
                  ? `translateY(-${spreadOffsets[i]}px) scale(1)`
                  : isFront
                    ? 'translateY(0) scale(1)'
                    : i === 1
                      ? 'translateY(-12px) scale(0.94)'
                      : i === 2
                        ? 'translateY(-24px) scale(0.88)'
                        : 'translateY(-24px) scale(0.82)',
                opacity: spread || i < 3 ? 1 : 0,
                pointerEvents: spread || isFront ? 'auto' : 'none',
                zIndex: 50 - i,
              }}
            >
              <ToastCardContent t={t} onClose={() => markLeaving(t.id)} isFront={isFront} spread={spread} />
            </div>
          );
        })}
        {toasts.filter((t) => t.leaving).map((t) => (
          <div
            key={t.id}
            data-toast-id={t.id}
            role="status"
            ref={(el) => {
              if (el) els.current.set(t.id, el);
              else els.current.delete(t.id);
            }}
            className="toast-banner is-leaving group glass-surface glass-blur w-full rounded-2xl border border-border/60 text-card-foreground shadow-lg"
          >
            <ToastCardContent t={t} onClose={() => markLeaving(t.id)} isFront spread />
          </div>
        ))}
      </div>
    </div>
  );
}
