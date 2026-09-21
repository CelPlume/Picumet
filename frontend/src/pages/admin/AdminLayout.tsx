// 管理后台布局
import { useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Users, HardDrive, ShieldCheck, Share2, Files, ScrollText, Settings } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { INDICATOR_CLASS, useIndicator } from '@/components/ui/indicator';

export default function AdminLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const indicator = useIndicator(navRef, location.pathname);
  const items = [
    { to: '/admin', end: true, icon: <LayoutDashboard className="h-4 w-4" />, label: t('admin.nav.dashboard') },
    { to: '/admin/users', icon: <Users className="h-4 w-4" />, label: t('admin.nav.users') },
    { to: '/admin/storage', icon: <HardDrive className="h-4 w-4" />, label: t('admin.nav.storage') },
    { to: '/admin/permissions', icon: <ShieldCheck className="h-4 w-4" />, label: t('admin.nav.permissions') },
    { to: '/admin/shares', icon: <Share2 className="h-4 w-4" />, label: t('admin.nav.shares') },
    { to: '/admin/files', icon: <Files className="h-4 w-4" />, label: t('admin.files') },
    { to: '/admin/logs', icon: <ScrollText className="h-4 w-4" />, label: t('admin.nav.logs') },
    { to: '/admin/settings', icon: <Settings className="h-4 w-4" />, label: t('admin.nav.settings') },
  ];
  return (
    <AppShell activeNav="admin">
      <h1 className="mb-4 text-xl font-semibold">{t('admin.title')}</h1>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav
          ref={navRef}
          className="glass-surface glass-blur relative flex w-full shrink-0 flex-col gap-1 rounded-xl border p-2 scrollbar-none md:w-44 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto"
        >
          {/* 选中指示器：强调色淡化 + 随模糊三档门控，active 项之间平滑滑动 */}
          {indicator.ready && <span aria-hidden className={INDICATOR_CLASS} style={{ top: indicator.pos, height: indicator.size }} />}
          {items.map((it) => {
            const active = it.end ? location.pathname === it.to : location.pathname === it.to || location.pathname.startsWith(it.to + '/');
            return (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                data-active={active ? 'true' : 'false'}
                className={cn(
                  'relative z-[1] flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active ? 'font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {it.icon}
                {it.label}
              </NavLink>
            );
          })}
        </nav>
        {/* overflow-clip + clip-margin：内容贴边时（如 Users/Files 工具栏的搜索框），
            3px focus ring 仍可画出裁切边界而不产生布局位移；不支持的浏览器退化为纯裁切 */}
        <div className="flex min-w-0 flex-1 flex-col md:h-[calc(100vh-12rem)] md:overflow-clip md:[overflow-clip-margin:4px]">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
