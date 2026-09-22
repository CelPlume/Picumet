// 个性化设置：个人资料（含存储用量）· 邮箱管理 · 修改密码 · 右键单击行为 · 主题（含自定义背景）
import { useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Button,
  Badge,
  Switch,
  Progress,
} from '@/components/ui/core';
import { FormCardSkeleton } from '@/components/ui/skeleton';
import { RadioGroup } from '@/components/ui/radio-group';
import { InputOTP } from '@/components/ui/input-otp';
import { Select } from '@/components/ui/select';
import { BlurSlider } from '@/components/settings/BlurSlider';
import { FilesPerRowSlider } from '@/components/settings/FilesPerRowSlider';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/theme';
import { setLocale } from '@/lib/i18n';
import { formatBytes } from '@/lib/utils';
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

const ACCENT_PRESETS = ['#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#0EA5E9', '#64748B'];
const MAX_BG_SIZE = 2 * 1024 * 1024; // 2MB

export default function PersonalizationPage() {
  const { t } = useTranslation();
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
  const [pwdSending, setPwdSending] = useState(false);
  const [pwdCountdown, setPwdCountdown] = useState(0);

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
        body: { oldPassword, newPassword, emailCode: pwdCode || undefined },
      });
      toast('success', t('settings.passwordChanged'));
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setPwdCode('');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.security.changeFailed'));
    } finally {
      setSavingPwd(false);
    }
  };

  const sendOtp = async () => {
    if (!newEmail) return toast('error', t('settings.security.newEmailRequired'));
    setOtpSending(true);
    try {
      await apiFetch('/api/users/me/email/send-otp', { method: 'POST', body: { email: newEmail } });
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

  return (
    <div className="grid max-w-7xl items-start gap-6 lg:grid-cols-2">
      {/* 左列：个人资料 · 邮箱管理 · 修改密码 */}
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" /> {t('settings.nav.profile')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              {data.profile.avatarUrl ? (
                <img src={data.profile.avatarUrl} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover" />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
                  {(displayName || data.profile.username).slice(0, 1).toUpperCase()}
                </div>
              )}
              <div>
                <p className="font-medium">{displayName || data.profile.username}</p>
                <p className="text-sm text-muted-foreground">@{data.profile.username}</p>
                <Badge variant={data.profile.role === 'admin' ? 'default' : 'secondary'}>
                  {data.profile.role === 'admin' ? t('admin.admin') : t('admin.user')}
                </Badge>
              </div>
            <div className="ml-auto w-44 min-w-0 flex-1 space-y-2 sm:w-auto sm:max-w-md lg:max-w-lg">
                <div>
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>{t('settings.profile.storageSpace')}</span>
                    <span className="font-medium text-foreground">{formatBytes(q.usedStorage)} / {formatBytes(q.maxStorage)}</span>
                  </div>
                  <Progress value={q.storagePercent} className="h-1.5" />
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>{t('settings.filesUsed')}</span>
                    <span className="font-medium text-foreground">{q.usedFiles} / {q.maxFiles}</span>
                  </div>
                  <Progress value={q.filesPercent} className="h-1.5" />
                </div>
              </div>
            </div>

            <div>
              <Label>{t('settings.displayName')}</Label>
              <Input className="mt-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={data.profile.username} />
            </div>
            <div>
              <Label>{t('settings.avatarUrl')}</Label>
              <Input className="mt-1" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." />
            </div>
            <div>
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
            <Button onClick={save} loading={saving}>{t('common.save')}</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" /> {t('settings.security.emailManagement')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
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
            <div>
              <Label>{t('settings.security.changeEmail')}</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="new@example.com"
                  className="flex-1"
                  disabled={otpSent}
                />
                <Button onClick={sendOtp} loading={otpSending} variant="outline" disabled={countdown > 0}>
                  {countdown > 0 ? `${countdown}s` : t('settings.security.sendOtp')}
                </Button>
              </div>
              {otpSent && (
                <div className="mt-2 flex flex-col gap-2">
                  <InputOTP value={verificationCode} onChange={setVerificationCode} />
                  <Button onClick={verifyOtp} loading={verifying} variant="outline">
                    {t('settings.security.verifyEmail')}
                  </Button>
                </div>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.security.otpHint')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> {t('settings.changePassword')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>{t('settings.currentPassword')}</Label>
              <Input type="password" className="mt-1" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
            </div>
            {data?.profile.email && (
              <div>
                <Label>{t('settings.passwordCode')}</Label>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <InputOTP value={pwdCode} onChange={setPwdCode} />
                  <Button variant="outline" className="shrink-0" onClick={() => void sendPwdCode()} loading={pwdSending} disabled={pwdCountdown > 0}>
                    {pwdCountdown > 0 ? `${pwdCountdown}s` : t('auth.sendCode')}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.passwordCodeHint')}</p>
              </div>
            )}
            <div>
              <Label>{t('settings.newPassword')}</Label>
              <Input type="password" className="mt-1" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div>
              <Label>{t('settings.confirmPassword')}</Label>
              <Input type="password" className="mt-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <Button onClick={change} loading={savingPwd}>{t('settings.changePassword')}</Button>
          </CardContent>
        </Card>
      </div>

      {/* 右列：右键单击行为 · 主题（含自定义背景） */}
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MousePointerClick className="h-4 w-4 text-primary" /> {t('settings.appearance.rightClickAction')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={theme.rightClickAction}
              onChange={(v) => theme.set({ rightClickAction: v as 'properties' | 'menu' })}
              className="grid-cols-2"
              options={[
                { value: 'properties', label: t('settings.appearance.rightClickProperties'), description: t('settings.appearance.rightClickPropertiesDesc') },
                { value: 'menu', label: t('settings.appearance.rightClickMenu'), description: t('settings.appearance.rightClickMenuDesc') },
              ]}
            />
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{t('settings.appearance.rightClickMultiSelect')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.appearance.rightClickMultiSelectDesc')}</p>
              </div>
              <Switch checked={theme.rightClickMultiSelect} onChange={(v) => theme.set({ rightClickMultiSelect: v })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-primary" /> {t('settings.theme')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={theme.theme}
              onChange={(v) => theme.set({ theme: v as 'light' | 'dark' | 'system' })}
              className="grid-cols-3"
              options={themeOptions}
            />

            <div>
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

            <div className="grid gap-4 sm:grid-cols-2">
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
            </div>

            <div>
              <Label>{t('settings.blurLevel')}</Label>
              <BlurSlider value={theme.blurLevel} onChange={(level) => theme.set({ blurLevel: level })} className="mt-3" />
            </div>

            <div>
              <Label>{isMobile ? t('settings.filesPerRowMobile') : t('settings.filesPerRowDesktop')}</Label>
              {isMobile ? (
                <FilesPerRowSlider min={2} max={4} value={theme.filesPerRowMobile} onChange={(n) => theme.set({ filesPerRowMobile: n })} className="mt-3" />
              ) : (
                <FilesPerRowSlider value={theme.filesPerRow} onChange={(n) => theme.set({ filesPerRow: n })} className="mt-3" />
              )}
            </div>

            {/* 自定义背景（置于模糊效果之后） */}
            <div className="space-y-2">
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
    </div>
  );
}
