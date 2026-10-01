// 第三方登录补充注册页（/sso/complete?token=…）
//
// OIDC / GitHub 鉴权成功后，若没有可关联的本地账号，就落到本页由用户**自填**本站资料
// （邮箱 / 用户名 / 密码 + 邮箱验证码），不复用提供方档案——提供方信息只用于一键预填
// （用户可选）。第三方身份与令牌在提交时落库（见 workers/src/services/sso/README.md）。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Wand2 } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui/core';
import { InputOTP } from '@/components/ui/input-otp';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { useSite } from '@/stores/site';
import { useAuth } from '@/stores/auth';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import { ssoErrorKey } from '@/components/sso-buttons';
import type { SsoPendingProfile, User, Quota } from '@shared/types';

/**
 * 验证码行是否显示。服务端只在「提交的邮箱 = 提供方已验证的邮箱」时免验证码，
 * 因此用户把邮箱改成别的地址（或提供方未验证）时前端必须同步显示该行，
 * 否则用户会拿到「邮箱验证码错误或已过期」而看不到输入位。
 */
function otpRowVisible(profile: SsoPendingProfile, email: string): boolean {
  if (profile.emailVerificationRequired) return true;
  const providerEmail = profile.emailVerified ? (profile.email ?? '').trim().toLowerCase() : '';
  return providerEmail !== '' && email.trim().toLowerCase() !== providerEmail;
}

export default function SsoComplete() {
  const { t } = useTranslation();
  const site = useSite();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [profile, setProfile] = useState<SsoPendingProfile | null>(null);
  const [loadError, setLoadError] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  // OTP 错误态：提交被后端判 INVALID_OTP 时整行抖动（与注册页同款反馈）
  const [otpError, setOtpError] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => clearInterval(countdownTimerRef.current ?? undefined), []);

  // 读取待填档案（一次性令牌）：过期/失效时给出可操作的错误态
  useEffect(() => {
    if (!token) {
      setLoadError(t('auth.ssoComplete.missingToken'));
      return;
    }
    void (async () => {
      try {
        const res = await apiFetch<SsoPendingProfile>(`/api/auth/sso/pending?token=${encodeURIComponent(token)}`);
        setProfile(res.data);
      } catch (err) {
        setLoadError(err instanceof ApiError ? t(ssoErrorKey(err.code)) : t('err.network'));
      }
    })();
  }, [token, t]);

  /** 一键预填提供方下发的邮箱与用户名（可选动作，填完仍可修改） */
  const applyProviderProfile = () => {
    if (!profile) return;
    if (profile.email) setEmail(profile.email);
    if (profile.username) setUsername(profile.username);
    toast('success', t('auth.ssoComplete.prefilled'));
  };

  const sendOtp = async () => {
    if (!email) return setError(t('auth.emailRequired'));
    setOtpSending(true);
    try {
      await apiFetch('/api/auth/register/send-otp', { method: 'POST', body: { email } });
      setCountdown(60);
      clearInterval(countdownTimerRef.current ?? undefined);
      countdownTimerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) clearInterval(countdownTimerRef.current ?? undefined);
          return c - 1;
        });
      }, 1000);
      toast('success', t('auth.codeSent'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setOtpSending(false);
    }
  };

  const submit = async () => {
    if (!profile) return;
    setError('');
    setLoading(true);
    try {
      await apiFetch<{ user: User; quota: Quota }>('/api/auth/sso/complete', {
        method: 'POST',
        body: {
          token,
          username,
          password,
          email,
          emailCode: emailCode || undefined,
          inviteCode: inviteCode.trim() || undefined,
        },
      });
      // 注册即登录：与密码登录同款收尾（写 auth store 后再跳转，避免被 RequireAuth 弹回登录页）
      const me = await apiFetch<{ user: User; quota: Quota }>('/api/auth/me');
      useAuth.getState().setAuth(me.data.user, me.data.quota);
      navigate('/files', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') setOtpError(true);
      if (err instanceof ApiError && err.code === 'SSO_PENDING_INVALID') setLoadError(t(ssoErrorKey(err.code)));
      setError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between px-4">
        <Link to="/login" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {t('common.login')}
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="flex justify-center">
              <Logo size={48} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} siteHeaderTitle={site.siteHeaderTitle} />
            </div>
            <h3 className="mt-4 text-balance text-center text-lg font-semibold text-foreground">
              {t('auth.ssoComplete.title')}
            </h3>
            <p className="mt-1 text-pretty text-center text-sm text-muted-foreground">
              {profile
                ? t('auth.ssoComplete.subtitle', { name: profile.providerName })
                : t('auth.ssoComplete.subtitleGeneric')}
            </p>
          </div>

          {loadError ? (
            <div className="space-y-4">
              <p className="text-sm text-destructive">{loadError}</p>
              <Link to="/login" className="block">
                <Button variant="outline" className="w-full py-2 font-medium">{t('common.login')}</Button>
              </Link>
            </div>
          ) : !profile ? (
            <p className="text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {(profile.email || profile.username) && (
                <Button type="button" variant="outline" className="w-full py-2 text-sm font-medium" onClick={applyProviderProfile}>
                  <Wand2 className="h-4 w-4" />
                  {t('auth.ssoComplete.useProviderInfo', { name: profile.providerName })}
                </Button>
              )}
              <div>
                <Label className="text-sm font-medium text-foreground">{t('login.username')}</Label>
                <Input className="mt-2" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
              </div>
              <div>
                <Label className="text-sm font-medium text-foreground">{t('login.email')}</Label>
                <Input type="email" className="mt-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              {/* 验证码行与注册页同构：OTP 分段输入 + 右侧发送按钮，总宽与上方文本框一致 */}
              {otpRowVisible(profile, email) && (
                <div>
                  <Label className="text-sm font-medium text-foreground">{t('auth.emailCode')}</Label>
                  <div className="mt-2 flex gap-2">
                    <InputOTP
                      value={emailCode}
                      onChange={(v) => {
                        setEmailCode(v);
                        setOtpError(false);
                      }}
                      className="min-w-0 flex-1"
                      error={otpError}
                    />
                    <Button type="button" variant="outline" className="shrink-0" onClick={sendOtp} loading={otpSending} disabled={countdown > 0}>
                      {countdown > 0 ? `${countdown}s` : t('auth.sendCode')}
                    </Button>
                  </div>
                </div>
              )}
              <div>
                <Label className="text-sm font-medium text-foreground">{t('login.password')}</Label>
                <Input className="mt-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              {profile.inviteEnabled && (
                <div>
                  <Label className="text-sm font-medium text-foreground">
                    {profile.inviteRequired ? t('auth.inviteCode') : t('auth.inviteCodeOptional')}
                  </Label>
                  <InputOTP
                    mode="alphanumeric"
                    length={6}
                    value={inviteCode}
                    onChange={setInviteCode}
                    className="mt-2"
                    ariaLabelKey="auth.inviteDigit"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('auth.inviteHint')}</p>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button className="mt-4 w-full py-2 font-medium" size="lg" type="submit" loading={loading}>
                {t('auth.ssoComplete.submit')}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
