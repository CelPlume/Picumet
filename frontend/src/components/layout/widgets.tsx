// 主题切换 + 语言切换 + 用户菜单（顶栏小组件）
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Languages, LogOut, Settings, Shield, User } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/theme';
import { setLocale } from '@/lib/i18n';
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui/dropdown';
import { Button } from '@/components/ui/core';

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const set = useTheme((s) => s.set);
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <Button
      variant="ghost"
      size="icon"
      title="切换主题"
      onClick={() => set({ theme: dark ? 'light' : 'dark' })}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language?.startsWith('en') ? 'English' : '中文';
  return (
    <Dropdown
      trigger={
        <Button variant="ghost" size="icon" title="语言">
          <Languages className="h-4 w-4" />
        </Button>
      }
    >
      {(close) => (
        <>
          <DropdownItem
            onClick={() => {
              setLocale('zh-CN');
              close();
            }}
          >
            <span className={i18n.language?.startsWith('zh') ? 'font-semibold' : ''}>中文</span>
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              setLocale('en-US');
              close();
            }}
          >
            <span className={i18n.language?.startsWith('en') ? 'font-semibold' : ''}>English</span>
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  if (!user) return null;
  const display = user.displayName || user.username;
  return (
    <Dropdown
      triggerClass="flex items-center"
      trigger={
        <div className="flex items-center gap-2 rounded-full p-1 pr-2 hover:bg-accent">
          <Avatar name={display} url={user.avatarUrl} size={28} />
          <span className="hidden max-w-[120px] truncate text-sm sm:block">{display}</span>
        </div>
      }
    >
      {(close) => (
        <>
          <DropdownLabel>{user.email}</DropdownLabel>
          <DropdownSeparator />
          <DropdownItem onClick={() => { close(); window.location.href = '/files'; }}>
            <User className="h-4 w-4" /> {t('nav.files')}
          </DropdownItem>
          {user.role === 'admin' && (
            <DropdownItem onClick={() => { close(); window.location.href = '/admin'; }}>
              <Shield className="h-4 w-4" /> {t('nav.admin')}
            </DropdownItem>
          )}
          <DropdownItem onClick={() => { close(); window.location.href = '/settings/profile'; }}>
            <Settings className="h-4 w-4" /> {t('nav.settings')}
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem danger onClick={() => { close(); void logout(); }}>
            <LogOut className="h-4 w-4" /> {t('common.logout')}
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}

export function Avatar({ name, url, size = 32 }: { name: string; url?: string; size?: number }) {
  if (url) {
    return <img src={url} alt={name} className="rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className="flex items-center justify-center rounded-full bg-primary text-primary-foreground font-medium"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
