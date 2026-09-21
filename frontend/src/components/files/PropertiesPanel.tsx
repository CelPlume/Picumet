// 属性面板：文件信息 + 自定义标题/颜色/图标 + 设置密码
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { FileListItem } from '@shared/types';
import { Button, Input, Label, Separator, Badge } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { useUpdateFile } from './data';
import FileIcon from './FileIcon';

const COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#64748B'];

/** 游客（未登录访客）可见性：'inherit' 跟随角色默认，null 等同 'inherit' */
type GuestVisibility = 'inherit' | 'none' | 'download' | 'view';

/** shared/types 暂未包含该灰度字段：本地扩展读取，不改动共享类型 */
type PanelFile = FileListItem & { guestVisibility?: GuestVisibility | null };

export function PropertiesPanel({
  file,
  onClose,
}: {
  file: PanelFile | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateFile();
  const [customTitle, setCustomTitle] = useState(file?.customTitle ?? '');
  const [customColor, setCustomColor] = useState(file?.customColor ?? '');
  const [iconEmoji, setIconEmoji] = useState(file?.iconEmoji ?? '');
  const [password, setPassword] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'users' | 'public'>(file?.visibility ?? 'private');
  const [guestVisibility, setGuestVisibility] = useState<GuestVisibility>(file?.guestVisibility ?? 'inherit');
  const [ruleEffect, setRuleEffect] = useState('allow');
  const [ruleTargetMode, setRuleTargetMode] = useState('all');
  const [ruleUserId, setRuleUserId] = useState('');

  if (!file) return null;

  const save = async (fields: Record<string, unknown>) => {
    try {
      await update.mutateAsync({ id: file.id, fields });
      toast('success', t('files.properties.saved'));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.properties.saveFailed'));
    }
  };

  const createRule = async () => {
    try {
      await apiFetch('/api/users/rules', {
        method: 'POST',
        body: {
          itemId: file.id,
          effect: ruleEffect,
          permissions: ['read', 'download'],
          ...(ruleTargetMode === 'all' ? { allUsers: true } : { targetUserId: ruleUserId.trim() }),
        },
      });
      toast('success', t('files.properties.ruleCreated'));
      setRuleUserId('');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('common.createFailed'));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h3 className="text-sm font-medium">{t('files.propertiesTitle')}</h3>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label={t('common.close')}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 scrollbar-thin">
        <div className="flex items-center gap-2.5">
          <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg bg-muted">
            <FileIcon name={file.name} type={file.type} iconEmoji={file.iconEmoji} className="h-8 w-8" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.customTitle ?? file.name}</p>
            <p className="truncate text-xs text-muted-foreground">{file.path}</p>
          </div>
        </div>

        {file.hasPassword && <Badge variant="warning">{t('files.passwordProtected')}</Badge>}

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground">{t('files.type')}</p>
            <p className="font-medium">{file.type === 'folder' ? t('files.properties.typeFolder') : file.mimeType ?? t('files.properties.typeFile')}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{t('files.size')}</p>
            <p className="font-medium">{formatBytes(file.size)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{t('files.modified')}</p>
            <p className="font-medium">{formatDateTime(file.updatedAt)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">ID</p>
            <p className="truncate font-medium">{file.id.slice(0, 8)}</p>
          </div>
        </div>

        <Separator className="my-2" />

        <div className="space-y-2.5">
          <div>
            <Label className="text-xs">{t('files.properties.customTitleLabel')}</Label>
            <div className="mt-1 flex gap-1.5">
              <Input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder={file.name} className="h-8 text-sm" />
              <Button variant="outline" size="sm" onClick={() => void save({ customTitle: customTitle || null })} className="h-8 shrink-0">
                {t('common.save')}
              </Button>
            </div>
          </div>

          <div>
            <Label className="text-xs">{t('settings.accentColor')}</Label>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setCustomColor(c);
                    void save({ customColor: c });
                  }}
                  className="h-5 w-5 rounded-full border border-border transition-transform hover:scale-110"
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
                className="h-5 w-7 cursor-pointer rounded border"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">{t('files.properties.customIcon')}</Label>
            <div className="mt-1 flex gap-1.5">
              <Input value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} placeholder="📄" className="h-8 text-sm" />
              <Button variant="outline" size="sm" onClick={() => void save({ iconEmoji: iconEmoji || null })} className="h-8 shrink-0">
                {t('common.save')}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('files.properties.customIconHint')}</p>
          </div>

          {file.type === 'file' && (
            <div>
              <Label className="text-xs">{t('files.passwordProtected')}</Label>
              <div className="mt-1 flex gap-1.5">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('files.properties.setPasswordPlaceholder')} className="h-8 text-sm" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void save({ accessPassword: password || null })}
                  className="h-8 shrink-0"
                >
                  {password ? t('files.properties.setPassword') : t('files.properties.clearPassword')}
                </Button>
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs">{t('files.properties.visibility')}</Label>
            <Select
              className="mt-1"
              value={visibility}
              onValueChange={(v) => {
                if (v !== 'private' && v !== 'users' && v !== 'public') return;
                setVisibility(v);
                void save({ visibility: v });
              }}
              options={[
                { value: 'private', label: t('files.properties.visibilityPrivate') },
                { value: 'users', label: t('files.properties.visibilityUsers') },
                { value: 'public', label: t('files.properties.visibilityPublic') },
              ]}
            />
            {file.visibility === 'public' && file.reviewStatus === 'pending' && (
              <p className="mt-1 text-xs text-amber-600">{t('files.properties.reviewPending')}</p>
            )}
            {file.visibility === 'public' && file.reviewStatus === 'approved' && (
              <p className="mt-1 text-xs text-emerald-600">{t('files.properties.reviewApproved')}</p>
            )}
            {file.visibility === 'public' && file.reviewStatus === 'rejected' && (
              <p className="mt-1 text-xs text-destructive">{t('files.properties.reviewRejected')}</p>
            )}
          </div>

          <div>
            <Label className="text-xs">{t('files.properties.guestAccess')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('files.properties.guestAccessDesc')}</p>
            <Select
              className="mt-1"
              value={guestVisibility}
              onValueChange={(v) => {
                if (v !== 'inherit' && v !== 'none' && v !== 'download' && v !== 'view') return;
                setGuestVisibility(v);
                void save({ guestVisibility: v });
              }}
              options={[
                { value: 'inherit', label: t('files.properties.guestInherit') },
                { value: 'none', label: t('files.properties.guestNone') },
                { value: 'download', label: t('files.properties.guestDownload') },
                { value: 'view', label: t('files.properties.guestView') },
              ]}
            />
          </div>

          <div>
            <Label className="text-xs">{t('files.properties.accessRules')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('files.properties.accessRulesDesc')}</p>
            <div className="mt-1 space-y-1.5">
              <Select
                className="w-full"
                value={ruleEffect}
                onValueChange={(v) => setRuleEffect(v)}
                options={[
                  { value: 'allow', label: t('files.properties.effectAllow') },
                  { value: 'deny', label: t('files.properties.effectDeny') },
                ]}
              />
              <Select
                className="w-full"
                value={ruleTargetMode}
                onValueChange={(v) => setRuleTargetMode(v)}
                options={[
                  { value: 'all', label: t('files.properties.targetAll') },
                  { value: 'user', label: t('files.properties.targetUser') },
                ]}
              />
              {ruleTargetMode === 'user' && (
                <Input value={ruleUserId} onChange={(e) => setRuleUserId(e.target.value)} placeholder={t('files.properties.userIdPlaceholder')} className="h-9 w-full text-sm" />
              )}
              <Button variant="outline" onClick={() => void createRule()} className="w-full">
                {t('files.properties.addRule')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
