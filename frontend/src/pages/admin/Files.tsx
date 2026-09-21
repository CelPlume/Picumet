// 管理员：全部文件（含公开审核，§4.2）
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Check, X, Files, Settings2, Lock, Users, Globe, Ban, RotateCcw, FilterX } from 'lucide-react';
import { Card, Input, Badge, Button, EmptyState, ConfirmDialog, SEARCH_INPUT_GLASS } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import FileIcon from '@/components/files/FileIcon';
import { AdminFileSettingsDialog } from '@/components/files/AdminFileSettingsDialog';
import type { FileListItem } from '@shared/types';

/** 表头与数据行共用的网格模板（md 起多一列路径、lg 起再多上传用户 + 存储桶/挂载点/哈希值共四列），保证表头表与行表列对齐 */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1.4fr)_96px_140px_120px_84px] md:grid-cols-[minmax(0,1.2fr)_minmax(140px,1.4fr)_96px_140px_120px_84px] lg:grid-cols-[minmax(0,1.2fr)_112px_minmax(140px,1.4fr)_110px_96px_100px_96px_135px_104px_84px]';

/** 管理端列表行：后端在 FileListItem 上附加属主用户名（ownerName）与封禁/存储定位（banned/buckets/mounts/hash） */
type AdminFileRow = FileListItem & {
  ownerName?: string;
  banned?: boolean;
  buckets?: string[];
  mounts?: string[];
  hash?: string | null;
};

/** 可见性：纯图标+文字（无胶囊底），语义色只体现在文字 */
function VisibilityBadge({ file }: { file: FileListItem }) {
  const { t } = useTranslation();
  if (file.visibility === 'private') {
    return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" />{t('admin.allFiles.private')}</span>;
  }
  if (file.visibility === 'users') {
    return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />{t('admin.allFiles.usersOnly')}</span>;
  }
  if (file.reviewStatus === 'pending') {
    return <span className="flex items-center gap-1 text-xs text-amber-600"><Globe className="h-3.5 w-3.5" />{t('admin.allFiles.pendingReview')}</span>;
  }
  if (file.reviewStatus === 'rejected') {
    return <span className="flex items-center gap-1 text-xs text-destructive"><Globe className="h-3.5 w-3.5" />{t('admin.allFiles.rejected')}</span>;
  }
  return <span className="flex items-center gap-1 text-xs text-emerald-600"><Globe className="h-3.5 w-3.5" />{t('admin.allFiles.published')}</span>;
}

