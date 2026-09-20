// 设置页布局
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Shield, KeyRound, Palette, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';

export default function SettingsLayout() {
  const { t } = useTranslation();
  const items = [
    { to: '/settings/profile', icon: <User className="h-4 w-4" />, label: t('settings.profile'), desc: t('settings.profileDesc') },
    { to: '/settings/security', icon: <Shield className="h-4 w-4" />, label: t('settings.security'), desc: t('settings.securityDesc') },
    { to: '/settings/api-keys', icon: <KeyRound className="h-4 w-4" />, label: t('settings.apiKeys'), desc: t('settings.apiKeysDesc') },
    { to: '/settings/access-rules', icon: <Users className="h-4 w-4" />, label: '访问规则', desc: '授权其他用户访问' },
    { to: '/settings/appearance', icon: <Palette className="h-4 w-4" />, label: t('settings.appearance'), desc: t('settings.appearanceDesc') },
  ];
  return (
    <AppShell activeNav="settings">
      <h1 className="mb-4 text-xl font-semibold">{t('settings.title')}</h1>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav className="glass-surface glass-blur flex w-full shrink-0 flex-col gap-1 rounded-xl border p-2 scrollbar-none md:w-56 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent'
                )
              }
            >
              {it.icon}
              <span>
                <span className="block font-medium">{it.label}</span>
                <span className="block text-xs text-muted-foreground/70">{it.desc}</span>
              </span>
            </NavLink>
          ))}
        </nav>
        <div className="scrollbar-none min-w-0 flex-1 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
