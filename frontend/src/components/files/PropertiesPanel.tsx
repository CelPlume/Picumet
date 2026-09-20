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
  const [visibility, setVisibility] = useState<'private' | 'users' | 'public'>(file?.visibility ?? 'private');
  const [ruleEffect, setRuleEffect] = useState('allow');
  const [ruleTargetMode, setRuleTargetMode] = useState('all');
  const [ruleUserId, setRuleUserId] = useState('');

  if (!file) return null;

  const save = async (fields: Record<string, unknown>) => {
    try {
      await update.mutateAsync({ id: file.id, fields });
      toast('success', '已保存');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '保存失败');
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
      toast('success', '规则已创建');
      setRuleUserId('');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '创建失败');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h3 className="text-sm font-medium">{t('files.propertiesTitle')}</h3>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="关闭">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 scrollbar-thin">
        <div className="flex items-center gap-2.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-2xl">
            {file.iconEmoji ?? (file.type === 'folder' ? '📁' : '📄')}
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
            <p className="font-medium">{file.type === 'folder' ? '文件夹' : file.mimeType ?? '文件'}</p>
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
            <Label className="text-xs">{t('files.name')}（自定义标题）</Label>
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
            <Label className="text-xs">图标 Emoji</Label>
            <div className="mt-1 flex gap-1.5">
              <Input value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} placeholder="📄" maxLength={8} className="h-8 text-sm" />
              <Button variant="outline" size="sm" onClick={() => void save({ iconEmoji: iconEmoji || null })} className="h-8 shrink-0">
                {t('common.save')}
              </Button>
            </div>
          </div>

          {file.type === 'file' && (
            <div>
              <Label className="text-xs">{t('files.passwordProtected')}</Label>
              <div className="mt-1 flex gap-1.5">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="设置访问密码" className="h-8 text-sm" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void save({ accessPassword: password || null })}
                  className="h-8 shrink-0"
                >
                  {password ? '设置' : '清除'}
                </Button>
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs">可见性</Label>
            <Select
              className="mt-1"
              value={visibility}
              onValueChange={(v) => {
                if (v !== 'private' && v !== 'users' && v !== 'public') return;
                setVisibility(v);
                void save({ visibility: v });
              }}
              options={[
                { value: 'private', label: '私密（仅自己与授权者）' },
                { value: 'users', label: '站内用户可见' },
                { value: 'public', label: '公开（进入公开空间）' },
              ]}
            />
            {file.visibility === 'public' && file.reviewStatus === 'pending' && (
              <p className="mt-1 text-xs text-amber-600">公开申请审核中，管理员批准后所有人可见</p>
            )}
            {file.visibility === 'public' && file.reviewStatus === 'approved' && (
              <p className="mt-1 text-xs text-emerald-600">已公开，可在公开空间访问</p>
            )}
            {file.visibility === 'public' && file.reviewStatus === 'rejected' && (
              <p className="mt-1 text-xs text-destructive">公开申请被驳回</p>
            )}
          </div>

          <div>
            <Label className="text-xs">访问规则</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">授权/禁止其他用户访问此文件（需 can_grant 能力位；管理入口：设置 → 访问规则）</p>
            <div className="mt-1 flex gap-1.5">
              <Select
                className="w-24 shrink-0"
                value={ruleEffect}
                onValueChange={(v) => setRuleEffect(v)}
                options={[
                  { value: 'allow', label: '允许' },
                  { value: 'deny', label: '禁止' },
                ]}
              />
              <Select
                className="w-32 shrink-0"
                value={ruleTargetMode}
                onValueChange={(v) => setRuleTargetMode(v)}
                options={[
                  { value: 'all', label: '全部用户' },
                  { value: 'user', label: '指定用户' },
                ]}
              />
              {ruleTargetMode === 'user' && (
                <Input value={ruleUserId} onChange={(e) => setRuleUserId(e.target.value)} placeholder="用户 ID" className="h-8 min-w-0 flex-1 text-sm" />
              )}
              <Button variant="outline" size="sm" onClick={() => void createRule()} className="h-8 shrink-0">
                添加
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