export default function AdminFiles() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<AdminFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<string | null>('updatedAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [searchInput, setSearchInput] = useState('');
  /** 防抖后的搜索词（并入 query） */
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  /** 属性设置弹窗的目标行；null = 关闭 */
  const [settingsTarget, setSettingsTarget] = useState<FileListItem | null>(null);
  /** 筛选下拉选项（挂载点/存储桶/用户名，进入页面一次性加载） */
  const [mountList, setMountList] = useState<Array<{ id: string; name: string }>>([]);
  const [providerList, setProviderList] = useState<Array<{ id: string; name: string }>>([]);
  const [usernames, setUsernames] = useState<string[]>([]);
  /** 筛选状态（'' = 不过滤）；任一变化重置 page=1 重新拉取 */
  const [mountFilter, setMountFilter] = useState('');
  const [bucketFilter, setBucketFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState('');
  const [hashInput, setHashInput] = useState('');
  const [hashFilter, setHashFilter] = useState('');
  /** 封禁确认弹窗目标；null = 关闭 */
  const [banTarget, setBanTarget] = useState<AdminFileRow | null>(null);
  const [banLoading, setBanLoading] = useState(false);

  useEffect(() => {
    void apiFetch<{ mounts: Array<{ id: string; name: string }> }>('/api/admin/mounts').then((r) => setMountList(r.data.mounts));
    void apiFetch<{ providers: Array<{ id: string; name: string }> }>('/api/admin/storage/providers').then((r) => setProviderList(r.data.providers));
    void apiFetch<{ users: Array<{ username: string }> }>('/api/admin/users?limit=100').then((r) => setUsernames(r.data.users.map((u) => u.username)));
  }, []);

  /** 查询串由分页/搜索/全部筛选统一派生，任一变化即重新拉取 */
  const query = useMemo(() => {
    const q = new URLSearchParams();
    q.set('page', String(page));
    q.set('limit', String(pageSize));
    if (search) q.set('search', search);
    if (mountFilter) q.set('mount', mountFilter);
    if (bucketFilter) q.set('bucket', bucketFilter);
    if (userFilter) q.set('user', userFilter);
    if (visibilityFilter) q.set('visibility', visibilityFilter);
    if (hashFilter) q.set('hash', hashFilter);
    return q.toString();
  }, [page, pageSize, search, mountFilter, bucketFilter, userFilter, visibilityFilter, hashFilter]);

  const load = async () => {
    setLoading(true);
    const res = await apiFetch<{ items: AdminFileRow[]; pagination: { total: number } }>(`/api/admin/files?${query}`);
    setFiles(res.data.items);
    setTotal(res.data.pagination.total);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const t = setTimeout(() => { setHashFilter(hashInput); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [hashInput]);

  const sortedRows = useMemo(() => {
    if (!sort) return files;
    return sortByKey(files, sort as keyof FileListItem, order);
  }, [files, sort, order]);

  const review = async (f: FileListItem, status: 'approved' | 'rejected') => {
    try {
      await apiFetch(`/api/admin/files/${f.id}/review`, { method: 'PATCH', body: { status } });
      toast('success', status === 'approved' ? t('admin.allFiles.approved') : t('admin.allFiles.rejected'));
      await load();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('admin.operationFailed'));
    }
  };

  const setVisibility = async (f: FileListItem, visibility: 'private' | 'users' | 'public') => {
    try {
      await apiFetch(`/api/admin/files/${f.id}/review`, { method: 'PATCH', body: { visibility } });
      toast('success', t('admin.allFiles.visibilityUpdated'));
      await load();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('admin.operationFailed'));
    }
  };

  /** 封禁/解封（PUT /api/admin/files/:id/ban），成功后刷新当前页 */
  const toggleBan = async (f: AdminFileRow) => {
    try {
      setBanLoading(true);
      await apiFetch(`/api/admin/files/${f.id}/ban`, { method: 'PUT', body: { banned: !f.banned } });
      toast('success', !f.banned ? t('admin.allFiles.bannedToast') : t('admin.allFiles.unbannedToast'));
      setBanTarget(null);
      await load();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('admin.operationFailed'));
    } finally {
      setBanLoading(false);
    }
  };

  /** 是否存在任一筛选条件（含搜索词），用于清除按钮可用态 */
  const hasFilters = Boolean(
    search || hashFilter || mountFilter || bucketFilter || userFilter || visibilityFilter
  );

  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setHashInput('');
    setHashFilter('');
    setMountFilter('');
    setBucketFilter('');
    setUserFilter('');
    setVisibilityFilter('');
    setPage(1);
  };

  const mountSelectOptions = mountList.map((m) => ({ value: m.id, label: m.name }));
  const bucketSelectOptions = providerList.map((p) => ({ value: p.id, label: p.name }));
  const userSelectOptions = usernames.map((u) => ({ value: u, label: u }));
  const visibilitySelectOptions = [
    { value: 'private', label: t('admin.allFiles.private') },
    { value: 'users', label: t('admin.allFiles.usersOnly') },
    { value: 'public', label: t('admin.allFiles.published') },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
          <Input className={cn('pl-8', SEARCH_INPUT_GLASS)} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('files.searchPlaceholder')} />
        </div>
        {/* 筛选组：任一变化重置 page=1 重新拉取 */}
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-32" triggerClassName={SEARCH_INPUT_GLASS} value={mountFilter} onValueChange={(v) => { setMountFilter(v); setPage(1); }} options={mountSelectOptions} placeholder={t('admin.allFiles.mounts')} />
          <Select className="w-32" triggerClassName={SEARCH_INPUT_GLASS} value={bucketFilter} onValueChange={(v) => { setBucketFilter(v); setPage(1); }} options={bucketSelectOptions} placeholder={t('admin.allFiles.buckets')} />
          <Select className="w-32" triggerClassName={SEARCH_INPUT_GLASS} value={userFilter} onValueChange={(v) => { setUserFilter(v); setPage(1); }} options={userSelectOptions} placeholder={t('admin.user')} />
          <Select className="w-28" triggerClassName={SEARCH_INPUT_GLASS} value={visibilityFilter} onValueChange={(v) => { setVisibilityFilter(v); setPage(1); }} options={visibilitySelectOptions} placeholder={t('admin.allFiles.visibility')} />
          <Input className={cn('w-44', SEARCH_INPUT_GLASS)} value={hashInput} onChange={(e) => setHashInput(e.target.value)} placeholder={t('admin.allFiles.hash')} />
          <Button variant="outline" size="sm" onClick={clearFilters} disabled={!hasFilters}>
            <FilterX className="h-4 w-4" />
            {t('admin.allFiles.clearFilters')}
          </Button>
        </div>
      </div>
      {/* 表头固定在滚动区上方：表头与数据行同在卡片玻璃上、同为透明层（观感一致），
          行只在下方容器内滚动，不会滑到表头下面造成叠加 */}
      <Card className="mt-3 flex max-h-[calc(100vh-12.7rem)] flex-col py-0 overflow-hidden">
        <table className="block w-full shrink-0 overflow-hidden text-sm [scrollbar-gutter:stable]">
          <thead className="block">
            <tr className={ROW_GRID + ' whitespace-nowrap border-b text-left text-muted-foreground'}>
              <th className="px-4 py-2"><SortableHeader title={t('files.name')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="hidden px-4 py-2 lg:block">{t('admin.allFiles.owner')}</th>
              <th className="hidden px-4 py-2 md:block">{t('admin.allFiles.path')}</th>
              <th className="hidden px-4 py-2 lg:block">{t('admin.allFiles.buckets')}</th>
              <th className="hidden px-4 py-2 lg:block">{t('admin.allFiles.mounts')}</th>
              <th className="hidden px-4 py-2 lg:block">{t('admin.allFiles.hash')}</th>
              <th className="px-4 py-2"><SortableHeader title={t('files.size')} sortKey="size" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title={t('files.modified')} sortKey="updatedAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('admin.allFiles.visibility')}</th>
              <th className="px-4 py-2">{t('common.actions')}</th>
            </tr>
          </thead>
        </table>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          <table className="block w-full text-sm">
            <tbody className="block">
              {loading ? (
                <tr className="block"><td className="block px-4 py-2"><TableSkeleton rows={6} cols={6} /></td></tr>
              ) : files.length === 0 ? (
                <tr className="block"><td className="block px-4 py-2"><EmptyState icon={<Files className="h-7 w-7" />} title={t('admin.allFiles.emptyTitle')} description={t('admin.allFiles.emptyDesc')} /></td></tr>
              ) : sortedRows.map((f) => (
                <tr key={f.id} className={ROW_GRID + ' border-b last:border-0 hover:bg-accent/50' + (f.banned ? ' opacity-40' : '')}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <FileIcon name={f.name} type={f.type} className="h-5 w-5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{f.name}</span>
                    </div>
                  </td>
                  <td className="hidden px-4 py-2 text-xs text-muted-foreground lg:block" title={f.ownerId}>
                    {f.ownerName || f.ownerId.slice(0, 8)}
                  </td>
                  <td className="hidden truncate px-4 py-2 font-mono text-xs text-muted-foreground md:block">{f.path}</td>
                  <td className="hidden max-w-full truncate px-4 py-2 text-xs text-muted-foreground lg:block" title={(f.buckets ?? []).join('、') || undefined}>
                    {(f.buckets ?? []).join('、') || '-'}
                  </td>
                  <td className="hidden max-w-full truncate px-4 py-2 text-xs text-muted-foreground lg:block" title={(f.mounts ?? []).join('、') || undefined}>
                    {(f.mounts ?? []).join('、') || '-'}
                  </td>
                  <td className="hidden truncate px-4 py-2 font-mono text-xs text-muted-foreground lg:block">{f.hash || '-'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{f.type === 'folder' ? '-' : formatBytes(f.size)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(f.updatedAt)}</td>
                  <td className="px-4 py-2"><VisibilityBadge file={f} /></td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setBanTarget(f)}
                      className={cn('rounded-md p-1.5 hover:bg-accent', f.banned ? 'text-muted-foreground hover:text-foreground' : 'text-destructive')}
                      title={f.banned ? t('admin.allFiles.unban') : t('admin.allFiles.ban')}
                    >
                      {f.banned ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettingsTarget(f)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t('admin.allFiles.settings')}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
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

      {/* 属性设置（常驻挂载：进出动画由 Dialog 统一处理） */}
      <AdminFileSettingsDialog
        file={settingsTarget}
        onClose={() => setSettingsTarget(null)}
        onSaved={() => {
          setSettingsTarget(null);
          void load();
        }}
      />

      {/* 封禁/解封确认 */}
      <ConfirmDialog
        open={banTarget !== null}
        onClose={() => setBanTarget(null)}
        onConfirm={() => { if (banTarget) void toggleBan(banTarget); }}
        title={banTarget?.banned ? t('admin.allFiles.unban') : t('admin.allFiles.ban')}
        message={t(banTarget?.banned ? 'admin.allFiles.unbanConfirm' : 'admin.allFiles.banConfirm', { name: banTarget?.name ?? '' })}
        confirmText={banTarget?.banned ? t('admin.allFiles.unban') : t('admin.allFiles.ban')}
        loading={banLoading}
      />
    </div>
  );
}
