// 公开分享页 / 图床短链（多项目：单文件、文件夹、文件+文件夹混合）
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Ban, ChevronRight, Download, Eye, FileQuestion, FileText, FolderOpen, KeyRound, Link2, Lock, Share2, X } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { useSite } from '@/stores/site';
import { Badge, Button, EmptyState, Input, Spinner } from '@/components/ui/core';
import { Dropdown } from '@/components/ui/dropdown';
import { ShareLinkPanel } from '@/components/share/ShareLinkPanel';
import FileIcon from '@/components/files/FileIcon';
import { SharePageSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatBytes, formatDateTime, isImage } from '@/lib/utils';
import type { FileListItem } from '@shared/types';


/** 分享项目视图：文件列表项 + 所属根项目 id（根项目取自身 id，目录内条目取所属根文件夹项目 id） */
interface ShareItemView extends FileListItem {
  rootId: string;
}

interface ShareInfo {
  id: string;
  title?: string;
  creatorName: string;
  items: ShareItemView[];
  allowPreview: boolean;
  allowDownload: boolean;
  expiresAt?: number;
  requiresPassword: boolean;
  /** 仅创建者/管理员可见：访问密码明文（供分享面板「附带密码」使用） */
  password?: string;
  viewCount: number;
  maxViews?: number;
  downloadCount?: number;
  maxDownloads?: number;
}

/** 文件夹项目内的一级目录列举（GET /api/shares/:id/list） */
interface FolderListing {
  rootId: string;
  /** 相对根文件夹的路径，形如 /a/b */
  path: string;
  items: ShareItemView[];
}

/** 页面外壳：顶部 Logo 栏 + 内容区（加载/错误/密码门/内容四个分支共用） */
function ShareShell({ children }: { children: ReactNode }) {
  const site = useSite();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-center border-b">
        <a href="/">
          <Logo size={24} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} siteHeaderTitle={site.siteHeaderTitle} />
        </a>
      </header>
      {children}
    </div>
  );
}

/** 拼接根文件夹内的相对路径（base 为 / 或 /a/b） */
function relJoin(base: string, name: string): string {
  return `${base === '/' ? '' : base}/${name}`;
}

