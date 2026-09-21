// 安全设置：修改密码 + 邮箱管理
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Button, Badge } from '@/components/ui/core';
import { InputOTP } from '@/components/ui/input-otp';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';

interface ProfileData {
  email: string;
  emailVerified: boolean;
}

export default function SecurityPage() {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [otpSending, setOtpSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    void apiFetch<{ user: ProfileData }>('/api/users/me')
      .then((res) => {
        setEmail(res.data.user.email);
        setEmailVerified(res.data.user.emailVerified);
      })
      .catch(() => undefined);
  }, []);

  // 验证码发送倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const change = async () => {
    if (newPassword !== confirm) return toast('error', t('settings.passwordMismatch'));
    if (newPassword.length < 8) return toast('error', t('login.newPasswordShort'));
    setSaving(true);
    try {
      await apiFetch('/api/users/me/password', { method: 'PUT', body: { oldPassword, newPassword } });
      toast('success', t('settings.passwordChanged'));
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.security.changeFailed'));
    } finally {
      setSaving(false);
    }
  };

  const sendOtp = async () => {
    if (!newEmail) return toast('error', t('settings.security.newEmailRequired'));
    setOtpSending(true);
    try {
      await apiFetch('/api/users/me/email/send-otp', { method: 'POST', body: { email: newEmail } });
      toast('success', t('settings.security.otpSent'));
      setOtpSent(true);
      setCountdown(60);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.security.sendFailed'));
    } finally {
      setOtpSending(false);
    }
  };

  const verifyOtp = async () => {
    if (!verificationCode) return toast('error', t('settings.security.codeRequired'));
    setVerifying(true);
    try {
      await apiFetch('/api/users/me/email/verify-otp', { method: 'POST', body: { email: newEmail, code: verificationCode } });
      setEmail(newEmail);
      setEmailVerified(true);
      setNewEmail('');
      setVerificationCode('');
      setOtpSent(false);
      setCountdown(0);
      toast('success', t('settings.security.emailVerified'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.security.verifyFailed'));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      {/* 邮箱管理 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> {t('settings.security.emailManagement')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('settings.security.currentEmail')}</Label>
            <div className="mt-1 flex items-center gap-2">
              <Input readOnly value={email || t('settings.security.notSet')} className="flex-1 bg-muted/50" />
              {emailVerified ? (
                <Badge variant="success">{t('settings.verified')}</Badge>
              ) : (
                <Badge variant="warning">{t('settings.notVerified')}</Badge>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t('settings.security.emailHint')}
            </p>
          </div>
          <div>
            <Label>{t('settings.security.changeEmail')}</Label>
            <div className="mt-1 flex gap-2">
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="new@example.com"
                className="flex-1"
                disabled={otpSent}
              />
              <Button onClick={sendOtp} loading={otpSending} variant="outline" disabled={countdown > 0}>
                {countdown > 0 ? `${countdown}s` : t('settings.security.sendOtp')}
              </Button>
            </div>
            {otpSent && (
              <div className="mt-2 flex flex-col gap-2">
                <InputOTP value={verificationCode} onChange={setVerificationCode} />
                <Button onClick={verifyOtp} loading={verifying} variant="outline">
                  {t('settings.security.verifyEmail')}
                </Button>
              </div>
            )}
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t('settings.security.otpHint')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 修改密码 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t('settings.changePassword')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('settings.currentPassword')}</Label>
            <Input type="password" className="mt-1" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
          </div>
          <div>
            <Label>{t('settings.newPassword')}</Label>
            <Input type="password" className="mt-1" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <div>
            <Label>{t('settings.confirmPassword')}</Label>
            <Input type="password" className="mt-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <Button onClick={change} loading={saving}>{t('settings.changePassword')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
