// 第三方登录补充注册页（/sso/complete?token=…）
//
// OIDC / GitHub 鉴权成功后，若没有可关联的本地账号，就落到本页由用户**自填**本站资料
// （邮箱 / 用户名 / 密码 + 邮箱验证码），不复用提供方档案——提供方信息只用于一键预填
// （用户可选）。第三方身份与令牌在提交时落库（见 workers/src/services/sso/README.md）。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Link2, UserPlus, Wand2 } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui/core';
import { InputOTP } from '@/components/ui/input-otp';
import { CaptchaWidget } from '@/components/captcha';
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

  // ===== 关联已有账号分支 =====
  // pending 令牌来自第三方回调（该浏览器已通过提供方身份验证），站点侧还需要证明
  // 「这个浏览器属于该本地账号的主人」：密码 → （TOTP 或邮箱验证码）→ 绑定 + 登录。
  const [mode, setMode] = useState<'create' | 'link'>('create');
  const [linkStep, setLinkStep] = useState<'form' | 'totp' | 'email'>('form');
  const [identifier, setIdentifier] = useState('');
  const [linkPassword, setLinkPassword] = useState('');
  const [linkCode, setLinkCode] = useState('');
  const [linkEmailMasked, setLinkEmailMasked] = useState('');
  const [linkError, setLinkError] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkCaptchaToken, setLinkCaptchaToken] = useState('');
  const [linkCaptchaReset, setLinkCaptchaReset] = useState(0);
  const captcha = site.captcha;

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

  const applyAuth = (user: User, quota: Quota) => {
    useAuth.getState().setAuth(user, quota);
    navigate('/files', { replace: true });
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
      applyAuth(me.data.user, me.data.quota);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') setOtpError(true);
      if (err instanceof ApiError && err.code === 'SSO_PENDING_INVALID') setLoadError(t(ssoErrorKey(err.code)));
      setError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setLoading(false);
    }
  };

  // ===== 关联已有账号 =====
  const submitLink = async () => {
    if (!profile) return;
    setLinkError('');
    if (!identifier.trim()) return setLinkError(t('auth.ssoLink.identifierRequired'));
    if (!linkPassword) return setLinkError(t('auth.ssoLink.passwordRequired'));
    if (captcha?.enabled && captcha.login && !linkCaptchaToken) {
      return setLinkError(t('auth.captchaRequired'));
    }
    setLinkLoading(true);
    try {
      const res = await apiFetch<{ step: 'done' | 'totp' | 'email'; user?: User; quota?: Quota; emailMasked?: string }>(
        `/api/auth/sso/${profile.providerId}/link`,
        {
          method: 'POST',
          body: {
            token,
            identifier: identifier.trim(),
            password: linkPassword,
            turnstileToken: linkCaptchaToken || undefined,
          },
        }
      );
      if (res.data.step === 'done' && res.data.user && res.data.quota) {
        applyAuth(res.data.user, res.data.quota);
        return;
      }
      setLinkStep(res.data.step === 'email' ? 'email' : 'totp');
      setLinkEmailMasked(res.data.emailMasked ?? '');
      setLinkCaptchaToken('');
      setLinkCaptchaReset((n) => n + 1);
    } catch (err) {
      setLinkCaptchaToken('');
      setLinkCaptchaReset((n) => n + 1);
      if (err instanceof ApiError && err.code === 'SSO_PENDING_INVALID') setLoadError(t(ssoErrorKey(err.code)));
      setLinkError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setLinkLoading(false);
    }
  };

  const submitLinkVerify = async () => {
    setLinkError('');
    if (!linkCode.trim()) return setLinkError(t('auth.ssoLink.codeRequired'));
    setLinkLoading(true);
    try {
      const res = await apiFetch<{ step: 'done'; user: User; quota: Quota }>(
        `/api/auth/sso/${profile?.providerId ?? ''}/link-verify`,
        { method: 'POST', body: { token, code: linkCode.trim() } }
      );
      applyAuth(res.data.user, res.data.quota);
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setLinkLoading(false);
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
            <div className="space-y-4">
              {/* 分支选择：关联已有账号 / 创建新账号（第三方身份已验证，站点侧二选一收尾） */}
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('auth.ssoLink.modeGroup')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'link'}
                  onClick={() => {
                    setMode('link');
                    setError('');
                  }}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    mode === 'link' ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <Link2 className={`h-4 w-4 ${mode === 'link' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <p className="mt-1.5 text-sm font-medium">{t('auth.ssoLink.modeLink')}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('auth.ssoLink.modeLinkDesc')}</p>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'create'}
                  onClick={() => {
                    setMode('create');
                    setLinkError('');
                  }}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    mode === 'create' ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <UserPlus className={`h-4 w-4 ${mode === 'create' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <p className="mt-1.5 text-sm font-medium">{t('auth.ssoLink.modeCreate')}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('auth.ssoLink.modeCreateDesc')}</p>
                </button>
              </div>

              {mode === 'create' ? (
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
              ) : linkStep === 'form' ? (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitLink();
                  }}
                >
                  <div>
                    <Label className="text-sm font-medium text-foreground">{t('auth.ssoLink.identifierLabel')}</Label>
                    <Input
                      className="mt-2"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder={t('auth.ssoLink.identifierPlaceholder')}
                      autoComplete="username"
                      autoFocus
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-foreground">{t('login.password')}</Label>
                    <Input
                      className="mt-2"
                      type="password"
                      value={linkPassword}
                      onChange={(e) => setLinkPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                    />
                  </div>
                  {captcha?.enabled && captcha.login && captcha.siteKey && (
                    <CaptchaWidget
                      provider={captcha.provider}
                      siteKey={captcha.siteKey}
                      action="login"
                      onToken={setLinkCaptchaToken}
                      resetSignal={linkCaptchaReset}
                    />
                  )}
                  {linkError && <p className="text-sm text-destructive">{linkError}</p>}
                  <Button className="mt-4 w-full py-2 font-medium" size="lg" type="submit" loading={linkLoading}>
                    {t('auth.ssoLink.verifyIdentity')}
                  </Button>
                </form>
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitLinkVerify();
                  }}
                >
                  <p className="text-sm text-muted-foreground">
                    {linkStep === 'totp'
                      ? t('auth.ssoLink.totpHint')
                      : t('auth.ssoLink.emailHint', { email: linkEmailMasked })}
                  </p>
                  <div>
                    <Label className="text-sm font-medium text-foreground">
                      {linkStep === 'totp' ? t('auth.ssoLink.totpLabel') : t('auth.emailCode')}
                    </Label>
                    <Input
                      className="mt-2"
                      value={linkCode}
                      onChange={(e) => setLinkCode(e.target.value)}
                      placeholder={linkStep === 'totp' ? '123456 / 8 位备用码' : '123456'}
                      inputMode={linkStep === 'totp' ? 'text' : 'numeric'}
                      autoComplete="one-time-code"
                      autoFocus
                    />
                  </div>
                  {linkError && <p className="text-sm text-destructive">{linkError}</p>}
                  <Button className="mt-4 w-full py-2 font-medium" size="lg" type="submit" loading={linkLoading}>
                    {t('auth.ssoLink.verifyAndLink')}
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
