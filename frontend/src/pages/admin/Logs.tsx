// 管理员：访问日志
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText } from 'lucide-react';
import { Card, Badge, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';
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
  share: 'secondary',
  delete: 'destructive',
  login: 'outline',
};

export default function AdminLogs() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
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

      <Card className="mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2"><SortableHeader title={t('admin.logs.action')} sortKey="action" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('admin.logs.path')}</th>
              <th className="px-4 py-2">{t('admin.user')}</th>
              <th className="hidden px-4 py-2 md:table-cell">IP</th>
              <th className="px-4 py-2"><SortableHeader title={t('admin.logs.bytes')} sortKey="bytesTransferred" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title={t('admin.logs.time')} sortKey="createdAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><TableSkeleton rows={6} cols={5} /></td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={6}><EmptyState icon={<ScrollText className="h-7 w-7" />} title={t('admin.logs.empty')} description={t('admin.logs.emptyDesc')} /></td></tr>
            ) : sortedRows.map((l) => (
              <tr key={l.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2"><Badge variant={(ACTION_COLOR[l.action] as 'success' | 'default' | 'secondary' | 'destructive' | 'outline') ?? 'secondary'}>{l.action}</Badge></td>
                <td className="max-w-[260px] truncate px-4 py-2 font-mono text-xs">{l.path ?? '-'}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{l.userId ? l.userId.slice(0, 8) : t('admin.logs.anonymous')}</td>
                <td className="hidden px-4 py-2 text-xs text-muted-foreground md:table-cell">{l.ipAddress ?? '-'}</td>
                <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">{l.bytesTransferred ? formatBytes(l.bytesTransferred) : '-'}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(l.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
