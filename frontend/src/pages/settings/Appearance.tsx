// 外观设置
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pipette, Upload, X, Image as ImageIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Label, Switch, Button } from '@/components/ui/core';
import { RadioGroup } from '@/components/ui/radio-group';
import { BlurSlider } from '@/components/settings/BlurSlider';
import { useTheme } from '@/stores/theme';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const ACCENT_PRESETS = ['#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#0EA5E9', '#64748B'];

const MAX_BG_SIZE = 2 * 1024 * 1024; // 2MB

export default function AppearancePage() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [uploadingBg, setUploadingBg] = useState(false);
  const customColorRef = useRef<HTMLInputElement>(null);
  const isCustomAccent = !ACCENT_PRESETS.some((c) => c.toLowerCase() === theme.accentColor.toLowerCase());

  const handleBackgroundUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('error', t('settings.appearance.imageOnly'));
      return;
    }
    if (file.size > MAX_BG_SIZE) {
      toast('error', t('settings.appearance.imageTooLarge'));
      return;
    }
    setUploadingBg(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      theme.set({ backgroundType: 'image', backgroundUrl: base64 });
      localStorage.setItem('picumet:custom-background', base64);
      toast('success', t('settings.appearance.backgroundUploaded'));
      setUploadingBg(false);
    };
    reader.onerror = () => {
      toast('error', t('settings.appearance.imageReadFailed'));
      setUploadingBg(false);
    };
    reader.readAsDataURL(file);
  };

  const clearBackground = () => {
    theme.set({ backgroundType: 'none', backgroundUrl: undefined });
    localStorage.removeItem('picumet:custom-background');
    toast('success', t('settings.appearance.backgroundCleared'));
  };

  const themeOptions = [
    { value: 'light', label: t('settings.themeLight'), description: t('settings.appearance.themeLightDesc') },
    { value: 'dark', label: t('settings.themeDark'), description: t('settings.appearance.themeDarkDesc') },
    { value: 'system', label: t('settings.themeSystem'), description: t('settings.appearance.themeSystemDesc') },
  ];

  return (
    <div className="grid max-w-5xl items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.theme')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={theme.theme}
            onChange={(v) => theme.set({ theme: v as 'light' | 'dark' | 'system' })}
            options={themeOptions}
          />

          <div>
            <Label>{t('settings.accentColor')}</Label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {ACCENT_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => theme.set({ accentColor: c })}
                  className={cn(
                    'h-7 w-7 cursor-pointer rounded-full border shadow-sm transition-transform hover:scale-110',
                    theme.accentColor.toLowerCase() === c.toLowerCase()
                      ? 'border-transparent ring-2 ring-primary ring-offset-2 ring-offset-background'
                      : 'border-border'
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
              <button
                type="button"
                aria-label={t('settings.accentCustom')}
                onClick={() => customColorRef.current?.click()}
                className={cn(
                  'flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border shadow-sm transition-transform hover:scale-110',
                  isCustomAccent
                    ? 'border-transparent ring-2 ring-primary ring-offset-2 ring-offset-background'
                    : 'border-border'
                )}
                style={{ background: 'conic-gradient(#ef4444, #f59e0b, #10b981, #0ea5e9, #8b5cf6, #ec4899, #ef4444)' }}
              >
                <Pipette className="h-3.5 w-3.5 text-white drop-shadow" />
              </button>
              <input
                ref={customColorRef}
                type="color"
                value={theme.accentColor}
                onChange={(e) => theme.set({ accentColor: e.target.value })}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>{t('settings.appearance.fileIconStyle')}</Label>
              <RadioGroup
                value={theme.fileIcons}
                onChange={(v) => theme.set({ fileIcons: v as 'iconify' | 'emoji' })}
                options={[
                  { value: 'iconify', label: t('settings.appearance.fileIconsIconify'), description: t('settings.appearance.fileIconsIconifyDesc') },
                  { value: 'emoji', label: 'Emoji', description: t('settings.appearance.fileIconsEmojiDesc') },
                ]}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label>{t('settings.appearance.folderDisplay')}</Label>
              <RadioGroup
                value={theme.folderPreview}
                onChange={(v) => theme.set({ folderPreview: v as 'icon' | 'contents' })}
                options={[
                  { value: 'icon', label: t('settings.appearance.folderPreviewIcon'), description: t('settings.appearance.folderPreviewIconDesc') },
                  { value: 'contents', label: t('settings.appearance.folderPreviewContents'), description: t('settings.appearance.folderPreviewContentsDesc') },
                ]}
                className="mt-1.5"
              />
            </div>
          </div>

          <div>
            <Label>{t('settings.blurLevel')}</Label>
            <BlurSlider value={theme.blurLevel} onChange={(level) => theme.set({ blurLevel: level })} className="mt-3" />
          </div>

          <div>
            <Label>{t('settings.appearance.rightClickAction')}</Label>
            <RadioGroup
              value={theme.rightClickAction}
              onChange={(v) => theme.set({ rightClickAction: v as 'properties' | 'menu' })}
              options={[
                { value: 'properties', label: t('settings.appearance.rightClickProperties'), description: t('settings.appearance.rightClickPropertiesDesc') },
                { value: 'menu', label: t('settings.appearance.rightClickMenu'), description: t('settings.appearance.rightClickMenuDesc') },
              ]}
              className="mt-1.5"
            />
            <div className="mt-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{t('settings.appearance.rightClickMultiSelect')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.appearance.rightClickMultiSelectDesc')}</p>
              </div>
              <Switch checked={theme.rightClickMultiSelect} onChange={(v) => theme.set({ rightClickMultiSelect: v })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.background')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={theme.backgroundType}
            onChange={(v) => theme.set({ backgroundType: v as 'none' | 'image' | 'color' })}
            options={[
              { value: 'none', label: t('settings.backgroundNone') },
              { value: 'image', label: t('settings.backgroundImage') },
            ]}
          />

          {theme.backgroundType === 'image' && (
            <div className="space-y-2">
              <Label>{t('settings.backgroundImage')}</Label>
              <div className="flex gap-2">
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-accent">
                  <Upload className="h-4 w-4" />
                  {uploadingBg ? t('settings.appearance.uploading') : t('settings.appearance.uploadImage')}
                  <input type="file" accept="image/*" className="hidden" onChange={handleBackgroundUpload} disabled={uploadingBg} />
                </label>
                {theme.backgroundUrl && (
                  <Button variant="outline" onClick={clearBackground}>
                    <X className="h-4 w-4" /> {t('settings.appearance.clear')}
                  </Button>
                )}
              </div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5" />
                {t('settings.appearance.backgroundHint')}
              </p>
            </div>
          )}

          {theme.backgroundType !== 'none' && (
            <div className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              {t('settings.appearance.previewArea')}
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
