// 管理员仪表板
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Files, HardDrive, Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/core';
import { StatCardSkeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { useAuth } from '@/stores/auth';

interface Stats {
  users: { total: number; active: number };
  files: { total: number; size: number };
  storage: Array<{ providerId: string; name: string; usedSpace: number; fileCount: number }>;
  recentActivity: Array<{ type: string; message: string; timestamp: number }>;
}

export default function AdminDashboard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const user = useAuth((s) => s.user);

  useEffect(() => {
    void apiFetch<Stats>('/api/admin/stats').then((res) => setStats(res.data));
  }, []);

  const cards = stats
    ? [
        { icon: <Users className="h-5 w-5" />, label: t('admin.totalUsers'), value: String(stats.users.total), sub: `${t('admin.activeUsers')}: ${stats.users.active}` },
        { icon: <Files className="h-5 w-5" />, label: t('admin.totalFiles'), value: String(stats.files.total), sub: formatBytes(stats.files.size) },
        { icon: <HardDrive className="h-5 w-5" />, label: t('admin.storageUsage'), value: stats.storage.length ? formatBytes(stats.storage[0]?.usedSpace ?? 0) : '0 B', sub: `${stats.storage.length} 存储源` },
        { icon: <Activity className="h-5 w-5" />, label: t('admin.requests24h'), value: '-', sub: '近 24 小时' },
      ]
    : [];

  return (
    <div className="h-full space-y-6 overflow-y-auto scrollbar-none">
      {!stats ? <StatCardSkeleton count={4} /> : (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">{c.icon}</div>
              <div>
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className="text-xl font-semibold">{c.value}</p>
                <p className="text-xs text-muted-foreground">{c.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 font-medium">{t('admin.storageUsage')}</h3>
            <div className="space-y-3">
              {stats?.storage.map((s) => (
                <div key={s.providerId}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{s.name}</span>
                    <span className="text-muted-foreground">{formatBytes(s.usedSpace)} · {s.fileCount} 文件</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: '60%' }} />
                  </div>
                </div>
              ))}
              {(!stats?.storage || stats.storage.length === 0) && (
                <p className="text-sm text-muted-foreground">暂无存储数据</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 font-medium">{t('admin.recentActivity')}</h3>
            <div className="space-y-2">
              {stats?.recentActivity.map((a, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">{a.message}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {new Date(a.timestamp).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
              {(!stats?.recentActivity || stats.recentActivity.length === 0) && (
                <p className="text-sm text-muted-foreground">暂无活动</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        当前管理员：<span className="font-medium">{user?.username}</span>
      </p>
    </div>
  );
}
