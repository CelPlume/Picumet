// 桶泳道图（git-graph 风格，参考 git-graph-svg 的泳道/节点语言）：
// 最外层 = 存储桶泳道（彩色纵向 lane + 节点圆点），下一级 = 挂载点节点，展开层按模式分两种：
// - 仪表盘（BucketMountGraph）：展开 = 顶层文件夹 + 递归文件计数（只显示计数）
// - 全部文件挂载点视图（MountView）：展开 = 本桶物理存储的具体文件（分页加载）
// 备份桶：某挂载点的备用池成员且本桶 0 文件 → 琥珀 badge，点击高亮主桶的桶→挂载点树（3s 熄灭）；
// 拼好桶：挂载点节点出现在每个持有其文件的桶泳道上，展开只列本桶存储的文件。
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CornerUpLeft, Database, Folder, Settings2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import FileIcon from '@/components/files/FileIcon';
import { useMountFolderSummary, useMountTreeQuery, type BucketMountNode, type BucketNode, type TreeFileRow } from '@/components/files/data';
import { EmptyState } from '@/components/ui/core';
import type { FileListItem } from '@shared/types';

/** 泳道配色：按桶 id 稳定散列（git-graph-svg 默认色板的低饱和近亲，贴主题灰底） */
const LANE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
function laneColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

/** 备份桶 badge：点击高亮主桶泳道（主桶的桶→挂载点树），滚动定位 + 3 秒后自动熄灭 */
function StandbyBadge({ standby, onHighlight }: { standby: BucketNode['standbys'][number]; onHighlight: (providerId: string) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onHighlight(standby.primaryProviderId)}
      title={t('admin.allFiles.highlightPrimary', { name: standby.primaryProviderName })}
      className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0" />
      <span className="truncate">{t('admin.allFiles.standbyFor', { mount: standby.mountName })}</span>
      <span className="shrink-0 opacity-60">→ {standby.primaryProviderName}</span>
    </button>
  );
}

/** 泳道壳：桶头（level 0 圆点，x 圆心 6px；折叠空心/展开实心，无外圈）；
    highlighted = 主桶树高亮态（badge 点击）。level-0 引导线由各挂载点行分段绘制，
    止于最后一个挂载点圆心，避免穿过任何空心圆 */
