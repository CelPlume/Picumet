// 轻量 Toast
import { create } from 'zustand';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (type: ToastType, message: string) => void;
  remove: (id: number) => void;
}

let toastSeq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (type, message) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3500);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(type: ToastType, message: string) {
  useToastStore.getState().push(type, message);
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[320px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-md border bg-card p-3 shadow-lg',
            t.type === 'error' && 'border-destructive/40',
            t.type === 'success' && 'border-emerald-500/40'
          )}
        >
          {t.type === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
          {t.type === 'error' && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
          {t.type === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
          <p className="flex-1 text-sm">{t.message}</p>
          <button onClick={() => remove(t.id)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
