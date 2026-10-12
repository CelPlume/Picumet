// 登录页 + 忘记密码（真实调用 /api/auth/forgot-password）
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button, Input, Label, Dialog } from '@/components/ui/core';
import { InputOTP } from '@/components/ui/input-otp';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { toast } from '@/components/ui/toast';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import { SsoButtons, ssoErrorKey } from '@/components/sso-buttons';
import type { User, Quota } from '@shared/types';

export default function Login() {
  const { t } = useTranslation();
  const site = useSite();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // 登录标识：用户名或邮箱同一输入框（后端 findByLoginIdentifier 收敛）
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSending, setResetSending] = useState(false);
  const [showTotpStep, setShowTotpStep] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const redirect = params.get('redirect') || '/files';
  // 已持有有效会话（JWT Cookie）：登录页直接跳转，无需重复输密码
  const authUser = useAuth((s) => s.user);
  const authLoading = useAuth((s) => s.loading);
  useEffect(() => {
    if (!authLoading && authUser) navigate(redirect, { replace: true });
  }, [authUser, authLoading, navigate, redirect]);

  useEffect(() => {
    if (params.get('registered') === '1') {
      toast('success', t('login.registered'));
    }
    // 迁移 0016：注册走了「待验证」分支 —— 账号尚未创建，必须先点邮件里的激活链接。
    // 用长驻 toast（不自动消失）+ 邮箱回显，避免用户直接去登录而困惑。
    if (params.get('checkEmail') === '1') {
      const emailed = params.get('email');
      // duration 用大而有限的值（setTimeout 对 Infinity 会立即触发）；
      // 10 分钟足够用户切去邮箱点链接，期间 toast 不被自动吞掉。
      toast('info', emailed ? t('login.checkEmail', { email: emailed }) : t('login.checkEmailNoAddr'), { duration: 10 * 60_000 });
    }
    if (params.get('resetDone') === '1') {
      toast('success', t('login.resetDone'));
    }
    // 第三方登录回跳的错误码（回调失败时后端 302 到本页并带 sso_error）
    const ssoError = params.get('sso_error');
    if (ssoError) setError(t(ssoErrorKey(ssoError)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      await apiFetch<unknown>('/api/auth/login', {
        method: 'POST',
        // 登录为未认证端点，取 CSRF 令牌必 401 —— 显式跳过，多余往返也是 2FA 第二步卡 loading 的诱因之一
        skipCsrf: true,
        body: {
          username: identifier.trim(),
          password,
          totpCode: showTotpStep ? totpCode.trim() : undefined,
        },
      });
      const me = await apiFetch<{ user: User; quota: Quota }>('/api/auth/me');
      useAuth.getState().setAuth(me.data.user, me.data.quota);
      navigate(redirect, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') {
        // 进入第二步：必须在此复位 loading，否则按钮永久转圈（第二步的 finally 不覆盖此分支）
        setLoading(false);
        setShowTotpStep(true);
        setError('');
        return;
      }
      setError(err instanceof ApiError ? err.message : t('err.network'));
      setLoading(false);
    }
  };

  const sendReset = async () => {
    if (!resetEmail) return;
    setResetSending(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: resetEmail },
      });
      toast('success', res.data?.message ?? t('login.emailSent').replace('{{email}}', resetEmail));
      setShowReset(false);
      setResetEmail('');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setResetSending(false);
    }
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
            <h3 className="mt-4 text-balance text-center text-lg font-semibold text-foreground">{t('login.title')}</h3>
            <p className="mt-1 text-pretty text-center text-sm text-muted-foreground">{t('login.subtitle')}</p>
          </div>

          {showTotpStep ? (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div className="space-y-1 text-center">
                <h4 className="text-base font-semibold text-foreground">{t('auth.totpTitle')}</h4>
                <p className="text-xs text-muted-foreground">{useBackupCode ? t('auth.backupCodeDesc') : t('auth.totpDesc')}</p>
              </div>

              {!useBackupCode ? (
                <div className="flex justify-center py-2">
                  <InputOTP
                    value={totpCode}
                    onChange={(v) => { setTotpCode(v); setError(''); }}
                    length={6}
                  />
                </div>
              ) : (
                <div>
                  <Label className="text-sm font-medium text-foreground">{t('auth.backupCode')}</Label>
                  <Input
                    className="mt-2 font-mono text-center tracking-wider"
                    value={totpCode}
                    onChange={(e) => { setTotpCode(e.target.value); setError(''); }}
                    placeholder="abcdef12"
                    autoFocus
                  />
                </div>
              )}

              {error && <p className="text-sm text-destructive text-center">{error}</p>}

              <Button
                className="mt-4 w-full py-2 font-medium"
                size="lg"
                type="submit"
                loading={loading}
                disabled={loading || (useBackupCode ? totpCode.trim().length < 8 : totpCode.trim().length < 6)}
              >
                {t('auth.verifyAndLogin')}
              </Button>

              <div className="flex items-center justify-between pt-2 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setUseBackupCode(!useBackupCode);
                    setTotpCode('');
                    setError('');
                  }}
                  className="text-primary hover:underline"
                >
                  {useBackupCode ? t('auth.useTotpCode') : t('auth.useBackupCode')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowTotpStep(false);
                    setTotpCode('');
                    setError('');
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t('auth.backToPassword')}
                </button>
              </div>
            </form>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div>
                <Label className="text-sm font-medium text-foreground">{t('login.identifier')}</Label>
                <Input
                  className="mt-2"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={t('login.identifierPlaceholder')}
                  autoComplete="username"
                  autoFocus
                />
              </div>
              <div>
                <Label className="text-sm font-medium text-foreground">{t('login.password')}</Label>
                <Input className="mt-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button className="mt-4 w-full py-2 font-medium" size="lg" type="submit" loading={loading}>
                {t('common.login')}
              </Button>
            </form>
          )}
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
            <div className="grid grid-cols-2 gap-2">
              <Link to="/register" className="block">
                <Button variant="outline" className="w-full py-2 font-medium">{t('login.registerNow')}</Button>
              </Link>
              <Link to="/free-mode" className="block">
                <Button variant="outline" className="w-full py-2 font-medium">{t('login.freeMode')}</Button>
              </Link>
              <Button variant="ghost" className="col-span-2 w-full py-2 text-sm text-muted-foreground" onClick={() => setShowReset(true)}>
                {t('login.resetPassword')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 忘记密码 */}
      <Dialog
        open={showReset}
        onClose={() => setShowReset(false)}
        title={t('login.resetPassword')}
        footer={<Button onClick={() => setShowReset(false)}>{t('common.close')}</Button>}
      >
        <div className="space-y-3">
          <Label>{t('login.email')}</Label>
          <Input
            type="email"
            value={resetEmail}
            onChange={(e) => setResetEmail(e.target.value)}
            placeholder="you@example.com"
            onKeyDown={(e) => e.key === 'Enter' && sendReset()}
          />
          <Button className="w-full" onClick={sendReset} loading={resetSending}>
            {t('login.sendReset')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