function BucketLane({
  b,
  highlighted,
  open,
  onToggle,
  children,
}: {
  b: BucketNode;
  highlighted?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const color = laneColor(b.id);
  return (
    <div
      data-bucket-lane={b.id}
      className={cn('relative rounded-lg pl-6 transition-colors', highlighted && 'bg-primary/5 shadow-[inset_0_0_0_1.5px_hsl(var(--primary)/0.45)]')}
    >
      {/* 桶头节点（点击折叠/展开挂载点） */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="relative flex min-w-0 flex-wrap items-center gap-2 rounded-md py-1 pr-2 text-left transition-colors hover:bg-accent/40"
      >
        <span
          aria-hidden
          className={cn('absolute -left-6 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full', !open && 'border-2 bg-transparent')}
          style={open ? { backgroundColor: color } : { borderColor: color }}
        />
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="inline-flex max-w-full items-center truncate rounded-full px-2.5 py-1 text-xs font-semibold text-white" style={{ backgroundColor: color }} title={`${b.name} · ${b.bucket}`}>
          {b.name}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={b.bucket}>{b.bucket}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t('admin.dashboard.filesCount', { count: b.fileCount })} · {formatBytes(b.usedSpace)}
        </span>
      </button>
      {open && (
        <div className="relative">
          {/* 桶圆点 → 第一个挂载点之间的泳道补段 */}
          {b.mounts.length > 0 && <span aria-hidden className="absolute -left-[19px] top-[22px] h-2.5 w-0.5 rounded-full" style={{ backgroundColor: `${color}55` }} />}
          <div className="space-y-1 pb-1">{children}</div>
        </div>
      )}
    </div>
  );
}

/** 挂载点节点行：分叉连接线（桶泳道 → 圆点）+ level-1 圆点与子树引导线。
    坐标系（泳道容器内）：桶泳道圆心 x=6；挂载点圆点（level 1）圆心 x=20——不同层级不同缩进；
    level-1 引导线起于挂载点圆点下方、止于最后一个子行的行高中点，空心圆内不穿线 */
function MountNodeShell({
  color,
  m,
  open,
  onToggle,
  isLast,
  children,
}: {
  color: string;
  m: BucketMountNode;
  open: boolean;
  onToggle: () => void;
  isLast: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="relative flex min-w-0 items-center gap-1.5">
        {/* level-0 泳道段：贯穿本行并上下越过 5px 封住行距缝（末行止于行高中点）；圆心 x=6 */}
        <span
          aria-hidden
          className={cn('absolute -left-[19px] w-0.5 rounded-full', isLast ? 'bottom-1/2 top-[-5px]' : 'bottom-[-5px] top-[-5px]')}
          style={{ backgroundColor: `${color}55` }}
        />
        {/* 分叉连接线：桶圆点右缘 x12 → 挂载点圆点左缘 x22 */}
        <span aria-hidden className="absolute -left-[12px] top-1/2 h-0.5 w-[10px]" style={{ backgroundColor: `${color}66` }} />
        {/* 挂载点圆点（level 1，圆心 x28）；空心/实心随展开态，无外圈 */}
        <span
          aria-hidden
          className={cn('absolute -left-[2px] top-1/2 z-10 h-3 w-3 -translate-y-1/2 rounded-full', !open && 'border-2 bg-transparent')}
          style={open ? { backgroundColor: color } : { borderColor: color }}
        />
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'ml-4 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/60',
            open && 'bg-accent/60'
          )}
          aria-expanded={open}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="truncate text-xs font-medium" title={m.mountPath}>{m.name}</span>
          <span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:block">{m.mountPath}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {t('admin.dashboard.filesCount', { count: m.fileCount })} · {formatBytes(m.usedSpace)}
          </span>
        </button>
      </div>
      {open && (
        // level-1 子树：引导线圆心 x28，顶端贴挂载点圆点下缘（-8px），止于最后一个子行行高中点
        <div className="relative ml-[3px]">
          <span aria-hidden className="absolute bottom-[14px] left-0 top-[-8px] w-0.5" style={{ backgroundColor: `${color}55` }} />
          <div className="pl-4">{children}</div>
        </div>
      )}
    </div>
  );
}

