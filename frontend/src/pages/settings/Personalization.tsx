// 个性化设置：个人资料（含存储用量）· 邮箱管理 · 修改密码 · 右键单击行为 · 主题（含自定义背景）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  User,
  Mail,
  ShieldCheck,
  MousePointerClick,
  Palette,
  Pipette,
  Upload,
  X,
  Image as ImageIcon,
  Ticket,
  Copy,
  KeyRound,
  Check,
  Download,
  Eye,
  Plus,
} from 'lucide-react';
import QRCode from 'qrcode';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Button,
  Badge,
  Switch,
  Dialog,
} from '@/components/ui/core';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';
import { FormCardSkeleton } from '@/components/ui/skeleton';
import { RadioGroup } from '@/components/ui/radio-group';
import { InputOTP } from '@/components/ui/input-otp';
import { Select } from '@/components/ui/select';
import { BlurSlider, FilesPerRowSlider, MotionSlider, OverscrollSlider } from '@/components/ui/slider';
import { revealDelay, innerDelay } from '@/components/ui/reveal';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { ACCENT_PRESETS } from '@/stores/theme';
import type { MotionSpeed } from '@/stores/theme';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';
import { useCaptchaGate } from '@/components/captcha';
import { useTheme } from '@/stores/theme';
import { UsageDisplay } from '@/components/ui/usage';
import { Avatar } from '@/components/layout/widgets';
import { setLocale } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { Quota } from '@shared/types';

interface SettingsData {
  profile: {
    username: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
    avatarUrl?: string;
    locale: string;
    role: string;
  };
  appearance: { theme: string; accentColor: string; blurLevel: string };
  quota: Quota;
}

const MAX_BG_SIZE = 2 * 1024 * 1024; // 2MB

/** 受邀用户条目（GET /api/invites）：用户名 + 所用邀请码 + 注册时间 */
interface InvitedUserItem {
  username: string;
  code: string;
  registeredAt: number;
}

interface InviteCodeItem {
  id: string;
  code: string;
  name: string | null;
  createdAt: number;
  invitedUsers: InvitedUserItem[];
}

/** 注册时间格式化：中文按 年/月/日（YYYY/MM/DD），英文按 月/日/年（MM/DD/YYYY） */
function formatRegisteredDate(ms: number, lang?: string): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (lang && lang.toLowerCase().startsWith('en')) {
    return `${m}/${day}/${y}`;
  }
  return `${y}/${m}/${day}`;
}

/** 邀请码卡与受邀用户表统一的 3 列网格：第 1 列名称/用户名（左对齐），第 2 列邀请码（中间列），第 3 列时间（右对齐） */
/** 邀请码卡与受邀用户表统一的 3 列网格：第 1 列名称/用户名（左对齐），第 2 列邀请码（中间列），第 3 列时间（右对齐） */
const INVITE_GRID = 'grid grid-cols-[minmax(0,1.2fr)_120px_minmax(135px,1fr)] items-center gap-3';

