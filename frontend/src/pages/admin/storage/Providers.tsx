// 管理员：存储提供商配置
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, Plus, Trash2, PlugZap, Pencil } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog, ConfirmDialog, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { STORAGE_PRESETS, r2S3Endpoint } from '@/lib/storage-presets';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';

interface Provider {
  id: string;
  name: string;
  type: 'r2' | 's3';
  endpoint: string;
  region: string;
  bucket: string;
  publicDomain?: string;
  pathPrefix: string;
  status: string;
  createdAt: number;
  hasCredentials: boolean;
}

export function StorageProviders() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<string | null>('name');
  const [order, setOrder] = useState<SortOrder>('asc');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<Provider | null>(null);
  const [mountTouched, setMountTouched] = useState(false);

  const load = async () => {
    const res = await apiFetch<{ providers: Provider[] }>('/api/admin/storage/providers');
    setProviders(res.data.providers);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = async () => {
    try {
      await apiFetch('/api/admin/storage/providers', { method: 'POST', body: form });
        toast('success', t('admin.storageProviders.added'));
        setShowCreate(false);
        setForm({});
        setMountTouched(false);
        await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.addFailed'));
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
      toast('error', t('admin.storageProviders.testFailed'));
    } finally {
      setTesting(null);
    }
  };

  const del = async (p: Provider) => {
    try {
      await apiFetch(`/api/admin/storage/providers/${p.id}`, { method: 'DELETE' });
      toast('success', t('admin.deleted'));
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.deleteFailed'));
    }
    setConfirmDelete(null);
  };

  const openEdit = (p: Provider) => {
    setEditing(p);
    setEditForm({
      preset: 'custom',
      name: p.name,
      endpoint: p.endpoint === '__binding__' ? '' : p.endpoint,
      region: p.region,
      bucket: p.bucket,
      publicDomain: p.publicDomain ?? '',
      pathPrefix: p.pathPrefix,
      accessKeyId: '',
      secretAccessKey: '',
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await apiFetch(`/api/admin/storage/providers/${editing.id}`, { method: 'PUT', body: editForm });
      toast('success', t('admin.updated'));
      setEditing(null);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.updateFailed'));
    }
  };

  const typeLabel: Record<string, string> = { r2: t('admin.storageProviders.typeR2'), s3: t('admin.storageProviders.typeS3') };

  const sortedRows = useMemo(() => {
    if (!sort) return providers;
    return sortByKey(providers, sort as keyof Provider, order);
  }, [providers, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('admin.nav.storage')} · {t('admin.itemCount', { n: providers.length })}</p>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" /> {t('admin.addProvider')}</Button>
      </div>


      <Card className="mt-3 max-h-[calc(100vh-14rem)] overflow-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.providerName')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.providerType')} sortKey="type" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('admin.bucket')}</th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.region')} sortKey="region" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('admin.pathPrefix')}</th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.status')} sortKey="status" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><TableSkeleton rows={5} cols={5} /></td></tr>
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={7}><EmptyState icon={<HardDrive className="h-7 w-7" />} title={t('admin.storageProviders.emptyTitle')} description={t('admin.storageProviders.emptyDesc')} /></td></tr>
            ) : sortedRows.map((p) => (
              <tr key={p.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2 font-medium">{p.name}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{typeLabel[p.type]}</td>
                <td className="px-4 py-2 font-mono text-xs">{p.bucket}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{p.region || '-'}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{p.pathPrefix || '/'}</td>
                <td className="px-4 py-2"><Badge variant={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Badge></td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <button onClick={() => test(p)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" title={t('admin.testConnection')}><PlugZap className="h-4 w-4" /></button>
                    <button onClick={() => openEdit(p)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" title={t('common.edit')}><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => setConfirmDelete(p)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10" title={t('common.delete')}><Trash2 className="h-4 w-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

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
          {/* 预设：仅预填字段，非模式切换（所有字段始终平铺可见） */}
          <div>
            <Label>{t('admin.storageProviders.preset')}</Label>
            <Select
              value={form.preset ?? 'custom'}
              onValueChange={(v) => {
                const preset = STORAGE_PRESETS.find((p) => p.id === v);
                setForm((f) => ({
                  ...f,
                  preset: v,
                  endpoint: preset?.endpoint ?? '',
                  region: preset?.region ?? '',
                }));
              }}
              className="mt-1"
              options={STORAGE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.providerName')}</Label>
              <Input className="mt-1" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder={t('admin.storageProviders.namePlaceholder')} />
            </div>
            <div>
              <Label>{t('admin.bucket')}</Label>
              <Input className="mt-1" value={form.bucket ?? ''} onChange={(e) => {
                set('bucket', e.target.value);
                // 挂载路径默认 / + Bucket 名（未手动修改时跟随）
                if (!mountTouched) set('mountPath', e.target.value ? `/${e.target.value}` : '');
              }} placeholder="my-bucket" />
            </div>
          </div>
          <div>
            <Label>{t('admin.endpoint')}</Label>
            <Input className="mt-1" value={form.endpoint ?? ''} onChange={(e) => set('endpoint', e.target.value)}
              placeholder={STORAGE_PRESETS.find((p) => p.id === (form.preset ?? 'custom'))?.endpointHint ?? ''} />
            <p className="mt-1 text-xs text-muted-foreground">
              {STORAGE_PRESETS.find((p) => p.id === (form.preset ?? 'custom'))?.endpointHint}
              {' '}· {t('admin.storageProviders.endpointHint')}
            </p>
          </div>
          {form.preset === 'r2' && (
            <div>
              <Label>{t('admin.storageProviders.accountIdLabel')}</Label>
              <Input className="mt-1" value={form.accountId ?? ''} onChange={(e) => {
                set('accountId', e.target.value);
                set('endpoint', r2S3Endpoint(e.target.value));
              }} placeholder={t('admin.storageProviders.accountIdPlaceholder')} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.region')}</Label>
              <Input className="mt-1" value={form.region ?? ''} onChange={(e) => set('region', e.target.value)} placeholder="auto" />
            </div>
            <div>
              <Label>{t('admin.mountPath')}</Label>
              <Input className="mt-1" value={form.mountPath ?? ''} onChange={(e) => { setMountTouched(true); set('mountPath', e.target.value); }} placeholder="/my-bucket" />
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

      {/* 编辑存储提供商 */}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t('admin.storageProviders.editTitle', { name: editing?.name ?? '' })}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button onClick={saveEdit}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>{t('admin.providerName')}</Label>
            <Input className="mt-1" value={editForm.name ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <Label>{t('admin.endpoint')} <span className="text-muted-foreground">{t('admin.storageProviders.endpointResetHint')}</span></Label>
            <Input className="mt-1" value={editForm.endpoint ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, endpoint: e.target.value }))} placeholder={STORAGE_PRESETS.find((p) => p.id === (editForm.preset ?? 'custom'))?.endpointHint ?? ''} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.region')}</Label>
              <Input className="mt-1" value={editForm.region ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, region: e.target.value }))} />
            </div>
            <div>
              <Label>{t('admin.bucket')}</Label>
              <Input className="mt-1" value={editForm.bucket ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, bucket: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.accessKey')} <span className="text-muted-foreground">{t('admin.storageProviders.keepIfEmpty')}</span></Label>
              <Input className="mt-1" value={editForm.accessKeyId ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, accessKeyId: e.target.value }))} />
            </div>
            <div>
              <Label>{t('admin.secretKey')} <span className="text-muted-foreground">{t('admin.storageProviders.keepIfEmpty')}</span></Label>
              <Input className="mt-1" type="password" value={editForm.secretAccessKey ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, secretAccessKey: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.publicDomain')}</Label>
              <Input className="mt-1" value={editForm.publicDomain ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, publicDomain: e.target.value }))} />
            </div>
            <div>
              <Label>{t('admin.pathPrefix')}</Label>
              <Input className="mt-1" value={editForm.pathPrefix ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, pathPrefix: e.target.value }))} />
            </div>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void del(confirmDelete)}
        title={t('admin.storageProviders.deleteTitle')}
        message={t('admin.storageProviders.deleteConfirm', { name: confirmDelete?.name ?? '' })}
      />
    </div>
  );
}
