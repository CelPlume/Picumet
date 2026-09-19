// 对话框 / 确认框（自定义实现）
// 弹出/关闭动画与毛玻璃表面统一收敛在本组件内：
// 无论调用方常驻挂载还是条件挂载，进出动画表现一致（遮罩压暗+模糊同步淡入，面板缩放淡入）。
import { useEffect, useState, type ReactNode } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './core';

const EXIT_MS = 300;

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  // mounted：是否渲染在 DOM（延迟卸载以播放退出动画）；entered：是否处于打开样式（驱动过渡）
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // 双 rAF：确保“关闭样式”先完成首次绘制，再切入“打开样式”触发过渡
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setEntered(false);
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开期间锁定页面滚动（含退出动画期间）
  useEffect(() => {
    if (!mounted) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mounted]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" aria-hidden={!open}>
      {/* 遮罩：压暗与模糊同步淡入淡出 */}
      <div
        className={cn(
          'glass-overlay absolute inset-0 transition-opacity duration-300 ease-out',
          entered ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          'glass-surface glass-blur relative z-10 w-full rounded-lg border shadow-lg transition-[opacity,transform] duration-300 ease-out',
          'text-card-foreground',
          entered ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-4 scale-95 opacity-0',
          width
        )}
      >
        {/* 无标题时不渲染头部条（避免空带），关闭钮绝对定位到右上角 */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
        {(title || description) && (
          <div className="p-6 pb-0 pr-12">
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
        )}
        {/* children 在整个显示周期（含退出动画）保持挂载，避免面板塌缩 */}
        <div className={cn('p-6', (title || description) && 'mt-4 pt-0', footer && 'pb-5')}>{children}</div>
        {footer && <div className="flex justify-end gap-2 px-6 pb-5">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '删除',
  cancelText = '取消',
  variant = 'destructive',
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'destructive' | 'default';
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      {/* 排版参考 HeroUI AlertDialog：紧凑 Header（状态图标 + 标题）→ Body（描述）→ Footer（右对齐操作） */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-5 w-5 text-destructive" />
        </div>
        <p className="text-base font-semibold leading-6">{title}</p>
      </div>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">{message}</p>
    </Dialog>
  );
}
