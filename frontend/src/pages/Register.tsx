// 注册页（独立路由 /register）
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui/core';
import { InputOTP } from '@/components/ui/input-otp';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { useSite } from '@/stores/site';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import { SsoButtons } from '@/components/sso-buttons';
import type { User } from '@shared/types';

export default function Register() {
  const { t } = useTranslation();
  const site = useSite();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  // OTP 错误态：提交被后端判 INVALID_OTP 时整行抖动（参考 interior/moumen 的 error recovery）
  const [otpError, setOtpError] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  // 倒计时定时器登记：组件卸载时清除，避免泄漏的定时器串扰后续用例
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => clearInterval(countdownTimerRef.current ?? undefined), []);

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
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ user: User; message: string }>('/api/auth/register', {
        method: 'POST',
        body: { username, password, email, emailCode: emailCode || undefined, inviteCode: inviteCode.trim() || undefined },
      });
      navigate(`/login?registered=1`);
      return res;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') setOtpError(true);
      setError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setLoading(false);
    }
    return undefined;
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {t('common.back')}
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
            <h3 className="mt-4 text-balance text-center text-lg font-semibold text-foreground">{t('login.registerTitle')}</h3>
            <p className="mt-1 text-pretty text-center text-sm text-muted-foreground">{t('login.registerSub')}</p>
          </div>

          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.username')}</Label>
              <Input className="mt-2" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
            </div>
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.email')}</Label>
              <Input type="email" className="mt-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            {/* 验证码 + 发送按钮：OTP 分段输入 + 右侧发送验证码按钮，行宽与上方文本框一致（预留输入位） */}
            <div>
              <Label className="text-sm font-medium text-foreground">{t('auth.emailCode')}</Label>
              <div className="mt-2 flex gap-2">
                <InputOTP
                  value={emailCode}
                  onChange={(v) => { setEmailCode(v); setOtpError(false); }}
                  className="min-w-0 flex-1"
                  error={otpError}
                />
                <Button type="button" variant="outline" className="shrink-0" onClick={sendOtp} loading={otpSending} disabled={countdown > 0}>
                  {countdown > 0 ? `${countdown}s` : t('auth.sendCode')}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.password')}</Label>
              <Input className="mt-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            {/* 邀请码（系统设置「注册设置」开启时展示；必填语义随 invite_required）：
                码值仅 [0-9A-Z]{6}，分段输入组件内过滤并转大写，服务端仍按区分大小写精确匹配 */}
            {site.inviteEnabled && (
              <div>
                <Label className="text-sm font-medium text-foreground">
                  {site.inviteRequired ? t('auth.inviteCode') : t('auth.inviteCodeOptional')}
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
              {t('common.register')}
            </Button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-2 text-xs uppercase tracking-wider text-muted-foreground">{t('common.or')}</span>
            </div>
          </div>

          <div className="space-y-3">
            <SsoButtons />
            <Link to="/login" className="block">
              <Button variant="outline" className="w-full py-2 font-medium">{t('common.login')}</Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
