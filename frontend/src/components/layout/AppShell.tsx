// 认证应用外壳：顶栏 + 内容区 + 页脚
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Share2, Settings, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { Logo } from './Logo';
import { ThemeToggle, LanguageSwitcher, UserMenu } from './widgets';

export function AppShell({ children, activeNav }: { children: ReactNode; activeNav?: 'files' | 'shares' | 'settings' }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const freeMode = useAuth((s) => s.freeMode);

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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Link to="/files">
              <Logo size={26} />
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
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-4">{children}</main>
    </div>
  );
}
