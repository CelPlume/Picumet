// 重置密码页（独立路由 /reset-password?token=xxx）
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui/core';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';

export default function ResetPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    if (password.length < 8) {
      setError(t('login.newPasswordShort', '密码至少 8 位'));
      return;
    }
    if (password !== confirm) {
      setError(t('login.passwordMismatch', '两次输入的密码不一致'));
      return;
    }
    setLoading(true);
    try {
      await apiFetch<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: { token, password },
      });
      navigate('/login?resetDone=1');
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
          <h1 className="mb-6 text-center text-xl font-semibold">{t('login.resetPassword')}</h1>

          <div className="space-y-4">
            <div>
              <Label>{t('login.newPassword')}</Label>
              <Input className="mt-1.5" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoFocus />
            </div>
            <div>
              <Label>{t('login.confirmPassword')}</Label>
              <Input className="mt-1.5" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="w-full" size="lg" onClick={submit} loading={loading}>
              {t('login.submitReset')}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              <Link to="/login" className="text-primary hover:underline">{t('common.login')}</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
