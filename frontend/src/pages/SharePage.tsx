// 公开分享页 / 图床短链
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Download, Link2, Lock, Share2, Eye, QrCode } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { Button, Input, Badge } from '@/components/ui/core';
import { SharePageSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

// M-5：本地生成二维码 data URL，不依赖第三方 qrserver
function LocalQr({ data }: { data: string }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(data, { width: 180, margin: 1 })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc('');
      });
    return () => {
      alive = false;
    };
  }, [data]);
  if (!src) {
    return <div className="h-[190px] w-[190px] animate-pulse rounded-md bg-muted" aria-label={t('sharePage.qrLoading')} />;
  }
  return <img src={src} alt="QR" className="rounded-md border" />;
}

interface ShareInfo {
  id: string;
  title?: string;
  creatorName: string;
  file: FileListItem | null;
  allowPreview: boolean;
  allowDownload: boolean;
  expiresAt?: number;
  requiresPassword: boolean;
  viewCount: number;
  maxViews?: number;
}

export default function SharePage({ imageMode = false }: { imageMode?: boolean }) {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // M-02：不再把密码放入 URL；依赖验证接口种下的授权 cookie
      const res = await apiFetch<{ share: ShareInfo }>(`/api/shares/${id}`);
      setInfo(res.data.share);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('sharePage.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const verify = async () => {
    if (!password) return;
    try {
      // M-02：POST 提交密码，服务端校验后种短期授权 cookie
      await apiFetch<{ authorized: boolean }>(`/api/shares/${id}/verify`, {
        method: 'POST',
        body: { password },
      });
      setPassword('');
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('err.invalidPassword'));
    }
  };

  const download = async () => {
    if (!id || !info?.file) return;
    try {
      // M-02：不携带密码；授权 cookie 已种下
      const res = await apiFetch<{ url: string }>(`/api/shares/${id}/download`);
      window.open(res.data.url, '_blank');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.downloadFailed'));
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    toast('success', t('sharePage.linkCopied'));
  };

  const previewUrl = info?.file ? `/api/shares/${id}/preview` : null;

  const file = info?.file;
  const ext = file?.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  const isImg = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-center border-b">
        <a href="/"><Logo size={24} /></a>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-4 py-10">
        {loading ? (
          <SharePageSkeleton />
        ) : error ? (
          <div className="py-16 text-center">
            <div className="mb-3 text-5xl">⛔</div>
            <h2 className="text-lg font-semibold">{error}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {error === '分享已过期' && t('share.expired')}
              {error === '分享已被撤销' && t('share.revoked')}
            </p>
          </div>
        ) : !info ? null : info.requiresPassword && !info.file ? (
          // 密码门
          <div className="w-full max-w-sm glass-surface glass-blur rounded-xl border p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="mb-1 font-semibold">{t('share.passwordProtected')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{info.title} · {t('share.shareBy')}: @{info.creatorName}</p>
            <div className="flex gap-2">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('share.passwordPlaceholder')} onKeyDown={(e) => e.key === 'Enter' && verify()} />
              <Button onClick={verify}>{t('share.view')}</Button>
            </div>
          </div>
        ) : (
          // 分享内容
          <div className="w-full space-y-4">
            <div className="glass-surface glass-blur rounded-xl border p-5 text-center">
              {file && imageMode && previewUrl && isImg ? (
                <img src={previewUrl} alt={file.name} className="mx-auto max-h-[50vh] rounded-md object-contain" />
              ) : (
                <div className="mb-3 flex justify-center text-6xl">
                  {file?.type === 'folder' ? '📁' : file?.iconEmoji ?? '📄'}
                </div>
              )}
              <h1 className="text-lg font-semibold">{info.title ?? file?.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('share.shareBy')}: @{info.creatorName}
                {file && ` · ${formatBytes(file.size)}`}
                {info.expiresAt && ` · ${t('share.expiresAt')}: ${formatDateTime(info.expiresAt)}`}
              </p>
              <div className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{t('share.viewCount')}: {info.viewCount}</Badge>
                {info.maxViews && <Badge variant="outline">{info.viewCount}/{info.maxViews}</Badge>}
                {info.requiresPassword && <Badge variant="warning"><Lock className="mr-1 h-3 w-3" /> {t('sharePage.passwordProtected')}</Badge>}
              </div>
            </div>

            <div className="flex items-center justify-center gap-2">
              {info.allowDownload && (
                <Button onClick={download}>
                  <Download className="h-4 w-4" /> {t('share.download')}
                </Button>
              )}
              <Button variant="outline" onClick={copyLink}>
                <Link2 className="h-4 w-4" /> {t('share.copyLink')}
              </Button>
              <Button variant="outline" onClick={() => setShowQr((v) => !v)}>
                <QrCode className="h-4 w-4" />
              </Button>
            </div>

            {showQr && (
              <div className="flex justify-center">
                <LocalQr data={window.location.href} />
              </div>
            )}

            {file && !imageMode && info.allowPreview && (
              <div className="glass-surface glass-blur mt-2 rounded-xl border p-4 text-center">
                <p className="mb-2 flex items-center justify-center gap-1 text-sm text-muted-foreground">
                  <Eye className="h-4 w-4" /> {t('share.view')}
                </p>
                {isImg && previewUrl ? (
                  <img src={previewUrl} alt={file.name} className="mx-auto max-h-[40vh] rounded-md object-contain" />
                ) : (
                  <p className="text-sm text-muted-foreground">{file.name}</p>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Powered by Picumet · <Share2 className="inline h-3 w-3" /> {t('landing.badge')}
      </footer>
    </div>
  );
}
