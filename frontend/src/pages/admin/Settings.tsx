// 管理员：系统设置 + 公告
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Plus, Trash2, Mail, Send, Globe, ShieldCheck, ShieldBan, Megaphone, UserPlus, BarChart3, ScrollText, KeyRound, Database, GitCompare, Copy, Check, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Button, Switch, Badge, Dialog, ConfirmDialog } from '@/components/ui/core';
import { SsoProvidersDialog } from './SsoProvidersDialog';
import { Dropdown, DROPDOWN_ITEM_CLASS } from '@/components/ui/dropdown';
import { cn } from '@/lib/utils';
import { useMinLoading } from '@/hooks/useMinLoading';
import { revealDelay, innerDelay } from '@/components/ui/reveal';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Select } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type { Announcement } from '@shared/types';

interface Settings {
  siteTitle: string;
  /** 左上角标题：'' = 只显示 Logo 不出文字；undefined（后端未设置）= 跟随 siteTitle */
  siteHeaderTitle?: string;
  siteLogo?: string;
  siteFavicon?: string;
  allowRegistration: boolean;
  allowGuestAccess: boolean;
  requireEmailVerification: boolean;
  /** 注册设置：邀请码机制（迁移 0010 设置键） */
  inviteEnabled: boolean;
  inviteRequired: boolean;
  inviteGeneration: 'all_users' | 'admin_only';
  inviteMaxPerUser: number;
  /** 第三方登录（SSO/OIDC，迁移 0012）：站点总开关；来源配置走「OIDC 设置」弹窗 */
  ssoEnabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitRequestsPerMinute: number;
  authRateLimitPerMinute: number;
  maxConcurrentTransfers: number;
  rateLimitDownloadsPerMinute: number;
  directPrefix: string;
  rootTarget: 'landing' | 'files' | 'direct';
  uploadUrl?: string;
  returnUrl?: string;
  appBaseUrl?: string;
  allowedOrigins?: string;
  // 人机验证（Turnstile / reCAPTCHA）：provider + 总开关 + 密钥对 + 七个防护面
  captchaProvider?: 'turnstile' | 'recaptcha';
  captchaEnabled?: boolean;
  captchaSiteKey?: string;
  captchaSecretKey?: string;
  captchaFaceLogin?: boolean;
  captchaFaceRegister?: boolean;
  captchaFaceShareDownload?: boolean;
  captchaFaceUpload?: boolean;
  captchaFacePasswordChange?: boolean;
  captchaFaceEmailVerify?: boolean;
  captchaFacePasswordReset?: boolean;
  captchaFaceBackupCodes?: boolean;
  signEnabled?: boolean;
  signDefault?: boolean;
  signExpiresIn?: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpFromName: string;
  smtpFromEmail: string;
  emailEnabled: boolean;
  /** 审计日志策略：记录等级与项目（分组） */
  auditLogLevel: 'all' | 'essential' | 'security';
  auditLogItems: Array<'auth' | 'upload' | 'download' | 'share' | 'admin' | 'failure'>;
  /** 访问统计（迁移 0011）：来源二选一（d1 = 网关审计 / umami = 前端行为统计）+ Umami 脚本面配置 */
  statsSource: 'd1' | 'umami';
  umamiEnabled: boolean;
  umamiScriptUrl: string;
  umamiWebsiteId: string;
  umamiHostUrl: string;
  umamiDomains: string;
  umamiPerformance: boolean;
  umamiExcludeSearch: boolean;
  umamiDoNotTrack: boolean;
}
interface IpBan {
  id: string;
  ip: string;
  reason?: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt?: number | null;
}
interface IndexPending {
  jobId: string;
  type: 'standard' | 'advanced';
  startedAt: number;
  completedAt: number;
  stats: { added: number; removed: number; modified: number; unchanged: number; total: number };
  diffSnippet: string;
}
interface IndexStatus {
  running: boolean;
  lastRunAt: number | null;
  fileCount: number;
  pending: IndexPending | null;
}

/** 卡内行骨架：卡片壳（玻璃纹理）常驻，数据到位前仅在卡内绘制行骨架 —— 骨架长在玻璃卡里 */
function CardRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}


/** CORS 白名单输入解析：逗号/换行分隔；缺省 scheme 补 https:// */
function parseCorsList(raw: string | undefined | null): string[] {
  return Array.from(new Set((raw ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean)));
}

