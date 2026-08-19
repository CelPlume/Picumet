// 抽屉组件（shadcn 风格）
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Drawer({
  open,
  onClose,
  side = 'right',
  children,
  className,
  title,
  width,
}: {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right' | 'top' | 'bottom';
  children: ReactNode;
  className?: string;
  title?: string;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const sideStyles: Record<string, string> = {
    left: 'left-0 top-0 h-full',
    right: 'right-0 top-0 h-full',
    top: 'top-0 left-0 w-full',
    bottom: 'bottom-0 left-0 w-full',
  };

  const sideAnim: Record<string, string> = {
    left: 'animate-slide-in-from-left',
    right: 'animate-slide-in-from-right',
    top: 'animate-slide-in-from-top',
    bottom: 'animate-slide-in-from-bottom',
  };

  const widthCls =
    side === 'left' || side === 'right'
      ? width ?? (side === 'right' ? 'w-96 max-w-[90vw]' : 'w-72 max-w-[90vw]')
      : 'h-[80vh] max-h-[80vh]';

  return (
    <div className={cn('fixed inset-0 z-50', className)}>
      {/* Backdrop */}
      <div className="animate-dialog-overlay absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div
        className={cn(
          'fixed z-10 flex flex-col bg-background shadow-xl',
          sideStyles[side],
          widthCls,
          sideAnim[side]
        )}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
