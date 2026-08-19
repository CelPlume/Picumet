// 管理员：全部分享
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Link2 } from 'lucide-react';
import { Card, Badge } from '@/components/ui/core';
import { Pagination } from '@/components/ui/pagination';
import { toast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = async () => {
    const res = await apiFetch<{ items: ShareRow[]; pagination: { total: number } }>(`/api/admin/shares?page=${page}&limit=${pageSize}`);
    setShares(res.data.items);
    setTotal(res.data.pagination.total);
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

  return (
    <div className="space-y-2">
      {shares.map((s) => (
        <Card key={s.id} className="flex items-center gap-3 p-3">
          <Link2 className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{s.title ?? s.file?.name}</p>
            <p className="text-xs text-muted-foreground">
              {s.creatorId} · {s.file ? formatBytes(s.file.size) : ''} · 创建于 {formatDateTime(s.createdAt)}
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            <p>{s.viewCount} 浏览 · {s.downloadCount} 下载</p>
            <p>{s.expiresAt ? `过期: ${formatDateTime(s.expiresAt)}` : '永久'}</p>
          </div>
          <Badge variant={s.status === 'active' ? 'success' : 'secondary'}>{s.status}</Badge>
          <button onClick={() => revoke(s.id)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
            <Trash2 className="h-4 w-4" />
          </button>
        </Card>
      ))}
      {shares.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无分享</p>}

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