/** 单行条目：与文件页 FileRow 同一视觉语言（item-surface 三态 + FileIcon + 名称 + 大小 + 行尾操作） */
function ShareRow({
  item,
  allowDownload,
  canPreview,
  thumb,
  onOpen,
  onDownload,
  onPreview,
}: {
  item: ShareItemView;
  allowDownload: boolean;
  canPreview: boolean;
  thumb?: string;
  onOpen: () => void;
  onDownload: () => void;
  onPreview: () => void;
}) {
  const { t } = useTranslation();
  const isFolder = item.type === 'folder';
  return (
    <div
      onClick={() => (isFolder ? onOpen() : canPreview ? onPreview() : undefined)}
      className="item-surface grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border px-3 py-2 text-sm"
    >
      {/* 名称按钮承担键盘可达性：Enter/Space 触发的 click 冒泡到行，不会重复执行 */}
      <button
        type="button"
        className="flex min-w-0 cursor-pointer items-center gap-2 text-left"
        title={isFolder ? t('share.openFolder') : item.name}
      >
        {isFolder ? (
          <FileIcon name={item.name} type="folder" className="h-5 w-5 shrink-0" iconEmoji={item.iconEmoji} />
        ) : (
          <FileIcon name={item.name} type="file" className="h-5 w-5 shrink-0" src={thumb} preview iconEmoji={item.iconEmoji} />
        )}
        <span className="truncate">{item.name}</span>
      </button>
      <span className="text-right text-muted-foreground">{isFolder ? '-' : formatBytes(item.size)}</span>
      <div className="flex items-center justify-end">
        {isFolder ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        ) : allowDownload ? (
          <button
            type="button"
            aria-label={`${t('common.download')} ${item.name}`}
            title={t('common.download')}
            className="glass-control cursor-pointer rounded bg-card/[var(--glass-alpha,0.72)] p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
          >
            <Download className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function SharePage({ imageMode = false }: { imageMode?: boolean }) {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [password, setPassword] = useState('');
  /** 本页已知的明文密码（刚通过密码门或 URL 带入）：只喂给转发菜单，不参与鉴权 */
  const [knownPassword, setKnownPassword] = useState('');
  /** 转发菜单里是否已展开明文密码 */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderListing | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [previewItem, setPreviewItem] = useState<ShareItemView | null>(null);

  /** 拉取分享内容（不动 loading：带 ?password= 直接进时由 bootstrap 统一控制骨架屏时机） */
  const requestShare = async (): Promise<ShareInfo | null> => {
    try {
      // M-02：不再把密码放入 URL；依赖验证接口种下的授权 cookie
      const res = await apiFetch<{ share: ShareInfo }>(`/api/shares/${id}`);
      setInfo(res.data.share);
      setFolder(null);
      setPreviewItem(null);
      return res.data.share;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('sharePage.loadFailed'));
      setErrorCode(err instanceof ApiError ? err.code : null);
      return null;
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    await requestShare();
    setLoading(false);
  };

  /** 密码门：提交密码后重新加载（pw 缺省取输入框的值） */
  const verify = async (pw: string = password) => {
    if (!pw) return;
    try {
      // M-02：POST 提交密码，服务端校验后种短期授权 cookie
      await apiFetch<{ authorized: boolean }>(`/api/shares/${id}/verify`, {
        method: 'POST',
        body: { password: pw },
      });
      // 保留本次通过的密码：转发菜单的「查看密码 / 含密码链接 / 带密码文案」复用该值
      setKnownPassword(pw);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('err.invalidPassword'));
    }
  };

  useEffect(() => {
    // 带参数直接进：URL 里的 ?password= 自动填入并提交一次验证（成功走正常加载，失败按上述 toast 提示）。
    // 只有分享本身需要密码时才验证——公开分享带 ?password= 无意义，避免无谓报错。
    const urlPassword = new URLSearchParams(window.location.search).get('password') ?? '';
    const bootstrap = async () => {
      setLoading(true);
      setError(null);
      setErrorCode(null);
      const share = await requestShare();
      if (share?.requiresPassword && urlPassword) {
        setPassword(urlPassword);
        await verify(urlPassword);
      }
      setLoading(false);
    };
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** 进入文件夹项目（sub 为相对根文件夹的路径，缺省 /） */
  const openFolder = async (rootId: string, sub: string) => {
    setFolderLoading(true);
    setPreviewItem(null);
    try {
      const res = await apiFetch<{ shareId: string; rootId: string; path: string; items: ShareItemView[] }>(
        `/api/shares/${id}/list?root=${encodeURIComponent(rootId)}&sub=${encodeURIComponent(sub)}`
      );
      setFolder({ rootId: res.data.rootId, path: res.data.path, items: res.data.items });
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('sharePage.loadFailed'));
    } finally {
      setFolderLoading(false);
    }
  };

  const download = async (itemId: string) => {
    if (!id) return;
    try {
      // M-02：不携带密码；授权 cookie 已种下
      const res = await apiFetch<{ url: string; expiresIn: number }>(
        `/api/shares/${id}/download?itemId=${encodeURIComponent(itemId)}`
      );
      window.open(res.data.url, '_blank');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.downloadFailed'));
    }
  };

  /** 分享链接（规范形态，不含密码）：二维码与「复制链接」共用 */
  const shareUrl = `${window.location.origin}/share/${id}`;


  /** 链接（含密码）：仅在本页已知密码时可用 */


  /** 复制分享文案：已知密码用带密码模板，否则用无密码模板 */

  /** 图片预览直出流（对象流，鉴权靠 cookie） */
  const previewSrc = (itemId: string) => `/api/shares/${id}/preview?itemId=${encodeURIComponent(itemId)}`;

  const items = folder ? folder.items : (info?.items ?? []);

  // 面包屑：各段均可点击回跳（根 = 项目列表）
  const crumbs = useMemo(() => {
    const segs = (folder?.path ?? '').split('/').filter(Boolean);
    return segs.map((name, i) => ({ name, sub: '/' + segs.slice(0, i + 1).join('/') }));
  }, [folder]);

  const goRoot = () => {
    setFolder(null);
    setPreviewItem(null);
  };

  const goParent = () => {
    if (!folder) return;
    // 已在根文件夹 → 退回项目列表；否则回到相对路径的上一级
    if (crumbs.length === 0) {
      goRoot();
      return;
    }
    void openFolder(folder.rootId, crumbs.length === 1 ? '/' : crumbs[crumbs.length - 2].sub);
  };

  if (loading) {
    return (
      <ShareShell>
        <SharePageSkeleton />
      </ShareShell>
    );
  }

  if (error || !info) {
    // 按错误码分支（不再比较中文文案）；图标统一用 lucide
    const ErrorIcon = errorCode === 'LOGIN_REQUIRED' ? Lock : errorCode === 'NOT_FOUND' ? FileQuestion : Ban;
    const errorTitle =
      errorCode === 'LOGIN_REQUIRED'
        ? t('sharePage.loginRequired')
        : errorCode === 'SHARE_REVOKED'
          ? t('share.revoked')
          : errorCode === 'SHARE_EXPIRED'
            ? t('share.expired')
            : errorCode === 'SHARE_LIMIT_REACHED'
              ? t('sharePage.limitReached')
              : errorCode === 'NOT_FOUND'
                ? t('sharePage.notFound')
                : (error ?? t('sharePage.unavailable'));
    return (
      <ShareShell>
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-4 py-16">
          <div className="glass-surface glass-blur w-full max-w-sm rounded-xl border p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <ErrorIcon className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">{errorTitle}</h2>
            {errorCode === 'LOGIN_REQUIRED' && <p className="mt-1 text-sm text-muted-foreground">{t('sharePage.loginRequiredDesc')}</p>}
            {errorCode === 'LOGIN_REQUIRED' && (
              <a href={`/login?redirect=${encodeURIComponent(window.location.pathname)}`} className="mt-4 inline-block">
                <Button>{t('sharePage.goLogin')}</Button>
              </a>
            )}
          </div>
        </main>
      </ShareShell>
    );
  }

  // 密码门：密码未通过时后端返回空 items
  if (info.requiresPassword && info.items.length === 0) {
    return (
      <ShareShell>
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-4 py-16">
          <div className="glass-surface glass-blur w-full max-w-sm rounded-xl border p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="mb-1 font-semibold">{t('share.passwordProtected')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{info.title} · {t('share.shareBy')}: @{info.creatorName}</p>
            {/* 密码门也可转发：分享面板显示二维码与链接，创建者还能带上密码 */}
            <div className="mb-4 flex justify-center">
              <Dropdown
                align="start"
                contentClass="w-[184px] max-w-[calc(100vw-2rem)] sm:w-[212px]"
                trigger={
                  <Button variant="outline" title={t('share.shareLinkAndQr')} aria-label={t('share.shareLinkAndQr')}>
                    <Share2 className="h-4 w-4" /> {t('common.share')}
                  </Button>
                }
              >
                {(close) => (
                  <ShareLinkPanel
                    id={info.id}
                    password={info.password ?? knownPassword}
                    user={info.creatorName}
                    title={info.title ?? t('share.itemsCount', { count: 1 })}
                    onClose={close}
                  />
                )}
              </Dropdown>
            </div>
            <div className="flex gap-2">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('share.passwordPlaceholder')} onKeyDown={(e) => e.key === 'Enter' && void verify()} />
              <Button onClick={() => void verify()}>{t('share.view')}</Button>
            </div>
          </div>
        </main>
      </ShareShell>
    );
  }

  const singleItem = !folder && info.items.length === 1 ? info.items[0] : null;
  const singleFile = singleItem && singleItem.type === 'file' ? singleItem : null;
  // 图床短链（imageMode）+ 单项目图片：保持大图预览
  const heroItem = imageMode && singleFile && info.allowPreview && isImage(singleFile.name) ? singleFile : null;
  const totalSize = info.items.reduce((sum, it) => (it.type === 'file' ? sum + it.size : sum), 0);
  const title = info.title || (info.items.length === 1 ? info.items[0].name : t('sharePage.itemsSection'));

  return (
    <ShareShell>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-4 py-10">
        <div className="w-full space-y-4">
          {/* 分享元信息 */}
          <div className="glass-surface glass-blur rounded-xl border p-5 text-center">
            <h1 className="truncate text-lg font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('share.shareBy')}: @{info.creatorName}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {info.expiresAt ? `${t('share.expiresAt')}: ${formatDateTime(info.expiresAt)}` : t('share.never')}
              {info.items.length > 1 && ` · ${t('share.itemsSummary', { count: info.items.length, size: formatBytes(totalSize) })}`}
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{t('share.viewCount')}: {info.viewCount}</Badge>
              {info.maxViews ? <Badge variant="outline">{info.viewCount}/{info.maxViews}</Badge> : null}
              {info.maxDownloads ? (
                <Badge variant="outline">{t('share.downloads', { used: info.downloadCount ?? 0, max: info.maxDownloads })}</Badge>
              ) : null}
              {info.items.length > 1 && <Badge variant="outline">{t('share.itemsCount', { count: info.items.length })}</Badge>}
              {info.requiresPassword && <Badge variant="warning"><Lock className="h-3 w-3" /> {t('sharePage.passwordProtected')}</Badge>}
            </div>
          </div>

          {/* 操作区：「分享」下拉 = 转发面板（二维码 / 复制链接 / 含密码链接 / 查看密码 / 复制文案）+ 下载（单文件） */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Dropdown
              align="start"
              contentClass="w-[184px] max-w-[calc(100vw-2rem)] sm:w-[212px]"
              trigger={
                <Button variant="outline" title={t('share.shareLinkAndQr')} aria-label={t('share.shareLinkAndQr')}>
                  <Share2 className="h-4 w-4" /> {t('common.share')}
                </Button>
              }
            >
              {(close) => (
                <ShareLinkPanel
                  id={info.id}
                  password={info.password ?? knownPassword}
                  user={info.creatorName}
                  title={info.title ?? (info.items.length === 1 ? info.items[0]?.name ?? '' : t('share.itemsCount', { count: info.items.length }))}
                  onClose={close}
                />
              )}
            </Dropdown>
            {info.allowDownload && singleFile && (
              <Button onClick={() => void download(singleFile.id)}>
                <Download className="h-4 w-4" /> {t('common.download')}
              </Button>
            )}
          </div>

          {heroItem ? (
            // 图床短链大图预览
            <div className="glass-surface glass-blur rounded-xl border p-4 text-center">
              <img src={previewSrc(heroItem.id)} alt={heroItem.name} className="mx-auto max-h-[60vh] rounded-md object-contain" />
              <p className="mt-3 truncate text-sm text-muted-foreground">{heroItem.name}</p>
            </div>
          ) : (
            <>
              {/* 文件夹项目内：返回上级 + 面包屑 */}
              {folder && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={goParent}>
                    <ArrowLeft className="h-4 w-4" /> {t('share.back')}
                  </Button>
                  <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted-foreground" aria-label={t('sharePage.breadcrumbRoot')}>
                    <button type="button" onClick={goRoot} className="shrink-0 cursor-pointer rounded px-1 py-0.5 hover:bg-accent hover:text-foreground">
                      {t('sharePage.breadcrumbRoot')}
                    </button>
                    {crumbs.map((c) => (
                      <span key={c.sub} className="flex min-w-0 items-center gap-1">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <button
                          type="button"
                          onClick={() => void openFolder(folder.rootId, c.sub)}
                          title={c.name}
                          className="max-w-40 cursor-pointer truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                        >
                          {c.name}
                        </button>
                      </span>
                    ))}
                  </nav>
                </div>
              )}

              {/* 项目 / 目录条目列表 */}
              {folderLoading ? (
                <div className="flex justify-center py-10"><Spinner /></div>
              ) : items.length === 0 ? (
                <EmptyState icon={<FolderOpen className="h-7 w-7" />} title={folder ? t('share.folderEmpty') : t('share.noItems')} />
              ) : (
                <div className="glass-surface glass-blur space-y-2 rounded-xl border p-3">
                  {items.map((item) => {
                    const canPreview = info.allowPreview && item.type === 'file' && isImage(item.name);
                    return (
                      <ShareRow
                        key={`${item.rootId}:${item.id}`}
                        item={item}
                        allowDownload={info.allowDownload}
                        canPreview={canPreview}
                        thumb={canPreview ? previewSrc(item.id) : undefined}
                        // 顶层条目自身即根项目；目录内条目沿用根项目 id + 相对路径
                        onOpen={() =>
                          void openFolder(folder ? folder.rootId : item.id, folder ? relJoin(folder.path, item.name) : '/')
                        }
                        onDownload={() => void download(item.id)}
                        onPreview={() => setPreviewItem((cur) => (cur?.id === item.id ? null : item))}
                      />
                    );
                  })}
                </div>
              )}

              {/* 图片预览面板 */}
              {previewItem && info.allowPreview && (
                <div className="glass-surface glass-blur rounded-xl border p-4">
                  <div className="mb-2 flex items-center justify-between gap-2 text-sm text-muted-foreground">
                    <span className="truncate">{previewItem.name}</span>
                    <button
                      type="button"
                      onClick={() => setPreviewItem(null)}
                      aria-label={t('common.close')}
                      title={t('common.close')}
                      className="glass-control shrink-0 cursor-pointer rounded bg-card/[var(--glass-alpha,0.72)] p-1 hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <img src={previewSrc(previewItem.id)} alt={previewItem.name} className="mx-auto max-h-[50vh] rounded-md object-contain" />
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Powered by Picumet · <Share2 className="inline h-3 w-3" /> {t('landing.badge')}
      </footer>
    </ShareShell>
  );
}
