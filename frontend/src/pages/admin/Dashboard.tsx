// 管理员仪表板：四张紧凑统计卡 + 活跃挂载点关系图 + 存储使用/近期活动（GET /api/admin/dashboard）
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Files, HardDrive, Database, Activity } from 'lucide-react';
import { Card, CardContent, EmptyState, Progress } from '@/components/ui/core';
import { StatCardSkeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';

interface DashboardStats {
  users: { total: number; active: number };
  userRoles: { admin: number; user: number; guest: number };
  files: number;
  providers: number;
  activeMounts: number;
  usedSpace: number;
  totalCapacity: number | null;
}

interface DashboardMount {
  id: string;
  name: string;
  mountPath: string;
  status: string;
  capacityBytes: number | null;
  usedSpace: number;
  fileCount: number;
  provider: { id: string; name: string; bucket: string };
  standbys: Array<{ id: string; name: string; bucket: string; weight: number }>;
}

interface DashboardActivity {
  type: string;
  message: string;
  timestamp: number;
}

interface DashboardData {
  stats: DashboardStats;
  mounts: DashboardMount[];
  recentActivity: DashboardActivity[];
}

/** 关系图：挂载点名 pill → 主桶 pill（实底）→ 备用桶 pills（琥珀描边），
    pill 间以短横线段连接（aria-hidden，随 flex-wrap 折行） */

export default function AdminDashboard() {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const user = useAuth((s) => s.user);

  useEffect(() => {
    void apiFetch<DashboardData>('/api/admin/dashboard').then((res) => setData(res.data));
  }, []);

  const stats = data?.stats;
  const mounts = data?.mounts ?? [];

  // 四张紧凑卡（约 90px 高）：图标 + 标签 + 大数字（≤text-2xl）+ 小字补充
  const cards = stats
    ? [
        {
          icon: <Users className="h-3.5 w-3.5" />,
          label: t('admin.dashboard.usersOverview'),
          value: String(stats.users.total),
          sub: (
            <span className="truncate text-[11px] text-muted-foreground">
              {t('admin.dashboard.roleAdmin')} {stats.userRoles.admin} · {t('admin.dashboard.roleUser')} {stats.userRoles.user} · {t('admin.dashboard.roleGuest')} {stats.userRoles.guest}
            </span>
          ),
        },
        {
          icon: <HardDrive className="h-3.5 w-3.5" />,
          label: t('admin.dashboard.memoryUsage'),
          value: formatBytes(stats.usedSpace),
          sub:
            stats.totalCapacity != null && stats.totalCapacity > 0 ? (
              <Progress value={Math.min(100, (stats.usedSpace / stats.totalCapacity) * 100)} className="mt-0.5 h-1.5 w-full" />
            ) : (
              <span className="text-[11px] text-muted-foreground">{t('admin.dashboard.capacityUnset')}</span>
            ),
        },
        { icon: <Files className="h-3.5 w-3.5" />, label: t('admin.totalFiles'), value: String(stats.files), sub: null },
        { icon: <Database className="h-3.5 w-3.5" />, label: t('admin.dashboard.bucketCount'), value: String(stats.providers), sub: null },
      ]
    : [];

  return (
    <div className="h-full space-y-2 overflow-y-auto scrollbar-none">
      {/* 顶部统计卡：md 以下纵向堆叠 */}
      {!stats ? (
        <StatCardSkeleton count={4} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {cards.map((c) => (
            <Card key={c.label}>
              <CardContent className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{c.icon}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] leading-tight text-muted-foreground">{c.label}</p>
                    <p className="text-lg font-semibold leading-tight">{c.value}</p>
                    {c.sub && <div className="truncate text-[10px] leading-tight text-muted-foreground">{c.sub}</div>}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 底部：左 挂载点关系图（3/5）+ 右 存储使用/近期活动（2/5） */}
      {stats && (
        <div className="grid items-start gap-3 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardContent className="p-3">
              <h3 className="mb-3 flex items-center gap-2 font-medium">
                {t('admin.dashboard.activeMounts')}
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{stats.activeMounts}</span>
              </h3>
              {mounts.length === 0 ? (
                <EmptyState compact icon={<Database className="h-4 w-4" />} title={t('admin.dashboard.noMounts')} description={t('admin.dashboard.noMountsDesc')} />
              ) : (
                <div className="space-y-2">
                  {mounts.map((m) => (
                    <div key={m.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                      {/* 挂载点名 */}
                      <span
                        className="inline-flex max-w-full items-center truncate rounded-full bg-muted px-2.5 py-1 text-xs font-medium"
                        title={m.mountPath}
                      >
                        {m.name}
                      </span>
                      <span aria-hidden className="h-px w-4 shrink-0 bg-border" />
                      {/* 主桶（在用「拼好桶」，实底） */}
                      <span
                        className="inline-flex max-w-full items-center truncate rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                        title={`${m.provider.name} · ${m.provider.bucket}`}
                      >
                        {m.provider.name}
                      </span>
                      {/* 备用桶（琥珀描边） */}
                      {m.standbys.map((s) => (
                        <Fragment key={s.id}>
                          <span aria-hidden className="h-px w-4 shrink-0 bg-border" />
                          <span
                            className="inline-flex max-w-full items-center truncate rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400"
                            title={`${s.name} · ${s.bucket}`}
                          >
                            {s.name}
                            <span className="ml-1 opacity-60">×{s.weight}</span>
                          </span>
                        </Fragment>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {mounts.length > 0 && (
                <div className="mt-3 flex items-center gap-4 border-t pt-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                    {t('admin.dashboard.primaryBucket')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full border border-amber-500/60 bg-amber-500/20" />
                    {t('admin.dashboard.standbyBucket')}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3 lg:col-span-2">
            <Card>
              <CardContent className="p-3">
                <h3 className="mb-2 font-medium">{t('admin.storageUsage')}</h3>
                <div className="space-y-2.5">
                  {mounts.length === 0 ? (
                    <EmptyState compact icon={<HardDrive className="h-4 w-4" />} title={t('admin.dashboard.noStorage')} description={t('admin.dashboard.noStorageDesc')} />
                  ) : (
                    mounts.map((m) => (
                      <div key={m.id}>
                        <div className="mb-1 flex justify-between gap-2 text-sm">
                          <span className="truncate">{m.name}</span>
                          <span className="shrink-0 text-muted-foreground">
                            {formatBytes(m.usedSpace)} · {t('admin.dashboard.filesCount', { count: m.fileCount })}
                          </span>
                        </div>
                        {/* 无容量数据时只出数字，不画进度条 */}
                        {m.capacityBytes != null && m.capacityBytes > 0 && (
                          <div className="h-1 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (m.usedSpace / m.capacityBytes) * 100)}%` }} />
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-3">
                <h3 className="mb-2 font-medium">{t('admin.recentActivity')}</h3>
                <div className="space-y-2">
                  {(data?.recentActivity ?? []).length === 0 ? (
                    <EmptyState compact icon={<Activity className="h-4 w-4" />} title={t('admin.dashboard.noActivity')} description={t('admin.dashboard.noActivityDesc')} />
                  ) : (
                    data?.recentActivity.slice(0, 6).map((a, i) => (
                      <div key={`${a.timestamp}-${i}`} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                        <div className="min-w-0 truncate">{a.message}</div>
                        <div className="ml-2 shrink-0 text-xs text-muted-foreground">{formatDateTime(a.timestamp)}</div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {t('admin.dashboard.currentAdmin')}
        <span className="font-medium">{user?.username}</span>
      </p>
    </div>
  );
}
