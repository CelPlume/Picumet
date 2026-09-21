// 设置页布局
import { useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Shield, KeyRound, Palette, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { INDICATOR_CLASS, useIndicator } from '@/components/ui/indicator';

export default function SettingsLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const indicator = useIndicator(navRef, location.pathname);
  const items = [
    { to: '/settings/profile', icon: <User className="h-4 w-4 shrink-0" />, label: t('settings.nav.profile'), desc: t('settings.profileDesc') },
    { to: '/settings/security', icon: <Shield className="h-4 w-4 shrink-0" />, label: t('settings.nav.security'), desc: t('settings.securityDesc') },
    { to: '/settings/api-keys', icon: <KeyRound className="h-4 w-4 shrink-0" />, label: t('settings.nav.apiKeys'), desc: t('settings.apiKeysDesc') },
    { to: '/settings/access-rules', icon: <Users className="h-4 w-4 shrink-0" />, label: t('settings.layout.accessRules'), desc: t('settings.layout.accessRulesDesc') },
    { to: '/settings/appearance', icon: <Palette className="h-4 w-4 shrink-0" />, label: t('settings.nav.appearance'), desc: t('settings.appearanceDesc') },
  ];
  return (
    <AppShell activeNav="settings">
      <h1 className="mb-4 text-xl font-semibold">{t('settings.title')}</h1>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav
          ref={navRef}
          className="glass-surface glass-blur relative flex w-full shrink-0 flex-col gap-1 rounded-xl border p-2 scrollbar-none md:w-56 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto"
        >
          {/* 选中指示器：强调色淡化 + 随模糊三档门控，active 项之间平滑滑动 */}
          {indicator.ready && <span aria-hidden className={INDICATOR_CLASS} style={{ top: indicator.pos, height: indicator.size }} />}
          {items.map((it) => {
            const active = location.pathname === it.to || location.pathname.startsWith(it.to + '/');
            return (
              <NavLink
                key={it.to}
                to={it.to}
                data-active={active ? 'true' : 'false'}
                className={cn(
                  'relative z-[1] flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active ? 'font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {it.icon}
                <span>
                  <span className="block font-medium">{it.label}</span>
                  <span className="block text-xs text-muted-foreground/70">{it.desc}</span>
                </span>
              </NavLink>
            );
          })}
        </nav>
        <div className="scrollbar-none min-w-0 flex-1 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
