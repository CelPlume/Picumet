// 我的分享列表 + 创建分享
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Share2, Link2, QrCode, Trash2, Download, Lock, Copy, ExternalLink, X, LayoutGrid, List as ListIcon, MoreVertical } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Input, Label, EmptyState, Badge, Dialog, Card, Switch } from '@/components/ui/core';
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui/dropdown';
import { Select } from '@/components/ui/select';
import { ShareGridSkeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDateTime, formatBytes, timeAgo, cn } from '@/lib/utils';
import FileIcon from '@/components/files/FileIcon';
import type { FileListItem } from '@shared/types';

interface ShareItem {
  id: string;
  title?: string;
  file: FileListItem | null;
  expiresAt?: number;
  viewCount: number;
  maxViews?: number;
  downloadCount: number;
  maxDownloads?: number;
  allowPreview: boolean;
  allowDownload: boolean;
  status: string;
  createdAt: number;
}

export default function MyShares() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createFileId, setCreateFileId] = useState('');
  const [password, setPassword] = useState('');
  const [expiresIn, setExpiresIn] = useState(0);
  const [maxDownloads, setMaxDownloads] = useState(0);
  const [allowDownload, setAllowDownload] = useState(true);
  const [allowPreview, setAllowPreview] = useState(true);
  const [created, setCreated] = useState<{ id: string; url: string; qrcode: string } | null>(null);
  const [myFiles, setMyFiles] = useState<FileListItem[]>([]);
  const [qrDialog, setQrDialog] = useState<{ share: ShareItem; url: string; dataUrl: string } | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);

  const showQr = async (s: ShareItem) => {
    const url = `${window.location.origin}/share/${s.id}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 2 }).catch(() => '');
    setQrDialog({ share: s, url, dataUrl });
  };

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

  useEffect(() => {
    const createId = params.get('create');
    if (createId) {
      setCreateFileId(createId);
      setShowCreate(true);
      void loadMyFiles();
    }
  }, [params]);

  const loadMyFiles = async () => {
    try {
      const res = await apiFetch<{ items: FileListItem[] }>('/api/files?path=/&limit=500');
      setMyFiles(res.data.items.filter((i) => i.type === 'file'));
    } catch {
      /* ignore */
    }
  };

  const createShare = async () => {
    if (!createFileId) return toast('error', '请选择文件');
    try {
      const res = await apiFetch<{ share: { id: string; url: string; qrcode: string } }>('/api/shares', {
        method: 'POST',
        body: {
          fileId: createFileId,
          password: password || undefined,
          expiresIn: expiresIn || undefined,
          maxDownloads: maxDownloads || undefined,
          allowPreview,
          allowDownload,
        },
      });
      setCreated(res.data.share);
      setShowCreate(false);
      await load();
      // 后端不返回二维码，客户端生成
      const url = res.data.share.url.startsWith('http') ? res.data.share.url : window.location.origin + res.data.share.url;
      const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 2 }).catch(() => '');
      setCreated((c) => (c ? { ...c, qrcode: dataUrl } : c));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '创建失败');
    }
  };

  const revoke = async (id: string) => {
    try {
      await apiFetch(`/api/shares/${id}`, { method: 'DELETE' });
      toast('success', '已撤销');
      await load();
    } catch (err) {
      toast('error', '操作失败');
    }
  };

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url.startsWith('http') ? url : window.location.origin + url);
    toast('success', '链接已复制');
  };

  // 三点菜单：卡片与列表共用（二维码 / 打开 / 复制链接 / 撤销）
  const shareMenu = (s: ShareItem) => (
    <Dropdown
      align="end"
      trigger={
        <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="分享操作" title="更多操作">
          <MoreVertical className="h-4 w-4" />
        </button>
      }
    >
      {(close) => (
        <>
          <DropdownItem icon={<QrCode className="h-4 w-4" />} onClick={() => { close(); void showQr(s); }}>
            二维码
          </DropdownItem>
          <DropdownItem icon={<ExternalLink className="h-4 w-4" />} onClick={() => { close(); window.open(`/share/${s.id}`, '_blank', 'noreferrer'); }}>
            打开
          </DropdownItem>
          <DropdownItem icon={<Link2 className="h-4 w-4" />} onClick={() => { close(); void copyLink(`/share/${s.id}`); }}>
            复制链接
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem danger icon={<Trash2 className="h-4 w-4" />} onClick={() => { close(); void revoke(s.id); }}>
            撤销分享
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );

  return (
    <AppShell activeNav="shares">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('share.title')}</h1>
        <div className="flex items-center gap-2">
          {shares.length > 0 && (
            <div className="flex rounded-md border">
              <button
                onClick={() => setViewMode('grid')}
                className={cn(
                  'rounded-l-md px-2.5 py-1.5 transition-colors',
                  viewMode === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'
                )}
                title="卡片视图"
                aria-label="卡片视图"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={cn(
                  'rounded-r-md px-2.5 py-1.5 transition-colors',
                  viewMode === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'
                )}
                title="列表视图"
                aria-label="列表视图"
              >
                <ListIcon className="h-4 w-4" />
              </button>
            </div>
          )}
          <Button onClick={() => { setShowCreate(true); void loadMyFiles(); }}>
            <Share2 className="h-4 w-4" /> {t('share.create')}
          </Button>
        </div>
      </div>

      {loading ? (
        <ShareGridSkeleton />
      ) : shares.length === 0 ? (
        <EmptyState
          title={t('share.noShares')}
          description={t('share.noSharesDesc')}
          action={
            <Button onClick={() => { setShowCreate(true); void loadMyFiles(); }}>
              <Share2 className="h-4 w-4" /> {t('share.create')}
            </Button>
          }
        />
      ) : (
        <>
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-3 gap-3 md:grid-cols-4">
              {shares.map((s) => (
                <Card key={s.id} className="group flex flex-col gap-1.5 p-3 transition-shadow hover:shadow-lg">
                  <div className="flex items-center gap-2">
                    <FileIcon
                      name={s.file?.name ?? ''}
                      type={s.file?.type === 'folder' ? 'folder' : 'file'}
                      className="h-8 w-8 shrink-0"
                      iconEmoji={s.file?.iconEmoji}
                    />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium" title={s.title ?? s.file?.name}>
                      {s.title ?? s.file?.name}
                      {s.file?.hasPassword && <Lock className="ml-1 inline h-3 w-3 text-muted-foreground" />}
                    </p>
                    {shareMenu(s)}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant={s.status === 'active' ? 'success' : 'secondary'} className="shrink-0 text-xs">
                      {s.status}
                    </Badge>
                    <span className="truncate">{s.file ? formatBytes(s.file.size) : '-'}</span>
                  </div>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={s.expiresAt ? `过期: ${formatDateTime(s.expiresAt)}` : '永久有效'}
                  >
                    {s.expiresAt ? `${formatDateTime(s.expiresAt)} 过期` : '永久有效'} · 查看 {s.viewCount}
                    {s.maxDownloads ? ` · 下载 ${s.downloadCount}/${s.maxDownloads}` : ''}
                  </p>
                  <div className="mt-auto hidden items-center justify-end gap-0.5 border-t pt-2 sm:flex">
                    <button onClick={() => void showQr(s)} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t('share.qrcode')}>
                      <QrCode className="h-4 w-4" />
                    </button>
                    <a href={`/share/${s.id}`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="打开">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    <button onClick={() => copyLink(`/share/${s.id}`)} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="复制链接">
                      <Link2 className="h-4 w-4" />
                    </button>
                    <button onClick={() => revoke(s.id)} className="rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10" title="撤销">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              {shares.map((s) => (
                <div
                  key={s.id}
                  className="group grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border border-transparent bg-card px-3 py-2.5 text-sm transition-colors hover:border-border hover:bg-accent/50 sm:grid-cols-[auto_minmax(0,1fr)_90px_120px_auto]"
                >
                  <FileIcon name={s.file?.name ?? ''} type={s.file?.type === 'folder' ? 'folder' : 'file'} className="h-5 w-5 shrink-0" iconEmoji={s.file?.iconEmoji} />
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={s.title ?? s.file?.name}>
                      {s.title ?? s.file?.name}
                      {s.file?.hasPassword && <Lock className="ml-1 inline h-3 w-3 text-muted-foreground" />}
                    </p>
                  </div>
                  <span className="truncate text-right text-xs text-muted-foreground">{s.file ? formatBytes(s.file.size) : '-'}</span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">{timeAgo(s.createdAt)}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge variant={s.status === 'active' ? 'success' : 'secondary'} className="w-[52px] justify-center text-xs">{s.status}</Badge>
                    {shareMenu(s)}
                  </div>
                </div>
              ))}
            </div>
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
            className="mt-4 border-t pt-3"
          />
        </>
      )}

      {/* 创建分享 */}
      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t('share.createTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={createShare}>{t('common.create')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>分享文件</Label>
            {(() => {
              const pre = myFiles.find((f) => f.id === createFileId);
              return pre ? (
                <div className="mt-1 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <FileIcon name={pre.name} type="file" className="h-5 w-5" iconEmoji={pre.iconEmoji} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{pre.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(pre.size)}</span>
                </div>
              ) : (
                <Select
                  value={createFileId}
                  onValueChange={setCreateFileId}
                  placeholder="请选择文件..."
                  className="mt-1"
                  options={myFiles.map((f) => ({ value: f.id, label: f.name }))}
                />
              );
            })()}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('share.passwordOptional')}</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('share.password')} />
            </div>
            <div>
              <Label>{t('share.expiresIn')}</Label>
              <Select
                value={String(expiresIn)}
                onValueChange={(v) => setExpiresIn(Number(v))}
                className="mt-1"
                options={[
                  { value: '0', label: t('share.forever') },
                  { value: '3600', label: t('share.hours1') },
                  { value: '86400', label: t('share.hours24') },
                  { value: '604800', label: t('share.days7') },
                  { value: '2592000', label: t('share.days30') },
                ]}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('share.maxDownloads')}</Label>
              <Input type="number" min={0} value={maxDownloads || ''} onChange={(e) => setMaxDownloads(Number(e.target.value))} placeholder="不限" />
            </div>
            <div className="flex items-end justify-between pb-1">
              <span className="text-sm">{t('share.allowDownload')}</span>
              <Switch checked={allowDownload} onChange={setAllowDownload} />
            </div>
          </div>
        </div>
      </Dialog>

      {/* 创建成功 */}
      <Dialog
        open={!!created}
        onClose={() => setCreated(null)}
        title="✅ 分享已创建"
        footer={
          <Button onClick={() => setCreated(null)}>{t('common.close')}</Button>
        }
      >
        {created && (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/50 p-3">
              <p className="mb-1 text-xs text-muted-foreground">{t('share.link')}</p>
              <div className="flex items-center gap-2">
                <Input readOnly value={created.url} className="font-mono text-xs" />
                <Button size="sm" variant="outline" onClick={() => copyLink(created.url)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <img src={created.qrcode} alt="QR" className="h-28 w-28 rounded-md border" />
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="flex items-center gap-1"><QrCode className="h-4 w-4" /> 扫描二维码访问</p>
                <a href={`/share/${created.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                  <Download className="h-4 w-4" /> 打开分享页
                </a>
              </div>
            </div>
          </div>
        )}
      </Dialog>

      {/* 查看分享二维码 */}
      <Dialog
        open={!!qrDialog}
        onClose={() => setQrDialog(null)}
        title={`${t('share.qrcode')} · ${qrDialog?.share.title ?? qrDialog?.share.file?.name ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setQrDialog(null)}>{t('common.close')}</Button>
          </>
        }
      >
        {qrDialog && (
          <div className="flex flex-col items-center gap-4 py-2">
            {qrDialog.dataUrl ? (
              <img src={qrDialog.dataUrl} alt="QR" className="h-48 w-48 rounded-md border-8 border-background" />
            ) : (
              <p className="text-sm text-muted-foreground">二维码生成失败</p>
            )}
            <div className="flex w-full items-center gap-2">
              <Input readOnly value={qrDialog.url} className="flex-1 font-mono text-xs" />
              <Button size="sm" variant="outline" onClick={() => void copyLink(qrDialog.url)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              使用手机扫描二维码即可打开分享链接
            </p>
          </div>
        )}
      </Dialog>
    </AppShell>
  );
}
