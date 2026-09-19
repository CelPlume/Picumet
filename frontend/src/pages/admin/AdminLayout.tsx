// 管理后台布局
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Users, HardDrive, ShieldCheck, Share2, Files, ScrollText, Settings } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';

export default function AdminLayout() {
  const { t } = useTranslation();
  const items = [
    { to: '/admin', end: true, icon: <LayoutDashboard className="h-4 w-4" />, label: t('admin.dashboard') },
    { to: '/admin/users', icon: <Users className="h-4 w-4" />, label: t('admin.users') },
    { to: '/admin/storage', icon: <HardDrive className="h-4 w-4" />, label: t('admin.storage') },
    { to: '/admin/permissions', icon: <ShieldCheck className="h-4 w-4" />, label: t('admin.permissions') },
    { to: '/admin/shares', icon: <Share2 className="h-4 w-4" />, label: t('admin.shares') },
    { to: '/admin/files', icon: <Files className="h-4 w-4" />, label: t('admin.files') },
    { to: '/admin/logs', icon: <ScrollText className="h-4 w-4" />, label: t('admin.logs') },
    { to: '/admin/settings', icon: <Settings className="h-4 w-4" />, label: t('admin.settings') },
  ];
  return (
    <AppShell activeNav="admin">
      <h1 className="mb-4 text-xl font-semibold">{t('admin.title')}</h1>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav className="glass-surface glass-blur flex w-full shrink-0 flex-col gap-1 rounded-xl border p-2 scrollbar-none md:w-44 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent'
                )
              }
            >
              {it.icon}
              {it.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col md:h-[calc(100vh-12rem)] md:overflow-hidden">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
