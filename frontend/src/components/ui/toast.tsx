// Toast（shadcn 风格：可堆叠、支持操作撤销、默认 10s 自动消失）
import { create } from 'zustand';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme } from '@/stores/theme';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  action?: ToastAction;
  duration?: number;
  leaving?: boolean;
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  remove: (id: number) => void;
}

let toastSeq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    // 默认 10s 消失（先标记 leaving 播放退场，再移除）
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) }));
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, 200);
    }, t.duration ?? 10000);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(
  type: ToastType,
  message: string,
  opts?: { action?: ToastAction; duration?: number }
) {
  useToastStore.getState().push({ type, message, action: opts?.action, duration: opts?.duration });
}

export function Toaster() {
  const enableBlur = useTheme((s) => s.enableBlur);
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'animate-slide-in-from-top pointer-events-auto flex items-start gap-2.5 rounded-lg border p-3.5 text-popover-foreground shadow-lg transition-opacity duration-200',
            enableBlur ? 'bg-popover/80 backdrop-blur-xl backdrop-saturate-150' : 'bg-popover',
            t.leaving && 'opacity-0',
            t.type === 'error' && 'border-destructive/40',
            t.type === 'success' && 'border-emerald-500/40'
          )}
          role="status"
        >
          {t.type === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
          {t.type === 'error' && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
          {t.type === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5">{t.message}</p>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  remove(t.id);
                }}
                className="mt-1.5 text-sm font-medium text-primary hover:underline"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button onClick={() => remove(t.id)} className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
