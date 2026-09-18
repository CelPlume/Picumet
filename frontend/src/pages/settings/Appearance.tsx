// 外观设置
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X, Image as ImageIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Switch, Button } from '@/components/ui/core';
import { ColorPicker } from '@/components/ui/colorpicker';
import { RadioGroup } from '@/components/ui/radio-group';
import { useTheme } from '@/stores/theme';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#0EA5E9', '#64748B'];

const MAX_BG_SIZE = 2 * 1024 * 1024; // 2MB

export default function AppearancePage() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [uploadingBg, setUploadingBg] = useState(false);

  const handleBackgroundUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('error', '仅支持图片文件');
      return;
    }
    if (file.size > MAX_BG_SIZE) {
      toast('error', '图片文件不能超过 2MB');
      return;
    }
    setUploadingBg(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      theme.set({ backgroundType: 'image', backgroundUrl: base64 });
      localStorage.setItem('picumet:custom-background', base64);
      toast('success', '背景图片已上传');
      setUploadingBg(false);
    };
    reader.onerror = () => {
      toast('error', '图片读取失败');
      setUploadingBg(false);
    };
    reader.readAsDataURL(file);
  };

  const clearBackground = () => {
    theme.set({ backgroundType: 'none', backgroundUrl: undefined });
    localStorage.removeItem('picumet:custom-background');
    toast('success', '已清除背景图片');
  };

  const themeOptions = [
    { value: 'light', label: t('settings.themeLight'), description: '始终使用浅色模式' },
    { value: 'dark', label: t('settings.themeDark'), description: '始终使用深色模式' },
    { value: 'system', label: t('settings.themeSystem'), description: '跟随操作系统外观' },
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>{t('settings.accentColor')}</Label>
              <div className="mt-1.5">
                <ColorPicker value={theme.accentColor} onChange={(c) => theme.set({ accentColor: c })} presets={COLORS} />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border px-3">
              <div>
                <p className="text-sm font-medium">{t('settings.enableBlur')}</p>
                <p className="text-xs text-muted-foreground">弹窗/菜单/提示背景模糊</p>
              </div>
              <Switch checked={theme.enableBlur} onChange={(v) => theme.set({ enableBlur: v })} />
            </div>

            <div>
              <Label>文件图标风格</Label>
              <RadioGroup
                value={theme.fileIcons}
                onChange={(v) => theme.set({ fileIcons: v as 'iconify' | 'emoji' })}
                options={[
                  { value: 'iconify', label: 'Iconify 图标', description: '线性图标，统一描边' },
                  { value: 'emoji', label: 'Emoji', description: '彩色表情符号' },
                ]}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label>文件夹显示</Label>
              <RadioGroup
                value={theme.folderPreview}
                onChange={(v) => theme.set({ folderPreview: v as 'icon' | 'contents' })}
                options={[
                  { value: 'icon', label: '文件夹图标', description: '仅显示文件夹图标' },
                  { value: 'contents', label: '显示内部文件预览', description: '按当前排序展示前四项' },
                ]}
                className="mt-1.5"
              />
            </div>
          </div>

          <div>
            <Label>右键单击行为</Label>
            <RadioGroup
              value={theme.rightClickAction}
              onChange={(v) => theme.set({ rightClickAction: v as 'properties' | 'menu' })}
              options={[
                { value: 'properties', label: '打开属性面板', description: '直接查看文件属性' },
                { value: 'menu', label: '打开上下文菜单', description: '弹出操作菜单' },
              ]}
              className="mt-1.5"
            />
            <div className="mt-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">右键多选文件</p>
                <p className="text-xs text-muted-foreground">右键未选中文件时累积加入选择集</p>
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
                  {uploadingBg ? '上传中...' : '上传图片（≤2MB）'}
                  <input type="file" accept="image/*" className="hidden" onChange={handleBackgroundUpload} disabled={uploadingBg} />
                </label>
                {theme.backgroundUrl && (
                  <Button variant="outline" onClick={clearBackground}>
                    <X className="h-4 w-4" /> 清除
                  </Button>
                )}
              </div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5" />
                支持 JPG/PNG/WebP，最大 2MB，图片将保存在浏览器本地存储中。
              </p>
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
