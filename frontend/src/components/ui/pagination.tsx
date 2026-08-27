// 分页组件（交互式：页码跳转 + 每页条数均可点击填写）
import { useState } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  const [editingSize, setEditingSize] = useState(false);
  const [sizeValue, setSizeValue] = useState(String(pageSize));
  const [editingJump, setEditingJump] = useState(false);
  const [jumpValue, setJumpValue] = useState(String(page));

  const commitSize = () => {
    const n = parseInt(sizeValue, 10);
    if (!isNaN(n) && n >= 1) {
      onPageSizeChange?.(n);
      onPageChange(1);
      setSizeValue(String(n));
    } else {
      setSizeValue(String(pageSize));
    }
    setEditingSize(false);
  };

  const commitJump = () => {
    const n = parseInt(jumpValue, 10);
    if (!isNaN(n)) {
      onPageChange(Math.max(1, Math.min(pages, n)));
      setJumpValue(String(Math.max(1, Math.min(pages, n))));
    } else {
      setJumpValue(String(page));
    }
    setEditingJump(false);
  };

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-1.5 py-2', className)}>
      {onPageSizeChange && (
        <div className="mr-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          每页
          {editingSize ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commitSize();
              }}
              className="flex items-center gap-1"
            >
              <input
                autoFocus
                value={sizeValue}
                onChange={(e) => setSizeValue(e.target.value.replace(/\D/g, ''))}
                onBlur={commitSize}
                onKeyDown={(e) => e.key === 'Escape' && setEditingSize(false)}
                inputMode="numeric"
                className="h-7 w-14 rounded-md border bg-background px-1.5 text-center text-xs tabular-nums outline-none ring-1 ring-ring focus-visible:ring-2"
                aria-label="每页条数"
              />
              <button type="submit" className="rounded-md p-1 text-muted-foreground hover:bg-accent" aria-label="确定">
                <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
            </form>
          ) : (
            <button
              onClick={() => {
                setSizeValue(String(pageSize));
                setEditingSize(true);
              }}
              className="cursor-pointer rounded-md px-2 py-0.5 font-medium tabular-nums text-foreground transition-colors hover:bg-secondary/60"
              title="点击修改每页条数"
            >
              {pageSize}
            </button>
          )}
          条
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

      {/* 跳页：点击页码可填写 */}
      <div className="ml-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        {editingJump ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commitJump();
            }}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              value={jumpValue}
              onChange={(e) => setJumpValue(e.target.value.replace(/\D/g, ''))}
              onBlur={commitJump}
              onKeyDown={(e) => e.key === 'Escape' && setEditingJump(false)}
              inputMode="numeric"
              className="h-7 w-12 rounded-md border bg-background px-1.5 text-center text-xs tabular-nums outline-none ring-1 ring-ring focus-visible:ring-2"
              aria-label="跳转到页"
            />
            <button type="submit" className="rounded-md px-1.5 py-0.5 text-xs font-bold uppercase tracking-tighter text-primary hover:bg-accent" aria-label="GO">
              GO
            </button>
          </form>
        ) : (
          <button
            onClick={() => {
              setJumpValue(String(page));
              setEditingJump(true);
            }}
            className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 transition-colors hover:bg-secondary/60"
            title="点击输入页码"
          >
            <span className="font-semibold tabular-nums text-foreground">{page}</span>
            <span className="text-xs font-medium uppercase tracking-wider">/ {pages} 页</span>
          </button>
        )}
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>
    </div>
  );
}
