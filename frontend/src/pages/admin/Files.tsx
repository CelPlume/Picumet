// 管理员：全部文件
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Card, Input } from '@/components/ui/core';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import FileIcon from '@/components/files/FileIcon';
import type { FileListItem } from '@shared/types';

export default function AdminFiles() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = async (q = '') => {
    const res = await apiFetch<{ items: FileListItem[]; pagination: { total: number } }>(
      `/api/admin/files?page=${page}&limit=${pageSize}&search=${encodeURIComponent(q)}`
    );
    setFiles(res.data.items);
    setTotal(res.data.pagination.total);
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

  return (
    <div className="space-y-3">
      <div className="relative w-72">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索文件名" />
      </div>
      <div className="space-y-1">
        {files.map((f) => (
          <div key={f.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
            <FileIcon name={f.name} type={f.type} className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <code className="hidden max-w-[240px] truncate text-xs text-muted-foreground md:block">{f.path}</code>
            <span className="shrink-0 text-muted-foreground">{f.type === 'folder' ? '-' : formatBytes(f.size)}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(f.updatedAt)}</span>
          </div>
        ))}
        {files.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无文件</p>}
      </div>

      {total > 0 && (
        <Pagination
          page={page}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </div>
  );
}
