// 登录 / 注册（Tab 切换）+ 忘记密码
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);

  const redirect = params.get('redirect') || '/files';

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      if (tab === 'login') {
        await apiFetch<unknown>('/api/auth/login', { method: 'POST', body: { username, password } });
        const me = await apiFetch<{ user: User; quota: Quota }>('/api/auth/me');
        useAuth.getState().setAuth(me.data.user, me.data.quota);
        navigate(redirect, { replace: true });
      } else {
        const res = await apiFetch<{ user: { email: string } }>('/api/auth/register', {
          method: 'POST',
          body: { username, password, email },
        });
        toast('success', res.message ?? '注册成功');
        setTab('login');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.network'));
    } finally {
      setLoading(false);
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

          <div className="mb-6 grid grid-cols-2 rounded-lg bg-muted p-1 text-sm font-medium">
            <button
              onClick={() => setTab('login')}
              className={`rounded-md py-2 transition-colors ${tab === 'login' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              {t('common.login')}
            </button>
            <button
              onClick={() => setTab('register')}
              className={`rounded-md py-2 transition-colors ${tab === 'register' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              {t('common.register')}
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <Label>{t('login.username')}</Label>
              <Input className="mt-1.5" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
            </div>
            {tab === 'register' && (
              <div>
                <Label>{t('login.email')}</Label>
                <Input className="mt-1.5" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
            )}
            <div>
              <Label>{t('login.password')}</Label>
              <Input className="mt-1.5" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </div>

            {tab === 'login' && (
              <div className="flex justify-end">
                <button className="text-xs text-primary hover:underline" onClick={() => setShowReset(true)}>
                  {t('login.forgot')}
                </button>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="w-full" size="lg" onClick={submit} loading={loading}>
              {tab === 'login' ? t('common.login') : t('common.register')}
            </Button>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <Link to="/free-mode" className="text-primary hover:underline">自由模式</Link>
            </div>
          </div>
        </div>
      </div>

      {/* 忘记密码 */}
      <Dialog
        open={showReset}
        onClose={() => setShowReset(false)}
        title={t('login.resetPassword')}
        footer={
          <Button onClick={() => setShowReset(false)}>{t('common.close')}</Button>
        }
      >
        <div className="space-y-3">
          <Label>{t('login.email')}</Label>
          <Input type="email" placeholder="you@example.com" />
          <Button
            className="w-full"
            onClick={async () => {
              toast('success', t('login.emailSent').replace('{{email}}', ''));
              setShowReset(false);
            }}
          >
            {t('login.sendReset')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
