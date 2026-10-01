// 主题切换 + 语言切换 + 用户菜单（顶栏小组件）
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Languages, LogOut, Settings, Shield, FolderOpen, Monitor, Check } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/theme';
import { setLocale } from '@/lib/i18n';
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui/dropdown';
import { Button } from '@/components/ui/core';
import { UsageDisplay } from '@/components/ui/usage';
import { getCachedAsset, cacheAsset, assetProxyUrl } from '@/lib/image-cache';

const THEME_OPTIONS = [
  { value: 'light', labelKey: 'settings.themeLight', icon: <Sun className="h-4 w-4" /> },
  { value: 'dark', labelKey: 'settings.themeDark', icon: <Moon className="h-4 w-4" /> },
  { value: 'system', labelKey: 'settings.themeSystem', icon: <Monitor className="h-4 w-4" /> },
];

export function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const set = useTheme((s) => s.set);
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const currentIcon = THEME_OPTIONS.find((o) => o.value === theme)?.icon ?? (dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />);
  return (
    <Dropdown
      align="end"
      trigger={
        <Button variant="ghost" size="icon" title={t('settings.theme')} aria-label={t('common.toggleTheme')}>
          {currentIcon}
        </Button>
      }
    >
      {(close) => (
        <>
          <DropdownLabel>{t('common.themeMenu')}</DropdownLabel>
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
                <span>{t(opt.labelKey)}</span>
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
  const { t, i18n } = useTranslation();
  return (
    <Dropdown
      align="end"
      trigger={
        <Button variant="ghost" size="icon" title={t('settings.language')} aria-label={t('common.toggleLanguage')}>
          <Languages className="h-4 w-4" />
        </Button>
      }
    >
      {(close) => (
        <>
          <DropdownLabel>{t('common.languageMenu')}</DropdownLabel>
          <DropdownItem
            onClick={() => {
              setLocale('zh-CN');
              close();
            }}
          >
            <span className="flex w-full items-center justify-between gap-8">
              <span>{t('common.langChinese')}</span>
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
  const { user, quota, logout } = useAuth();
  const { t } = useTranslation();
  if (!user) return null;
  const display = user.displayName || user.username;
  return (
    <Dropdown
      align="end"
      triggerClass="flex items-center"
      contentClass="w-72"
      trigger={
        <div className="flex h-9 items-center gap-1.5 rounded-md p-1 pr-2 hover:bg-accent">
          <Avatar name={display} url={user.avatarUrl} size={28} />
          <span className="hidden max-w-[120px] truncate text-sm sm:block">{display}</span>
        </div>
      }
    >
      {(close) => (
        <>
          {/* 身份区：左=邮箱（上行）+ 昵称（下行），右=小头像；Avatar 高度恰为两行文本（text-sm × 2 = 40px） */}
          <div className="flex items-center gap-3 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.email}</p>
              <p className="truncate text-sm text-muted-foreground">{display}</p>
            </div>
            <span className="shrink-0">
              <Avatar name={display} url={user.avatarUrl} size={40} />
            </span>
          </div>
          <DropdownSeparator />
          {/* 用量区：文件数量 + 存储空间（auth store 已随 /api/auth/me 返回 quota）；
              进度条 / 运动圆环由外观设置 usageStyle 决定，个人资料卡与头像菜单共用 */}
          {quota && (
            <div className="px-2 py-1.5">
              <UsageDisplay quota={quota} compact />
            </div>
          )}
          <DropdownSeparator />
          <DropdownItem onClick={() => { close(); window.location.href = '/files'; }}>
            <FolderOpen className="h-4 w-4" /> {t('nav.files')}
          </DropdownItem>
          <DropdownItem onClick={() => { close(); window.location.href = '/settings/profile'; }}>
            <Settings className="h-4 w-4" /> {t('nav.settings')}
          </DropdownItem>
          {user.role === 'admin' && (
            <DropdownItem onClick={() => { close(); window.location.href = '/admin'; }}>
              <Shield className="h-4 w-4" /> {t('nav.admin')}
            </DropdownItem>
          )}
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
  const [imgError, setImgError] = useState(false);
  const proxy = assetProxyUrl('avatar', url);
  const [src, setSrc] = useState<string | undefined>(() => getCachedAsset('avatar', url) || proxy || url);

  useEffect(() => {
    setImgError(false);
    if (!url) {
      setSrc(undefined);
      return;
    }
    const cached = getCachedAsset('avatar', url);
    if (cached) {
      setSrc(cached);
    } else {
      const target = assetProxyUrl('avatar', url) || url;
      setSrc(target);
      void cacheAsset('avatar', url).then((dataUrl) => {
        if (dataUrl) setSrc(dataUrl);
      });
    }
  }, [url]);

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={name}
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
        onError={() => {
          // 若中转端点失败，尝试直接请求原始外链一次；均失败才回落首字母头像
          if (src !== url && url) {
            setSrc(url);
          } else {
            setImgError(true);
          }
        }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-full bg-primary font-medium text-primary-foreground"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
