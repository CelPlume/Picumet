// 自由模式：输入对象存储凭据临时访问
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Cloud } from 'lucide-react';
import { Button, Input, Label, Badge } from '@/components/ui/core';
import { apiFetch, ApiError } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { toast } from '@/components/ui/toast';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';

type ProviderType = 'r2' | 's3' | 'oracle';

export default function FreeMode() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const site = useSite();
  const [type, setType] = useState<ProviderType>('r2');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [hours, setHours] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const providers: { id: ProviderType; label: string }[] = [
    { id: 'r2', label: 'Cloudflare R2' },
    { id: 's3', label: 'AWS S3' },
    { id: 'oracle', label: 'Oracle Cloud' },
  ];

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ expiresAt: number; sessionHours: number }>('/api/free-mode/init', {
        method: 'POST',
        body: { type, endpoint, region, bucket, accessKeyId, secretAccessKey, sessionHours: hours },
      });
      useAuth.getState().setFreeMode(true, res.data.expiresAt);
      toast('success', '自由模式已开启');
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
        <Logo size={24} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} />
      </header>

      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Cloud className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">自由模式</h1>
            <p className="mt-1 text-sm text-muted-foreground">使用你自己的对象存储凭据临时访问，凭据仅保存在服务端内存中。</p>
          </div>

          <div className="mb-4 grid grid-cols-3 gap-2">
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => setType(p.id)}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  type === p.id ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-accent'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div>
              <Label>Endpoint</Label>
              <Input className="mt-1" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://xxx.r2.cloudflarestorage.com" />
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
              <Label>会话时长</Label>
              <div className="mt-1 flex gap-2">
                {[1, 4, 8].map((h) => (
                  <button
                    key={h}
                    onClick={() => setHours(h)}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                      hours === h ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-accent'
                    }`}
                  >
                    {h} {h === 1 ? '小时' : '小时'}
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button className="w-full" onClick={submit} loading={loading}>
              连接并进入
            </Button>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="warning">安全提示</Badge>
              凭据不会保存到本地或数据库，会话过期后自动清除。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
