// 注册页（独立路由 /register）
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui/core';
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

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ user: User; message: string }>('/api/auth/register', {
        method: 'POST',
        body: { username, password, email },
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
          <div className="mb-6 flex justify-center">
            <Logo size={36} />
          </div>
          <h1 className="mb-6 text-center text-xl font-semibold">{t('common.register')}</h1>

          <div className="space-y-4">
            <div>
              <Label>{t('login.username')}</Label>
              <Input className="mt-1.5" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
            </div>
            <div>
              <Label>{t('login.email')}</Label>
              <Input className="mt-1.5" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div>
              <Label>{t('login.password')}</Label>
              <Input className="mt-1.5" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="w-full" size="lg" onClick={submit} loading={loading}>
              {t('common.register')}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              {t('login.hasAccount')}{' '}
              <Link to="/login" className="text-primary hover:underline">{t('common.login')}</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
