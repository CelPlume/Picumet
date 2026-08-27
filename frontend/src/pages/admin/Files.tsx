// 管理员：全部文件
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Card, Input } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';
import { formatBytes, formatDateTime } from '@/lib/utils';
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative w-72">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索文件名" />
      </div>
      <Card className="mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2"><SortableHeader title="文件名" sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="hidden px-4 py-2 md:table-cell">路径</th>
              <th className="px-4 py-2"><SortableHeader title="大小" sortKey="size" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title="更新时间" sortKey="updatedAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4}><TableSkeleton rows={6} cols={4} /></td></tr>
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
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && files.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无文件</p>}
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
