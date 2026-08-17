// 我的分享列表 + 创建分享
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Share2, Link2, QrCode, Trash2, Download, Lock, Copy, ExternalLink } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Input, Label, EmptyState, Badge, Dialog, Card, Switch } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDateTime, formatBytes, timeAgo } from '@/lib/utils';
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
    }
  }, [params]);

  const loadMyFiles = async () => {
    try {
      const res = await apiFetch<{ items: FileListItem[] }>('/api/files?path=/&limit=200');
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
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-xl">
                  {s.file?.type === 'folder' ? '📁' : s.file?.iconEmoji ?? '📄'}
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
            <Label>选择文件</Label>
            <select
              value={createFileId}
              onChange={(e) => setCreateFileId(e.target.value)}
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">请选择文件...</option>
              {myFiles.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('share.passwordOptional')}</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('share.password')} />
            </div>
            <div>
              <Label>{t('share.expiresIn')}</Label>
              <select value={expiresIn} onChange={(e) => setExpiresIn(Number(e.target.value))} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value={0}>{t('share.forever')}</option>
                <option value={3600}>{t('share.hours1')}</option>
                <option value={86400}>{t('share.hours24')}</option>
                <option value={604800}>{t('share.days7')}</option>
                <option value={2592000}>{t('share.days30')}</option>
              </select>
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
    </AppShell>
  );
}
