// 管理员：挂载点管理
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderTree, Plus, Trash2, Pencil } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';

interface MountItem {
  id: string;
  mountPath: string;
  name: string;
  providerId: string;
  providerName: string;
  providerType: string;
  sortBy: string;
  sortOrder: string;
  priority: number;
  status: string;
}

interface Provider {
  id: string;
  name: string;
  type: string;
}

export default function AdminMounts() {
  const { t } = useTranslation();
  const [mounts, setMounts] = useState<MountItem[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const load = async () => {
    const [mRes, pRes] = await Promise.all([
      apiFetch<{ mounts: MountItem[] }>('/api/admin/mounts'),
      apiFetch<{ providers: Provider[] }>('/api/admin/storage/providers'),
    ]);
    setMounts(mRes.data.mounts);
    setProviders(pRes.data.providers);
  };

  useEffect(() => {
    void load();
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = async () => {
    try {
      await apiFetch('/api/admin/mounts', { method: 'POST', body: { ...form, priority: Number(form.priority ?? 0) } });
      toast('success', '已添加挂载点');
      setShowCreate(false);
      setForm({});
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '添加失败');
    }
  };

  const del = async (m: MountItem) => {
    if (!confirm(`确定删除挂载点 ${m.mountPath}？`)) return;
    try {
      await apiFetch(`/api/admin/mounts/${m.id}`, { method: 'DELETE' });
      toast('success', '已删除');
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '删除失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('admin.mounts')} · {mounts.length} 个</p>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" /> {t('admin.addMount')}</Button>
      </div>

      <div className="space-y-2">
        {mounts.map((m) => (
          <Card key={m.id} className="flex items-center gap-3 p-3">
            <FolderTree className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                <code className="text-primary">{m.mountPath}</code>
                <span className="ml-2 text-muted-foreground">{m.name}</span>
              </p>
              <p className="text-xs text-muted-foreground">{m.providerName} · {m.providerType} · priority {m.priority}</p>
            </div>
            <Badge variant="secondary">{m.sortBy} {m.sortOrder}</Badge>
            <button onClick={() => del(m)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
              <Trash2 className="h-4 w-4" />
            </button>
          </Card>
        ))}
      </div>

      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t('admin.addMount')}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={create}>{t('common.create')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>{t('admin.mountPath')}</Label>
            <Input className="mt-1" value={form.mountPath ?? ''} onChange={(e) => set('mountPath', e.target.value)} placeholder="/images" />
          </div>
          <div>
            <Label>名称</Label>
            <Input className="mt-1" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="图片库" />
          </div>
          <div>
            <Label>{t('admin.storage')}</Label>
            <select value={form.providerId ?? ''} onChange={(e) => set('providerId', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">请选择存储...</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>{t('admin.sortBy')}</Label>
              <select value={form.sortBy ?? 'name'} onChange={(e) => set('sortBy', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="name">名称</option>
                <option value="time">时间</option>
                <option value="size">大小</option>
                <option value="manual">手动</option>
              </select>
            </div>
            <div>
              <Label>{t('admin.sortOrder')}</Label>
              <select value={form.sortOrder ?? 'asc'} onChange={(e) => set('sortOrder', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="asc">升序</option>
                <option value="desc">降序</option>
              </select>
            </div>
            <div>
              <Label>{t('admin.priority')}</Label>
              <Input type="number" className="mt-1" value={form.priority ?? '0'} onChange={(e) => set('priority', e.target.value)} />
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
