// 管理员：访问日志
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText } from 'lucide-react';
import { Card, Badge, EmptyState } from '@/components/ui/core';
import { useMinLoading } from '@/hooks/useMinLoading';
import { TableSkeleton } from '@/components/ui/skeleton';
import { revealDelay } from '@/components/ui/reveal';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';
import { formatDateTime, formatBytes } from '@/lib/utils';

interface LogRow {
  id: string;
  userId?: string;
  action: string;
  path?: string;
  metadata?: string;
  ipAddress?: string;
  userAgent?: string;
  bytesTransferred: number;
  statusCode?: number;
  createdAt: number;
}

const ACTION_COLOR: Record<string, string> = {
  upload: 'success',
  download: 'default',
  download_failed: 'destructive',
  share: 'secondary',
  delete: 'destructive',
  login: 'outline',
};

/** 表头与数据行共用的网格模板（md 起多一列 IP），保证表头表与行表列对齐；
    路径列给最小宽度下限，窄容器时横向滚动而非塌缩 */
const LOG_ROW_GRID =
  'grid grid-cols-[104px_minmax(160px,1fr)_96px_88px_150px] md:grid-cols-[104px_minmax(160px,1fr)_96px_110px_88px_150px]';

export default function AdminLogs() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  // 骨架屏最短驻留：数据太快时也保证加载动画可见（§33）
  const showSkeleton = useMinLoading(loading);
  /** 双表结构：表体横向滚动时表头同步平移，列保持对齐（表头表在滚动容器外） */
  const headerTableRef = useRef<HTMLTableElement>(null);
  const syncHeaderScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (headerTableRef.current) headerTableRef.current.style.transform = `translateX(-${e.currentTarget.scrollLeft}px)`;
  };
  const [sort, setSort] = useState<string | null>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    setLoading(true);
    void apiFetch<{ logs: LogRow[]; pagination: { total: number } }>(`/api/admin/logs?page=${page}&limit=${pageSize}`)
      .then((res) => {
        setLogs(res.data.logs);
        setTotal(res.data.pagination.total);
        setLoading(false);
      });
  }, [page, pageSize]);

  const sortedRows = useMemo(() => {
    if (!sort) return logs;
    return sortByKey(logs, sort as keyof LogRow, order);
  }, [logs, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">

      {/* 表头与数据行同在卡片玻璃上（提交版双表结构）；表体横向滚动时表头同步平移保持列对齐 */}
      <Card className="reveal mt-3 flex min-h-0 flex-1 flex-col py-0 overflow-hidden" style={revealDelay(0)}>
        {/* 裁剪放外层包裹：表体横向滚动时表头表格整体平移，右侧被裁的列随之进入视野 */}
        <div className="w-full shrink-0 overflow-hidden [scrollbar-gutter:stable]">
          <table ref={headerTableRef} className="block w-full text-sm">
            <thead className="block">
              <tr className={LOG_ROW_GRID + ' whitespace-nowrap border-b text-left text-muted-foreground'}>
                <th className="px-4 py-2"><SortableHeader title={t('admin.logs.action')} sortKey="action" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
                <th className="px-4 py-2">{t('admin.logs.path')}</th>
                <th className="px-4 py-2">{t('admin.user')}</th>
                <th className="hidden px-4 py-2 md:block">IP</th>
                <th className="px-4 py-2"><SortableHeader title={t('admin.logs.bytes')} sortKey="bytesTransferred" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
                <th className="px-4 py-2"><SortableHeader title={t('admin.logs.time')} sortKey="createdAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              </tr>
            </thead>
          </table>
        </div>
        <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" onScroll={syncHeaderScroll}>
          <table className="block w-full text-sm">
            <tbody className="block">
              {showSkeleton ? (
                <tr className="block"><td className="block px-4 py-2"><TableSkeleton rows={6} cols={5} /></td></tr>
              ) : logs.length === 0 ? (
                <tr className="block"><td className="block px-4 py-2"><EmptyState icon={<ScrollText className="h-7 w-7" />} title={t('admin.logs.empty')} description={t('admin.logs.emptyDesc')} /></td></tr>
              ) : sortedRows.map((l, i) => (
                <tr key={l.id} className={LOG_ROW_GRID + ' reveal-row border-b last:border-0 hover:bg-accent/50'} style={revealDelay(i, 'inner')}>
                  <td className="px-4 py-2"><Badge variant={(ACTION_COLOR[l.action] as 'success' | 'default' | 'secondary' | 'destructive' | 'outline') ?? 'secondary'}>{l.action}</Badge></td>
                  <td className="truncate px-4 py-2 font-mono text-xs">{l.path ?? '-'}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{l.userId ? l.userId.slice(0, 8) : t('admin.logs.anonymous')}</td>
                  <td className="hidden px-4 py-2 text-xs text-muted-foreground md:block">{l.ipAddress ?? '-'}</td>
                  <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">{l.bytesTransferred ? formatBytes(l.bytesTransferred) : '-'}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {total > 0 && (
  <div className="shrink-0 pt-2">
        <Pagination
          page={page}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
  </div>
      )}
    </div>
  );
}
