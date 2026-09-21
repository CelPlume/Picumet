// 我的分享列表 + 管理（创建入口已移至文件页）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2, Trash2, Lock, ExternalLink, LayoutGrid, List as ListIcon, CheckCircle2, Clock, Ban, Eye, Download } from 'lucide-react';
import { Button, EmptyState, Badge, Card, ConfirmDialog } from '@/components/ui/core';
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui/dropdown';
import { ShareLinkPanel } from '@/components/share/ShareLinkPanel';
import { ShareGridSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDateTime, formatBytes, timeAgo, cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import FileIcon from '@/components/files/FileIcon';
import type { FileListItem, ShareStatus } from '@shared/types';

interface ShareItem {
  id: string;
  title?: string;
  expiresAt?: number;
  viewCount: number;
  maxViews?: number;
  downloadCount: number;
  maxDownloads?: number;
  allowPreview: boolean;
  allowDownload: boolean;
  /** 分享自带访问密码 */
  passwordProtected: boolean;
  /** 仅登录用户可访问 */
  requireLogin: boolean;
  /** 指定用户白名单人数（requireLogin 且带白名单时 > 0） */
  allowedUserCount: number;
  status: ShareStatus;
  createdAt: number;
  /** 分享包含的条目数（含文件夹与文件） */
  itemCount: number;
  totalSize: number;
  /** 首个条目：用于名称/图标回退（旧字段 file 已废弃） */
  firstItem: FileListItem | null;
  /** 分享密码明文：后端仅在创建者列表接口且可解密时返回，否则该字段缺失 */
  password?: string;
}

/** 转发菜单内联二维码：本地生成 data URL（尺寸与公开分享页一致，160/180px 响应式） */

// 状态徽章：图标 + 本地化文案（不再直接渲染英文枚举）
/** 访问权限一句话文案（表格列用） */
function accessLabel(s: { requireLogin: boolean; allowedUserCount: number }, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (s.allowedUserCount > 0) return `${t('myShares.accessUsers')} · ${s.allowedUserCount}`;
  return s.requireLogin ? t('myShares.accessLogin') : t('myShares.accessPublic');
}

/** 开关态图标：开=主色对勾，关=灰化横线 */
function ToggleCell({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {on ? (
        <CheckCircle2 className="h-4 w-4 text-primary" aria-label={t('admin.active')} />
      ) : (
        <span className="text-muted-foreground line-through">{t('admin.disabled')}</span>
      )}
    </span>
  );
}

function StatusBadge({ status }: { status: ShareStatus }) {
  const { t } = useTranslation();
  const map = {
    active: { Icon: CheckCircle2, label: t('share.statusActive'), variant: 'success' as const },
    expired: { Icon: Clock, label: t('share.statusExpired'), variant: 'secondary' as const },
    revoked: { Icon: Ban, label: t('share.statusRevoked'), variant: 'destructive' as const },
  };
  const { Icon, label, variant } = map[status] ?? map.expired;
  return (
    <Badge variant={variant}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

// 分享设置信息组（卡片视图与列表视图共用，两处呈现同一套设置）——固定三行、左对齐、行间距紧凑：
// ① 访问权限 ② 预览/下载开关 ③ 访问/下载次数

export default function MyShares() {
  const { t } = useTranslation();
  /** 当前登录用户名：复制分享文案的 {{user}}（取不到时用「分享者」兜底） */
  const currentUsername = useAuth((s) => s.user?.username);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmRevoke, setConfirmRevoke] = useState<ShareItem | null>(null);
  /** 转发菜单里已展开明文密码的分享 id */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  // 两种视图：卡片（信息三行）与表格（可排序，列头齐全）
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  // 表格排序（与后台表格同一套 SortableHeader/sortByKey；服务端分页，排序作用于当前页）
  const [sort, setSort] = useState<string | null>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');

  const onSort = (key: string) => {
    setSort(key);
    setOrder(order === 'asc' ? 'desc' : 'asc');
  };

  const sortedShares = useMemo(
    () => (sort ? sortByKey(shares, sort as keyof ShareItem, order) : shares),
    [shares, sort, order]
  );


  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: ShareItem[]; pagination: { total: number } }>(
        `/api/shares?page=${page}&limit=${pageSize}`
      );
      setShares(res.data.items);
      setTotal(res.data.pagination.total);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    try {
      await apiFetch(`/api/shares/${id}`, { method: 'DELETE' });
      toast('success', t('myShares.revoked'));
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('myShares.operationFailed'));
    }
    setConfirmRevoke(null);
  };

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url.startsWith('http') ? url : window.location.origin + url);
    toast('success', t('files.linkCopied'));
  };

  /** 分享规范链接（不含密码）：二维码与「复制链接」共用 */
  const shareUrl = (id: string) => `${window.location.origin}/share/${id}`;

  /** 链接（含密码）：列表返回明文密码时可用 */

  const copyPassword = async (pw: string) => {
    await navigator.clipboard.writeText(pw);
    toast('success', t('share.passwordCopied'));
  };

  /** 复制分享文案：列表带明文密码用带密码模板，否则用无密码模板 */

  return (
    <div className="space-y-4">
      {shares.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          <div className="glass-control flex rounded-md border bg-muted/[var(--glass-alpha,0.72)]">
            <button
              onClick={() => setViewMode('grid')}
              className={cn(
                'rounded-l-md px-2.5 py-1.5 transition-colors',
                viewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent/60'
              )}
              title={t('files.viewCards')}
              aria-label={t('files.viewCards')}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={cn(
                'rounded-r-md px-2.5 py-1.5 transition-colors',
                viewMode === 'table' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent/60'
              )}
              title={t('files.viewList')}
              aria-label={t('files.viewList')}
            >
              <ListIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <ShareGridSkeleton />
      ) : shares.length === 0 ? (
        <EmptyState
          title={t('share.noShares')}
          description={t('share.createFromFiles')}
        />
      ) : (
        <>
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {sortedShares.map((s) => (
                <Card key={s.id} className="glass-surface glass-blur flex flex-col gap-1.5 p-3 transition-colors hover:border-border hover:[background-image:linear-gradient(rgb(0_0_0/0.08))]">
                  <div className="flex items-center gap-2">
                    <FileIcon
                      name={s.firstItem?.name ?? ''}
                      type={s.firstItem?.type === 'folder' ? 'folder' : 'file'}
                      className="h-8 w-8 shrink-0"
                      iconEmoji={s.firstItem?.iconEmoji}
                    />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium" title={s.title ?? s.firstItem?.name}>
                      {s.title ?? s.firstItem?.name}
                      {s.itemCount > 1 && <span className="ml-1 text-xs text-muted-foreground">{t('share.itemsCount', { count: s.itemCount })}</span>}
                    </p>
                    <StatusBadge status={s.status} />
                  </div>
                  {/* 三行：访问权限 / 预览+下载 / 访问与下载计数 */}
                  <p className="truncate text-xs text-muted-foreground">
                    {accessLabel(s, t)}
                    {s.passwordProtected && <Lock className="ml-1 inline h-3 w-3" />}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Eye className="h-3.5 w-3.5" /> {t('admin.shares.previewShort')}
                      <span className={s.allowPreview ? 'text-primary' : 'line-through'}>{s.allowPreview ? t('admin.active') : t('admin.disabled')}</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Download className="h-3.5 w-3.5" /> {t('admin.shares.downloadShort')}
                      <span className={s.allowDownload ? 'text-primary' : 'line-through'}>{s.allowDownload ? t('admin.active') : t('admin.disabled')}</span>
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.viewCount}/{s.maxViews ?? t('myShares.noLimit')} · {s.downloadCount}/{s.maxDownloads ?? t('myShares.noLimit')}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-1 border-t pt-2">
                    <span className="truncate text-xs text-muted-foreground" title={s.expiresAt ? formatDateTime(s.expiresAt) : t('share.never')}>
                      {s.expiresAt ? formatDateTime(s.expiresAt) : t('share.never')}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <Dropdown
                        align="end"
                        contentClass="w-[184px] max-w-[calc(100vw-2rem)] sm:w-[212px]"
                        trigger={
                          <button className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t('share.shareLinkAndQr')} aria-label={t('share.shareLinkAndQr')}>
                            <Share2 className="h-4 w-4" />
                          </button>
                        }
                      >
                        {(close) => (
                          <ShareLinkPanel
                            id={s.id}
                            password={s.password}
                            user={currentUsername || t('share.shareBy')}
                            title={s.title ?? s.firstItem?.name ?? t('share.itemsCount', { count: s.itemCount })}
                            onClose={close}
                          />
                        )}
                      </Dropdown>
                      <a href={`/share/${s.id}`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t('files.open')}>
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <button onClick={() => setConfirmRevoke(s)} className="rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10" title={t('settings.revoke')}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
          <Card className="max-h-[calc(100vh-11.7rem)] overflow-auto py-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className={'px-4 py-2'}><SortableHeader title={t('files.name')} sortKey="title" sort={sort} order={order} onSort={onSort} /></th>
                  <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.status')} sortKey="status" sort={sort} order={order} onSort={onSort} /></th>
                  <th className={'px-4 py-2'}>{t('admin.shares.accessShort')}</th>
                  <th className={'px-4 py-2'}>{t('admin.shares.needPassword')}</th>
                  <th className={'hidden px-4 py-2 lg:table-cell'}>{t('admin.shares.previewShort')}</th>
                  <th className={'hidden px-4 py-2 lg:table-cell'}>{t('admin.shares.downloadShort')}</th>
                  <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.views')} sortKey="viewCount" sort={sort} order={order} onSort={onSort} /></th>
                  <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.downloads')} sortKey="downloadCount" sort={sort} order={order} onSort={onSort} /></th>
                  <th className={'px-4 py-2'}><SortableHeader title={t('admin.shares.expiresShort')} sortKey="expiresAt" sort={sort} order={order} onSort={onSort} /></th>
                  <th className={'hidden px-4 py-2 md:table-cell'}><SortableHeader title={t('admin.shares.created')} sortKey="createdAt" sort={sort} order={order} onSort={onSort} /></th>
                  <th className={'px-4 py-2'}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedShares.map((s) => (
                  <tr key={s.id} className="border-b transition-colors last:border-0 hover:bg-accent/50">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <FileIcon
                          name={s.firstItem?.name ?? ''}
                          type={s.firstItem?.type === 'folder' ? 'folder' : 'file'}
                          className="h-5 w-5 shrink-0"
                          iconEmoji={s.firstItem?.iconEmoji}
                        />
                        <span className="min-w-0 truncate font-medium" title={s.title ?? s.firstItem?.name}>
                          {s.title ?? s.firstItem?.name}
                        </span>
                        {s.itemCount > 1 && (
                          <span className="shrink-0 text-xs text-muted-foreground">{t('share.itemsCount', { count: s.itemCount })}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{accessLabel(s, t)}</td>
                    <td className="px-4 py-2">
                      {s.passwordProtected ? (
                        <Lock className="h-4 w-4 text-primary" aria-label={t('admin.shares.needPassword')} />
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-2 lg:table-cell">
                      <ToggleCell on={s.allowPreview} />
                    </td>
                    <td className="hidden px-4 py-2 lg:table-cell">
                      <ToggleCell on={s.allowDownload} />
                    </td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{s.viewCount}/{s.maxViews ?? t('myShares.noLimit')}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{s.downloadCount}/{s.maxDownloads ?? t('myShares.noLimit')}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{s.expiresAt ? formatDateTime(s.expiresAt) : t('share.never')}</td>
                    <td className="hidden px-4 py-2 text-xs text-muted-foreground md:table-cell">{timeAgo(s.createdAt)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-0.5">
                        <Dropdown
                          align="end"
                          contentClass="w-[184px] max-w-[calc(100vw-2rem)] sm:w-[212px]"
                          trigger={
                            <button className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t('share.shareLinkAndQr')} aria-label={t('share.shareLinkAndQr')}>
                              <Share2 className="h-4 w-4" />
                            </button>
                          }
                        >
                          {(close) => (
                            <ShareLinkPanel
                              id={s.id}
                              password={s.password}
                              user={currentUsername || t('share.shareBy')}
                              title={s.title ?? s.firstItem?.name ?? t('share.itemsCount', { count: s.itemCount })}
                              onClose={close}
                            />
                          )}
                        </Dropdown>
                        <a href={`/share/${s.id}`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t('files.open')}>
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        <button onClick={() => setConfirmRevoke(s)} className="rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10" title={t('settings.revoke')}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          )}

          <Pagination
            page={page}
            total={total}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
            className="mt-4"
          />
        </>
      )}

      {/* 查看分享二维码 */}
      

      <ConfirmDialog
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => confirmRevoke && void revoke(confirmRevoke.id)}
        title={t('myShares.revokeShare')}
        message={t('myShares.revokeConfirm', { name: confirmRevoke?.title || confirmRevoke?.firstItem?.name || confirmRevoke?.id })}
      />
    </div>
  );
}
