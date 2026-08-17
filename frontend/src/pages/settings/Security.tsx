// 安全设置：修改密码
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Button } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';

export default function SecurityPage() {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const change = async () => {
    if (newPassword !== confirm) return toast('error', t('settings.passwordMismatch'));
    if (newPassword.length < 8) return toast('error', '密码至少 8 位');
    setSaving(true);
    try {
      await apiFetch('/api/users/me/password', { method: 'PUT', body: { oldPassword, newPassword } });
      toast('success', t('settings.passwordChanged'));
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '修改失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.changePassword')}</CardTitle>
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
