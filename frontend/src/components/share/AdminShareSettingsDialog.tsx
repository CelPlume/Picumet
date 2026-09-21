// 管理员：分享设置弹窗
// 打开时 GET /api/admin/shares/:id 拉详情，可改写分享本身（状态 / 有效期 / 次数上限 /
// 预览与下载开关 / 访问权限 / 密码）；保存时只 PATCH 与详情快照不同的字段。
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Eye, Globe, KeyRound, Lock, LogIn, UserCheck } from 'lucide-react';
import { Badge, Button, Dialog, Input, Label, Switch } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { TableSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { ApiError, apiFetch } from '@/lib/api';
import { cn, formatBytes, formatDateTime } from '@/lib/utils';
import FileIcon from '@/components/files/FileIcon';
import type { FileListItem, ShareStatus } from '@shared/types';

/** 管理员可写入的分享字段（全部可选，与 PATCH /api/admin/shares/:id 契约一致） */
interface AdminSharePatch {
  status?: 'active' | 'revoked';
  expiresAt?: number | null;
  maxViews?: number | null;
  maxDownloads?: number | null;
  allowPreview?: boolean;
  allowDownload?: boolean;
  requireLogin?: boolean;
  allowedUsers?: string[] | null;
  password?: string | null;
}

/** GET /api/admin/shares/:id 的 share 视图 */
export interface AdminShareDetail {
  id: string;
  title?: string;
  creatorId: string;
  creatorName: string;
  status: ShareStatus;
  expiresAt?: number | null;
  maxViews?: number | null;
  viewCount: number;
  maxDownloads?: number | null;
  downloadCount: number;
  allowPreview: boolean;
  allowDownload: boolean;
  requireLogin: boolean;
  allowedUserCount: number;
  passwordProtected: boolean;
  createdAt: number;
  lastAccessedAt?: number | null;
  items: FileListItem[];
}

/** 访问权限三态：所有人 / 仅登录用户 / 指定用户白名单 */
type AccessMode = 'public' | 'login' | 'users';

/** 时间戳 → <input type="datetime-local"> 需要的本地时间串（分钟精度） */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 上限输入 → 数值：空串与 <=0 一律视为「不限」(null) */
function toLimit(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function AdminShareSettingsDialog({
  open,
  shareId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** 待设置的分享 id；null 时弹窗不渲染内容 */
  shareId: string | null;
  onClose: () => void;
  /** 保存成功后回调（父级刷新列表） */
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<AdminShareDetail | null>(null);

  // 表单态：打开时用详情快照初始化，保存时与快照比对得出增量字段
  const [status, setStatus] = useState<'active' | 'revoked'>('active');
  const [neverExpires, setNeverExpires] = useState(true);
  const [expiresInput, setExpiresInput] = useState('');
  const [maxViews, setMaxViews] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [allowPreview, setAllowPreview] = useState(true);
  const [allowDownload, setAllowDownload] = useState(true);
  const [accessMode, setAccessMode] = useState<AccessMode>('public');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!open || !shareId) return;
    // 关闭期间不卸载详情（弹窗退出动画要沿用最后一次内容），打开时才重置为骨架
    let alive = true;
    setLoading(true);
    setDetail(null);
    void (async () => {
      try {
        const res = await apiFetch<{ share: AdminShareDetail }>(`/api/admin/shares/${shareId}`);
        if (!alive) return;
        const s = res.data.share;
        setDetail(s);
        setStatus(s.status === 'revoked' ? 'revoked' : 'active');
        setNeverExpires(!s.expiresAt);
        setExpiresInput(s.expiresAt ? toLocalInput(s.expiresAt) : '');
        setMaxViews(s.maxViews ? String(s.maxViews) : '');
        setMaxDownloads(s.maxDownloads ? String(s.maxDownloads) : '');
        setAllowPreview(s.allowPreview);
        setAllowDownload(s.allowDownload);
        setAccessMode(!s.requireLogin ? 'public' : s.allowedUserCount > 0 ? 'users' : 'login');
        setAllowedUsers('');
        setPassword('');
      } catch {
        if (!alive) return;
        toast('error', t('admin.shares.loadFailed'));
        onClose();
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // t / onClose 不参与依赖：仅在打开某个分享时拉取一次详情，避免父级重渲染触发重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shareId]);

  const save = async () => {
    if (!detail) return;
    const patch: AdminSharePatch = {};

    if (status !== (detail.status === 'revoked' ? 'revoked' : 'active')) patch.status = status;

    // 有效期：永久 → null；指定时间 → 校验后下发；仅当输入相对快照有变化才写
    const initialExpiresInput = detail.expiresAt ? toLocalInput(detail.expiresAt) : '';
    if (!neverExpires) {
      const ts = expiresInput ? new Date(expiresInput).getTime() : Number.NaN;
      if (!Number.isFinite(ts)) return toast('error', t('myShares.expiryInvalid'));
      if (expiresInput !== initialExpiresInput) patch.expiresAt = ts;
    } else if (detail.expiresAt) {
      patch.expiresAt = null;
    }

    if (maxViews.trim() !== (detail.maxViews ? String(detail.maxViews) : '')) patch.maxViews = toLimit(maxViews);
    if (maxDownloads.trim() !== (detail.maxDownloads ? String(detail.maxDownloads) : '')) {
      patch.maxDownloads = toLimit(maxDownloads);
    }

    if (allowPreview !== detail.allowPreview) patch.allowPreview = allowPreview;
    if (allowDownload !== detail.allowDownload) patch.allowDownload = allowDownload;

    // 访问权限：requireLogin 只在取值变化时下发；白名单只在意图明确时下发，
    // 避免管理员仅修改其他字段时把既有白名单清空（后端详情只给人数不给用户名）
    const initialMode: AccessMode = !detail.requireLogin ? 'public' : detail.allowedUserCount > 0 ? 'users' : 'login';
    const users = allowedUsers.split(',').map((u) => u.trim()).filter(Boolean);
    const requireLogin = accessMode !== 'public';
    if (requireLogin !== detail.requireLogin) patch.requireLogin = requireLogin;
    if (accessMode === 'users') {
      if (users.length > 0) patch.allowedUsers = users;
      else if (initialMode !== 'users') return toast('error', t('myShares.usersRequired'));
    } else if (initialMode === 'users') {
      patch.allowedUsers = null;
    }

    // 密码：填了新密码即重置；留空即清除（原无密码时无需下发）
    if (password.trim()) patch.password = password.trim();
    else if (detail.passwordProtected) patch.password = null;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiFetch(`/api/admin/shares/${detail.id}`, { method: 'PATCH', body: patch });
      toast('success', t('admin.shares.saved'));
      onSaved();
      onClose();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const AccessIcon = accessMode === 'users' ? UserCheck : accessMode === 'login' ? LogIn : Globe;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl w-[calc(100vw-2rem)]"
      title={t('admin.shares.settings')}
      description={detail ? detail.title ?? detail.items[0]?.name ?? detail.id : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} loading={saving} disabled={loading || !detail}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {loading || !detail ? (
        <TableSkeleton rows={5} cols={3} />
      ) : (
        <div className="space-y-5">
          {/* 只读概览：创建者 / 过期时间 / 浏览 / 下载 */}
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">{t('admin.shares.creator')}</p>
              <p className="truncate font-medium" title={detail.creatorId}>
                {detail.creatorName || detail.creatorId}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('share.expiresAt')}</p>
              <p className="font-medium">{detail.expiresAt ? formatDateTime(detail.expiresAt) : t('share.forever')}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('admin.shares.views')}</p>
              <p className="font-medium tabular-nums">
                {t('share.views', { used: detail.viewCount, max: detail.maxViews ?? t('myShares.noLimit') })}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('admin.shares.downloads')}</p>
              <p className="font-medium tabular-nums">
                {t('share.downloads', { used: detail.downloadCount, max: detail.maxDownloads ?? t('myShares.noLimit') })}
              </p>
            </div>
          </div>

          {/* 只读：分享项目列表（名称 / 类型 / 大小） */}
          <div>
            <div className="flex items-center justify-between">
              <Label>{t('admin.shares.itemsList')}</Label>
              <span className="text-xs text-muted-foreground">{t('share.itemsCount', { count: detail.items.length })}</span>
            </div>
            {detail.items.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('share.noItems')}</p>
            ) : (
              <div className="mt-1 max-h-40 divide-y divide-border overflow-y-auto rounded-md border">
                {detail.items.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 px-3 py-2">
                    <FileIcon name={f.name} type={f.type} className="h-5 w-5 shrink-0" iconEmoji={f.iconEmoji} />
                    <span className="min-w-0 flex-1 truncate text-sm">{f.customTitle ?? f.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {f.type === 'folder' ? t('files.properties.typeFolder') : t('files.properties.typeFile')}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                      {f.type === 'folder' ? '-' : formatBytes(f.size)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 可编辑：状态 / 有效期 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t('admin.shares.status')}</Label>
              <Select
                className="mt-1"
                value={status}
                onValueChange={(v) => setStatus(v === 'revoked' ? 'revoked' : 'active')}
                options={[
                  { value: 'active', label: t('share.statusActive') },
                  { value: 'revoked', label: t('share.statusRevoked') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.shares.extend')}</Label>
              <div className="mt-1 flex items-center justify-between rounded-md border px-3 py-1.5">
                <span className={cn('text-sm', !neverExpires && 'text-muted-foreground')}>{t('share.forever')}</span>
                <Switch checked={neverExpires} onChange={setNeverExpires} size="sm" />
              </div>
              {!neverExpires && (
                <Input
                  type="datetime-local"
                  className="mt-2"
                  value={expiresInput}
                  onChange={(e) => setExpiresInput(e.target.value)}
                  aria-label={t('admin.shares.extend')}
                />
              )}
            </div>
          </div>

          {/* 可编辑：次数上限（留空 / 0 = 不限） */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t('share.maxViews')}</Label>
              <Input
                type="number"
                min={0}
                className="mt-1"
                value={maxViews}
                onChange={(e) => setMaxViews(e.target.value)}
                placeholder={t('myShares.noLimit')}
              />
            </div>
            <div>
              <Label>{t('share.maxDownloads')}</Label>
              <Input
                type="number"
                min={0}
                className="mt-1"
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                placeholder={t('myShares.noLimit')}
              />
            </div>
          </div>

          {/* 可编辑：访问权限 */}
          <div>
            <Label>{t('admin.shares.access')}</Label>
            <div className="mt-1 flex items-center gap-2">
              <AccessIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Select
                className="flex-1"
                value={accessMode}
                onValueChange={(v) => setAccessMode(v === 'users' ? 'users' : v === 'login' ? 'login' : 'public')}
                options={[
                  { value: 'public', label: t('myShares.accessPublic') },
                  { value: 'login', label: t('myShares.accessLogin') },
                  { value: 'users', label: t('myShares.accessUsers') },
                ]}
              />
            </div>
            {accessMode === 'users' && (
              <>
                <Input
                  className="mt-2"
                  value={allowedUsers}
                  onChange={(e) => setAllowedUsers(e.target.value)}
                  placeholder={t('myShares.allowedUsersPlaceholder')}
                />
                {detail.allowedUserCount > 0 && !allowedUsers.trim() && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('myShares.accessUsers')} · {detail.allowedUserCount}
                  </p>
                )}
              </>
            )}
          </div>

          {/* 可编辑：密码（留空 = 清除） */}
          <div>
            <div className="flex items-center gap-2">
              <Label>{t('admin.shares.password')}</Label>
              {detail.passwordProtected && (
                <Badge variant="warning">
                  <Lock className="mr-1 h-3 w-3" />
                  {t('share.passwordProtected')}
                </Badge>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                type="password"
                className="flex-1"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('admin.shares.passwordNew')}
                autoComplete="new-password"
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('admin.shares.passwordNew')} · {t('admin.shares.passwordClear')}
            </p>
          </div>

          {/* 可编辑：预览 / 下载开关 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="inline-flex items-center gap-2 text-sm">
                <Eye className={cn('h-4 w-4', allowPreview ? 'text-primary' : 'text-muted-foreground')} />
                {t('share.allowPreview')}
              </span>
              <Switch checked={allowPreview} onChange={setAllowPreview} size="sm" />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="inline-flex items-center gap-2 text-sm">
                <Download className={cn('h-4 w-4', allowDownload ? 'text-primary' : 'text-muted-foreground')} />
                {t('share.allowDownload')}
              </span>
              <Switch checked={allowDownload} onChange={setAllowDownload} size="sm" />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default AdminShareSettingsDialog;
