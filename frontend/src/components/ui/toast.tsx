// Toast（HeroUI v3 复刻：最新在最上层；折叠态后方层以 0.05 系数缩小（宽高同步变小）
// 且高度统一压为最前层高度、内容隐藏；悬停展开全部并暂停自动关闭计时）
// 布局采用绝对定位 + transform 驱动：新增/移除时其余 Toast 通过 transform 过渡自动补位。
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { create } from 'zustand';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  remove: (id: number) => void;
  markLeaving: (id: number) => void;
  clearAll: () => void;
}

let toastSeq = 0;

// HeroUI 时序：进入 350ms、退出 250ms、默认 4s 自动关闭
const LEAVE_MS = 250;
const DEFAULT_DURATION = 4000;

// 计时器登记表：悬停区域时暂停全部倒计时（记录剩余时间，移出后恢复）
const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; remaining: number; started: number }>();

function schedule(id: number, duration: number): void {
  const entry = { timer: setTimeout(() => useToastStore.getState().markLeaving(id), duration), remaining: duration, started: Date.now() };
  timers.set(id, entry);
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    schedule(id, t.duration ?? DEFAULT_DURATION);
  },
  markLeaving: (id) => {
    const entry = timers.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      timers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) }));
    // 退场动画播完后移除，恢复堆叠布局
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), LEAVE_MS);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  // 路由切换时清空全部 toast（逐条走退场动画）
  clearAll: () => {
    for (const t of useToastStore.getState().toasts) {
      if (!t.leaving) useToastStore.getState().markLeaving(t.id);
    }
  },
}));

/** 暂停/恢复全部倒计时（悬停展开时暂停，移出恢复，与 HeroUI 行为一致） */
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

// 单条 Toast 的进出场：entered 由双 rAF 翻转；顶部放置时新 Toast 从上方 -105% 滑入，
// 最前层退出反向滑回上方，非最前层退出缩放 0.96（与 HeroUI 一致）
function ToastCard({
  t,
  frontmost,
  expanded,
  els,
  onClose,
}: {
  t: ToastItem;
  frontmost: boolean;
  expanded: boolean;
  els: { current: Map<number, HTMLElement> };
  onClose: () => void;
}) {
  const { t: translate } = useTranslation();
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  const reveal = frontmost || expanded;
  return (
    <div
      data-toast-id={t.id}
      ref={(el) => {
        if (el) els.current.set(t.id, el);
        else els.current.delete(t.id);
      }}
      className={cn(
        'group glass-surface-popover glass-blur pointer-events-auto relative flex items-start gap-2.5 rounded-2xl border border-border/60 px-4 py-3 text-popover-foreground',
        // 折叠态非最前层不带投影：投影会被包装层 overflow hidden 的直角裁出方形阴影
        frontmost || expanded ? 'shadow-lg' : 'shadow-none',
        'transition-[transform,opacity] [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
        t.leaving && !frontmost ? 'duration-200' : 'duration-[350ms]',
        // 退出：最前层滑回上方；展开态非最前层原地缩退（HeroUI 行为）
        entered && !t.leaving
          ? 'translate-y-0 scale-100 opacity-100'
          : frontmost
            ? '-translate-y-[105%] opacity-0'
            : 'scale-[0.96] opacity-0'
      )}
      role="status"
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2.5 transition-opacity duration-200',
          reveal ? 'opacity-100' : 'opacity-0'
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
      {/* 关闭按钮：最前层或展开态悬停时浮现（右上角小圆钮，与 HeroUI 一致） */}
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
    </div>
  );
}

// 折叠态参数（HeroUI Provider 默认值）：gap 12、缩放系数 0.05、最多可见 3 条。
// 折叠态后方层下移 PEEK 露出上沿形成堆叠；其高度被最前层裁齐（不会露出底角），
// 且非最前层不带投影（投影被包装层直角裁切会露出方形阴影）
const GAP = 12;
const PEEK = 12;
const SCALE_FACTOR = 0.05;
const VISIBLE_LEVELS = 3;

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const markLeaving = useToastStore((s) => s.markLeaving);
  const location = useLocation();
  const [hovered, setHovered] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const els = useRef(new Map<number, HTMLElement>());
  const prevPathRef = useRef(location.pathname);

  // 路由切换（页面跳转）即清空全部 toast：逐条播放退场动画后移除
  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      prevPathRef.current = location.pathname;
      useToastStore.getState().clearAll();
    }
  }, [location.pathname]);

  // 高度测量：内容随文案/操作按钮变化，用 ResizeObserver 保持展开偏移准确
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = prev;
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset.toastId);
          if (!Number.isFinite(id)) continue;
          // 量边框盒（含 py 内边距）：contentRect 会漏掉内边距导致包装层过矮裁切卡片
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
  }, [toasts.length]);

  // 渲染顺序 = 最新在前（store 按时间正序 push，反转即最新在顶）
  const list = [...toasts].reverse();
  const expanded = hovered || list.length <= 1;
  const h = (id: number) => heights[id] ?? 56;
  const frontH = list.length > 0 ? h(list[0].id) : 0;

  // 展开偏移：逐条累加实际高度 + gap；折叠偏移：每层下移 PEEK 露出上沿（堆叠效果）
  let acc = 0;
  const expandedOffsets = list.map((t) => {
    const off = acc;
    acc += h(t.id) + GAP;
    return off;
  });
  const collapsedOffsets = list.map((_, i) => Math.min(i, VISIBLE_LEVELS - 1) * PEEK);
  const offsets = expanded ? expandedOffsets : collapsedOffsets;

  // 容器高度：展开 = 最后一条底部；折叠 = 最前层高度 + 下方各层上沿
  const stageH =
    list.length === 0
      ? 0
      : expanded
        ? expandedOffsets[expandedOffsets.length - 1] - GAP + h(list[list.length - 1].id)
        : frontH + Math.min(list.length - 1, VISIBLE_LEVELS - 1) * PEEK;

  return (
    <div
      className="pointer-events-none fixed right-4 top-4 z-[100] w-[460px] max-w-[calc(100vw-2rem)]"
      onMouseEnter={() => {
        setHovered(true);
        pauseToastTimers();
      }}
      onMouseLeave={() => {
        setHovered(false);
        resumeToastTimers();
      }}
    >
      <div
        className="relative w-full transition-[height] duration-[350ms] [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]"
        style={{ height: stageH }}
      >
        {list.map((t, i) => (
          <div
            key={t.id}
            className={cn(
              'absolute inset-x-0 top-0',
              // 仅折叠态的后方层需要裁切（隐藏底角）；最前层/展开层必须可见溢出，
              // 否则右上角关闭按钮被裁半、卡片投影被直角裁出方形阴影
              !expanded && i > 0 ? 'overflow-hidden' : 'overflow-visible'
            )}
            style={{
              transform: `translateY(${offsets[i]}px) scale(${expanded ? 1 : 1 - SCALE_FACTOR * i})`,
              transformOrigin: 'top center',
              zIndex: list.length - i,
              height: expanded ? h(t.id) : frontH,
              opacity: expanded || i < VISIBLE_LEVELS ? 1 : 0,
              transition:
                'transform 350ms cubic-bezier(0.16, 1, 0.3, 1), height 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
            }}
          >
            {/* 关闭走退场动画（markLeaving）而非直接移除：卡片原地缩退/滑出后堆叠平滑回流 */}
            <ToastCard t={t} frontmost={i === 0} expanded={expanded} els={els} onClose={() => markLeaving(t.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
