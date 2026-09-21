// 管理员：全部文件（含公开审核，§4.2）
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Check, X, Files } from 'lucide-react';
import { Card, Input, Badge, EmptyState, SEARCH_INPUT_GLASS } from '@/components/ui/core';
import { cn } from '@/lib/utils';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import FileIcon from '@/components/files/FileIcon';
import type { FileListItem } from '@shared/types';

export default function AdminFiles() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<string | null>('updatedAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = async (q = '') => {
    setLoading(true);
    const res = await apiFetch<{ items: FileListItem[]; pagination: { total: number } }>(
      `/api/admin/files?page=${page}&limit=${pageSize}&search=${encodeURIComponent(q)}`
    );
    setFiles(res.data.items);
    setTotal(res.data.pagination.total);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  useEffect(() => {
    const t = setTimeout(() => { setPage(1); void load(search); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const sortedRows = useMemo(() => {
    if (!sort) return files;
    return sortByKey(files, sort as keyof FileListItem, order);
  }, [files, sort, order]);

  const review = async (f: FileListItem, status: 'approved' | 'rejected') => {
    try {
      await apiFetch(`/api/admin/files/${f.id}/review`, { method: 'PATCH', body: { status } });
      toast('success', status === 'approved' ? t('admin.allFiles.approved') : t('admin.allFiles.rejected'));
      await load(search);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('admin.operationFailed'));
    }
  };

  const setVisibility = async (f: FileListItem, visibility: 'private' | 'users' | 'public') => {
    try {
      await apiFetch(`/api/admin/files/${f.id}/review`, { method: 'PATCH', body: { visibility } });
      toast('success', t('admin.allFiles.visibilityUpdated'));
      await load(search);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('admin.operationFailed'));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative w-72">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
        <Input className={cn('pl-8', SEARCH_INPUT_GLASS)} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('files.searchPlaceholder')} />
      </div>
      <Card className="mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2"><SortableHeader title={t('files.name')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="hidden px-4 py-2 md:table-cell">{t('admin.allFiles.path')}</th>
              <th className="px-4 py-2"><SortableHeader title={t('files.size')} sortKey="size" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title={t('files.modified')} sortKey="updatedAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('admin.allFiles.publicStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5}><TableSkeleton rows={6} cols={4} /></td></tr>
            ) : files.length === 0 ? (
              <tr><td colSpan={5}><EmptyState icon={<Files className="h-7 w-7" />} title={t('admin.allFiles.emptyTitle')} description={t('admin.allFiles.emptyDesc')} /></td></tr>
            ) : sortedRows.map((f) => (
              <tr key={f.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <FileIcon name={f.name} type={f.type} className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                  </div>
                </td>
                <td className="hidden max-w-[240px] truncate px-4 py-2 font-mono text-xs text-muted-foreground md:table-cell">{f.path}</td>
                <td className="px-4 py-2 text-muted-foreground">{f.type === 'folder' ? '-' : formatBytes(f.size)}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(f.updatedAt)}</td>
                <td className="px-4 py-2">
                  {f.visibility === 'public' ? (
                    f.reviewStatus === 'pending' ? (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="warning">{t('admin.allFiles.pendingReview')}</Badge>
                        <button onClick={() => void review(f, 'approved')} className="rounded p-1 text-emerald-600 hover:bg-accent" title={t('admin.allFiles.approve')}><Check className="h-4 w-4" /></button>
                        <button onClick={() => void review(f, 'rejected')} className="rounded p-1 text-destructive hover:bg-accent" title={t('admin.allFiles.reject')}><X className="h-4 w-4" /></button>
                      </div>
                    ) : f.reviewStatus === 'approved' ? (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="success">{t('admin.allFiles.published')}</Badge>
                        <button onClick={() => void setVisibility(f, 'private')} className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" title={t('admin.allFiles.unpublishTitle')}>{t('admin.allFiles.unpublish')}</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="warning">{t('admin.allFiles.rejected')}</Badge>
                        <button onClick={() => void review(f, 'approved')} className="rounded p-1 text-emerald-600 hover:bg-accent" title={t('admin.allFiles.approve')}><Check className="h-4 w-4" /></button>
                      </div>
                    )
                  ) : f.visibility === 'users' ? (
                    <div className="flex items-center gap-1.5">
                      <Badge>{t('admin.allFiles.usersOnly')}</Badge>
                      <button onClick={() => void setVisibility(f, 'private')} className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" title={t('admin.allFiles.setPrivate')}>{t('admin.allFiles.makePrivate')}</button>
                      <button onClick={() => void setVisibility(f, 'public')} className="rounded px-1.5 py-0.5 text-xs text-emerald-600 hover:bg-accent" title={t('admin.allFiles.setPublic')}>{t('admin.allFiles.makePublic')}</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{t('admin.allFiles.private')}</span>
                      <button onClick={() => void setVisibility(f, 'public')} className="rounded px-1.5 py-0.5 text-xs text-emerald-600 hover:bg-accent" title={t('admin.allFiles.setPublic')}>{t('admin.allFiles.makePublic')}</button>
                    </div>
                  )}
                </td>
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
