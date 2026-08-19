// 认证应用外壳：顶栏 + 内容区 + 页脚（含移动端汉堡菜单、公告横幅）
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Share2, Settings, ShieldCheck, Menu, X, Home } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';
import { Logo } from './Logo';
import { ThemeToggle, LanguageSwitcher, UserMenu } from './widgets';
import { AnnouncementBanner } from './AnnouncementBanner';
import { Drawer } from '@/components/ui/drawer';
import { useState } from 'react';

export function AppShell({ children, activeNav }: { children: ReactNode; activeNav?: 'files' | 'shares' | 'settings' | 'admin' }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const freeMode = useAuth((s) => s.freeMode);
  const site = useSite();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItem = (key: 'files' | 'shares' | 'settings', to: string, icon: ReactNode, label: string) => (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        activeNav === key || location.pathname.startsWith(to)
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {icon}
      {label}
    </Link>
  );

  const mobileLinks = [
    { to: '/files', icon: <FolderOpen className="h-5 w-5" />, label: t('nav.files') },
    { to: '/shares', icon: <Share2 className="h-5 w-5" />, label: t('nav.shares') },
    { to: '/settings/profile', icon: <Settings className="h-5 w-5" />, label: t('nav.settings') },
    ...(user?.role === 'admin' ? [{ to: '/admin', icon: <ShieldCheck className="h-5 w-5" />, label: t('nav.admin') }] : []),
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur-md shadow-sm supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4">
          <div className="flex items-center gap-2">
            {/* 移动端汉堡菜单 */}
            <button
              className="rounded-md p-2 text-muted-foreground hover:bg-accent md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="打开菜单"
            >
              <Menu className="h-5 w-5" />
            </button>
            <Link to="/files">
              <Logo size={26} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} />
            </Link>
            {freeMode && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {t('files.freeModeBadge')}
              </span>
            )}
          </div>
          <nav className="hidden items-center gap-1 md:flex">
            {navItem('files', '/files', <FolderOpen className="h-4 w-4" />, t('nav.files'))}
            {navItem('shares', '/shares', <Share2 className="h-4 w-4" />, t('nav.shares'))}
            {navItem('settings', '/settings/profile', <Settings className="h-4 w-4" />, t('nav.settings'))}
            {user?.role === 'admin' && (
              <Link
                to="/admin"
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  activeNav === 'admin' || location.pathname.startsWith('/admin')
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <ShieldCheck className="h-4 w-4" />
                {t('nav.admin')}
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <LanguageSwitcher />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* 公告横幅 */}
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-2">
        <AnnouncementBanner />
      </div>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-4">{children}</main>

      {/* 移动端抽屉菜单 */}
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} side="left" title="菜单">
        <nav className="flex flex-col gap-1 p-2">
          <Link to="/" className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent" onClick={() => setMobileOpen(false)}>
            <Home className="h-5 w-5" /> 首页
          </Link>
          {mobileLinks.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent',
                location.pathname.startsWith(l.to) && 'bg-accent font-medium'
              )}
              onClick={() => setMobileOpen(false)}
            >
              {l.icon}
              {l.label}
            </Link>
          ))}
        </nav>
      </Drawer>
    </div>
  );
}
