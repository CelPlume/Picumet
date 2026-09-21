// 认证应用外壳：顶栏 + 内容区 + 页脚（含移动端汉堡菜单、公告横幅）
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Settings, ShieldCheck, Menu, X, Home } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';
import { Logo } from './Logo';
import { ThemeToggle, LanguageSwitcher, UserMenu } from './widgets';
import { AnnouncementBanner } from './AnnouncementBanner';
import { Drawer } from '@/components/ui/drawer';
import { useRef, useState } from 'react';
import { useIndicator } from '@/components/ui/indicator';

export function AppShell({ children, activeNav }: { children: ReactNode; activeNav?: 'files' | 'shares' | 'settings' | 'admin' }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const freeMode = useAuth((s) => s.freeMode);
  const site = useSite();
  const navRef = useRef<HTMLElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  // 导航指示器：persistKey 缓存跨 AppShell 重挂载的位置（换页重挂载时从旧位置平滑滑出），
  // 活跃项以 data-active 标记（与 Tabs/侧边栏共用同一测量 hook）
  const navInd = useIndicator(navRef, location.pathname, { axis: 'x', persistKey: 'appshell-nav' });

  const navItem = (key: 'files' | 'settings', to: string, icon: ReactNode, label: string) => {
    const active = activeNav === key || location.pathname.startsWith(to);
    return (
      <Link
        to={to}
        data-active={active ? 'true' : 'false'}
        className={cn(
          'relative z-10 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          active ? 'font-medium text-primary' : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground'
        )}
      >
        {icon}
        {label}
      </Link>
    );
  };

  const mobileLinks = [
    { to: '/files', active: location.pathname.startsWith('/files'), icon: <FolderOpen className="h-5 w-5" />, label: t('nav.files') },
    { to: '/settings/profile', active: location.pathname.startsWith('/settings/profile'), icon: <Settings className="h-5 w-5" />, label: t('nav.settings') },
    ...(user?.role === 'admin'
      ? [{ to: '/admin', active: location.pathname.startsWith('/admin'), icon: <ShieldCheck className="h-5 w-5" />, label: t('nav.admin') }]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="glass-surface glass-blur sticky top-0 z-30 border-b shadow-sm">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4">
          <div className="flex items-center gap-2">
            {/* 移动端汉堡菜单 */}
            <button
              className="rounded-md p-2 text-muted-foreground hover:bg-accent md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label={t('common.openMenu')}
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
          {/* 右侧控制组：导航 tab 右缘紧贴深浅色切换（与主页「查看文档」同款对齐） */}
          <div className="flex items-center gap-2">
            <nav ref={navRef} className="relative hidden items-center gap-1 rounded-lg p-1 md:flex">
              {navInd.ready && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-1 rounded-md bg-primary/10 transition-all duration-300 ease-out"
                  style={{ left: navInd.pos, width: navInd.size }}
                />
              )}
              {navItem('files', '/files', <FolderOpen className="h-4 w-4" />, t('nav.files'))}
              {navItem('settings', '/settings/profile', <Settings className="h-4 w-4" />, t('nav.settings'))}
              {user?.role === 'admin' && (
                <Link
                  to="/admin"
                  data-active={activeNav === 'admin' || location.pathname.startsWith('/admin') ? 'true' : 'false'}
                  className={cn(
                    'relative z-10 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    activeNav === 'admin' || location.pathname.startsWith('/admin')
                      ? 'font-medium text-primary'
                      : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground'
                  )}
                >
                  <ShieldCheck className="h-4 w-4" />
                  {t('nav.admin')}
                </Link>
              )}
            </nav>
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

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-3">{children}</main>

      {/* 移动端抽屉菜单 */}
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} side="left" title={t('common.menu')}>
        <nav className="flex flex-col gap-1 p-2">
          <Link to="/" className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent" onClick={() => setMobileOpen(false)}>
            <Home className="h-5 w-5" /> {t('nav.home')}
          </Link>
          {mobileLinks.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent',
                l.active && 'bg-accent font-medium'
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
