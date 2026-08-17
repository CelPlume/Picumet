// 管理员：存储提供商配置
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, Plus, Trash2, PlugZap, Pencil } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';

interface Provider {
  id: string;
  name: string;
  type: 'r2' | 's3' | 'oracle';
  endpoint: string;
  region: string;
  bucket: string;
  publicDomain?: string;
  uploadDomain?: string;
  pathPrefix: string;
  status: string;
  createdAt: number;
  hasCredentials: boolean;
}

export default function AdminStorage() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const load = async () => {
    const res = await apiFetch<{ providers: Provider[] }>('/api/admin/storage/providers');
    setProviders(res.data.providers);
  };

  useEffect(() => {
    void load();
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = async () => {
    try {
      await apiFetch('/api/admin/storage/providers', { method: 'POST', body: form });
      toast('success', '已添加存储');
      setShowCreate(false);
      setForm({});
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '添加失败');
    }
  };

  const test = async (p: Provider) => {
    setTesting(p.id);
    try {
      const res = await apiFetch<{ connected: boolean; latency?: number; message: string }>(
        `/api/admin/storage/providers/${p.id}/test`,
        { method: 'POST' }
      );
      toast(res.data.connected ? 'success' : 'error', `${p.name}: ${res.data.message}${res.data.latency ? ` (${res.data.latency}ms)` : ''}`);
    } catch {
      toast('error', '测试失败');
    } finally {
      setTesting(null);
    }
  };

  const del = async (p: Provider) => {
    if (!confirm(`确定删除存储 ${p.name}？`)) return;
    try {
      await apiFetch(`/api/admin/storage/providers/${p.id}`, { method: 'DELETE' });
      toast('success', '已删除');
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '删除失败');
    }
  };

  const typeLabel: Record<string, string> = { r2: 'R2', s3: 'S3', oracle: 'Oracle' };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('admin.storage')} · {providers.length} 个</p>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" /> {t('admin.addProvider')}</Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {providers.map((p) => (
          <Card key={p.id} className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <HardDrive className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">{typeLabel[p.type]} · {p.bucket} · {p.endpoint || '(R2 绑定)'}</p>
              </div>
              <Badge variant={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Badge>
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('admin.region')}: {p.region || '-'}</span>
              <span>·</span>
              <span>prefix: {p.pathPrefix || '/'}</span>
              <div className="flex-1" />
              <button onClick={() => test(p)} className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent">
                <PlugZap className="h-3.5 w-3.5" /> {testing === p.id ? '...' : t('admin.testConnection')}
              </button>
              <button onClick={() => del(p)} className="rounded-md p-1 text-destructive hover:bg-destructive/10">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </Card>
        ))}
      </div>

      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t('admin.addProvider')}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={create}>{t('common.create')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.providerName')}</Label>
              <Input className="mt-1" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="主存储" />
            </div>
            <div>
              <Label>{t('admin.providerType')}</Label>
              <select value={form.type ?? 'r2'} onChange={(e) => set('type', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="r2">Cloudflare R2</option>
                <option value="s3">AWS S3</option>
                <option value="oracle">Oracle Cloud</option>
              </select>
            </div>
          </div>
          <div>
            <Label>{t('admin.endpoint')} <span className="text-muted-foreground">（R2 可留空使用本地绑定）</span></Label>
            <Input className="mt-1" value={form.endpoint ?? ''} onChange={(e) => set('endpoint', e.target.value)} placeholder="https://xxx.r2.cloudflarestorage.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.region')}</Label>
              <Input className="mt-1" value={form.region ?? ''} onChange={(e) => set('region', e.target.value)} placeholder="auto" />
            </div>
            <div>
              <Label>{t('admin.bucket')}</Label>
              <Input className="mt-1" value={form.bucket ?? ''} onChange={(e) => set('bucket', e.target.value)} placeholder="my-bucket" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.accessKey')}</Label>
              <Input className="mt-1" value={form.accessKeyId ?? ''} onChange={(e) => set('accessKeyId', e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.secretKey')}</Label>
              <Input className="mt-1" type="password" value={form.secretAccessKey ?? ''} onChange={(e) => set('secretAccessKey', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.publicDomain')}</Label>
              <Input className="mt-1" value={form.publicDomain ?? ''} onChange={(e) => set('publicDomain', e.target.value)} placeholder="https://cdn.example.com" />
            </div>
            <div>
              <Label>{t('admin.pathPrefix')}</Label>
              <Input className="mt-1" value={form.pathPrefix ?? ''} onChange={(e) => set('pathPrefix', e.target.value)} placeholder="/prod/" />
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
