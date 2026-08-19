// 个人资料设置
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Button, Badge, Progress } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { setLocale } from '@/lib/i18n';
import { formatBytes } from '@/lib/utils';
import type { Quota } from '@shared/types';

interface SettingsData {
  profile: {
    username: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
    avatarUrl?: string;
    defaultPath: string;
    locale: string;
    role: string;
  };
  appearance: { theme: string; accentColor: string; enableBlur: boolean };
  quota: Quota;
}

export default function ProfilePage() {
  const { t } = useTranslation();
  const [data, setData] = useState<SettingsData | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [locale, setLocaleState] = useState('zh-CN');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiFetch<SettingsData>('/api/users/me/settings').then((res) => {
      setData(res.data);
      setDisplayName(res.data.profile.displayName ?? '');
      setAvatarUrl(res.data.profile.avatarUrl ?? '');
      setLocaleState(res.data.profile.locale);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/users/me/settings', { method: 'PUT', body: { displayName, avatarUrl, locale } });
      setLocale(locale);
      toast('success', '已保存');
      await useAuth.getState().fetchMe();
    } catch {
      toast('error', '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div className="py-16 text-center text-muted-foreground">{t('common.loading')}</div>;

  const q = data.quota;

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.profile')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            {data.profile.avatarUrl ? (
              <img src={data.profile.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
                {(displayName || data.profile.username).slice(0, 1).toUpperCase()}
              </div>
            )}
            <div>
              <p className="font-medium">{displayName || data.profile.username}</p>
              <p className="text-sm text-muted-foreground">@{data.profile.username}</p>
              <Badge variant={data.profile.role === 'admin' ? 'default' : 'secondary'}>
                {data.profile.role === 'admin' ? t('admin.admin') : t('admin.user')}
              </Badge>
            </div>
          </div>

          <div>
            <Label>{t('settings.displayName')}</Label>
            <Input className="mt-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={data.profile.username} />
          </div>
          <div>
            <Label>{t('settings.avatarUrl')}</Label>
            <Input className="mt-1" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." />
          </div>
          <div>
            <Label>{t('settings.language')}</Label>
            <Select
              value={locale}
              onValueChange={setLocaleState}
              className="mt-1"
              options={[
                { value: 'zh-CN', label: '中文' },
                { value: 'en-US', label: 'English' },
              ]}
            />
          </div>
          <div>
            <Label>{t('settings.defaultPath')}</Label>
            <Input readOnly value={data.profile.defaultPath} className="mt-1 bg-muted/50 font-mono" />
          </div>
          <Button onClick={save} loading={saving}>{t('common.save')}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.storageUsed')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-muted-foreground">存储空间</span>
              <span>{formatBytes(q.usedStorage)} / {formatBytes(q.maxStorage)}</span>
            </div>
            <Progress value={q.storagePercent} />
          </div>
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-muted-foreground">文件数量</span>
              <span>{q.usedFiles} / {q.maxFiles}</span>
            </div>
            <Progress value={q.filesPercent} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
