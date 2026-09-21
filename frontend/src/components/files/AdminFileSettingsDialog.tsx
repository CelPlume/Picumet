// 管理后台「全部文件」属性设置弹窗：文件属性（名称/标题/图标/颜色）+ 可见性/游客权限 + 文件夹级联开关
// 实现方案 (b) 自建表单：PropertiesPanel 是右侧栏布局（自带标题栏、每字段独立即时保存、无重命名与级联开关），
// 直接嵌入弹窗需要额外的宽度/滚动适配且无法表达「一次提交 + cascade」语义，故复用其字段集自建表单。
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileListItem, GuestVisibility, Visibility } from '@shared/types';
import { Badge, Button, Dialog, Input, Label, Separator } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { CheckboxWithLabel } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import FileIcon from './FileIcon';

const COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#64748B'];

/** 表单态游客可见性：'inherit' = 未设置（提交给后端即跟随角色默认） */
type GuestVisibilityField = GuestVisibility | 'inherit';

export function AdminFileSettingsDialog({
  file,
  onClose,
  onSaved,
}: {
  /** 当前编辑的行；null = 已关闭 */
  file: FileListItem | null;
  onClose: () => void;
  /** 保存成功后回调（刷新列表由调用方负责） */
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  // 退出动画期间 file 已置空：保留最后一份文件供渲染（同 preview.tsx）
  const lastFileRef = useRef<FileListItem | null>(null);
  if (file) lastFileRef.current = file;
  const shown = file ?? lastFileRef.current;

  // 每次「打开」换一次 key：取消后重新打开不残留未保存的编辑
  const [opened, setOpened] = useState(false);
  const [session, setSession] = useState(0);
  if (opened !== !!file) {
    setOpened(!!file);
    if (file) setSession((s) => s + 1);
  }

  return (
    <Dialog
      open={!!file}
      onClose={onClose}
      title={t('admin.allFiles.settingsTitle')}
      width="w-[min(560px,94vw)]"
    >
      {shown && <SettingsForm key={session} file={shown} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function SettingsForm({
  file,
  onClose,
  onSaved,
}: {
  file: FileListItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const isFolder = file.type === 'folder';
  const [name, setName] = useState(file.name);
  const [customTitle, setCustomTitle] = useState(file.customTitle ?? '');
  const [customColor, setCustomColor] = useState(file.customColor ?? '');
  const [iconEmoji, setIconEmoji] = useState(file.iconEmoji ?? '');
  const [visibility, setVisibility] = useState<Visibility>(file.visibility);
  const [guestVisibility, setGuestVisibility] = useState<GuestVisibilityField>(file.guestVisibility ?? 'inherit');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  /** 级联开关：默认不勾选（只改本项），避免一次操作连带整串子树 */
  const [cascade, setCascade] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const nextName = name.trim();
    // 只提交真正改动过的字段；cascade 仅对文件夹有意义，显式传 false = 只改本项
    const payload: Record<string, unknown> = {};
    if (nextName !== file.name) payload.name = nextName;
    if (customTitle.trim() !== (file.customTitle ?? '')) payload.customTitle = customTitle.trim() || null;
    if (customColor !== (file.customColor ?? '')) payload.customColor = customColor || null;
    if (iconEmoji.trim() !== (file.iconEmoji ?? '')) payload.iconEmoji = iconEmoji.trim() || null;
    if (visibility !== file.visibility) payload.visibility = visibility;
    if (guestVisibility !== (file.guestVisibility ?? 'inherit')) payload.guestVisibility = guestVisibility;
    if (!isFolder) {
      if (clearPassword) payload.accessPassword = null;
      else if (password) payload.accessPassword = password;
    }
    // 级联只对文件夹有意义，随实际变更一起提交；显式 false = 只改本项（默认不勾选）
    if (isFolder && Object.keys(payload).length > 0) payload.cascade = cascade;

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiFetch(`/api/files/${file.id}`, { method: 'PUT', body: payload });
      toast('success', t('admin.allFiles.saved'));
      onSaved();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('admin.operationFailed'));
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg bg-muted">
          <FileIcon name={file.name} type={file.type} iconEmoji={iconEmoji || file.iconEmoji} className="h-8 w-8" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{customTitle || name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{file.path}</p>
        </div>
        {file.hasPassword && !isFolder && <Badge variant="warning">{t('files.passwordProtected')}</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground">{t('files.type')}</p>
          <p className="font-medium">{isFolder ? t('files.properties.typeFolder') : file.mimeType ?? t('files.properties.typeFile')}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t('files.size')}</p>
          <p className="font-medium">{isFolder ? '-' : formatBytes(file.size)}</p>
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

      <div className="space-y-3">
        <div>
          <Label className="text-xs">{t('files.name')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>

        <div>
          <Label className="text-xs">{t('files.properties.customTitleLabel')}</Label>
          <Input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder={file.name} className="mt-1 h-8 text-sm" />
        </div>

        <div>
          <Label className="text-xs">{t('files.properties.customIcon')}</Label>
          <Input value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} placeholder="📄" className="mt-1 h-8 text-sm" />
          <p className="mt-1 text-xs text-muted-foreground">{t('files.properties.customIconHint')}</p>
        </div>

        <div>
          <Label className="text-xs">{t('settings.accentColor')}</Label>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCustomColor(c)}
                aria-label={c}
                className="h-5 w-5 rounded-full border border-border transition-transform hover:scale-110"
                style={{ background: c }}
              />
            ))}
            <input
              type="color"
              value={customColor || '#3B82F6'}
              onChange={(e) => setCustomColor(e.target.value)}
              className="h-5 w-7 cursor-pointer rounded border"
            />
          </div>
        </div>

        <div>
          <Label className="text-xs">{t('files.properties.visibility')}</Label>
          <Select
            className="mt-1"
            value={visibility}
            onValueChange={(v) => {
              if (v !== 'private' && v !== 'users' && v !== 'public') return;
              setVisibility(v);
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
            }}
            options={[
              { value: 'inherit', label: t('files.properties.guestInherit') },
              { value: 'none', label: t('files.properties.guestNone') },
              { value: 'download', label: t('files.properties.guestDownload') },
              { value: 'view', label: t('files.properties.guestView') },
            ]}
          />
        </div>

        {!isFolder && (
          <div>
            <Label className="text-xs">{t('files.passwordProtected')}</Label>
            <div className="mt-1 flex gap-1.5">
              <Input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setClearPassword(false);
                }}
                placeholder={t('files.properties.setPasswordPlaceholder')}
                className="h-8 text-sm"
              />
              {file.hasPassword && (
                <Button
                  type="button"
                  variant={clearPassword ? 'destructive' : 'outline'}
                  size="sm"
                  className="h-8 shrink-0"
                  onClick={() => {
                    setPassword('');
                    setClearPassword(true);
                  }}
                >
                  {t('files.properties.clearPassword')}
                </Button>
              )}
            </div>
          </div>
        )}

        {isFolder && (
          <div className="rounded-lg border p-2.5">
            <CheckboxWithLabel
              checked={cascade}
              onChange={setCascade}
              label={t('admin.allFiles.cascade')}
              description={t('admin.allFiles.cascadeHint')}
            />
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void save()} loading={saving} disabled={!name.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

export default AdminFileSettingsDialog;
