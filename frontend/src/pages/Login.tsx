// 登录页 + 忘记密码（真实调用 /api/auth/forgot-password）
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button, Input, Label, Dialog } from '@/components/ui/core';
import { useAuth } from '@/stores/auth';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { toast } from '@/components/ui/toast';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import type { User, Quota } from '@shared/types';

export default function Login() {
  const { t } = useTranslation();
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
          <div className="mb-6 flex justify-center">
            <Logo size={36} />
          </div>
          <h1 className="mb-6 text-center text-xl font-semibold">{t('common.login')}</h1>

          <div className="space-y-4">
            <div>
              <Label>{t('login.username')}</Label>
              <Input className="mt-1.5" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
            </div>
            <div>
              <Label>{t('login.password')}</Label>
              <Input className="mt-1.5" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </div>

            <div className="flex justify-end">
              <button className="text-xs text-primary hover:underline" onClick={() => setShowReset(true)}>
                {t('login.forgot')}
              </button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="w-full" size="lg" onClick={submit} loading={loading}>
              {t('common.login')}
            </Button>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <Link to="/register" className="text-primary hover:underline">{t('login.registerNow')}</Link>
              <Link to="/free-mode" className="text-primary hover:underline">{t('login.freeMode')}</Link>
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
