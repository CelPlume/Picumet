// 管理员：全部分享
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Link2 } from 'lucide-react';
import { Card, Badge } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { toast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';
import { formatDateTime, formatBytes } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

interface ShareRow {
  id: string;
  title?: string;
  creatorId: string;
  file: FileListItem | null;
  viewCount: number;
  downloadCount: number;
  status: string;
  createdAt: number;
  expiresAt?: number;
}

export default function AdminShares() {
  const { t } = useTranslation();
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<string | null>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = async () => {
    setLoading(true);
    const res = await apiFetch<{ items: ShareRow[]; pagination: { total: number } }>(`/api/admin/shares?page=${page}&limit=${pageSize}`);
    setShares(res.data.items);
    setTotal(res.data.pagination.total);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  const revoke = async (id: string) => {
    await apiFetch(`/api/admin/shares/${id}`, { method: 'DELETE' });
    toast('success', '已撤销');
    await load();
  };

  const sortedRows = useMemo(() => {
    if (!sort) return shares;
    return sortByKey(shares, sort as keyof ShareRow, order);
  }, [shares, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">

      <Card className="mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2"><SortableHeader title="标题" sortKey="title" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">创建者</th>
              <th className="px-4 py-2"><SortableHeader title="浏览" sortKey="viewCount" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title="下载" sortKey="downloadCount" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title="过期时间" sortKey="expiresAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">状态</th>
              <th className="px-4 py-2">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><TableSkeleton rows={6} cols={5} /></td></tr>
            ) : sortedRows.map((s) => (
              <tr key={s.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate font-medium">{s.title ?? s.file?.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{s.creatorId}</td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{s.viewCount}</td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{s.downloadCount}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{s.expiresAt ? formatDateTime(s.expiresAt) : '永久'}</td>
                <td className="px-4 py-2"><Badge variant={s.status === 'active' ? 'success' : 'secondary'}>{s.status}</Badge></td>
                <td className="px-4 py-2">
                  <button onClick={() => revoke(s.id)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10" title="撤销">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && shares.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无分享</p>}
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
