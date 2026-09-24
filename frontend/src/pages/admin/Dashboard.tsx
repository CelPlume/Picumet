// 管理员仪表板：四张紧凑统计卡 + 活跃挂载点关系图 + 存储使用/近期活动（GET /api/admin/dashboard）
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Files, HardDrive, Database, Activity } from 'lucide-react';
import { Card, CardContent, EmptyState, Progress } from '@/components/ui/core';
import { StatCardSkeleton } from '@/components/ui/skeleton';
import { revealDelay, innerDelay } from '@/components/ui/reveal';
import { apiFetch } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { BucketMountGraph } from '@/components/admin/BucketMountGraph';
import { TrendCard } from '@/components/charts/TrendCard';
import type { BucketNode } from '@/components/files/data';

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
  buckets: BucketNode[];
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
          icon: <Users className="h-5 w-5" />,
          label: t('admin.dashboard.usersOverview'),
          value: String(stats.users.total),
          sub: (
            <span className="truncate text-[11px] text-muted-foreground">
              {t('admin.dashboard.roleAdmin')} {stats.userRoles.admin} · {t('admin.dashboard.roleUser')} {stats.userRoles.user} · {t('admin.dashboard.roleGuest')} {stats.userRoles.guest}
            </span>
          ),
        },
        {
          icon: <HardDrive className="h-5 w-5" />,
          label: t('admin.dashboard.memoryUsage'),
          value: formatBytes(stats.usedSpace),
          sub:
            stats.totalCapacity != null && stats.totalCapacity > 0 ? (
              <Progress value={Math.min(100, (stats.usedSpace / stats.totalCapacity) * 100)} className="mt-0.5 h-1.5 w-full" />
            ) : (
              <span className="text-[11px] text-muted-foreground">{t('admin.dashboard.capacityUnset')}</span>
            ),
        },
        { icon: <Files className="h-5 w-5" />, label: t('admin.totalFiles'), value: String(stats.files), sub: null },
        { icon: <Database className="h-5 w-5" />, label: t('admin.dashboard.bucketCount'), value: String(stats.providers), sub: null },
      ]
    : [];

  return (
    <div className="h-full space-y-4 overflow-y-auto scrollbar-none">
      {/* 顶部统计卡：md 以下纵向堆叠 */}
      {!stats ? (
        <StatCardSkeleton count={4} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {cards.map((c, i) => (
            <Card key={c.label} className="reveal" style={revealDelay(i)}>
              <CardContent className="px-3 py-1">
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{c.icon}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs leading-tight text-muted-foreground">{c.label}</p>
                    <p className="text-xl font-semibold leading-tight">{c.value}</p>
                    {c.sub && <div className="truncate text-[11px] leading-tight text-muted-foreground">{c.sub}</div>}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 底部：左列（3/5）存储使用 → 活跃挂载点上下堆叠，右列（2/5）趋势面板（下载/分享/登录）。
          lg 以下左列整体先于右列渲染，故堆叠顺序为 存储使用 → 活跃挂载点 → 趋势。
          间距与 /admin/settings 统一：卡片纵向 16px（space-y-4/gap-4）、双栏横向 24px（lg:gap-6）。
          入场次序：顶部 4 张统计卡（0-3）之后，三张卡按 4-6 错开（动画档 all 时可见，§33） */}
      {stats && (
        <div className="grid items-start gap-4 lg:grid-cols-5 lg:gap-6">
          <div className="flex flex-col gap-4 lg:col-span-3">
            <Card className="reveal py-3" style={revealDelay(4)}>
              <CardContent className="p-3">
                <h3 className="mb-2 font-medium">{t('admin.storageUsage')}</h3>
                <div className="space-y-2.5">
                  {mounts.length === 0 ? (
                    <EmptyState compact icon={<HardDrive className="h-4 w-4" />} title={t('admin.dashboard.noStorage')} description={t('admin.dashboard.noStorageDesc')} />
                  ) : (
                    mounts.map((m, i) => (
                      <div key={m.id} className="reveal" style={innerDelay(4, i)}>
                        <div className="mb-1 flex justify-between gap-2 text-sm">
                          <span className="truncate">{m.name}</span>
                          <span className="shrink-0 text-muted-foreground">
                            {/* 有容量时把分母一并标出（否则只有已用，看不出比例）；无容量只出已用 */}
                            {m.capacityBytes != null && m.capacityBytes > 0
                              ? `${formatBytes(m.usedSpace)} / ${formatBytes(m.capacityBytes)}`
                              : formatBytes(m.usedSpace)}{' '}
                            · {t('admin.dashboard.filesCount', { count: m.fileCount })}
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

            <Card className="reveal py-3" style={revealDelay(5)}>
              <CardContent className="p-3">
                <h3 className="mb-3 flex items-center gap-2 font-medium">
                  {t('admin.dashboard.activeMounts')}
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{stats.activeMounts}</span>
                </h3>
                {(data?.buckets ?? []).length === 0 ? (
                  <EmptyState compact icon={<Database className="h-4 w-4" />} title={t('admin.dashboard.noMounts')} description={t('admin.dashboard.noMountsDesc')} />
                ) : (
                  <div className="reveal-row" style={innerDelay(5, 1)}>
                    <BucketMountGraph buckets={data?.buckets ?? []} />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 趋势面板（替代原近期活动）：下载 / 分享 / 登录三条曲线，自带粒度与时间范围筛选 */}
          <div className="reveal lg:col-span-2" style={revealDelay(6)}>
            <TrendCard />
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
