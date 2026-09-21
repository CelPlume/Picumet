// 可排序表头（点击切换 asc/desc）
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type SortOrder = 'asc' | 'desc';

export function SortableHeader({
  title,
  sortKey,
  sort,
  order,
  onSort,
  className,
}: {
  title: string;
  sortKey: string;
  sort: string | null;
  order: SortOrder;
  onSort: (key: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const active = sort === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground',
        active ? 'text-foreground' : 'text-muted-foreground',
        className
      )}
      aria-label={t('common.sortBy', { field: title })}
    >
      {title}
      {active ? (
        order === 'asc' ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-50" />
      )}
    </button>
  );
}

// 客户端排序工具：对当前页数据排序
export function sortByKey<T>(rows: T[], key: keyof T, order: SortOrder): T[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'zh-Hans-CN') * dir;
  });
}
