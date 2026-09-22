// 抽屉组件（shadcn 风格）
// 进出动画统一收敛在本组件：进入=滑入关键帧+淡入，退出=整体淡出后延迟卸载
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const EXIT_MS = 300;

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
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
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

  useEffect(() => {
    if (!mounted) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mounted]);

  if (!mounted) return null;

  const sideStyles: Record<string, string> = {
    left: 'left-0 top-0 h-full',
    right: 'right-0 top-0 h-full',
    top: 'top-0 left-0 w-full',
    bottom: 'bottom-0 left-0 w-full',
  };
  // 隐藏态/显示态： entered 翻转驱动 transition（与 Dialog 完全同款）
  const sideHidden: Record<string, string> = {
    left: '-translate-x-full opacity-0',
    right: 'translate-x-full opacity-0',
    top: '-translate-y-full opacity-0',
    bottom: 'translate-y-full opacity-0',
  };
  const sideShown: Record<string, string> = {
    left: 'translate-x-0 opacity-100',
    right: 'translate-x-0 opacity-100',
    top: 'translate-y-0 opacity-100',
    bottom: 'translate-y-0 opacity-100',
  };

  const widthCls =
    side === 'left' || side === 'right'
      ? width ?? (side === 'right' ? 'w-96 max-w-[90vw]' : 'w-72 max-w-[90vw]')
      : 'h-[80vh] max-h-[80vh]';

  return (
    <div className="fixed inset-0 z-50" aria-hidden={!open}>
      {/* Backdrop：压暗与模糊随 entered 同步过渡（与 Dialog 同款 transition 写法） */}
      <div
        className={cn(
          'glass-overlay absolute inset-0 transition-opacity duration-300 ease-out',
          entered ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />

      {/* Panel：与 Dialog 同款 entered 过渡——首帧以关闭样式绘制（双 rAF），再切入终态；
          opacity/transform 过渡全程保留 backdrop-filter，无 keyframes 合成器掉模糊问题 */}
      <div
        className={cn(
          'glass-dialog fixed z-10 flex flex-col text-card-foreground shadow-xl transition-[opacity,transform] duration-300 ease-out',
          sideStyles[side],
          widthCls,
          entered ? sideShown[side] : sideHidden[side],
          className
        )}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('common.close')}
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
