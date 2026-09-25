// 公开浏览页（§C 游客）：直接访问虚拟路径即文件页只读态（无 302 跳转）。
// 后端逐项鉴权：匿名访客受站点 allow_guest_access 开关 + role='guest' 规则约束；
// 登录用户另叠加自身默认路径权限与 users/public 可见性。
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FolderOpen, Home, Lock, LogIn, RefreshCw } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { useSite } from '@/stores/site';
import { Button, EmptyState } from '@/components/ui/core';
import { FileGridSkeleton } from '@/components/ui/skeleton';
import FileIcon from '@/components/files/FileIcon';
import { apiFetch, ApiError } from '@/lib/api';
import { formatBytes, timeAgo } from '@/lib/utils';

interface BrowseItem {
  name: string;
  type: 'file' | 'folder';
  path: string;
  size: number;
  updatedAt: number;
  hasPassword: boolean;
  url: string | null;
}

type BrowseState =
  | { kind: 'loading' }
  | { kind: 'items'; path: string; items: BrowseItem[] }
  | { kind: 'error'; status: number; code: string | null; message: string };

// 只读浏览页在 catch-all(*) 与显式入口(/browse/*)下复用：basePath 为挂载点，默认 '' 表示整段路径都是虚拟路径
function browseUrl(basePath: string, virtualPath: string): string {
  return basePath ? basePath + (virtualPath === '/' ? '' : virtualPath) : virtualPath;
}

export default function Browse({ basePath = '' }: { basePath?: string }) {
  const { t } = useTranslation();
  const site = useSite();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<BrowseState>({ kind: 'loading' });

  const virtualPath = useMemo(() => {
    const raw = decodeURIComponent(location.pathname);
    const path = basePath && (raw === basePath || raw.startsWith(`${basePath}/`)) ? raw.slice(basePath.length) : raw;
    return '/' + path.split('/').filter(Boolean).join('/');
  }, [location.pathname, basePath]);

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    apiFetch<{ path: string; items: BrowseItem[] }>(`/api/public/fs?path=${encodeURIComponent(virtualPath)}`)
      .then((res) => {
        if (alive) setState({ kind: 'items', path: res.data.path, items: res.data.items });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const status = err instanceof ApiError ? err.status : 0;
        const code = err instanceof ApiError ? err.code : null;
        const message = err instanceof ApiError ? err.message : t('sharePage.loadFailed');
        setState({ kind: 'error', status, code, message });
      });
    return () => {
      alive = false;
    };
  }, [virtualPath, t]);

  const crumbs = useMemo(() => {
    const segs = virtualPath.split('/').filter(Boolean);
    return segs.map((seg, i) => ({ name: seg, path: '/' + segs.slice(0, i + 1).join('/') }));
  }, [virtualPath]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b px-4">
        <Link to={'/'} className="flex items-center gap-2">
          <Logo size={24} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} siteHeaderTitle={site.siteHeaderTitle} />
        </Link>
        <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground" aria-label={t('browse.title')}>
          <Link to={'/'} className="shrink-0 rounded p-1 hover:bg-accent hover:text-foreground" title={t('common.back')}>
            <Home className="h-4 w-4" />
          </Link>
          {crumbs.map((c) => (
            <span key={c.path} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              <button
                onClick={() => navigate(browseUrl(basePath, c.path))}
                className="max-w-40 truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {state.kind === 'loading' ? (
          <FileGridSkeleton count={8} />
        ) : state.kind === 'error' ? (
          <div className="py-20 text-center">
            <div className="mb-3 text-5xl">
              {state.code === 'LOGIN_REQUIRED' ? '🔒' : state.status === 404 ? '🧭' : '⛔'}
            </div>
            <h2 className="text-lg font-semibold">
              {state.code === 'LOGIN_REQUIRED' ? t('browse.loginRequired') : state.status === 404 ? t('browse.notFound') : state.message}
            </h2>
            {state.code === 'LOGIN_REQUIRED' && (
              <>
                <p className="mt-1 text-sm text-muted-foreground">{t('browse.loginRequiredDesc')}</p>
                <a href={`/login?redirect=${encodeURIComponent(location.pathname)}`} className="mt-4 inline-block">
                  <Button>
                    <LogIn className="h-4 w-4" /> {t('sharePage.goLogin')}
                  </Button>
                </a>
              </>
            )}
            {state.status !== 404 && state.code !== 'LOGIN_REQUIRED' && (
              <Button variant="outline" className="mt-4" onClick={() => navigate(0)}>
                <RefreshCw className="h-4 w-4" /> {t('common.retry')}
              </Button>
            )}
          </div>
        ) : state.items.length === 0 ? (
          <EmptyState
            icon={<FolderOpen className="h-7 w-7" />}
            title={t('browse.emptyTitle')}
            description={t('browse.emptyDesc')}
          />
        ) : (
          <div className="grid grid-cols-3 gap-3 md:grid-cols-4">
            {state.items.map((item) => (
              <button
                key={item.path}
                onClick={() => {
                  if (item.type === 'folder') navigate(browseUrl(basePath, item.path));
                  else if (item.url) window.open(item.url, '_blank', 'noreferrer');
                }}
                className="glass-surface glass-blur group flex flex-col gap-1.5 rounded-lg border border-transparent p-3 text-left transition-colors hover:border-border hover:[background-image:linear-gradient(rgb(0_0_0/0.08))]"
                title={item.name}
              >
                <div className="flex items-center gap-2">
                  <FileIcon
                    name={item.name}
                    type={item.type}
                    className="h-8 w-8 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {item.name}
                    {(item.hasPassword || (item.type === 'file' && !item.url)) && <Lock className="ml-1 inline h-3 w-3 text-muted-foreground" />}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{item.type === 'folder' ? t('files.properties.typeFolder') : formatBytes(item.size)}</span>
                  <span className="truncate">{timeAgo(item.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
