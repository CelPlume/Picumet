// 抽屉组件（shadcn 风格）
// 进出动画统一收敛在本组件：进入=滑入关键帧+淡入，退出=整体淡出后延迟卸载
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn, motionDurationMs } from '@/lib/utils';

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
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开：面板一进 DOM 就先把「关闭态」钉进计算值（强制一次布局），再切 entered。
  // 过渡的触发条件是与「上一次计算值」不同——只要关闭态被样式系统算过一次就不会被吞。
  // 原先的双 rAF 挡不住 React 调度：组件条件挂载时 mounted 与 entered 可能合并进同一次
  // commit，元素首帧即终态（右键菜单还在逐项入场时点「属性」最容易撞上）。
  useLayoutEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;
    void el.getBoundingClientRect();
    setEntered(true);
  }, [open, mounted]);

  // 关闭：entered 落下 + 等面板过渡播完（transitionend）再卸载，读不到事件时按 token 兜底。
  // 时长与 CSS 同源（--duration-overlay，动画速度两档会改它），硬编码 300ms 会掐断舒适档。
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setEntered(false);
    const panel = panelRef.current;
    const finish = () => setMounted(false);
    const onEnd = (e: TransitionEvent) => {
      if (e.target === panel) finish();
    };
    const fallback = setTimeout(finish, motionDurationMs('--duration-overlay') + 120);
    panel?.addEventListener('transitionend', onEnd);
    return () => {
      clearTimeout(fallback);
      panel?.removeEventListener('transitionend', onEnd);
    };
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
          'glass-overlay absolute inset-0 transition-opacity [transition-duration:var(--duration-overlay)] ease-out',
          entered ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />

      {/* Panel：与 Dialog 同款 entered 过渡——首帧以关闭样式绘制（双 rAF），再切入终态；
          opacity/transform 过渡全程保留 backdrop-filter，无 keyframes 合成器掉模糊问题 */}
      <div
        ref={panelRef}
        className={cn(
          'glass-dialog fixed z-10 flex flex-col text-card-foreground shadow-xl transition-[opacity,transform] [transition-duration:var(--duration-overlay)] ease-out',
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
