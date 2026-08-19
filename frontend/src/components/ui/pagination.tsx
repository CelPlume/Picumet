// 分页组件（HeroUI 风格：页码 + 省略号 + 上一页/下一页 + 每页条数）
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from './select';

function buildPages(current: number, total: number): (number | '...')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | '...')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('...');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push('...');
  pages.push(total);
  return pages;
}

export function Pagination({
  page,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
  className,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange?: (s: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = buildPages(page, pages);

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-1.5 py-2', className)}>
      {onPageSizeChange && (
        <div className="mr-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          每页
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
            className="w-[84px]"
            options={pageSizeOptions.map((s) => ({ value: String(s), label: `${s} 条` }))}
          />
        </div>
      )}

      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="上一页"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {items.map((p, idx) =>
        p === '...' ? (
          <span key={`e${idx}`} className="flex h-8 w-8 items-center justify-center text-muted-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={cn(
              'h-8 min-w-8 rounded-lg px-2 text-sm font-medium transition-colors',
              p === page
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {p}
          </button>
        )
      )}

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pages}
        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="下一页"
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      <span className="ml-3 text-sm text-muted-foreground">
        共 {total} 条
      </span>
    </div>
  );
}
