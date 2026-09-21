// 创建分享对话框（文件页入口）：选中项（文件/文件夹可混合）→ 表单 → 链接 + 二维码
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Copy, QrCode, ExternalLink } from 'lucide-react';
import { Button, Dialog, Input, Label, Switch } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import type { FileListItem } from '@shared/types';
import FileIcon from './FileIcon';

/** 单次分享可携带的最大条目数（与后端 fileIds 校验一致） */
const MAX_SHARE_ITEMS = 50;

/** POST /api/shares 成功返回的分享视图；url 已补全为绝对地址 */
interface CreatedShare {
  id: string;
  url: string;
}

export function ShareDialog({
  open,
  items,
  onClose,
}: {
  open: boolean;
  items: FileListItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [expiryMode, setExpiryMode] = useState<'preset' | 'relative' | 'absolute'>('preset');
  const [expiresIn, setExpiresIn] = useState(0);
  const [relDays, setRelDays] = useState(0);
  const [relHours, setRelHours] = useState(0);
  const [relMinutes, setRelMinutes] = useState(0);
  const [relSeconds, setRelSeconds] = useState(0);
  const [absoluteAt, setAbsoluteAt] = useState('');
  const [accessMode, setAccessMode] = useState<'public' | 'login' | 'users'>('public');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [maxDownloads, setMaxDownloads] = useState(0);
  const [allowPreview, setAllowPreview] = useState(true);
  const [allowDownload, setAllowDownload] = useState(true);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [qrcode, setQrcode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 每次打开回到空白表单（上一次的成功结果/输入不残留）
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setPassword('');
    setExpiryMode('preset');
    setExpiresIn(0);
    setRelDays(0);
    setRelHours(0);
    setRelMinutes(0);
    setRelSeconds(0);
    setAbsoluteAt('');
    setAccessMode('public');
    setAllowedUsers('');
    setMaxDownloads(0);
    setAllowPreview(true);
    setAllowDownload(true);
    setCreated(null);
    setQrcode('');
    setSubmitting(false);
  }, [open]);

  const totalSize = items.reduce((sum, i) => sum + (i.type === 'folder' ? 0 : i.size), 0);

  const create = async () => {
    if (items.length === 0) return toast('error', t('share.selectItemsRequired'));
    if (items.length > MAX_SHARE_ITEMS) return toast('error', t('share.tooManyItems'));
    // 时间三模式：预设档位 / 自定义时长（天时分秒）/ 绝对截止时间，统一折成 expiresIn 或 expiresAt
    const relativeSeconds = relDays * 86400 + relHours * 3600 + relMinutes * 60 + relSeconds;
    let payloadExpiresIn: number | undefined;
    let payloadExpiresAt: number | undefined;
    if (expiryMode === 'preset') {
      payloadExpiresIn = expiresIn || undefined;
    } else if (expiryMode === 'relative') {
      if (relativeSeconds < 60) return toast('error', t('myShares.expiryMin'));
      payloadExpiresIn = relativeSeconds;
    } else {
      const ts = absoluteAt ? new Date(absoluteAt).getTime() : Number.NaN;
      if (!Number.isFinite(ts) || ts <= Date.now()) return toast('error', t('myShares.expiryInvalid'));
      payloadExpiresAt = ts;
    }
    const users = allowedUsers.split(',').map((s) => s.trim()).filter(Boolean);
    if (accessMode === 'users' && users.length === 0) return toast('error', t('myShares.usersRequired'));
    setSubmitting(true);
    try {
      const res = await apiFetch<{ share: CreatedShare }>('/api/shares', {
        method: 'POST',
        body: {
          fileIds: items.map((i) => i.id),
          title: title.trim() || undefined,
          password: password || undefined,
          expiresIn: payloadExpiresIn,
          expiresAt: payloadExpiresAt,
          maxDownloads: maxDownloads || undefined,
          allowPreview,
          allowDownload,
          requireLogin: accessMode === 'login' ? true : undefined,
          allowedUsers: accessMode === 'users' ? users : undefined,
        },
      });
      const share = res.data.share;
      // 后端可能返回相对路径：复制/二维码/展示统一用绝对地址
      const url = share.url.startsWith('http') ? share.url : window.location.origin + share.url;
      setCreated({ id: share.id, url });
      // 后端不返回二维码，客户端本地生成
      const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 2 }).catch(() => '');
      setQrcode(dataUrl);
    } catch (err) {
      // 选中项已被删除/移动时后端返回 404，提示刷新重试
      if (err instanceof ApiError && err.code === 'NOT_FOUND') toast('error', t('share.itemUnavailable'));
      else toast('error', err instanceof ApiError ? err.message : t('common.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url);
    toast('success', t('files.linkCopied'));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={created ? t('myShares.createdTitle') : t('share.createTitle')}
      footer={
        created ? (
          <Button onClick={onClose}>{t('common.close')}</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={() => void create()} loading={submitting}>{t('common.create')}</Button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            {qrcode ? (
              <img src={qrcode} alt={t('share.qrcode')} className="h-28 w-28 shrink-0 rounded-md border" />
            ) : (
              <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md border text-center text-xs text-muted-foreground">
                {t('myShares.qrcodeFailed')}
              </div>
            )}
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <QrCode className="h-4 w-4" /> {t('myShares.scanQrcode')}
            </p>
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            <p className="mb-1 text-xs text-muted-foreground">{t('share.link')}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={created.url} className="font-mono text-xs" />
              <Button size="sm" variant="outline" onClick={() => void copyLink(created.url)} aria-label={t('common.copy')}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.open(`/share/${created.id}`, '_blank', 'noreferrer')}
          >
            <ExternalLink className="h-4 w-4" /> {t('myShares.openSharePage')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <Label>{t('files.name')}</Label>
            <Input
              className="mt-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('common.optional')}
            />
          </div>

          {/* 所选条目（文件/文件夹混合，可滚动） */}
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              {items.length > 1 ? (
                <>
                  <span>{t('share.itemsCount', { count: items.length })}</span>
                  <span>{formatBytes(totalSize)}</span>
                </>
              ) : (
                <span>{formatBytes(totalSize)}</span>
              )}
            </div>
            <div className="mt-1 max-h-40 divide-y divide-border overflow-y-auto rounded-md border">
              {items.map((f) => (
                <div key={f.id} className="flex items-center gap-2 px-3 py-2">
                  <FileIcon name={f.name} type={f.type} className="h-5 w-5 shrink-0" iconEmoji={f.iconEmoji} />
                  <span className="min-w-0 flex-1 truncate text-sm">{f.customTitle ?? f.name}</span>
                  {f.type === 'file' && (
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('share.passwordOptional')}</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('share.password')} />
            </div>
            <div>
              <Label>{t('share.maxDownloads')}</Label>
              <Input type="number" min={0} value={maxDownloads || ''} onChange={(e) => setMaxDownloads(Number(e.target.value))} placeholder={t('myShares.noLimit')} />
            </div>
          </div>

          <div>
            <Label>{t('share.expiresIn')}</Label>
            <Select
              value={expiryMode}
              onValueChange={(v) => setExpiryMode(v as 'preset' | 'relative' | 'absolute')}
              className="mt-1"
              options={[
                { value: 'preset', label: t('myShares.expiryPreset') },
                { value: 'relative', label: t('myShares.expiryRelative') },
                { value: 'absolute', label: t('myShares.expiryAbsolute') },
              ]}
            />
            {expiryMode === 'preset' && (
              <Select
                value={String(expiresIn)}
                onValueChange={(v) => setExpiresIn(Number(v))}
                className="mt-2"
                options={[
                  { value: '0', label: t('share.forever') },
                  { value: '3600', label: t('share.hours1') },
                  { value: '86400', label: t('share.hours24') },
                  { value: '604800', label: t('share.days7') },
                  { value: '2592000', label: t('share.days30') },
                ]}
              />
            )}
            {expiryMode === 'relative' && (
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                <Input type="number" min={0} value={relDays || ''} onChange={(e) => setRelDays(Number(e.target.value))} placeholder={t('myShares.days')} aria-label={t('myShares.days')} />
                <Input type="number" min={0} value={relHours || ''} onChange={(e) => setRelHours(Number(e.target.value))} placeholder={t('myShares.hours')} aria-label={t('myShares.hours')} />
                <Input type="number" min={0} value={relMinutes || ''} onChange={(e) => setRelMinutes(Number(e.target.value))} placeholder={t('myShares.minutes')} aria-label={t('myShares.minutes')} />
                <Input type="number" min={0} value={relSeconds || ''} onChange={(e) => setRelSeconds(Number(e.target.value))} placeholder={t('myShares.seconds')} aria-label={t('myShares.seconds')} />
              </div>
            )}
            {expiryMode === 'absolute' && (
              <Input
                type="datetime-local"
                className="mt-2"
                value={absoluteAt}
                onChange={(e) => setAbsoluteAt(e.target.value)}
                aria-label={t('myShares.expiryAbsolute')}
              />
            )}
          </div>

          <div>
            <Label>{t('myShares.access')}</Label>
            <Select
              value={accessMode}
              onValueChange={(v) => setAccessMode(v as 'public' | 'login' | 'users')}
              className="mt-1"
              options={[
                { value: 'public', label: t('myShares.accessPublic') },
                { value: 'login', label: t('myShares.accessLogin') },
                { value: 'users', label: t('myShares.accessUsers') },
              ]}
            />
            {accessMode === 'users' && (
              <Input
                className="mt-2"
                value={allowedUsers}
                onChange={(e) => setAllowedUsers(e.target.value)}
                placeholder={t('myShares.allowedUsersPlaceholder')}
              />
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm">{t('share.allowPreview')}</span>
            <Switch checked={allowPreview} onChange={setAllowPreview} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('share.allowDownload')}</span>
            <Switch checked={allowDownload} onChange={setAllowDownload} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default ShareDialog;
