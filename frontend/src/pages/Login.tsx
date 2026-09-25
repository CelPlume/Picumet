// 登录页 + 忘记密码（真实调用 /api/auth/forgot-password）
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button, Input, Label, Dialog } from '@/components/ui/core';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { toast } from '@/components/ui/toast';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import type { User, Quota } from '@shared/types';

export default function Login() {
  const { t } = useTranslation();
  const site = useSite();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSending, setResetSending] = useState(false);

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
    if (params.get('resetDone') === '1') {
      toast('success', t('login.resetDone'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      await apiFetch<unknown>('/api/auth/login', { method: 'POST', body: { username, password } });
      const me = await apiFetch<{ user: User; quota: Quota }>('/api/auth/me');
      useAuth.getState().setAuth(me.data.user, me.data.quota);
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
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

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.username')}</Label>
              <Input className="mt-2" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
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

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-2 text-xs uppercase tracking-wider text-muted-foreground">{t('common.or')}</span>
            </div>
          </div>

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
