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
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import type { User } from '@shared/types';

export default function Register() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  // 倒计时定时器登记：组件卸载时清除，避免泄漏的定时器串扰后续用例
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => clearInterval(countdownTimerRef.current ?? undefined), []);

  const sendOtp = async () => {
    if (!email) return setError('请输入邮箱');
    setOtpSending(true);
    try {
      await apiFetch('/api/auth/register/send-otp', { method: 'POST', body: { email } });
      setOtpSent(true);
      setCountdown(60);
      clearInterval(countdownTimerRef.current ?? undefined);
      countdownTimerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) clearInterval(countdownTimerRef.current ?? undefined);
          return c - 1;
        });
      }, 1000);
      toast('success', '验证码已发送');
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
        body: { username, password, email, emailCode: emailCode || undefined },
      });
      navigate(`/login?registered=1`);
      return res;
    } catch (err) {
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
            <div className="flex justify-center"><Logo size={44} /></div>
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
              <div className="mt-2 flex gap-2">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                <Button type="button" variant="outline" onClick={sendOtp} loading={otpSending} disabled={countdown > 0} className="shrink-0">
                  {countdown > 0 ? `${countdown}s` : '发送验证码'}
                </Button>
              </div>
            </div>
            {otpSent && (
              <div>
                <Label className="text-sm font-medium text-foreground">邮箱验证码</Label>
                <InputOTP value={emailCode} onChange={setEmailCode} className="mt-2" />
              </div>
            )}
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.password')}</Label>
              <Input className="mt-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>

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

          <Link to="/login" className="block">
            <Button variant="outline" className="w-full py-2 font-medium">{t('common.login')}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
