// 自由模式：输入对象存储凭据临时访问（报告 §5.1：单表单平铺 + 预设，无模式切换）
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Cloud } from 'lucide-react';
import { Button, Input, Label, Badge } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { apiFetch, ApiError } from '@/lib/api';
import { STORAGE_PRESETS, r2S3Endpoint } from '@/lib/storage-presets';
import { Logo } from '@/components/layout/Logo';
import { toast } from '@/components/ui/toast';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';

export default function FreeMode() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const site = useSite();
  const [presetId, setPresetId] = useState('r2');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('auto');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [hours, setHours] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const preset = STORAGE_PRESETS.find((p) => p.id === presetId) ?? STORAGE_PRESETS[STORAGE_PRESETS.length - 1];

  const pickPreset = (id: string) => {
    const p = STORAGE_PRESETS.find((x) => x.id === id);
    setPresetId(id);
    setEndpoint(p?.endpoint ?? '');
    setRegion(p?.region ?? '');
  };

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ expiresAt: number; sessionHours: number }>('/api/free-mode/init', {
        method: 'POST',
        body: { endpoint, region, bucket, accessKeyId, secretAccessKey, sessionHours: hours },
      });
      useAuth.getState().setFreeMode(true, res.data.expiresAt);
      toast('success', t('freeMode.enabled'));
      navigate('/files');
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
        <Logo size={40} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? "Picumet"} siteHeaderTitle={site.siteHeaderTitle} />
      </header>

      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Cloud className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">{t('login.freeMode')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('freeMode.description')}</p>
          </div>

          <div className="glass-surface glass-blur space-y-3 rounded-lg border p-4">
            <div>
              <Label>{t('freeMode.preset')}</Label>
              <Select className="mt-1" value={presetId} onValueChange={pickPreset}
                options={STORAGE_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />
            </div>

            {preset.needsAccountId && (
              <div>
                <Label>{t('freeMode.r2Shortcut')}</Label>
                <Input className="mt-1" value={endpoint.match(/^https:\/\/(.+)\.r2\.cloudflarestorage\.com$/)?.[1] ?? ''}
                  onChange={(e) => setEndpoint(e.target.value ? r2S3Endpoint(e.target.value) : '')}
                  placeholder={t('freeMode.r2Placeholder')} />
              </div>
            )}

            <div>
              <Label>Endpoint URL</Label>
              <Input className="mt-1" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={preset.endpointHint} />
              <p className="mt-1 text-xs text-muted-foreground">{preset.endpointHint}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Region</Label>
                <Input className="mt-1" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="auto" />
              </div>
              <div>
                <Label>Bucket</Label>
                <Input className="mt-1" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-bucket" />
              </div>
            </div>
            <div>
              <Label>Access Key ID</Label>
              <Input className="mt-1" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
            </div>
            <div>
              <Label>Secret Access Key</Label>
              <Input className="mt-1" type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
            </div>
            <div>
              <Label>{t('freeMode.sessionDuration')}</Label>
              <div className="mt-1 flex gap-2">
                {[1, 4, 8].map((h) => (
                  <button
                    key={h}
                    onClick={() => setHours(h)}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                      hours === h ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-accent'
                    }`}
                  >
                    {t('freeMode.hours', { count: h })}
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="w-full" onClick={submit} loading={loading}>
              {t('freeMode.connect')}
            </Button>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="warning">{t('freeMode.securityNote')}</Badge>
              {t('freeMode.securityDesc')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
