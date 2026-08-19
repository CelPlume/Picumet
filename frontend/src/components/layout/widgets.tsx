// 主题切换 + 语言切换 + 用户菜单（顶栏小组件）
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Languages, LogOut, Settings, Shield, User, Monitor, Check } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/theme';
import { setLocale } from '@/lib/i18n';
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui/dropdown';
import { Button } from '@/components/ui/core';

const THEME_OPTIONS = [
  { value: 'light', label: '浅色', icon: <Sun className="h-4 w-4" /> },
  { value: 'dark', label: '深色', icon: <Moon className="h-4 w-4" /> },
  { value: 'system', label: '跟随系统', icon: <Monitor className="h-4 w-4" /> },
];

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const set = useTheme((s) => s.set);
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const currentIcon = THEME_OPTIONS.find((o) => o.value === theme)?.icon ?? (dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />);
  return (
    <Dropdown
      trigger={
        <Button variant="ghost" size="icon" title="主题" aria-label="切换主题">
          {currentIcon}
        </Button>
      }
    >
      {(close) => (
        <>
          <DropdownLabel>外观主题</DropdownLabel>
          {THEME_OPTIONS.map((opt) => (
            <DropdownItem
              key={opt.value}
              icon={opt.icon}
              onClick={() => {
                set({ theme: opt.value as 'light' | 'dark' | 'system' });
                close();
              }}
            >
              <span className="flex w-full items-center justify-between gap-8">
                <span>{opt.label}</span>
                {theme === opt.value && <Check className="h-4 w-4 text-primary" />}
              </span>
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language?.startsWith('zh') ? '中文' : 'English';
  return (
    <Dropdown
      trigger={
        <Button variant="ghost" size="icon" title="语言" aria-label="切换语言">
          <Languages className="h-4 w-4" />
        </Button>
      }
    >
      {(close) => (
        <>
          <DropdownLabel>语言 / Language</DropdownLabel>
          <DropdownItem
            onClick={() => {
              setLocale('zh-CN');
              close();
            }}
          >
            <span className="flex w-full items-center justify-between gap-8">
              <span>中文</span>
              {i18n.language?.startsWith('zh') && <Check className="h-4 w-4 text-primary" />}
            </span>
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              setLocale('en-US');
              close();
            }}
          >
            <span className="flex w-full items-center justify-between gap-8">
              <span>English</span>
              {i18n.language?.startsWith('en') && <Check className="h-4 w-4 text-primary" />}
            </span>
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
