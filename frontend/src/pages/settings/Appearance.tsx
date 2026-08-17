// 外观设置
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Switch } from '@/components/ui/core';
import { useTheme } from '@/stores/theme';
import { cn } from '@/lib/utils';

const COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#0EA5E9', '#64748B'];

export default function AppearancePage() {
  const { t } = useTranslation();
  const theme = useTheme();

  const themeOptions = [
    { id: 'light' as const, label: t('settings.themeLight') },
    { id: 'dark' as const, label: t('settings.themeDark') },
    { id: 'system' as const, label: t('settings.themeSystem') },
  ];

  return (
    <div className="max-w-xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.theme')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            {themeOptions.map((o) => (
              <button
                key={o.id}
                onClick={() => theme.set({ theme: o.id })}
                className={cn(
                  'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  theme.theme === o.id ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-accent'
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div>
            <Label>{t('settings.accentColor')}</Label>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => theme.set({ accentColor: c })}
                  className={cn(
                    'h-7 w-7 rounded-full transition-transform hover:scale-110',
                    theme.accentColor === c && 'ring-2 ring-offset-2 ring-foreground'
                  )}
                  style={{ background: c }}
                />
              ))}
              <input
                type="color"
                value={theme.accentColor}
                onChange={(e) => theme.set({ accentColor: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border"
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm">{t('settings.enableBlur')}</span>
            <Switch checked={theme.enableBlur} onChange={(v) => theme.set({ enableBlur: v })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.background')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            {(['none', 'image', 'color'] as const).map((bt) => (
              <button
                key={bt}
                onClick={() => theme.set({ backgroundType: bt })}
                className={cn(
                  'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  theme.backgroundType === bt ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-accent'
                )}
              >
                {bt === 'none' ? t('settings.backgroundNone') : bt === 'image' ? t('settings.backgroundImage') : t('settings.backgroundColor')}
              </button>
            ))}
          </div>

          {theme.backgroundType === 'image' && (
            <div>
              <Label>{t('settings.backgroundImage')}</Label>
              <Input
                className="mt-1"
                value={theme.backgroundUrl ?? ''}
                onChange={(e) => theme.set({ backgroundUrl: e.target.value })}
                placeholder={t('settings.backgroundUrlPlaceholder')}
              />
            </div>
          )}

          {theme.backgroundType === 'color' && (
            <div>
              <Label>{t('settings.backgroundColor')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color"
                  value={theme.backgroundColor ?? '#0f172a'}
                  onChange={(e) => theme.set({ backgroundColor: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded border"
                />
                <Input
                  value={theme.backgroundColor ?? ''}
                  onChange={(e) => theme.set({ backgroundColor: e.target.value })}
                  placeholder="#0f172a"
                />
              </div>
            </div>
          )}

          {theme.backgroundType !== 'none' && (
            <div className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              预览区域
              {theme.backgroundType === 'image' && theme.backgroundUrl && (
                <div
                  className="mt-2 h-24 rounded bg-cover bg-center"
                  style={{ backgroundImage: `url(${theme.backgroundUrl})` }}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
