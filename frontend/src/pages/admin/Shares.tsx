// 管理员：全部分享（列表展示完整属性 + 管理员级分享设置入口）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Trash2,
  Link2,
  Share2,
  CheckCircle2,
  Clock,
  Ban,
  Settings2,
  Lock,
  LockOpen,
  Eye,
  Download,
  Globe,
  LogIn,
  UserCheck,
} from 'lucide-react';
import { Card, Badge, ConfirmDialog, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { toast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';
import { AdminShareSettingsDialog } from '@/components/share/AdminShareSettingsDialog';
import { cn, formatDateTime } from '@/lib/utils';
import type { FileListItem, ShareStatus } from '@shared/types';

interface ShareRow {
  id: string;
  title?: string;
  creatorId: string;
  /** 创建者用户名（后端补充，老数据可能缺失） */
  creatorName?: string;
  /** 首个条目：名称/图标回退 */
  file: FileListItem | null;
  /** 分享包含的条目数 */
  itemCount: number;
  viewCount: number;
  maxViews?: number | null;
  downloadCount: number;
  maxDownloads?: number | null;
  allowPreview: boolean;
  allowDownload: boolean;
  /** 仅登录用户可访问 */
  requireLogin: boolean;
  /** 指定用户白名单人数（requireLogin 且带白名单时 > 0） */
  allowedUserCount: number;
  passwordProtected: boolean;
  status: ShareStatus;
  createdAt: number;
  expiresAt?: number | null;
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
  const [confirmRevoke, setConfirmRevoke] = useState<ShareRow | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);

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
    try {
      await apiFetch(`/api/admin/shares/${id}`, { method: 'DELETE' });
      toast('success', t('common.revoked'));
      await load();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('common.operationFailed'));
    }
    setConfirmRevoke(null);
  };

  const onSort = (key: string) => {
    setSort(key);
    setOrder(order === 'asc' ? 'desc' : 'asc');
  };

  // 弹窗关闭回调保持稳定引用：设置弹窗的加载 effect 依赖它，内联箭头会导致重复拉取
  const closeSettings = useCallback(() => setSettingsId(null), []);

  const sortedRows = useMemo(() => {
    if (!sort) return shares;
    return sortByKey(shares, sort as keyof ShareRow, order);
  }, [shares, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">

      <Card className="mt-3 min-h-0 flex-1 scrollbar-thin overflow-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.fileTitle')} sortKey="title" sort={sort} order={order} onSort={onSort} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.creator')} sortKey="creatorName" sort={sort} order={order} onSort={onSort} /></th>
              <th className={'px-4 py-2'}>{t('admin.shares.accessShort')}</th>
              <th className={'px-4 py-2'}>{t('admin.shares.needPassword')}</th>
              <th className={'px-4 py-2'}>{t('admin.shares.previewShort')}</th>
              <th className={'px-4 py-2'}>{t('admin.shares.downloadShort')}</th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.views')} sortKey="viewCount" sort={sort} order={order} onSort={onSort} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.downloads')} sortKey="downloadCount" sort={sort} order={order} onSort={onSort} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.expiresShort')} sortKey="expiresAt" sort={sort} order={order} onSort={onSort} /></th>
              <th className={'px-4 py-2'}>{t('admin.shares.status')}</th>
              <th className={'px-4 py-2'}>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11}><TableSkeleton rows={6} cols={5} /></td></tr>
            ) : shares.length === 0 ? (
              <tr><td colSpan={11}><EmptyState icon={<Share2 className="h-7 w-7" />} title={t('admin.shares.empty')} description={t('admin.shares.emptyDesc')} /></td></tr>
            ) : sortedRows.map((s) => (
              <tr key={s.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate font-medium">{s.title ?? s.file?.name}</span>
                    {s.itemCount > 1 && (
                      <span className="shrink-0 text-xs text-muted-foreground">{t('share.itemsCount', { count: s.itemCount })}</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs">
                  <span className="block truncate text-muted-foreground" title={s.creatorId}>
                    {s.creatorName || s.creatorId}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    {s.requireLogin ? (
                      s.allowedUserCount > 0 ? (
                        <UserCheck className="h-4 w-4 shrink-0" />
                      ) : (
                        <LogIn className="h-4 w-4 shrink-0" />
                      )
                    ) : (
                      <Globe className="h-4 w-4 shrink-0" />
                    )}
                    {s.requireLogin
                      ? s.allowedUserCount > 0
                        ? `${t('myShares.accessUsers')} · ${s.allowedUserCount}`
                        : t('myShares.accessLogin')
                      : t('myShares.accessPublic')}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {s.passwordProtected ? (
                    <Lock className="h-4 w-4 text-primary" aria-label={t('admin.shares.needPassword')} />
                  ) : (
                    <LockOpen className="h-4 w-4 text-muted-foreground/40" aria-label={t('common.none')} />
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
                    <Eye className={cn('h-4 w-4 shrink-0', s.allowPreview ? 'text-primary' : 'text-muted-foreground')} />
                    <span className={cn('text-muted-foreground', !s.allowPreview && 'line-through')}>
                      {s.allowPreview ? t('admin.active') : t('admin.disabled')}
                    </span>
                  </span>
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
                    <Download className={cn('h-4 w-4 shrink-0', s.allowDownload ? 'text-primary' : 'text-muted-foreground')} />
                    <span className={cn('text-muted-foreground', !s.allowDownload && 'line-through')}>
                      {s.allowDownload ? t('admin.active') : t('admin.disabled')}
                    </span>
                  </span>
                </td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">
                  {s.viewCount}/{s.maxViews ?? t('myShares.noLimit')}
                </td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">
                  {s.downloadCount}/{s.maxDownloads ?? t('myShares.noLimit')}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{s.expiresAt ? formatDateTime(s.expiresAt) : t('share.forever')}</td>
                <td className="px-4 py-2">
                  <Badge variant={s.status === 'active' ? 'success' : s.status === 'revoked' ? 'destructive' : 'secondary'}>
                    {s.status === 'active' ? (
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                    ) : s.status === 'revoked' ? (
                      <Ban className="mr-1 h-3 w-3" />
                    ) : (
                      <Clock className="mr-1 h-3 w-3" />
                    )}
                    {s.status === 'active' ? t('share.statusActive') : s.status === 'revoked' ? t('share.statusRevoked') : t('share.statusExpired')}
                  </Badge>
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSettingsId(s.id)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t('admin.shares.settings')}
                      aria-label={t('admin.shares.settings')}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setConfirmRevoke(s)}
                      className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                      title={t('admin.shares.revokeTitle')}
                      aria-label={t('admin.shares.revokeTitle')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
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

      <AdminShareSettingsDialog
        open={!!settingsId}
        shareId={settingsId}
        onClose={closeSettings}
        onSaved={() => void load()}
      />

      <ConfirmDialog
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => confirmRevoke && void revoke(confirmRevoke.id)}
        title={t('admin.shares.revokeTitle')}
        message={t('admin.shares.revokeConfirm', { name: confirmRevoke?.title ?? confirmRevoke?.file?.name ?? confirmRevoke?.id })}
      />
    </div>
  );
}
