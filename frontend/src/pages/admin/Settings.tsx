// 管理员：系统设置 + 公告
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Plus, Trash2, Mail, Send, Globe, ShieldCheck, Megaphone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Button, Switch, Badge } from '@/components/ui/core';
import { FormCardSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Select } from '@/components/ui/select';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type { Announcement } from '@shared/types';

interface Settings {
  siteTitle: string;
  siteLogo?: string;
  siteFavicon?: string;
  allowRegistration: boolean;
  allowGuestAccess: boolean;
  requireEmailVerification: boolean;
  enableTurnstile: boolean;
  turnstileSiteKey?: string;
  rateLimitEnabled: boolean;
  rateLimitRequestsPerMinute: number;
  maxConcurrentTransfers: number;
  rateLimitDownloadsPerMinute: number;
  directPrefix: string;
  rootTarget: 'landing' | 'files' | 'direct';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpFromName: string;
  smtpFromEmail: string;
  emailEnabled: boolean;
}

export default function AdminSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  /** 显示时长策略（§27）：banner 用 always/daily/interval/until/duration；toast 另支持 once */
  const [newMode, setNewMode] = useState<'always' | 'daily' | 'interval' | 'until' | 'duration' | 'once'>('always');
  /** 呈现形态：banner 常驻横幅 / toast 临时弹窗 */
  const [newKind, setNewKind] = useState<'banner' | 'toast'>('banner');
  const [newIntervalValue, setNewIntervalValue] = useState(1);
  const [newIntervalUnit, setNewIntervalUnit] = useState<'3600' | '86400' | '604800' | '2592000'>('86400');
  const [newUntil, setNewUntil] = useState('');
  const [newDurationValue, setNewDurationValue] = useState(1);
  const [newDurationUnit, setNewDurationUnit] = useState<'60' | '3600' | '86400'>('86400');
  const [testEmail, setTestEmail] = useState('');
  const [testSending, setTestSending] = useState(false);

  /** 列表里的策略摘要：总是 / 当日 / 每 n 单位 / 至 xx / 发布后 n 单位 */
  const annModeLabel = (a: Announcement): string => {
    const unitLabel = (seconds: number): string =>
      seconds === 3600 ? t('admin.systemSettings.annUnitHour')
      : seconds === 86400 ? t('admin.systemSettings.annUnitDay')
      : seconds === 604800 ? t('admin.systemSettings.annUnitWeek')
      : seconds === 2592000 ? t('admin.systemSettings.annUnitMonth')
      : t('admin.systemSettings.annUnitMinute');
    switch (a.displayMode) {
      case 'daily': return t('admin.systemSettings.annModeDaily');
      case 'once': return t('admin.systemSettings.annModeOnce');
      case 'interval': {
        const s = a.intervalSeconds ?? 0;
        return t('admin.systemSettings.annEvery', { n: Math.max(1, Math.round(s / (s === 3600 ? 3600 : s === 604800 ? 604800 : s === 2592000 ? 2592000 : 86400))), unit: unitLabel(s) });
      }
      case 'until': return t('admin.systemSettings.annUntil', { time: a.expiresAt ? formatDateTime(a.expiresAt) : '-' });
      case 'duration': {
        const s = a.intervalSeconds ?? 0;
        return t('admin.systemSettings.annDurationFor', { n: Math.max(1, Math.round(s / (s === 3600 ? 3600 : 86400))), unit: unitLabel(s) });
      }
      default: return t('admin.systemSettings.annModeAlways');
    }
  };

  const load = async () => {
    const [sRes, aRes] = await Promise.all([
      apiFetch<Settings>('/api/admin/settings'),
      apiFetch<{ items: Announcement[] }>('/api/admin/announcements'),
    ]);
    setSettings(sRes.data);
    setAnnouncements(aRes.data.items);
  };

  useEffect(() => {
    void load();
  }, []);

  const set = (k: string, v: unknown) => setSettings((s) => (s ? { ...s, [k]: v } : s));

  const save = async () => {
    if (!settings) return;
    try {
      await apiFetch('/api/admin/settings', { method: 'PATCH', body: settings });
      toast('success', t('admin.systemSettings.saved'));
    } catch {
      toast('error', t('admin.systemSettings.saveFailed'));
    }
  };

  const addAnnouncement = async () => {
    if (!newTitle || !newContent) return toast('error', t('admin.systemSettings.titleContentRequired'));
    // §27 显示时长：interval/until/duration 换算为秒或绝对时间戳
    const payload: Record<string, unknown> = { title: newTitle, content: newContent, level: 'info', displayMode: newMode, kind: newKind };
    if (newMode === 'interval') payload.intervalSeconds = newIntervalValue * Number(newIntervalUnit);
    if (newMode === 'until') {
      if (!newUntil) return toast('error', t('admin.systemSettings.annUntilRequired'));
      payload.endsAt = new Date(newUntil).getTime();
    }
    if (newMode === 'duration') payload.intervalSeconds = newDurationValue * Number(newDurationUnit);
    try {
      await apiFetch('/api/admin/announcements', { method: 'POST', body: payload });
      toast('success', t('admin.systemSettings.published'));
      setNewTitle('');
      setNewContent('');
      setNewMode('always');
      setNewKind('banner');
      setNewUntil('');
      await load();
    } catch {
      toast('error', t('admin.systemSettings.publishFailed'));
    }
  };

  const delAnnouncement = async (id: string) => {
    await apiFetch(`/api/admin/announcements/${id}`, { method: 'DELETE' });
    await load();
  };

  const sendTestEmail = async () => {
    if (!testEmail) return toast('error', t('admin.systemSettings.testEmailRequired'));
    setTestSending(true);
    try {
      await apiFetch('/api/admin/settings/test-email', { method: 'POST', body: { to: testEmail } });
      toast('success', t('admin.systemSettings.testEmailSent'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.systemSettings.sendFailed'));
    } finally {
      setTestSending(false);
    }
  };

  if (!settings) return <FormCardSkeleton />;

  return (
    <div className="h-full max-w-7xl space-y-4 overflow-y-auto scrollbar-none lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
      {/* 左列：站点设置 + 安全设置 */}
      <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" /> {t('admin.settingsSite')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.siteTitle')}</Label>
              <Input className="mt-1" value={settings.siteTitle} onChange={(e) => set('siteTitle', e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.siteLogo')}</Label>
              <Input className="mt-1" value={settings.siteLogo ?? ''} onChange={(e) => set('siteLogo', e.target.value)} />
            </div>
          </div>
          <div>
            <Label>{t('admin.siteFavicon')}</Label>
            <Input className="mt-1" value={settings.siteFavicon ?? ''} onChange={(e) => set('siteFavicon', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-md border p-3">
            <div>
              <Label>{t('admin.directPrefix')}</Label>
              <Select
                className="mt-1"
                value={settings.directPrefix}
                onValueChange={(v: string) => set('directPrefix', v)}
                options={[
                  { value: '', label: t('admin.directPrefixRoot') },
                  { value: '/d', label: '/d' },
                  { value: '/download', label: '/download' },
                  { value: '/raw', label: '/raw' },
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.directPrefixHint')}</p>
            </div>
            <div>
              <Label>{t('admin.rootTarget')}</Label>
              <Select
                className="mt-1"
                value={settings.rootTarget}
                onValueChange={(v: string) => set('rootTarget', 'landing' === v || 'files' === v || 'direct' === v ? v : 'landing')}
                options={[
                  { value: 'landing', label: t('admin.rootTargetLanding') },
                  { value: 'files', label: t('admin.rootTargetFiles') },
                  { value: 'direct', label: t('admin.rootTargetDirect') },
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.rootTargetHint')}</p>
            </div>
          </div>
          <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t('admin.settingsSecurity')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.allowRegistration')}</span>
              <Switch checked={settings.allowRegistration} onChange={(v) => set('allowRegistration', v)} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.allowGuestAccess')}</span>
              <Switch checked={settings.allowGuestAccess} onChange={(v) => set('allowGuestAccess', v)} />
            </div>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{t('admin.rateLimit')}</p>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.rateLimitEnabled')}</span>
              <Switch checked={settings.rateLimitEnabled} onChange={(v) => set('rateLimitEnabled', v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('admin.rateLimitRequestsPerMinute')}</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  max={10000}
                  value={String(settings.rateLimitRequestsPerMinute)}
                  onChange={(e) => set('rateLimitRequestsPerMinute', Number(e.target.value) || 1)}
                  disabled={!settings.rateLimitEnabled}
                />
              </div>
              <div>
                <Label>{t('admin.rateLimitDownloadsPerMinute')}</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={0}
                  max={100000}
                  value={String(settings.rateLimitDownloadsPerMinute)}
                  onChange={(e) => set('rateLimitDownloadsPerMinute', Math.max(0, Number(e.target.value) || 0))}
                  disabled={!settings.rateLimitEnabled}
                />
              </div>
              <div>
                <Label>{t('admin.maxConcurrentTransfers')}</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={0}
                  max={1000}
                  value={String(settings.maxConcurrentTransfers)}
                  onChange={(e) => set('maxConcurrentTransfers', Math.max(0, Number(e.target.value) || 0))}
                  disabled={!settings.rateLimitEnabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.rateLimitHint', {
                limit: settings.rateLimitRequestsPerMinute,
                user: settings.rateLimitRequestsPerMinute * 2,
              })}
            </p>
            <p className="text-xs text-muted-foreground">{t('admin.maxConcurrentTransfersHint')}</p>
            <p className="text-xs text-muted-foreground">{t('admin.rateLimitDownloadsHint')}</p>
          </div>
          <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
        </CardContent>
      </Card>
      </div>

      {/* 右列：SMTP + 公告 */}
      <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> {t('admin.systemSettings.smtp')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.systemSettings.smtpHost')}</Label>
              <Input className="mt-1" value={settings.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div>
              <Label>{t('admin.systemSettings.port')}</Label>
              <Input className="mt-1" type="number" value={settings.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} />
            </div>
          </div>
          <div>
            <Label>{t('login.username')}</Label>
            <Input className="mt-1" value={settings.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} />
          </div>
          <div>
            <Label>{t('login.password')}</Label>
            <Input className="mt-1" type="password" value={settings.smtpPassword} onChange={(e) => set('smtpPassword', e.target.value)} placeholder={t('admin.systemSettings.passwordPlaceholder')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.systemSettings.fromName')}</Label>
              <Input className="mt-1" value={settings.smtpFromName} onChange={(e) => set('smtpFromName', e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.systemSettings.fromEmail')}</Label>
              <Input className="mt-1" type="email" value={settings.smtpFromEmail} onChange={(e) => set('smtpFromEmail', e.target.value)} placeholder="noreply@example.com" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.systemSettings.enableTls')}</span>
              <Switch checked={settings.smtpSecure} onChange={(v) => set('smtpSecure', v)} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.systemSettings.enableEmail')}</span>
              <Switch checked={settings.emailEnabled} onChange={(v) => set('emailEnabled', v)} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.requireEmailVerification')}</span>
              <Switch checked={settings.requireEmailVerification} onChange={(v) => set('requireEmailVerification', v)} />
            </div>
          </div>
          <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          <div className="flex items-center gap-2 border-t pt-3">
            <Input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder={t('admin.systemSettings.testEmailPlaceholder')}
              className="flex-1"
            />
            <Button variant="outline" onClick={sendTestEmail} loading={testSending}>
              <Send className="h-4 w-4" /> {t('admin.systemSettings.sendTestEmail')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" /> {t('admin.announcements')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('admin.announcementTitle')} />
            <Input value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder={t('admin.announcementContent')} />
            {/* 公告类型：横幅 / 临时弹窗（toast）+ 显示时长策略 */}
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                value={newKind}
                onValueChange={(v) => {
                  const kind = v as 'banner' | 'toast';
                  setNewKind(kind);
                  setNewMode((m) => (kind === 'toast' && m === 'always' ? 'once' : kind === 'banner' && m === 'once' ? 'always' : m));
                }}
                options={[
                  { value: 'banner', label: t('admin.systemSettings.annKindBanner') },
                  { value: 'toast', label: t('admin.systemSettings.annKindToast') },
                ]}
              />
              <Select
                value={newMode}
                onValueChange={(v) => setNewMode(v as typeof newMode)}
                options={(newKind === 'toast'
                  ? [
                      { value: 'once', label: t('admin.systemSettings.annModeOnce') },
                      { value: 'interval', label: t('admin.systemSettings.annModeInterval') },
                      { value: 'until', label: t('admin.systemSettings.annModeUntil') },
                      { value: 'duration', label: t('admin.systemSettings.annModeDuration') },
                    ]
                  : [
                      { value: 'always', label: t('admin.systemSettings.annModeAlways') },
                      { value: 'daily', label: t('admin.systemSettings.annModeDaily') },
                      { value: 'interval', label: t('admin.systemSettings.annModeInterval') },
                      { value: 'until', label: t('admin.systemSettings.annModeUntil') },
                      { value: 'duration', label: t('admin.systemSettings.annModeDuration') },
                    ]
                ).filter((o) => o.value !== 'always' || newKind === 'banner')}
              />
              {newMode === 'interval' && (
                <div className="flex items-center gap-2">
                  <Input className="w-20" type="number" min={1} value={String(newIntervalValue)} onChange={(e) => setNewIntervalValue(Math.max(1, Number(e.target.value) || 1))} />
                  <Select
                    className="w-28"
                    value={newIntervalUnit}
                    onValueChange={(v) => setNewIntervalUnit(v as typeof newIntervalUnit)}
                    options={[
                      { value: '3600', label: t('admin.systemSettings.annUnitHour') },
                      { value: '86400', label: t('admin.systemSettings.annUnitDay') },
                      { value: '604800', label: t('admin.systemSettings.annUnitWeek') },
                      { value: '2592000', label: t('admin.systemSettings.annUnitMonth') },
                    ]}
                  />
                </div>
              )}
              {newMode === 'until' && (
                <Input type="datetime-local" value={newUntil} onChange={(e) => setNewUntil(e.target.value)} />
              )}
              {newMode === 'duration' && (
                <div className="flex items-center gap-2">
                  <Input className="w-20" type="number" min={1} value={newDurationValue} onChange={(e) => setNewDurationValue(Math.max(1, Number(e.target.value) || 1))} />
                  <Select
                    className="w-28"
                    value={newDurationUnit}
                    onValueChange={(v) => setNewDurationUnit(v as typeof newDurationUnit)}
                    options={[
                      { value: '60', label: t('admin.systemSettings.annUnitMinute') },
                      { value: '3600', label: t('admin.systemSettings.annUnitHour') },
                      { value: '86400', label: t('admin.systemSettings.annUnitDay') },
                    ]}
                  />
                </div>
              )}
            </div>
            <Button onClick={addAnnouncement}><Plus className="h-4 w-4" /> {t('admin.addAnnouncement')}</Button>
          </div>
          <div className="space-y-2">
            {announcements.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                <Badge variant={a.level === 'danger' ? 'destructive' : a.level === 'warning' ? 'warning' : 'secondary'}>{a.level}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium">{a.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{annModeLabel(a)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{a.active ? t('admin.active') : t('admin.disabled')}</span>
                <button onClick={() => delAnnouncement(a.id)} className="shrink-0 rounded p-1 text-destructive hover:bg-destructive/10">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