export default function AdminSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  // 骨架屏最短驻留：数据太快时也保证加载动画可见
  const showSkeleton = useMinLoading(!settings);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  /** 显示时长策略：banner 用 always/daily/interval/until/duration；toast 另支持 once */
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
  /** 「OIDC 设置」弹窗（第三方登录来源 CRUD） */
  const [ssoDialogOpen, setSsoDialogOpen] = useState(false);
  const [ipBans, setIpBans] = useState<IpBan[]>([]);
  const [newIp, setNewIp] = useState('');
  const [newIpReason, setNewIpReason] = useState('');
  const [deletingBanId, setDeletingBanId] = useState<string | null>(null);
  const [showIpBans, setShowIpBans] = useState(false);
  /** 「CORS 白名单」弹窗：来源列表编辑（逗号分隔存储在 allowed_origins 设置） */
  const [showCors, setShowCors] = useState(false);
  const [corsList, setCorsList] = useState<string[]>([]);
  const [newCorsOrigin, setNewCorsOrigin] = useState('');
  const [deletingCorsIndex, setDeletingCorsIndex] = useState<number | null>(null);
  // ===== 文件索引（标准/高级）→ 后台构建 + diff 确认 =====
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [indexBuilding, setIndexBuilding] = useState(false);
  const [indexApplying, setIndexApplying] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffCopied, setDiffCopied] = useState(false);
  /** 本端触发过构建 → 完成后自动弹窗；否则（离开页面期间完成的）只出按钮 */
  const indexAutoOpenRef = useRef(false);
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
    await loadIpBans();
  };

  useEffect(() => {
    void load();
  }, []);

  // 文件索引状态轮询：构建中加密轮询；本端触发过的构建完成后自动弹出 diff 弹窗
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const st = await loadIndexStatus();
      if (stopped || !st) return;
      if (st.running) {
        // 构建中加密轮询；stopped 守卫让卸载后的残余定时器直接空跑
        setTimeout(tick, 2000);
      } else if (st.pending && indexAutoOpenRef.current) {
        // 仅本端触发过的构建自动弹窗；离开页面期间完成的只出「查看 Diff」按钮
        indexAutoOpenRef.current = false;
        setDiffOpen(true);
      }
    };
    void tick();
    // 空闲心跳：捕获「离开页面期间启动」的后台构建（回到页面后可看到按钮）
    const heartbeat = setInterval(tick, 8000);
    return () => {
      stopped = true;
      clearInterval(heartbeat);
    };
  }, []);

  const set = (k: string, v: unknown) => setSettings((s) => (s ? { ...s, [k]: v } : s));

  const saveWith = async (snapshot: Settings) => {
    try {
      await apiFetch('/api/admin/settings', { method: 'PATCH', body: snapshot });
      toast('success', t('admin.systemSettings.saved'));
    } catch (err) {
      // 跨字段校验错误（如来源选 Umami 但脚本地址/Website ID 未有效配置）透传后端文案
      toast('error', err instanceof ApiError ? err.message : t('admin.systemSettings.saveFailed'));
    }
  };
  const save = async () => {
    if (!settings) return;
    await saveWith(settings);
  };

  // ===== CORS 白名单 =====
  const corsCount = parseCorsList(settings?.allowedOrigins).length;
  const openCorsDialog = () => {
    setCorsList(parseCorsList(settings?.allowedOrigins));
    setNewCorsOrigin('');
    setShowCors(true);
  };
  const persistCors = async (list: string[]) => {
    if (!settings) return;
    const next = list.map((o) => o.trim()).filter(Boolean);
    setCorsList(next);
    set('allowedOrigins', next.join(','));
    // 复用全局保存：快照写库 + allowed_origins 审计 + 缓存失效，立即生效
    await saveWith({ ...settings, allowedOrigins: next.join(',') });
  };

  // ===== 文件索引 =====
  const loadIndexStatus = async () => {
    try {
      const res = await apiFetch<IndexStatus>('/api/admin/index/status');
      setIndexStatus(res.data);
      return res.data;
    } catch {
      return null;
    }
  };

  const startIndex = async (type: 'standard' | 'advanced') => {
    setIndexBuilding(true);
    indexAutoOpenRef.current = true;
    try {
      await apiFetch('/api/admin/index/build', { method: 'POST', body: { type } });
      toast('success', t('admin.indexStarted'));
      const st = await loadIndexStatus();
      // 同步路径（极快完成）直接弹窗；异步路径由轮询完成后弹
      if (st && !st.running && st.pending) setDiffOpen(true);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.indexFailed'));
    } finally {
      setIndexBuilding(false);
    }
  };

  const applyIndexDiff = async () => {
    setIndexApplying(true);
    try {
      await apiFetch('/api/admin/index/apply', { method: 'POST' });
      toast('success', t('admin.indexApplied'));
      setDiffOpen(false);
      await loadIndexStatus();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.indexFailed'));
    } finally {
      setIndexApplying(false);
    }
  };

  const discardIndexDiff = async () => {
    try {
      await apiFetch('/api/admin/index/dismiss', { method: 'POST' });
      toast('success', t('admin.indexDiscarded'));
      setDiffOpen(false);
      await loadIndexStatus();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.indexFailed'));
    }
  };

  const copyIndexDiff = async () => {
    const text = indexStatus?.pending?.diffSnippet ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setDiffCopied(true);
      setTimeout(() => setDiffCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）时静默忽略，不阻塞主流程
    }
  };

  const addAnnouncement = async () => {
    if (!newTitle || !newContent) return toast('error', t('admin.systemSettings.titleContentRequired'));
    // 显示时长：interval/until/duration 换算为秒或绝对时间戳
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

  const loadIpBans = async () => {
    try {
      const res = await apiFetch<{ bans: IpBan[] }>('/api/admin/ip-bans');
      setIpBans(res.data.bans ?? []);
    } catch {
      // ignore
    }
  };

  const addIpBan = async () => {
    const ip = newIp.trim();
    if (!ip) return toast('error', t('admin.ipBanRequired'));
    try {
      await apiFetch('/api/admin/ip-bans', {
        method: 'POST',
        body: { ip, reason: newIpReason.trim() || undefined },
      });
      toast('success', t('admin.ipBanAdded'));
      setNewIp('');
      setNewIpReason('');
      await loadIpBans();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
    }
  };

  const removeIpBan = async (id: string) => {
    try {
      await apiFetch(`/api/admin/ip-bans/${id}`, { method: 'DELETE' });
      toast('success', t('admin.ipBanRemoved'));
      setDeletingBanId(null);
      await loadIpBans();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
    }
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

  return (
    <div className="h-full max-w-7xl space-y-4 overflow-y-auto scrollbar-none lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
      {/* 左列：站点设置 + 安全设置 + 日志审计 + 访问统计 */}
      <div className="min-w-0 space-y-4">
      <Card className="reveal" style={revealDelay(0)}>
        <CardHeader className="reveal-row" style={innerDelay(0, 0)}>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" /> {t('admin.settingsSite')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={4} />
          ) : (
            <>
          {/* 站点标识：标题在左、图标在右各占一行 —— 左上角（标题 + Logo）与浏览器标签页（标题 + Favicon）；
              左上角标题留空 = 只显示 Logo；标签页标题即 document.title */}
          <div className="reveal-row grid grid-cols-2 gap-3" style={innerDelay(0, 1)}>
            <div>
              <Label>{t('admin.siteHeaderTitle')}</Label>
              <Input className="mt-1" value={settings.siteHeaderTitle ?? ''} onChange={(e) => set('siteHeaderTitle', e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.siteLogo')}</Label>
              <Input className="mt-1" value={settings.siteLogo ?? ''} onChange={(e) => set('siteLogo', e.target.value)} placeholder="https://…" />
            </div>
          </div>
          <div className="reveal-row grid grid-cols-2 gap-3" style={innerDelay(0, 2)}>
            <div>
              <Label>{t('admin.siteTitle')}</Label>
              <Input className="mt-1" value={settings.siteTitle} onChange={(e) => set('siteTitle', e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.siteFavicon')}</Label>
              <Input className="mt-1" value={settings.siteFavicon ?? ''} onChange={(e) => set('siteFavicon', e.target.value)} placeholder="https://…" />
            </div>
          </div>
          {/* 卡内分区用分隔线（border-t pt-3，与测试邮箱一致）—— 卡中卡原则 */}
          <div className="reveal-row grid grid-cols-2 gap-3 border-t pt-3" style={innerDelay(0, 3)}>
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
          <div className="reveal-row grid grid-cols-1 gap-3 border-t pt-3" style={innerDelay(0, 4)}>
            <div>
              <Label>{t('admin.uploadUrl')}</Label>
              <Input
                className="mt-1"
                value={settings.uploadUrl ?? ''}
                onChange={(e) => set('uploadUrl', e.target.value)}
                placeholder="https://cdn.example.com"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.uploadUrlHint')}</p>
            </div>
            <div>
              <Label>{t('admin.returnUrl')}</Label>
              <Input
                className="mt-1"
                value={settings.returnUrl ?? ''}
                onChange={(e) => set('returnUrl', e.target.value)}
                placeholder="https://cdn.example.com"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.returnUrlHint')}</p>
            </div>
            <div>
              <Label>{t('admin.appBaseUrl')}</Label>
              <Input
                className="mt-1"
                value={settings.appBaseUrl ?? ''}
                onChange={(e) => set('appBaseUrl', e.target.value)}
                placeholder="https://picumet.pages.dev"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.appBaseUrlHint')}</p>
            </div>
          </div>
          {/* 链接签名设置（卡内分区，见卡中卡原则） */}
          <div className="reveal-row space-y-3 border-t pt-3" style={innerDelay(0, 5)}>
            <p className="text-sm font-medium">{t('admin.signSettings')}</p>
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('admin.signEnabled')}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.signEnabledHint')}</p>
              </div>
              <Switch checked={settings.signEnabled ?? true} onChange={(v) => set('signEnabled', v)} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('admin.signDefault')}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.signDefaultHint')}</p>
              </div>
              <Switch checked={settings.signDefault ?? true} onChange={(v) => set('signDefault', v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('admin.signExpiresPreset')}</Label>
                <Select
                  className="mt-1"
                  value={
                    [0, 3600, 86400, 604800, 2592000].includes(settings.signExpiresIn ?? 0)
                      ? String(settings.signExpiresIn ?? 0)
                      : 'custom'
                  }
                  onValueChange={(v) => {
                    if (v !== 'custom') set('signExpiresIn', Number(v));
                  }}
                  options={[
                    { value: '0', label: t('admin.signExpiresPermanent') },
                    { value: '3600', label: t('admin.signExpires1h') },
                    { value: '86400', label: t('admin.signExpires1d') },
                    { value: '604800', label: t('admin.signExpires7d') },
                    { value: '2592000', label: t('admin.signExpires30d') },
                    { value: 'custom', label: t('admin.signExpiresCustom') },
                  ]}
                />
              </div>
              <div>
                <Label>{t('admin.signExpiresIn')}</Label>
                <Input
                  type="number"
                  min={0}
                  className="mt-1"
                  value={String(settings.signExpiresIn ?? 0)}
                  onChange={(e) => set('signExpiresIn', Math.max(0, parseInt(e.target.value, 10) || 0))}
                  placeholder="0"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('admin.signExpiresInHint')}</p>
          </div>
          <div className="reveal-row" style={innerDelay(0, 6)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>
            </>
          )}
        </CardContent>
      </Card>


      {/* 安全设置：速率限制 */}
      <Card className="reveal" style={revealDelay(1)}>
        <CardHeader className="reveal-row" style={innerDelay(1, 0)}>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t('admin.settingsSecurity')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={4} />
          ) : (
            <>
          <div className="reveal-row space-y-2" style={innerDelay(1, 1)}>
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
                <Label>{t('admin.authRateLimitPerMinute')}</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={0}
                  max={10000}
                  value={String(settings.authRateLimitPerMinute ?? 2)}
                  onChange={(e) => set('authRateLimitPerMinute', Math.max(0, Number(e.target.value) || 0))}
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
            <div className="border-t pt-3">
              <Label>{t('admin.allowedOrigins')}</Label>
              <Input
                className="mt-1"
                value={settings.allowedOrigins ?? ''}
                onChange={(e) => set('allowedOrigins', e.target.value)}
                placeholder="https://picumet.pages.dev, https://picumet.hxcn.dev"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.allowedOriginsHint')}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.rateLimitHint', {
                limit: settings.rateLimitRequestsPerMinute,
                user: settings.rateLimitRequestsPerMinute * 2,
              })}
            </p>
            <p className="text-xs text-muted-foreground">{t('admin.authRateLimitHint')}</p>
            <p className="text-xs text-muted-foreground">{t('admin.maxConcurrentTransfersHint')}</p>
            <p className="text-xs text-muted-foreground">{t('admin.rateLimitDownloadsHint')}</p>
          </div>
          <div className="reveal-row" style={innerDelay(1, 2)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>

          {/* IP 封禁管理：独立弹窗（表格样式参考邀请码表，弹窗玻璃面随模糊档位门控） */}
          <div className="reveal-row border-t pt-3" style={innerDelay(1, 3)}>
            <Button variant="outline" onClick={() => setShowIpBans(true)}>
              <ShieldBan className="h-4 w-4" /> {t('admin.ipBans')}
              {ipBans.length > 0 && <Badge variant="secondary" className="ml-1">{ipBans.length}</Badge>}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.ipBansHint')}</p>
          </div>
            </>
          )}
        </CardContent>
      </Card>
      {/* 日志审计：记录等级与项目（独立卡片） */}
      <Card className="reveal" style={revealDelay(2)}>
        <CardHeader className="reveal-row" style={innerDelay(2, 0)}>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-primary" /> {t('admin.auditLog')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={4} />
          ) : (
            <>
          <div className="reveal-row space-y-2" style={innerDelay(2, 1)}>
            <div>
              <Label>{t('admin.auditLogLevel')}</Label>
              <Select
                className="mt-1"
                value={settings.auditLogLevel}
                onValueChange={(v: string) => set('auditLogLevel', v)}
                options={[
                  { value: 'all', label: t('admin.auditLevel.all') },
                  { value: 'essential', label: t('admin.auditLevel.essential') },
                  { value: 'security', label: t('admin.auditLevel.security') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.auditLogItems')}</Label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(
                  [
                    ['auth', 'admin.auditGroup.auth'],
                    ['upload', 'admin.auditGroup.upload'],
                    ['download', 'admin.auditGroup.download'],
                    ['share', 'admin.auditGroup.share'],
                    ['admin', 'admin.auditGroup.admin'],
                    ['failure', 'admin.auditGroup.failure'],
                  ] as const
                ).map(([group, key]) => (
                  <div key={group} className="flex items-center justify-between rounded-md border px-2 py-1.5">
                    <span className="text-sm">{t(key)}</span>
                    <Switch
                      checked={settings.auditLogItems.includes(group)}
                      onChange={(v) =>
                        set(
                          'auditLogItems',
                          v
                            ? [...settings.auditLogItems, group]
                            : settings.auditLogItems.filter((g) => g !== group)
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('admin.auditLogHint')}</p>
          </div>
          <div className="reveal-row" style={innerDelay(2, 2)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 访问统计：D1 审计 / Umami 二选一 + Umami tracker 配置（迁移 0011） */}
      <Card className="reveal" style={revealDelay(3)}>
        <CardHeader className="reveal-row" style={innerDelay(3, 0)}>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" /> {t('admin.settingsStats')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={6} />
          ) : (
            <>
          <div className="reveal-row space-y-2" style={innerDelay(3, 1)}>
            <div>
              <Label>{t('admin.statsSourceLabel')}</Label>
              <Select
                className="mt-1"
                value={settings.statsSource}
                onValueChange={(v: string) => set('statsSource', v === 'umami' ? 'umami' : 'd1')}
                options={[
                  { value: 'd1', label: t('admin.statsSource.d1') },
                  { value: 'umami', label: t('admin.statsSource.umami') },
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.statsSourceHint')}</p>
            </div>
          </div>
          {/* Umami 脚本面配置：仅来源为 umami 时展示（d1 时不显示，避免误以为生效） */}
          {settings.statsSource === 'umami' && (
            <div className="reveal-row space-y-3 border-t pt-3" style={innerDelay(3, 2)}>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('admin.umamiEnabled')}</span>
                <Switch checked={settings.umamiEnabled} onChange={(v) => set('umamiEnabled', v)} />
              </div>
              <div>
                <Label>{t('admin.umamiScriptUrl')}</Label>
                <Input
                  className="mt-1"
                  value={settings.umamiScriptUrl}
                  onChange={(e) => set('umamiScriptUrl', e.target.value)}
                  placeholder="https://umami.example.com/script.js"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('admin.umamiScriptUrlHint')}</p>
              </div>
              <div>
                <Label>{t('admin.umamiWebsiteId')}</Label>
                <Input
                  className="mt-1"
                  value={settings.umamiWebsiteId}
                  onChange={(e) => set('umamiWebsiteId', e.target.value)}
                  placeholder="94db1cb1-74f4-4a40-ad6c-962362670409"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t('admin.umamiHostUrl')}</Label>
                  <Input
                    className="mt-1"
                    value={settings.umamiHostUrl}
                    onChange={(e) => set('umamiHostUrl', e.target.value)}
                    placeholder="https://stats.example.com"
                  />
                </div>
                <div>
                  <Label>{t('admin.umamiDomains')}</Label>
                  <Input
                    className="mt-1"
                    value={settings.umamiDomains}
                    onChange={(e) => set('umamiDomains', e.target.value)}
                    placeholder="example.com,www.example.com"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t('admin.umamiPerformance')}</span>
                  <Switch checked={settings.umamiPerformance} onChange={(v) => set('umamiPerformance', v)} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t('admin.umamiExcludeSearch')}</span>
                  <Switch checked={settings.umamiExcludeSearch} onChange={(v) => set('umamiExcludeSearch', v)} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t('admin.umamiDoNotTrack')}</span>
                  <Switch checked={settings.umamiDoNotTrack} onChange={(v) => set('umamiDoNotTrack', v)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('admin.umamiHint')}</p>
            </div>
          )}
          <div className="reveal-row" style={innerDelay(3, 3)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>
            </>
          )}
        </CardContent>
      </Card>
      </div>

      {/* 右列：公告 + 注册设置 + SMTP */}
      <div className="min-w-0 space-y-4">
      {/* 公告 */}
      <Card className="reveal" style={revealDelay(4)}>
        <CardHeader className="reveal-row" style={innerDelay(4, 0)}>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" /> {t('admin.announcements')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={6} />
          ) : (
            <>
          <div className="reveal-row space-y-2" style={innerDelay(4, 1)}>
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
                <div className="col-span-full">
                  <DatePicker value={newUntil} onChange={setNewUntil} includeTime />
                </div>
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
          <div className="reveal-row space-y-2" style={innerDelay(4, 2)}>
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
            </>
          )}
        </CardContent>
      </Card>

      {/* 注册设置：开放注册 / 允许访客 + 邀请码机制（docs/PROGRESS.md「邀请码注册机制」） */}
      <Card className="reveal" style={revealDelay(5)}>
        <CardHeader className="reveal-row" style={innerDelay(5, 0)}>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-primary" /> {t('admin.settingsRegistration')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={5} />
          ) : (
            <>
          <div className="reveal-row space-y-2" style={innerDelay(5, 1)}>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.allowRegistration')}</span>
              <Switch checked={settings.allowRegistration} onChange={(v) => set('allowRegistration', v)} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.allowGuestAccess')}</span>
              <Switch checked={settings.allowGuestAccess} onChange={(v) => set('allowGuestAccess', v)} />
            </div>
          </div>
          <div className="reveal-row space-y-2 border-t pt-3" style={innerDelay(5, 2)}>
            <p className="text-sm font-medium">{t('admin.inviteCodes')}</p>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.inviteEnabled')}</span>
              <Switch checked={settings.inviteEnabled} onChange={(v) => set('inviteEnabled', v)} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.inviteRequired')}</span>
              <Switch checked={settings.inviteRequired} onChange={(v) => set('inviteRequired', v)} disabled={!settings.inviteEnabled} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('admin.inviteGeneration')}</Label>
                <Select
                  className="mt-1"
                  value={settings.inviteGeneration}
                  onValueChange={(v: string) => set('inviteGeneration', v === 'admin_only' ? 'admin_only' : 'all_users')}
                  options={[
                    { value: 'all_users', label: t('admin.inviteGenerationAll') },
                    { value: 'admin_only', label: t('admin.inviteGenerationAdmin') },
                  ]}
                />
              </div>
              <div>
                <Label>{t('admin.inviteMaxPerUser')}</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  max={100}
                  value={String(settings.inviteMaxPerUser)}
                  onChange={(e) => set('inviteMaxPerUser', Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('admin.inviteHint')}</p>
          </div>
          {/* 第三方登录（SSO/OIDC，迁移 0012）：站点总开关 + 来源配置弹窗（Google/GitHub 单例、自定义 OIDC 不限） */}
          <div className="reveal-row space-y-2 border-t pt-3" style={innerDelay(5, 3)}>
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary" /> {t('admin.ssoLogin')}
            </p>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.ssoEnabled')}</span>
              <Switch checked={settings.ssoEnabled} onChange={(v) => set('ssoEnabled', v)} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{t('admin.ssoHint')}</p>
              <Button variant="outline" className="shrink-0" onClick={() => setSsoDialogOpen(true)}>
                <KeyRound className="h-4 w-4" /> {t('admin.ssoProviders')}
              </Button>
            </div>
          </div>
          <div className="reveal-row" style={innerDelay(5, 4)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 人机验证（Turnstile / reCAPTCHA）：提供方 + 总开关 + 站点/服务端密钥 + 七个防护面（类 OIDC 卡片） */}
      <Card className="reveal" style={revealDelay(6)}>
        <CardHeader className="reveal-row" style={innerDelay(6, 0)}>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t('admin.captchaTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={4} />
          ) : (
            <>
          <div className="reveal-row space-y-2" style={innerDelay(6, 1)}>
            <div>
              <Label>{t('admin.captchaProvider')}</Label>
              <Select
                className="mt-1"
                value={settings.captchaProvider ?? 'turnstile'}
                onValueChange={(v) => set('captchaProvider', v)}
                options={[
                  { value: 'turnstile', label: 'Cloudflare Turnstile' },
                  { value: 'recaptcha', label: 'Google reCAPTCHA (v2/v3)' },
                ]}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.captchaEnabled')}</span>
              <Switch checked={settings.captchaEnabled ?? false} onChange={(v) => set('captchaEnabled', v)} />
            </div>
            <div>
              <Label>{t('admin.captchaSiteKey')}</Label>
              <Input className="mt-1 font-mono text-xs" value={settings.captchaSiteKey ?? ''} onChange={(e) => set('captchaSiteKey', e.target.value)} placeholder="0x4AAAAAAA..." />
            </div>
            <div>
              <Label>{t('admin.captchaSecretKey')}</Label>
              <Input className="mt-1 font-mono text-xs" type="password" value={settings.captchaSecretKey ?? ''} onChange={(e) => set('captchaSecretKey', e.target.value)} placeholder={t('admin.systemSettings.passwordPlaceholder')} />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.captchaSecretHint')}</p>
            </div>
          </div>
          <div className="reveal-row space-y-2 border-t pt-3" style={innerDelay(6, 2)}>
            <p className="text-xs font-medium text-muted-foreground">{t('admin.captchaFaces')}</p>
            {([
              ['captchaFaceLogin', 'admin.captchaFaceLogin'],
              ['captchaFaceRegister', 'admin.captchaFaceRegister'],
              ['captchaFaceShareDownload', 'admin.captchaFaceShareDownload'],
              ['captchaFaceUpload', 'admin.captchaFaceUpload'],
              ['captchaFacePasswordChange', 'admin.captchaFacePasswordChange'],
              ['captchaFaceEmailVerify', 'admin.captchaFaceEmailVerify'],
              ['captchaFacePasswordReset', 'admin.captchaFacePasswordReset'],
              ['captchaFaceBackupCodes', 'admin.captchaFaceBackupCodes'],
            ] as const).map(([key, i18nKey]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-sm">{t(i18nKey)}</span>
                <Switch checked={Boolean(settings[key])} onChange={(v) => set(key, v)} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{t('admin.captchaFacesHint')}</p>
          </div>
          <div className="reveal-row" style={innerDelay(6, 3)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="reveal" style={revealDelay(6)}>
        <CardHeader className="reveal-row" style={innerDelay(6, 0)}>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> {t('admin.systemSettings.smtp')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings || showSkeleton ? (
            <CardRowsSkeleton rows={4} />
          ) : (
            <>
          <div className="reveal-row grid grid-cols-2 gap-3" style={innerDelay(6, 1)}>
            <div>
              <Label>{t('admin.systemSettings.smtpHost')}</Label>
              <Input className="mt-1" value={settings.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div>
              <Label>{t('admin.systemSettings.port')}</Label>
              <Input className="mt-1" type="number" value={settings.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} />
            </div>
          </div>
          <div className="reveal-row" style={innerDelay(6, 2)}>
            <Label>{t('login.username')}</Label>
            <Input className="mt-1" value={settings.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} />
          </div>
          <div className="reveal-row" style={innerDelay(6, 3)}>
            <Label>{t('login.password')}</Label>
            <Input className="mt-1" type="password" value={settings.smtpPassword} onChange={(e) => set('smtpPassword', e.target.value)} placeholder={t('admin.systemSettings.passwordPlaceholder')} />
          </div>
          <div className="reveal-row grid grid-cols-2 gap-3" style={innerDelay(6, 4)}>
            <div>
              <Label>{t('admin.systemSettings.fromName')}</Label>
              <Input className="mt-1" value={settings.smtpFromName} onChange={(e) => set('smtpFromName', e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.systemSettings.fromEmail')}</Label>
              <Input className="mt-1" type="email" value={settings.smtpFromEmail} onChange={(e) => set('smtpFromEmail', e.target.value)} placeholder="noreply@example.com" />
            </div>
          </div>
          <div className="reveal-row space-y-2" style={innerDelay(6, 5)}>
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
          <div className="reveal-row" style={innerDelay(6, 6)}>
            <Button onClick={save}><Save className="h-4 w-4" /> {t('common.save')}</Button>
          </div>
          <div className="reveal-row flex items-center gap-2 border-t pt-3" style={innerDelay(6, 7)}>
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
            </>
          )}
        </CardContent>
      </Card>

      {/* OIDC 设置弹窗：第三方登录来源 CRUD（关闭时不渲染，不影响列布局） */}
      <SsoProvidersDialog open={ssoDialogOpen} onClose={() => setSsoDialogOpen(false)} />

      {/* 文件索引（标准/高级）：后台构建 → diff 确认 → 增量更新（SMTP 卡之后） */}
      <Card className="reveal" style={revealDelay(7)}>
        <CardHeader className="reveal-row" style={innerDelay(7, 0)}>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" /> {t('admin.settingsIndex')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!indexStatus ? (
            <CardRowsSkeleton rows={2} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('admin.settingsIndexHint')}</p>
              <div className="reveal-row grid grid-cols-2 gap-3" style={innerDelay(7, 1)}>
                <div>
                  <Label>{t('admin.indexLastRun')}</Label>
                  <p className="mt-1 text-sm">
                    {indexStatus.lastRunAt ? formatDateTime(indexStatus.lastRunAt) : t('admin.indexNeverRun')}
                  </p>
                </div>
                <div>
                  <Label>{t('admin.indexFileCount')}</Label>
                  <p className="mt-1 text-sm">{indexStatus.fileCount}</p>
                </div>
              </div>
              <div className="reveal-row flex flex-wrap items-center gap-2" style={innerDelay(7, 2)}>
                {/* 分裂按钮：左半默认标准索引，右侧箭头下拉选高级索引 */}
                <div className="flex items-center">
                  <Button
                    variant="outline"
                    className="rounded-r-none"
                    loading={indexBuilding}
                    disabled={indexStatus?.running}
                    onClick={() => void startIndex('standard')}
                  >
                    {t('admin.indexStandard')}
                  </Button>
                  <Dropdown
                    align="start"
                    trigger={
                      <Button
                        variant="outline"
                        className="rounded-l-none border-l-0 px-2"
                        disabled={indexStatus?.running}
                        aria-label={t('admin.indexAdvanced')}
                        title={t('admin.indexAdvanced')}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    }
                  >
                    {(close) => (
                      <button
                        type="button"
                        className={cn(DROPDOWN_ITEM_CLASS)}
                        onClick={() => {
                          close();
                          void startIndex('advanced');
                        }}
                      >
                        {t('admin.indexAdvanced')}
                      </button>
                    )}
                  </Dropdown>
                </div>
                {/* 右侧状态位：构建中显示「正在构建」且不可点；有差异时可点查看确认 */}
                {indexStatus?.running && (
                  <Button variant="secondary" disabled>
                    {t('admin.indexBuilding')}
                  </Button>
                )}
                {!indexStatus?.running && indexStatus?.pending && !diffOpen && (
                  <Button onClick={() => setDiffOpen(true)}>
                    <GitCompare className="h-4 w-4" /> {t('admin.indexViewDiff')}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* IP 封禁管理弹窗：封禁列表（IP / 理由 / 创建时间）+ 添加表单；玻璃面随模糊档位门控 */}
      <Dialog open={showIpBans} onClose={() => setShowIpBans(false)} title={t('admin.ipBans')}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('admin.ipBansHint')}</p>
          {ipBans.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-md border">
              {/* 表头 + 行：与邀请码表同款（表头分组、行内分隔线，禁卡中卡） */}
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_auto] items-center gap-3 bg-muted/30 px-3 py-1.5 text-sm font-medium text-muted-foreground">
                <span>{t('admin.ipBans')}</span>
                <span>{t('admin.ipBanReason')}</span>
                <span>{t('admin.ipBanCreatedAt')}</span>
              </div>
              <div className="divide-y">
                {ipBans.map((ban) => (
                  <div key={ban.id} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_auto] items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate font-mono text-xs font-semibold">{ban.ip}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{ban.reason || '-'}</span>
                    <button
                      onClick={() => setDeletingBanId(ban.id)}
                      className="shrink-0 rounded p-1 text-destructive transition-colors hover:bg-destructive/10"
                      title={t('admin.removeIpBan')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">{t('admin.noIpBans')}</p>
          )}
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row">
            <Input
              className="flex-1"
              placeholder={t('admin.ipAddressPlaceholder')}
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
            />
            <Input
              className="flex-1"
              placeholder={t('admin.ipBanReasonPlaceholder')}
              value={newIpReason}
              onChange={(e) => setNewIpReason(e.target.value)}
            />
            <Button onClick={addIpBan} variant="outline" className="shrink-0">
              <Plus className="h-4 w-4" /> {t('admin.addIpBan')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!deletingBanId}
        onClose={() => setDeletingBanId(null)}
        onConfirm={() => deletingBanId && void removeIpBan(deletingBanId)}
        title={t('admin.removeIpBan')}
        message={t('admin.removeIpBanConfirm')}
      />

      {/* CORS 白名单弹窗：来源表（来源 / 删除）+ 添加行；与 IP 封禁弹窗同款玻璃面 */}
      <Dialog open={showCors} onClose={() => setShowCors(false)} title={t('admin.corsOrigins')}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('admin.corsOriginsHint')}</p>
          {corsList.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 bg-muted/30 px-3 py-1.5 text-sm font-medium text-muted-foreground">
                <span>{t('admin.corsOriginLabel')}</span>
                <span className="sr-only">{t('common.actions')}</span>
              </div>
              <div className="divide-y">
                {corsList.map((entry, i) => (
                  <div key={`${entry}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate font-mono text-xs font-semibold">{entry}</span>
                    <button
                      onClick={() => setDeletingCorsIndex(i)}
                      className="shrink-0 rounded p-1 text-destructive transition-colors hover:bg-destructive/10"
                      title={t('admin.removeCorsOrigin')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">{t('admin.noCorsOrigins')}</p>
          )}
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row">
            <Input
              className="flex-1 font-mono text-xs"
              placeholder={t('admin.corsOriginPlaceholder')}
              value={newCorsOrigin}
              onChange={(e) => setNewCorsOrigin(e.target.value)}
            />
            <Button
              onClick={() => {
                const v = newCorsOrigin.trim();
                if (!v) return toast('error', t('admin.corsOriginRequired'));
                if (corsList.includes(v)) return toast('error', t('admin.corsOriginDuplicate'));
                void persistCors([...corsList, v]).then(() => setNewCorsOrigin(''));
              }}
              variant="outline"
              className="shrink-0"
            >
              <Plus className="h-4 w-4" /> {t('admin.addCorsOrigin')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deletingCorsIndex !== null}
        onClose={() => setDeletingCorsIndex(null)}
        onConfirm={() => {
          if (deletingCorsIndex === null) return;
          const next = corsList.filter((_, i) => i !== deletingCorsIndex);
          setDeletingCorsIndex(null);
          void persistCors(next);
        }}
        title={t('admin.removeCorsOrigin')}
        message={t('admin.removeCorsOriginConfirm')}
      />
      </div>

      {/* 索引 diff 弹窗：统计药丸 + 原生 diff 代码块（+ / - / !）+ 确认增量更新 / 放弃 */}
      <Dialog
        open={diffOpen && Boolean(indexStatus?.pending)}
        onClose={() => setDiffOpen(false)}
        width="max-w-4xl w-[calc(100vw-2rem)]"
        title={t('admin.indexDiffTitle')}
      >
        {indexStatus?.pending && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('admin.indexDiffHint')}</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">+ {indexStatus.pending.stats.added} {t('admin.indexStatAdded')}</Badge>
              <Badge variant="outline">- {indexStatus.pending.stats.removed} {t('admin.indexStatRemoved')}</Badge>
              <Badge variant="outline">! {indexStatus.pending.stats.modified} {t('admin.indexStatModified')}</Badge>
              <Badge variant="outline">{indexStatus.pending.stats.unchanged} {t('admin.indexStatUnchanged')}</Badge>
            </div>
            <div className="glass-surface-popover max-h-[50vh] overflow-auto rounded-lg">
              <pre className="min-w-max p-3 font-mono text-xs leading-5">
                {indexStatus.pending.diffSnippet.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith('+')
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : line.startsWith('-')
                          ? 'text-red-600 dark:text-red-400'
                          : line.startsWith('!')
                            ? 'text-amber-600 dark:text-amber-400'
                            : line.startsWith('#')
                              ? 'text-muted-foreground'
                              : 'text-foreground/80'
                    }
                  >
                    {line || ' '}
                  </div>
                ))}
              </pre>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void copyIndexDiff()}>
                {diffCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{' '}
                {diffCopied ? t('admin.indexCopied') : t('admin.indexCopyAll')}
              </Button>
              <Button onClick={() => void applyIndexDiff()} loading={indexApplying}>
                {t('admin.indexApply')}
              </Button>
              <Button variant="ghost" onClick={() => void discardIndexDiff()}>
                {t('admin.indexDiscard')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
