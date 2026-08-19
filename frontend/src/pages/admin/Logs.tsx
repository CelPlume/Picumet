// 管理员：访问日志
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText } from 'lucide-react';
import { Card, Badge } from '@/components/ui/core';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    void apiFetch<{ logs: LogRow[]; pagination: { total: number } }>(`/api/admin/logs?page=${page}&limit=${pageSize}`)
      .then((res) => {
        setLogs(res.data.logs);
        setTotal(res.data.pagination.total);
      });
  }, [page, pageSize]);

  return (
    <div className="space-y-2">
      {logs.map((l) => (
        <Card key={l.id} className="flex items-center gap-3 p-3 text-sm">
          <ScrollText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Badge variant={(ACTION_COLOR[l.action] as 'success' | 'default' | 'secondary' | 'destructive' | 'outline') ?? 'secondary'}>
            {l.action}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{l.path ?? '-'}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground md:block">{l.userId ? l.userId.slice(0, 8) : '匿名'}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{l.ipAddress ?? '-'}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{l.bytesTransferred ? formatBytes(l.bytesTransferred) : '-'}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(l.createdAt)}</span>
        </Card>
      ))}
      {logs.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无日志</p>}

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