/** 主桶树高亮：badge 点击 → 泳道描边 + 滚动定位，3 秒自动熄灭（仪表盘/挂载点视图共用） */
function useLaneHighlight() {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const highlight = (id: string) => {
    setHighlightId(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlightId(null), 3000);
    requestAnimationFrame(() => {
      document.querySelector(`[data-bucket-lane="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { highlightId, highlight };
}

// 仪表盘节点：展开 = 顶层文件夹 + 递归文件计数（只显示计数，不显示具体文件）
function DashboardBucketGraphInner({ buckets }: { buckets: BucketNode[] }) {
  const { t } = useTranslation();
  // 挂载点展开集合（可同时展开多个）；桶默认展开，collapsedBuckets 记录被折叠的桶
  const [openMounts, setOpenMounts] = useState<Set<string>>(new Set());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set());
  const { highlightId, highlight } = useLaneHighlight();
  const toggleMount = (key: string) => {
    setOpenMounts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleBucket = (id: string) => {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div className="space-y-3">
      {buckets.map((b) => {
        const color = laneColor(b.id);
        const bucketOpen = !collapsedBuckets.has(b.id);
        return (
          <BucketLane key={b.id} b={b} highlighted={highlightId === b.id} open={bucketOpen} onToggle={() => toggleBucket(b.id)}>
            {b.mounts.length === 0 && b.standbys.length === 0 && (
              <p className="px-2 py-0.5 text-[11px] text-muted-foreground">{t('admin.dashboard.bucketNoMounts')}</p>
            )}
            {b.mounts.map((m, mi) => {
              const key = `${b.id}:${m.id}`;
              const open = openMounts.has(key);
              return (
                <MountNodeShell key={key} color={color} m={m} open={open} onToggle={() => toggleMount(key)} isLast={mi === b.mounts.length - 1}>
                  <MountFolderSummary mountId={m.id} providerId={b.id} />
                </MountNodeShell>
              );
            })}
            {b.standbys.map((s) => (
              <div key={`${b.id}:${s.mountId}`} className="flex min-w-0 items-center px-2 py-0.5">
                <StandbyBadge standby={s} onHighlight={highlight} />
              </div>
            ))}
          </BucketLane>
        );
      })}
    </div>
  );
}

/** 挂载点展开层（仪表盘）：顶层文件夹 + 每夹递归文件计数（本桶过滤，0 文件夹隐藏） */
function MountFolderSummary({ mountId, providerId }: { mountId: string; providerId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useMountFolderSummary(mountId, providerId);
  if (isLoading) {
    return <div className="space-y-1 py-1">{[0, 1].map((i) => <div key={i} className="h-4 w-40 animate-pulse rounded bg-muted" />)}</div>;
  }
  if (!data) return null;
  return (
    <div className="py-0.5 text-xs">
      {data.rootFiles.count > 0 && (
        <div className="flex items-center gap-1.5 rounded px-1.5 py-1 text-muted-foreground">
          <Database className="h-3 w-3 shrink-0" />
          <span>{t('admin.dashboard.rootFiles')}</span>
          <span className="ml-auto shrink-0">{t('admin.dashboard.filesCount', { count: data.rootFiles.count })} · {formatBytes(data.rootFiles.size)}</span>
        </div>
      )}
      {data.folders.map((f) => (
        <div key={f.id} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent/40">
          <Folder className="h-3 w-3 shrink-0 text-primary/70" />
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {t('admin.dashboard.filesCount', { count: f.fileCount })} · {formatBytes(f.usedSpace)}
          </span>
        </div>
      ))}
      {data.folders.length === 0 && data.rootFiles.count === 0 && (
        <p className="px-1.5 py-1 text-muted-foreground">{t('admin.allFiles.bucketEmpty')}</p>
      )}
    </div>
  );
}

/** 仪表盘：活跃挂载点桶泳道图 */
export function BucketMountGraph({ buckets }: { buckets: BucketNode[] }) {
  return <DashboardBucketGraphInner buckets={buckets} />;
}

// ============ 全部文件 · 挂载点视图 ============

/** 单条文件行：图标 + 名称（封禁半透明）+ 属主 + 大小 + 属性设置入口 */
function MountFileRow({ f, onOpenSettings }: { f: TreeFileRow; onOpenSettings: (f: FileListItem) => void }) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/40', f.banned && 'opacity-40')}>
      <FileIcon name={f.name} type={f.type} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{f.name}</span>
      <span className="ml-auto hidden shrink-0 text-muted-foreground sm:block">{f.ownerName || f.ownerId.slice(0, 8)}</span>
      <span className="w-16 shrink-0 text-right text-muted-foreground">{f.type === 'folder' ? '-' : formatBytes(f.size)}</span>
      <button
        type="button"
        onClick={() => onOpenSettings(f)}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t('admin.allFiles.settings')}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 挂载点展开层（挂载点视图）：本桶物理存储的文件按 挂载点 → 文件夹 → 文件 层级分级。
    一次取该挂载点整棵子树行（bucket 筛选只作用于文件行，文件夹行保留作骨架），文件夹行内联展开/折叠 */
function MountContent({ bucketId, mountId, mountPath, refreshKey, onOpenSettings }: { bucketId: string; mountId: string; mountPath: string; refreshKey: number; onOpenSettings: (f: FileListItem) => void }) {
  const { t } = useTranslation();
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['admin-mount-content', mountId, bucketId, refreshKey],
    queryFn: async () => {
      const q = new URLSearchParams({ mount: mountId, bucket: bucketId });
      return (await apiFetch<{ items: TreeFileRow[]; truncated: boolean }>(`/api/admin/files/tree?${q.toString()}`)).data;
    },
  });
  const toggleFolder = (p: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };
  if (isLoading && !data) {
    return <div className="space-y-1 py-1">{[0, 1, 2].map((i) => <div key={i} className="h-5 w-full animate-pulse rounded bg-muted" />)}</div>;
  }
  const rows = data?.items ?? [];
  if (rows.length === 0) {
    return <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('admin.allFiles.bucketEmpty')}</p>;
  }
  const parentOf = (r: TreeFileRow) => (r.type === 'folder' ? (r.path.split('/').slice(0, -1).join('/') || '/') : r.path);
  const childrenOf = (parent: string): TreeFileRow[] =>
    rows
      .filter((r) => parentOf(r) === parent)
      .sort((a, b) => {
        const af = a.type === 'folder' ? 0 : 1;
        const bf = b.type === 'folder' ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  const renderLevel = (parent: string, depth: number): React.ReactNode => {
    const children = childrenOf(parent);
    if (children.length === 0) return null;
    return children.map((r) => {
      if (r.type === 'folder') {
        const open = openFolders.has(r.path);
        return (
          <div key={r.id || r.path}>
            <button
              type="button"
              onClick={() => toggleFolder(r.path)}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/40"
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
              <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="min-w-0 truncate">{r.name}</span>
              <span className="text-muted-foreground">/</span>
            </button>
            {/* 文件夹子树：每层一条引导线（border-l），随嵌套逐级缩进 */}
            {open && (
              <div className="ml-[7px] border-l border-border/50 pl-3">
                {renderLevel(r.path, depth + 1)}
              </div>
            )}
          </div>
        );
      }
      return (
        <div key={r.id} style={{ paddingLeft: 6 + depth * 14 }}>
          <MountFileRow f={r} onOpenSettings={onOpenSettings} />
        </div>
      );
    });
  };
  return (
    <div className="py-0.5">
      {data?.truncated && <p className="px-1.5 py-0.5 text-[11px] text-amber-600">{t('files.treeTruncated')}</p>}
      {renderLevel(mountPath, 0)}
      {rows.every((r) => parentOf(r) !== mountPath) && (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('admin.allFiles.bucketEmpty')}</p>
      )}
    </div>
  );
}

/** 全部文件页挂载点视图：桶 → 挂载点（本桶文件）+ 备用桶 badge；桶可折叠（默认展开），挂载点可多开 */
export function MountView({ refreshKey, onOpenSettings }: { refreshKey: number; onOpenSettings: (f: FileListItem) => void }) {
  const { t } = useTranslation();
  const [openMounts, setOpenMounts] = useState<Set<string>>(new Set());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set());
  const { highlightId, highlight } = useLaneHighlight();
  const { data, isLoading } = useMountTreeQuery();
  const toggleMount = (key: string) => {
    setOpenMounts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleBucket = (id: string) => {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  if (isLoading) {
    return <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />)}</div>;
  }
  const buckets = data?.buckets ?? [];
  if (buckets.length === 0) {
    return <EmptyState compact icon={<Database className="h-4 w-4" />} title={t('admin.dashboard.noMounts')} description={t('admin.dashboard.noMountsDesc')} />;
  }
  return (
    <div className="space-y-3 p-1">
      {buckets.map((b) => {
        const color = laneColor(b.id);
        const bucketOpen = !collapsedBuckets.has(b.id);
        return (
          <BucketLane key={b.id} b={b} highlighted={highlightId === b.id} open={bucketOpen} onToggle={() => toggleBucket(b.id)}>
            {b.mounts.length === 0 && b.standbys.length === 0 && (
              <p className="px-2 py-0.5 text-[11px] text-muted-foreground">{t('admin.dashboard.bucketNoMounts')}</p>
            )}
            {b.mounts.map((m, mi) => {
              const key = `${b.id}:${m.id}`;
              const open = openMounts.has(key);
              return (
                <MountNodeShell key={key} color={color} m={m} open={open} onToggle={() => toggleMount(key)} isLast={mi === b.mounts.length - 1}>
                  <MountContent bucketId={b.id} mountId={m.id} mountPath={m.mountPath} refreshKey={refreshKey} onOpenSettings={onOpenSettings} />
                </MountNodeShell>
              );
            })}
            {b.standbys.map((s) => (
              <div key={`${b.id}:${s.mountId}`} className="flex min-w-0 items-center px-2 py-0.5">
                <StandbyBadge standby={s} onHighlight={highlight} />
              </div>
            ))}
          </BucketLane>
        );
      })}
    </div>
  );
}
