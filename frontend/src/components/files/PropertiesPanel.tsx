// 属性面板：文件信息 + 自定义标题/颜色/图标 + 设置密码
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { FileListItem } from '@shared/types';
import { Button, Input, Label, Separator, Badge } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { useUpdateFile } from './data';

const COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#64748B'];

export function PropertiesPanel({
  file,
  onClose,
}: {
  file: FileListItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateFile();
  const [customTitle, setCustomTitle] = useState(file?.customTitle ?? '');
  const [customColor, setCustomColor] = useState(file?.customColor ?? '');
  const [iconEmoji, setIconEmoji] = useState(file?.iconEmoji ?? '');
  const [password, setPassword] = useState('');

  if (!file) return null;

  const save = async (fields: Record<string, unknown>) => {
    try {
      await update.mutateAsync({ id: file.id, fields });
      toast('success', '已保存');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="font-medium">{t('files.propertiesTitle')}</h3>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="关闭">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-muted text-3xl">
            {file.iconEmoji ?? (file.type === 'folder' ? '📁' : '📄')}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{file.customTitle ?? file.name}</p>
            <p className="text-xs text-muted-foreground">{file.path}</p>
          </div>
        </div>

        {file.hasPassword && <Badge variant="warning">{t('files.passwordProtected')}</Badge>}

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('files.type')}</p>
            <p>{file.type === 'folder' ? '文件夹' : file.mimeType ?? '文件'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('files.size')}</p>
            <p>{formatBytes(file.size)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('files.modified')}</p>
            <p>{formatDateTime(file.updatedAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">ID</p>
            <p className="truncate">{file.id.slice(0, 8)}</p>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <Label>{t('files.name')}（自定义标题）</Label>
            <div className="mt-1 flex gap-2">
              <Input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder={file.name} />
              <Button variant="outline" size="sm" onClick={() => void save({ customTitle: customTitle || null })}>
                {t('common.save')}
              </Button>
            </div>
          </div>

          <div>
            <Label>{t('settings.accentColor')}</Label>
            <div className="mt-1.5 flex items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setCustomColor(c);
                    void save({ customColor: c });
                  }}
                  className="h-6 w-6 rounded-full border border-border transition-transform hover:scale-110"
                  style={{ background: c }}
                />
              ))}
              <input
                type="color"
                value={customColor || '#3B82F6'}
                onChange={(e) => {
                  setCustomColor(e.target.value);
                  void save({ customColor: e.target.value });
                }}
                className="h-6 w-8 cursor-pointer rounded border"
              />
            </div>
          </div>

          <div>
            <Label>图标 Emoji</Label>
            <div className="mt-1 flex gap-2">
              <Input value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} placeholder="📄" maxLength={8} />
              <Button variant="outline" size="sm" onClick={() => void save({ iconEmoji: iconEmoji || null })}>
                {t('common.save')}
              </Button>
            </div>
          </div>

          {file.type === 'file' && (
            <div>
              <Label>{t('files.passwordProtected')}</Label>
              <div className="mt-1 flex gap-2">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="设置访问密码" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void save({ accessPassword: password || null })}
                >
                  {password ? '设置' : '清除'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
