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
          <div className="mb-8 text-center">
            <div className="flex justify-center"><Logo size={44} /></div>
            <h3 className="mt-4 text-balance text-center text-lg font-semibold text-foreground">{t('login.resetPassword')}</h3>
            <p className="mt-1 text-pretty text-center text-sm text-muted-foreground">{t('login.subtitle')}</p>
          </div>

          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.newPassword')}</Label>
              <Input className="mt-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoFocus />
            </div>
            <div>
              <Label className="text-sm font-medium text-foreground">{t('login.confirmPassword')}</Label>
              <Input className="mt-2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="mt-4 w-full py-2 font-medium" size="lg" type="submit" loading={loading}>
              {t('login.submitReset')}
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
