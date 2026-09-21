// Tabs 选项卡组件（滑动指示器：色块为唯一选中指示，useIndicator 测量驱动平滑滑动）
import { createContext, useContext, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useIndicator } from './indicator';

const TabsContext = createContext<{
  value: string;
  onValueChange: (v: string) => void;
} | null>(null);

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn('w-full gap-4', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const ctx = useContext(TabsContext);
  const listRef = useRef<HTMLDivElement>(null);
  // 滑动色块是唯一选中指示（TabsTrigger 不再自带底色，避免双指示器重叠）
  const ind = useIndicator(listRef, ctx?.value, { axis: 'x' });

  return (
    <div
      ref={listRef}
      role="tablist"
      className={cn(
        'glass-control no-scrollbar relative inline-flex h-9 w-fit items-center gap-1 overflow-x-auto rounded-lg bg-card/[var(--glass-alpha,0.72)] p-1 text-muted-foreground',
        className
      )}
    >
      {ind.ready && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 rounded-lg bg-muted shadow-sm ring-1 ring-border transition-all duration-300 ease-out"
          style={{ left: ind.pos, width: ind.size }}
        />
      )}
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('TabsTrigger must be used within Tabs');

  const isActive = ctx.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      data-active={isActive ? 'true' : 'false'}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'relative z-10 inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-3.5 text-sm font-medium transition-all outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
        className
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('TabsContent must be used within Tabs');

  if (ctx.value !== value) return null;

  return <div className={cn('animate-fade-in mt-4', className)}>{children}</div>;
}