export default function PersonalizationPage() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  // 手机/桌面各自记忆「每行卡片数」：按当前设备展示对应滑杆
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 个人资料
  const [data, setData] = useState<SettingsData | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [locale, setLocaleState] = useState('zh-CN');
  const [saving, setSaving] = useState(false);

  // 邮箱管理
  const [email, setEmail] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [otpError, setOtpError] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [otpSending, setOtpSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // 修改密码
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);
  // 改密邮箱验证码（账号有邮箱时才显示；未配置邮件服务时后端会自动跳过校验）
  const [pwdCode, setPwdCode] = useState('');
  const [pwdOtpError, setPwdOtpError] = useState(false);
  const [pwdSending, setPwdSending] = useState(false);
  const [pwdCountdown, setPwdCountdown] = useState(0);

  // 邀请码（docs/PROGRESS.md「邀请码注册机制」）：仅对有生成权限的用户显示。
  // 权限来自公开设置 invite_generation（all_users / admin_only）+ 本人角色；
  // 等 site.loaded 再判定，避免缓存缺失时先按默认值渲染再翻转。
  const site = useSite();
  // 人机验证门（password_change / email_verify 两面）：各自独立 token 与小部件
  const backupCaptcha = useCaptchaGate({
    provider: site.captcha?.provider ?? 'turnstile',
    siteKey: site.captcha?.siteKey ?? '',
    action: 'backup_codes',
    enabled: Boolean(site.captcha?.enabled && site.captcha.backupCodes),
  });
  const pwdCaptcha = useCaptchaGate({
    provider: site.captcha?.provider ?? 'turnstile',
    siteKey: site.captcha?.siteKey ?? '',
    action: 'password_change',
    enabled: Boolean(site.captcha?.enabled && site.captcha.passwordChange),
  });
  const emailCaptcha = useCaptchaGate({
    provider: site.captcha?.provider ?? 'turnstile',
    siteKey: site.captcha?.siteKey ?? '',
    action: 'email_verify',
    enabled: Boolean(site.captcha?.enabled && site.captcha.emailVerify),
  });
  const [invites, setInvites] = useState<InviteCodeItem[] | null>(null);
  const [inviteMax, setInviteMax] = useState(5);
  const [inviteName, setInviteName] = useState('');
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [invitesForbidden, setInvitesForbidden] = useState(false);
  const [inviteTab, setInviteTab] = useState<'codes' | 'users'>('codes');
  // 受邀用户汇总表：全部码的受邀记录合到一处展示，可按用户名/注册时间排序，
  // 默认按注册时间降序（新→旧）；切列时注册时间取 desc、用户名取 asc 作为各自的首个方向
  const [invitedSort, setInvitedSort] = useState<keyof InvitedUserItem>('registeredAt');
  const [invitedOrder, setInvitedOrder] = useState<SortOrder>('desc');
  const invitedAll = useMemo<InvitedUserItem[]>(
    () => (invites ?? []).flatMap((ic) => ic.invitedUsers),
    [invites]
  );
  const sortedInvited = useMemo(
    () => sortByKey(invitedAll, invitedSort, invitedOrder),
    [invitedAll, invitedSort, invitedOrder]
  );
  const onInvitedSort = (key: string) => {
    if (invitedSort === key) {
      setInvitedOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setInvitedSort(key as keyof InvitedUserItem);
    setInvitedOrder(key === 'registeredAt' ? 'desc' : 'asc');
  };
  // 生成权限分档，与服务端 canGenerateInvites 同口径（防「UI 隐藏但 API 放行」）：
  // 管理员恒可；guest 角色（仅下载的受限角色）不可；其余用户需开启邀请码注册且权限为 all_users。
  const role = data?.profile.role;
  const canGenerateInvites =
    role === 'admin' ? true : role === 'guest' ? false : Boolean(site.inviteEnabled) && (site.inviteGeneration ?? 'all_users') === 'all_users';

  useEffect(() => {
    if (!data || !site.loaded || !canGenerateInvites) return;
    void apiFetch<{ codes: InviteCodeItem[]; max: number }>('/api/invites')
      .then((res) => {
        setInvites(res.data.codes);
        setInviteMax(res.data.max);
      })
      .catch((err) => {
        // 设置刚被改成 admin_only 等场景：后端 403 → 区块整体隐藏（不 toast 打扰）
        if (err instanceof ApiError && err.status === 403) setInvitesForbidden(true);
      });
  }, [data, site.loaded, canGenerateInvites]);

  const generateInvite = async () => {
    setGeneratingInvite(true);
    try {
      const res = await apiFetch<{ codes: Array<Omit<InviteCodeItem, 'invitedUsers'>> }>('/api/invites', {
        method: 'POST',
        body: inviteName.trim() ? { name: inviteName.trim() } : {},
      });
      // 列表按创建时间倒序（与 GET 一致）：新码排最前
      setInvites((list) => [...res.data.codes.map((ic) => ({ ...ic, invitedUsers: [] })), ...(list ?? [])]);
      setInviteName('');
      toast('success', t('settings.invites.generated'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.invites.generateFailed'));
    } finally {
      setGeneratingInvite(false);
    }
  };

  const copyInviteLink = async (code: string) => {
    try {
      const origin = site.uploadUrl || site.returnUrl || window.location.origin;
      const link = `${origin.replace(/\/+$/, '')}/register?invite=${encodeURIComponent(code)}`;
      await navigator.clipboard.writeText(link);
      toast('success', t('settings.invites.linkCopied'));
    } catch {
      toast('error', t('common.copyFailed'));
    }
  };

  const copyBareCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast('success', t('settings.invites.codeCopied'));
    } catch {
      toast('error', t('common.copyFailed'));
    }
  };
  // 两步验证（2FA / TOTP）
  const [totpStatus, setTotpStatus] = useState<{ enabled: boolean; remainingBackupCodes: number } | null>(null);
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const [totpSetupData, setTotpSetupData] = useState<{ uri: string; secret: string; qrUrl: string } | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [enablingTotp, setEnablingTotp] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [showTotpDisable, setShowTotpDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disablingTotp, setDisablingTotp] = useState(false);
  const [showRegenBackup, setShowRegenBackup] = useState(false);
  const [showBackupList, setShowBackupList] = useState(false);
  const [backupList, setBackupList] = useState<string[] | null>(null);
  const [backupListLoading, setBackupListLoading] = useState(false);
  const [regenPassword, setRegenPassword] = useState('');
  const [regenCode, setRegenCode] = useState('');
  const [regeneratingBackup, setRegeneratingBackup] = useState(false);

  const loadTotpStatus = async () => {
    try {
      const res = await apiFetch<{ enabled: boolean; remainingBackupCodes: number }>('/api/users/2fa/status');
      setTotpStatus(res.data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadTotpStatus();
  }, []);

  const startTotpSetup = async () => {
    try {
      const res = await apiFetch<{ uri: string; secret: string }>('/api/users/2fa/setup', { method: 'POST' });
      const qrUrl = await QRCode.toDataURL(res.data.uri, { width: 200, margin: 2 });
      setTotpSetupData({ uri: res.data.uri, secret: res.data.secret, qrUrl });
      setSetupCode('');
      setNewBackupCodes(null);
      setCopiedCodes(false);
      setShowTotpSetup(true);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
    }
  };

  const confirmEnableTotp = async () => {
    if (setupCode.length !== 6) return toast('error', t('settings.twoFactor.codeInvalid'));
    setEnablingTotp(true);
    try {
      const res = await apiFetch<{ backupCodes: string[] }>('/api/users/2fa/enable', {
        method: 'POST',
        body: { code: setupCode },
      });
      setNewBackupCodes(res.data.backupCodes);
      toast('success', t('settings.twoFactor.enabled'));
      await loadTotpStatus();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setEnablingTotp(false);
    }
  };

  const confirmDisableTotp = async () => {
    if (!disablePassword) return toast('error', t('settings.twoFactor.currentPassword'));
    setDisablingTotp(true);
    try {
      await apiFetch('/api/users/2fa/disable', {
        method: 'POST',
        body: { password: disablePassword, code: disableCode || undefined },
      });
      toast('success', t('settings.twoFactor.disabled'));
      setShowTotpDisable(false);
      setDisablePassword('');
      setDisableCode('');
      await loadTotpStatus();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setDisablingTotp(false);
    }
  };

  const loadBackupList = async () => {
    setBackupListLoading(true);
    try {
      const res = await apiFetch<{ codes: string[] }>('/api/users/2fa/backup-codes');
      setBackupList(res.data.codes ?? []);
      await loadTotpStatus();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
      setBackupList([]);
    } finally {
      setBackupListLoading(false);
    }
  };

  const confirmRegenBackupCodes = async () => {
    if (!regenPassword || !regenCode) return toast('error', t('settings.twoFactor.codeInvalid'));
    setRegeneratingBackup(true);
    try {
      const backupToken = site.captcha?.enabled && site.captcha.backupCodes ? await backupCaptcha.freshToken().catch(() => undefined) : undefined;
      const res = await apiFetch<{ backupCodes: string[] }>('/api/users/2fa/backup-codes/regenerate', {
        method: 'POST',
        body: { password: regenPassword, code: regenCode, turnstileToken: backupToken },
      });
      setNewBackupCodes(res.data.backupCodes);
      setShowRegenBackup(false);
      setShowTotpSetup(true);
      setRegenPassword('');
      setRegenCode('');
      await loadTotpStatus();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'CAPTCHA_FAILED' || err.code === 'CAPTCHA_REQUIRED')) {
        toast('error', err.message);
      }
      toast('error', err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setRegeneratingBackup(false);
    }
  };

  // 主题
  const [uploadingBg, setUploadingBg] = useState(false);
  const customColorRef = useRef<HTMLInputElement>(null);
  const isCustomAccent = !ACCENT_PRESETS.some((c) => c.toLowerCase() === theme.accentColor.toLowerCase());

  useEffect(() => {
    void apiFetch<SettingsData>('/api/users/me/settings').then((res) => {
      setData(res.data);
      setDisplayName(res.data.profile.displayName ?? '');
      setAvatarUrl(res.data.profile.avatarUrl ?? '');
      setLocaleState(res.data.profile.locale);
      setEmail(res.data.profile.email);
      setEmailVerified(res.data.profile.emailVerified);
    });
  }, []);

  // 验证码发送倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // 改密验证码倒计时
  useEffect(() => {
    if (pwdCountdown <= 0) return;
    const timer = setInterval(() => setPwdCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [pwdCountdown]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/users/me/settings', { method: 'PUT', body: { displayName, avatarUrl, locale } });
      setLocale(locale);
      toast('success', t('settings.profile.saved'));
      await useAuth.getState().fetchMe();
    } catch {
      toast('error', t('settings.profile.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const sendPwdCode = async () => {
    setPwdSending(true);
    try {
      const res = await apiFetch<{ expiresIn: number }>('/api/users/me/password/send-code', { method: 'POST' });
      setPwdCountdown(res.data.expiresIn ?? 60);
      toast('success', t('auth.codeSent'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.operationFailed'));
    } finally {
      setPwdSending(false);
    }
  };

  const change = async () => {
    if (newPassword !== confirm) return toast('error', t('settings.passwordMismatch'));
    if (newPassword.length < 8) return toast('error', t('login.newPasswordShort'));
    setSavingPwd(true);
    try {
      await apiFetch('/api/users/me/password', {
        method: 'PUT',
        body: {
          oldPassword,
          newPassword,
          emailCode: pwdCode || undefined,
          turnstileToken: site.captcha?.enabled && site.captcha.passwordChange ? await pwdCaptcha.freshToken().catch(() => undefined) : undefined,
        },
      });
      toast('success', t('settings.passwordChanged'));
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setPwdCode('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') setPwdOtpError(true);
      toast('error', err instanceof ApiError ? err.message : t('settings.security.changeFailed'));
    } finally {
      setSavingPwd(false);
    }
  };

  const sendOtp = async () => {
    if (!newEmail) return toast('error', t('settings.security.newEmailRequired'));
    setOtpSending(true);
    try {
      const emailOtpToken = site.captcha?.enabled && site.captcha.emailVerify ? await emailCaptcha.freshToken().catch(() => undefined) : undefined;
      await apiFetch('/api/users/me/email/send-otp', { method: 'POST', body: { email: newEmail, turnstileToken: emailOtpToken } });
      toast('success', t('settings.security.otpSent'));
      setOtpSent(true);
      setCountdown(60);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.security.sendFailed'));
    } finally {
      setOtpSending(false);
    }
  };

  const verifyOtp = async () => {
    if (!verificationCode) return toast('error', t('settings.security.codeRequired'));
    setVerifying(true);
    try {
      await apiFetch('/api/users/me/email/verify-otp', {
        method: 'POST',
        body: { email: newEmail, code: verificationCode },
      });
      setEmail(newEmail);
      setEmailVerified(true);
      setNewEmail('');
      setVerificationCode('');
      setOtpSent(false);
      setCountdown(0);
      toast('success', t('settings.security.emailVerified'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') setOtpError(true);
      toast('error', err instanceof ApiError ? err.message : t('settings.security.verifyFailed'));
    } finally {
      setVerifying(false);
    }
  };

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
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'system', label: t('settings.themeSystem') },
  ];

  if (!data) {
    return (
      <div className="grid max-w-7xl items-start gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <FormCardSkeleton />
          <FormCardSkeleton />
        </div>
        <div className="space-y-6">
          <FormCardSkeleton />
          <FormCardSkeleton />
        </div>
      </div>
    );
  }

  const q = data.quota;
  const showInvites = site.loaded && canGenerateInvites && !invitesForbidden;
  const inviteList = invites ?? [];
  // 两步验证插在「修改密码」之后（左列第 4 张，序号 3）；邀请码在「两步验证」之后（左列第 5 张，序号 4）
  const inviteIdx = 4;
  const previewIdx = showInvites ? 5 : 4;
  const themeIdx = showInvites ? 6 : 5;

  return (
    <div className="grid max-w-7xl items-start gap-6 lg:grid-cols-2">
      {/* 左列：个人资料 · 邮箱管理 · 修改密码 · 邀请码（有生成权限时） */}
      <div className="space-y-6">
        <Card className="reveal" style={revealDelay(0)}>
          <CardHeader className="reveal-row" style={innerDelay(0, 0)}>
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" /> {t('settings.nav.profile')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="reveal-row flex flex-wrap items-center gap-4" style={innerDelay(0, 1)}>
              <Avatar name={displayName || data.profile.username} url={data.profile.avatarUrl} size={64} />
              <div>
                <p className="font-medium">{displayName || data.profile.username}</p>
                <p className="text-sm text-muted-foreground">@{data.profile.username}</p>
                <Badge variant={data.profile.role === 'admin' ? 'default' : 'secondary'}>
                  {data.profile.role === 'admin' ? t('admin.admin') : t('admin.user')}
                </Badge>
              </div>
            <div className="ml-auto w-56 min-w-0 flex-1 sm:w-auto sm:max-w-md lg:max-w-lg">
              {/* 用量展示：进度条 / 运动圆环由外观设置 usageStyle 决定（个人资料 + 头像菜单共用） */}
              <UsageDisplay quota={q} />
            </div>
            </div>

            <div className="reveal-row" style={innerDelay(0, 2)}>
              <Label>{t('settings.displayName')}</Label>
              <Input className="mt-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={data.profile.username} />
            </div>
            <div className="reveal-row" style={innerDelay(0, 3)}>
              <Label>{t('settings.avatarUrl')}</Label>
              <Input className="mt-1" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." />
            </div>
            <div className="reveal-row" style={innerDelay(0, 4)}>
              <Label>{t('settings.language')}</Label>
              <Select
                value={locale}
                onValueChange={setLocaleState}
                className="mt-1"
                options={[
                  { value: 'zh-CN', label: t('settings.langZh') },
                  { value: 'en-US', label: t('settings.langEn') },
                ]}
              />
            </div>
            <div className="reveal-row" style={innerDelay(0, 5)}>
              <Button onClick={save} loading={saving}>{t('common.save')}</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="reveal" style={revealDelay(1)}>
          <CardHeader className="reveal-row" style={innerDelay(1, 0)}>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" /> {t('settings.security.emailManagement')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="reveal-row" style={innerDelay(1, 1)}>
              <Label>{t('settings.security.currentEmail')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <Input readOnly value={email || t('settings.security.notSet')} className="flex-1 bg-muted/50" />
                {emailVerified ? (
                  <Badge variant="success">{t('settings.verified')}</Badge>
                ) : (
                  <Badge variant="warning">{t('settings.notVerified')}</Badge>
                )}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.security.emailHint')}</p>
            </div>
            <div className="reveal-row" style={innerDelay(1, 2)}>
              <Label>{t('settings.security.changeEmail')}</Label>
              <Input
                type="email"
                className="mt-1"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="new@example.com"
                disabled={otpSent}
              />
              {/* 验证码 + 发送按钮：OTP 分段输入 + 右侧发送验证码按钮，行宽与上方文本框一致（预留输入位） */}
              <div className="mt-2 flex gap-2">
                <InputOTP
                  value={verificationCode}
                  onChange={(v) => { setVerificationCode(v); setOtpError(false); }}
                  className="min-w-0 flex-1"
                  error={otpError}
                />
                <Button onClick={sendOtp} loading={otpSending} variant="outline" className="shrink-0" disabled={countdown > 0}>
                  {countdown > 0 ? `${countdown}s` : t('settings.security.sendOtp')}
                </Button>
                {emailCaptcha.element}
              </div>
              {otpSent && (
                <Button onClick={verifyOtp} loading={verifying} variant="outline" className="mt-2 w-full">
                  {t('settings.security.verifyEmail')}
                </Button>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.security.otpHint')}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="reveal" style={revealDelay(2)}>
          <CardHeader className="reveal-row" style={innerDelay(2, 0)}>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> {t('settings.changePassword')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="reveal-row" style={innerDelay(2, 1)}>
              <Label>{t('settings.currentPassword')}</Label>
              <Input type="password" className="mt-1" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
            </div>
            {data?.profile.email && (
              <div className="reveal-row" style={innerDelay(2, 2)}>
                <Label>{t('settings.passwordCode')}</Label>
                <div className="mt-1 flex gap-2">
                  <InputOTP
                    value={pwdCode}
                    onChange={(v) => { setPwdCode(v); setPwdOtpError(false); }}
                    className="min-w-0 flex-1"
                    error={pwdOtpError}
                  />
                  <Button variant="outline" className="shrink-0" onClick={() => void sendPwdCode()} loading={pwdSending} disabled={pwdCountdown > 0}>
                    {pwdCountdown > 0 ? `${pwdCountdown}s` : t('auth.sendCode')}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.passwordCodeHint')}</p>
              </div>
            )}
            <div className="reveal-row" style={innerDelay(2, 3)}>
              <Label>{t('settings.newPassword')}</Label>
              <Input type="password" className="mt-1" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div className="reveal-row" style={innerDelay(2, 4)}>
              <Label>{t('settings.confirmPassword')}</Label>
              <Input type="password" className="mt-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {site.captcha?.enabled && site.captcha.passwordChange && (
              <div className="reveal-row" style={innerDelay(2, 5)}>{pwdCaptcha.element}</div>
            )}
            <div className="reveal-row" style={innerDelay(2, 6)}>
              <Button onClick={change} loading={savingPwd}>{t('settings.changePassword')}</Button>
            </div>
          </CardContent>
        </Card>

        {/* 两步验证（2FA / TOTP） */}
        <Card className="reveal" style={revealDelay(3)}>
          <CardHeader className="reveal-row" style={innerDelay(3, 0)}>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" /> {t('settings.twoFactor.title')}
              </CardTitle>
              {totpStatus && (
                <Badge variant={totpStatus.enabled ? 'default' : 'secondary'}>
                  {totpStatus.enabled ? t('settings.twoFactor.enabled') : t('settings.twoFactor.disabled')}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="reveal-row text-xs text-muted-foreground" style={innerDelay(3, 1)}>
              {t('settings.twoFactor.desc')}
            </p>
            {totpStatus?.enabled ? (
              <div className="reveal-row space-y-3" style={innerDelay(3, 2)}>
                {/* 剩余数量 + 查看：无边框，分隔线过渡（卡中卡原则） */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {t('settings.twoFactor.backupCodesRemaining', { count: totpStatus.remainingBackupCodes })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setShowBackupList(true);
                        void loadBackupList();
                      }}
                    >
                      <Eye className="h-3.5 w-3.5" /> {t('settings.twoFactor.viewBackupCodes')}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between border-t pt-2.5">
                    <span className="text-xs text-muted-foreground">{t('settings.twoFactor.regenerateBackupCodes')}</span>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowRegenBackup(true)}>
                      <Plus className="h-3.5 w-3.5" /> {t('common.add')}
                    </Button>
                  </div>
                </div>
                <div>
                  <Button variant="outline" size="sm" className="h-8 w-full text-destructive hover:bg-destructive/10" onClick={() => setShowTotpDisable(true)}>
                    {t('settings.twoFactor.disable')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="reveal-row" style={innerDelay(3, 2)}>
                <Button onClick={startTotpSetup}>{t('settings.twoFactor.enable')}</Button>
              </div>
            )}
          </CardContent>
        </Card>

        {showInvites && (
          <Card className="reveal" style={revealDelay(inviteIdx)}>
            <CardHeader className="reveal-row" style={innerDelay(inviteIdx, 0)}>
              <CardTitle className="flex items-center gap-2">
                <Ticket className="h-4 w-4 text-primary" /> {t('settings.invites.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={inviteTab} onValueChange={(v) => setInviteTab(v as 'codes' | 'users')}>
                <div className="reveal-row" style={innerDelay(inviteIdx, 1)}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="codes">{t('settings.invites.tabCodes')}</TabsTrigger>
                    <TabsTrigger value="users">{t('settings.invites.tabUsers')}</TabsTrigger>
                  </TabsList>
                </div>

                {/* Tab 1: 邀请码 */}
                <TabsContent value="codes" className="space-y-4 pt-1">
                  <div>
                    <p className="text-xs text-muted-foreground">{t('settings.invites.description')}</p>
                    <div className="mt-2 flex gap-2">
                      <Input
                        className="flex-1"
                        value={inviteName}
                        onChange={(e) => setInviteName(e.target.value)}
                        placeholder={t('settings.invites.namePlaceholder')}
                        maxLength={50}
                      />
                      <Button
                        className="shrink-0"
                        onClick={generateInvite}
                        loading={generatingInvite}
                        disabled={inviteList.length >= inviteMax}
                      >
                        <Ticket className="h-4 w-4" /> {t('settings.invites.generate')}
                      </Button>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {t('settings.invites.usage', { used: inviteList.length, max: inviteMax })}
                      {inviteList.length >= inviteMax && ` · ${t('settings.invites.limitReached')}`}
                    </p>
                  </div>

                  {/* 邀请码表格：与受邀用户表格拥有完全一致的行内边距（py-2.5）和时间字号（text-sm） */}
                  <div className="border-t pt-2.5">
                    <div className={cn(INVITE_GRID, 'border-b pb-2 text-sm font-medium text-muted-foreground')}>
                      <div><span>{t('settings.invites.colName')}</span></div>
                      <div><span>{t('settings.invites.colInviteCode')}</span></div>
                      <div className="text-right"><span>{t('settings.invites.colCreatedAt')}</span></div>
                    </div>

                    {inviteList.length === 0 ? (
                      <div className="py-6">
                        <EmptyState compact icon={<Ticket className="h-4 w-4" />} title={t('settings.invites.codesEmpty')} />
                      </div>
                    ) : (
                      <div className="divide-y">
                        {inviteList.map((ic) => (
                          <div key={ic.id} className={cn(INVITE_GRID, 'py-2.5 hover:bg-accent/30 transition-colors')}>
                            {/* 第一列：邀请码名（左对齐，未命名显示 -） */}
                            <div className="min-w-0 pr-2">
                              <span className={cn('block truncate text-sm', ic.name ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                                {ic.name || '-'}
                              </span>
                            </div>

                            {/* 中间列：邀请码（小尺寸药丸）+ 复制按钮 */}
                            <div className="flex items-center gap-1.5">
                              <code
                                className="cursor-pointer rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs tracking-wider text-foreground hover:bg-muted transition-colors"
                                onClick={() => copyBareCode(ic.code)}
                                title={t('settings.invites.copyCodeTitle')}
                              >
                                {ic.code}
                              </code>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-foreground"
                                onClick={() => copyInviteLink(ic.code)}
                                title={t('settings.invites.copyLinkTitle')}
                                aria-label={t('settings.invites.copyLinkTitle')}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>

                            {/* 右侧：创建时间（右对齐，字号为 text-sm 与注册时间一致） */}
                            <div className="text-right">
                              <span className="font-mono text-sm text-muted-foreground whitespace-nowrap">
                                {formatDateTime(ic.createdAt)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Tab 2: 邀请的人 */}
                <TabsContent value="users" className="space-y-4 pt-1">
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{t('settings.invites.invitedUsers')}</p>
                      <p className="text-xs text-muted-foreground">{t('settings.invites.invitedCount', { count: invitedAll.length })}</p>
                    </div>
                    <div className="mt-2.5">
                      {/* 表头：三列与邀请码表格共享 INVITE_GRID，第 3 列右对齐 */}
                      <div className={cn(INVITE_GRID, 'border-b pb-2 text-sm font-medium text-muted-foreground')}>
                        <div className="flex items-center">
                          <SortableHeader
                            title={t('settings.invites.colUsername')}
                            sortKey="username"
                            sort={invitedSort}
                            order={invitedOrder}
                            onSort={onInvitedSort}
                          />
                        </div>
                        <div>
                          <span>{t('settings.invites.colCode')}</span>
                        </div>
                        <div className="flex items-center justify-end text-right">
                          <SortableHeader
                            title={t('settings.invites.colRegisteredAt')}
                            sortKey="registeredAt"
                            sort={invitedSort}
                            order={invitedOrder}
                            onSort={onInvitedSort}
                            className="ml-auto"
                          />
                        </div>
                      </div>

                      {/* 表体 */}
                      {sortedInvited.length === 0 ? (
                        <div className="py-6">
                          <EmptyState compact icon={<User className="h-4 w-4" />} title={t('settings.invites.invitedEmpty')} />
                        </div>
                      ) : (
                        sortedInvited.map((u) => (
                          <div
                            key={u.username}
                            className={cn(INVITE_GRID, 'py-2.5 border-b last:border-b-0 hover:bg-accent/30 transition-colors')}
                          >
                            <div className="min-w-0 pr-2">
                              <span className="block truncate text-sm font-medium text-foreground">{u.username}</span>
                            </div>
                            <div className="flex items-center">
                              <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs tracking-wider text-foreground">
                                {u.code}
                              </code>
                            </div>
                            <div className="text-right">
                              <span className="font-mono text-sm text-muted-foreground whitespace-nowrap">
                                {formatRegisteredDate(u.registeredAt, i18n.language)}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}
      </div>

      {/* 右列：预览行为（尺寸/右键）· 主题（含自定义背景） */}
      <div className="space-y-6">
        {/* 预览行为卡：尺寸模式（fit/original）+ 右键行为 + 多选开关，同卡收纳 */}
        <Card className="reveal" style={revealDelay(previewIdx)}>
          <CardHeader className="reveal-row" style={innerDelay(previewIdx, 0)}>
            <CardTitle className="flex items-center gap-2">
              <MousePointerClick className="h-4 w-4 text-primary" /> {t('settings.appearance.previewBehavior')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>{t('settings.appearance.previewSizeMode')}</Label>
              <RadioGroup
                value={theme.previewSizeMode}
                onChange={(v) => theme.set({ previewSizeMode: v as 'fit' | 'original' })}
                className="reveal-row grid-cols-2"
                style={innerDelay(previewIdx, 1)}
                options={[
                  { value: 'fit', label: t('settings.appearance.previewModeFitShort'), description: t('settings.appearance.previewModeFit') },
                  { value: 'original', label: t('settings.appearance.previewModeOriginalShort'), description: t('settings.appearance.previewModeOriginal') },
                ]}
              />
            </div>
            <div>
              <Label>{t('settings.appearance.rightClickAction')}</Label>
              <RadioGroup
                value={theme.rightClickAction}
                onChange={(v) => theme.set({ rightClickAction: v as 'menu' | 'properties' | 'multiselect' })}
                className="reveal-row grid-cols-1"
                style={innerDelay(previewIdx, 2)}
                options={[
                  { value: 'menu', label: t('settings.appearance.rightClickMenu'), description: t('settings.appearance.rightClickMenuDesc') },
                  { value: 'properties', label: t('settings.appearance.rightClickProperties'), description: t('settings.appearance.rightClickPropertiesDesc') },
                  { value: 'multiselect', label: t('settings.appearance.rightClickMultiselect'), description: t('settings.appearance.rightClickMultiselectDesc') },
                ]}
              />
            </div>
            <div className="reveal-row flex items-center justify-between rounded-lg border px-3 py-2.5" style={innerDelay(previewIdx, 3)}>
              <div>
                <p className="text-sm font-medium">{t('settings.appearance.mediaPreviews')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.appearance.mediaPreviewsDesc')}</p>
              </div>
              <Switch checked={theme.mediaPreviewsEnabled} onChange={(v) => theme.set({ mediaPreviewsEnabled: v })} />
            </div>
          </CardContent>
        </Card>

        <Card className="reveal" style={revealDelay(themeIdx)}>
          <CardHeader className="reveal-row" style={innerDelay(themeIdx, 0)}>
            <CardTitle className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-primary" /> {t('settings.theme')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={theme.theme}
              onChange={(v) => theme.set({ theme: v as 'light' | 'dark' | 'system' })}
              className="reveal-row grid-cols-3"
              style={innerDelay(themeIdx, 1)}
              options={themeOptions}
            />

            <div className="reveal-row" style={innerDelay(themeIdx, 2)}>
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

            <div className="reveal-row grid gap-4 sm:grid-cols-2" style={innerDelay(themeIdx, 3)}>
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

              {/* 用量展示样式独占一行（第 3 项绕行后 sm:col-span-2 占满行宽），
                  两个选项左右并列（同 motionSpeed 的 grid-cols-2 版式） */}
              <div className="sm:col-span-2">
                <Label>{t('settings.appearance.usageStyle')}</Label>
                <RadioGroup
                  value={theme.usageStyle}
                  onChange={(v) => theme.set({ usageStyle: v as 'progress' | 'activity' })}
                  options={[
                    { value: 'progress', label: t('settings.appearance.usageStyleProgress'), description: t('settings.appearance.usageStyleProgressDesc') },
                    { value: 'activity', label: t('settings.appearance.usageStyleActivity'), description: t('settings.appearance.usageStyleActivityDesc') },
                  ]}
                  className="mt-1.5 grid-cols-2"
                />
              </div>
            </div>

            {/* 每行卡片数置顶：三个滑块里唯一直接反映文件页观感的一项（桌面 4–8 / 手机 2–4 各记一份） */}
            <div className="reveal-row" style={innerDelay(themeIdx, 4)}>
              {isMobile ? (
                <FilesPerRowSlider
                  min={2}
                  max={4}
                  value={theme.filesPerRowMobile}
                  onChange={(n) => theme.set({ filesPerRowMobile: n })}
                  label={t('settings.filesPerRowMobile')}
                />
              ) : (
                <FilesPerRowSlider
                  value={theme.filesPerRow}
                  onChange={(n) => theme.set({ filesPerRow: n })}
                  label={t('settings.filesPerRowDesktop')}
                />
              )}
            </div>

            <div className="reveal-row" style={innerDelay(themeIdx, 5)}>
              <BlurSlider value={theme.blurLevel} onChange={(level) => theme.set({ blurLevel: level })} />
            </div>

            {/* 动画三档；「全部动画」档下再挂速度两档，与主题选择同款行内二选一 */}
            <div className="reveal-row" style={innerDelay(themeIdx, 6)}>
              <MotionSlider value={theme.motionLevel} onChange={(level) => theme.set({ motionLevel: level })} />
            </div>

            {theme.motionLevel === 'all' && (
              <div className="reveal-row" style={innerDelay(themeIdx, 7)}>
                <Label>{t('settings.appearance.motionSpeed')}</Label>
                <RadioGroup
                  value={theme.motionSpeed}
                  onChange={(v) => theme.set({ motionSpeed: v as MotionSpeed })}
                  className="mt-1.5 grid-cols-2"
                  options={[
                    {
                      value: 'efficient',
                      label: t('settings.appearance.motionSpeedEfficient'),
                      description: t('settings.appearance.motionSpeedEfficientDesc'),
                    },
                    {
                      value: 'comfortable',
                      label: t('settings.appearance.motionSpeedComfortable'),
                      description: t('settings.appearance.motionSpeedComfortableDesc'),
                    },
                  ]}
                />
              </div>
            )}

            {/* 过滚动效果：动画默认/全部档显示（关闭动画档没有可回弹的动效）；引擎见 lib/overscroll.ts */}
            {theme.motionLevel !== 'off' && (
              <div className="reveal-row" style={innerDelay(themeIdx, theme.motionLevel === 'all' ? 8 : 7)}>
                <OverscrollSlider
                  value={theme.overscrollEffect}
                  onChange={(level) => theme.set({ overscrollEffect: level })}
                />
              </div>
            )}

            {/* 自定义背景（置于三个滑块之后） */}
            <div className="reveal-row space-y-2" style={innerDelay(themeIdx, 9)}>
              <Label>{t('settings.background')}</Label>
              <RadioGroup
                className="grid-cols-2"
                value={theme.backgroundType}
                onChange={(v) => theme.set({ backgroundType: v as 'none' | 'image' | 'color' })}
                options={[
                  { value: 'none', label: t('settings.backgroundNone') },
                  { value: 'image', label: t('settings.backgroundImage') },
                ]}
              />

              {theme.backgroundType === 'image' && (
                <div className="space-y-2">
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
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2FA 启用向导 / 备用码展示弹窗 */}
      <Dialog
        open={showTotpSetup}
        onClose={() => {
          setShowTotpSetup(false);
          setTotpSetupData(null);
          setNewBackupCodes(null);
        }}
        title={newBackupCodes ? t('settings.twoFactor.backupCodesTitle') : t('settings.twoFactor.setupTitle')}
      >
        {newBackupCodes ? (
          <div className="space-y-4">
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('settings.twoFactor.backupCodesWarning')}
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm tracking-wider text-center">
              {newBackupCodes.map((code) => (
                <div key={code} className="rounded bg-background/80 py-1 border shadow-xs select-all">
                  {code}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 pt-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(newBackupCodes.join('\n'));
                    setCopiedCodes(true);
                    toast('success', t('common.copied'));
                  }}
                >
                  {copiedCodes ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('settings.apiKeys.copyAll')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const lines = [
                      `${t('settings.twoFactor.title')} - ${t('settings.twoFactor.backupCodesTitle')}`,
                      `${t('login.username')}: ${data.profile.username}`,
                      `${t('settings.twoFactor.backupCodesRemaining', { count: newBackupCodes.length })}`,
                      '',
                      ...newBackupCodes,
                    ];
                    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${data.profile.username}_backup_code.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast('success', t('settings.twoFactor.backupCodesDownloaded'));
                  }}
                >
                  <Download className="h-3.5 w-3.5" /> {t('settings.twoFactor.downloadBackupCodes')}
                </Button>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setShowTotpSetup(false);
                  setTotpSetupData(null);
                  setNewBackupCodes(null);
                }}
              >
                {t('settings.twoFactor.savedBackupCodes')}
              </Button>
            </div>
          </div>
        ) : totpSetupData ? (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              {t('settings.twoFactor.setupStep1')}
            </div>
            <div className="flex flex-col items-center justify-center gap-2">
              {totpSetupData.qrUrl && (
                <img src={totpSetupData.qrUrl} alt="2FA QR Code" className="h-44 w-44 rounded-lg border bg-white p-2 shadow-xs" />
              )}
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-muted-foreground select-all">{totpSetupData.secret}</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(totpSetupData.secret);
                    toast('success', t('common.copied'));
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="space-y-2 border-t pt-3">
              <Label className="text-xs">{t('settings.twoFactor.setupStep2')}</Label>
              <div className="flex justify-center py-1">
                <InputOTP
                  value={setupCode}
                  onChange={setSetupCode}
                  length={6}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowTotpSetup(false);
                  setTotpSetupData(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={confirmEnableTotp} loading={enablingTotp} disabled={setupCode.length !== 6}>
                {t('settings.twoFactor.confirmAndEnable')}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* 禁用 2FA 确认弹窗 */}
      <Dialog
        open={showTotpDisable}
        onClose={() => {
          setShowTotpDisable(false);
          setDisablePassword('');
          setDisableCode('');
        }}
        title={t('settings.twoFactor.disableTitle')}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t('settings.twoFactor.disableDesc')}
          </p>
          <div className="space-y-3">
            <div>
              <Label>{t('settings.twoFactor.currentPassword')}</Label>
              <Input
                type="password"
                className="mt-1"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <Label>{t('settings.twoFactor.currentCodeOrBackup')}</Label>
              <Input
                className="mt-1 font-mono"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="000000 / abcdef12"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowTotpDisable(false);
                setDisablePassword('');
                setDisableCode('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDisableTotp} loading={disablingTotp} disabled={!disablePassword.trim()}>
              {t('settings.twoFactor.disable')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 查看剩余备用码（服务端密文回读，对标 Google） */}
      <Dialog
        open={showBackupList}
        onClose={() => setShowBackupList(false)}
        title={t('settings.twoFactor.viewBackupCodes')}
        footer={<Button onClick={() => setShowBackupList(false)}>{t('common.close')}</Button>}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('settings.twoFactor.backupCodesWarning')}</p>
          {backupListLoading ? (
            <p className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : backupList && backupList.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm tracking-wider text-center">
              {backupList.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(code);
                    toast('success', t('common.copied'));
                  }}
                  title={t('common.copy')}
                  className="cursor-pointer select-all rounded border bg-background/80 py-1 shadow-xs transition-colors hover:bg-accent"
                >
                  {code}
                </button>
              ))}
            </div>
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">
              {t('settings.twoFactor.noBackupCodes')}
            </p>
          )}
          <div className="flex items-center gap-2 border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={!backupList || backupList.length === 0}
              onClick={() => {
                if (!backupList) return;
                void navigator.clipboard.writeText(backupList.join('\n'));
                toast('success', t('common.copied'));
              }}
            >
              <Copy className="h-3.5 w-3.5" /> {t('settings.apiKeys.copyAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={!backupList || backupList.length === 0}
              onClick={() => {
                if (!backupList) return;
                const lines = [
                  `${t('settings.twoFactor.title')} - ${t('settings.twoFactor.backupCodesTitle')}`,
                  `${t('login.username')}: ${data.profile.username}`,
                  '',
                  ...backupList,
                ];
                const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${data.profile.username}_backup_code.txt`;
                a.click();
                URL.revokeObjectURL(url);
                toast('success', t('settings.twoFactor.backupCodesDownloaded'));
              }}
            >
              <Download className="h-3.5 w-3.5" /> {t('settings.twoFactor.downloadBackupCodes')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 重新生成备用码弹窗 */}
      <Dialog
        open={showRegenBackup}
        onClose={() => {
          setShowRegenBackup(false);
          setShowBackupList(false);
          setRegenPassword('');
          setRegenCode('');
        }}
        title={t('settings.twoFactor.regenerateBackupCodes')}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t('settings.twoFactor.regenerateBackupCodesDesc')}
          </p>
          <div className="space-y-3">
            <div>
              <Label>{t('settings.twoFactor.currentPassword')}</Label>
              <Input
                type="password"
                className="mt-1"
                value={regenPassword}
                onChange={(e) => setRegenPassword(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <Label>{t('settings.twoFactor.currentTotpCode')}</Label>
              <div className="mt-2 flex justify-center">
                <InputOTP
                  value={regenCode}
                  onChange={(v) => setRegenCode(v)}
                  length={6}
                />
              </div>
            </div>
            {backupCaptcha.element}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowRegenBackup(false);
                setRegenPassword('');
                setRegenCode('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmRegenBackupCodes} loading={regeneratingBackup} disabled={!regenPassword.trim() || !regenCode.trim()}>
              {t('settings.twoFactor.regenerateBackupCodes')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
