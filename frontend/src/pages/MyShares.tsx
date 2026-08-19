// 我的分享列表 + 创建分享
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Share2, Link2, QrCode, Trash2, Download, Lock, Copy, ExternalLink, X } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Input, Label, EmptyState, Badge, Dialog, Card, Switch } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDateTime, formatBytes, timeAgo } from '@/lib/utils';
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

  const showQr = async (s: ShareItem) => {
    const url = `${window.location.origin}/share/${s.id}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 2 }).catch(() => '');
    setQrDialog({ share: s, url, dataUrl });
  };

  const load = async () => {
    try {
      const res = await apiFetch<{ items: ShareItem[] }>('/api/shares');
      setShares(res.data.items);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

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

  return (
    <AppShell activeNav="shares">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('share.title')}</h1>
        <Button onClick={() => { setShowCreate(true); void loadMyFiles(); }}>
          <Share2 className="h-4 w-4" /> {t('share.create')}
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-muted-foreground">{t('common.loading')}</div>
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
        <div className="space-y-3">
          {shares.map((s) => (
            <Card key={s.id} className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <FileIcon name={s.file?.name ?? ''} type={s.file?.type === 'folder' ? 'folder' : 'file'} className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.title ?? s.file?.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.file ? `${formatBytes(s.file.size)} · ` : ''}
                    {s.status === 'expired' ? t('share.expired') : s.status === 'revoked' ? t('share.revoked') : t('share.link')}
                    {s.expiresAt ? ` · ${t('share.expiresAt')}: ${formatDateTime(s.expiresAt)}` : ` · ${t('share.never')}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge variant={s.status === 'active' ? 'success' : 'secondary'}>{s.status}</Badge>
                  <button onClick={() => void showQr(s)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" title={t('share.qrcode')}>
                    <QrCode className="h-4 w-4" />
                  </button>
                  <a href={`/share/${s.id}`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" title="打开">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                  <button onClick={() => copyLink(`/share/${s.id}`)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
                    <Link2 className="h-4 w-4" />
                  </button>
                  <button onClick={() => revoke(s.id)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {s.file?.hasPassword || s.maxDownloads ? (
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  {s.file?.hasPassword && (
                    <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> 密码</span>
                  )}
                  {s.maxDownloads ? (
                    <span>{t('share.downloads').replace('{{used}}', String(s.downloadCount)).replace('{{max}}', String(s.maxDownloads))}</span>
                  ) : (
                    <span>{t('share.viewCount')}: {s.viewCount}</span>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
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
                  <FileIcon name={pre.name} type="file" className="h-5 w-5 text-muted-foreground" />
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
