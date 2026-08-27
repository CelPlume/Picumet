import { cn } from '@/lib/utils';

// ============ Skeleton 基元（shadcn 风格） ============
export function Skeleton({ className }: { className?: string }) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-accent', className)} />;
}

// ============ 文件卡片网格骨架 ============
export function FileGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-3">
          <Skeleton className="mb-3 h-16 w-16 rounded-md" />
          <Skeleton className="mb-2 h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ============ 文件列表行骨架 ============
export function FileListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border px-3 py-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-4 flex-1 max-w-[40%]" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

// ============ 分享卡片网格骨架 ============
export function ShareGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-10 w-10 rounded-md" />
          <Skeleton className="mb-2 h-4 w-2/3" />
          <Skeleton className="mb-1 h-3 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ============ 表单/详情卡片骨架 ============
export function FormCardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <Skeleton className="mb-4 h-5 w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mb-4 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

// ============ 表格骨架 ============
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-md border px-3 py-2.5">
          {Array.from({ length: cols }).map((__, j) => (
            <Skeleton key={j} className={cn('h-4', j === 0 ? 'w-1/4' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ============ 统计卡片骨架 ============
export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-4 w-1/2" />
          <Skeleton className="h-7 w-2/3" />
        </div>
      ))}
    </div>
  );
}

// ============ 应用级骨架（认证加载 / 路由懒加载） ============
export function AppSkeleton() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex h-14 items-center justify-between border-b px-4">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>
      <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
        <div className="mb-6 flex items-center gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
        </div>
        <FileGridSkeleton count={10} />
      </div>
    </div>
  );
}

// ============ 代码预览骨架 ============
export function CodeSkeleton() {
  return (
    <div className="h-full w-full space-y-2 overflow-auto p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-1/2' : 'w-2/3')} />
      ))}
    </div>
  );
}

// ============ 公开分享页骨架 ============
export function SharePageSkeleton() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="rounded-lg border bg-card p-6">
        <div className="mb-4 flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <Skeleton className="mb-4 h-3 w-1/4" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
