// 管理员：挂载点配置
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderTree, Plus, Trash2, Pencil, Eye, FolderOpen } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog, ConfirmDialog, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';

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

export function StorageMounts() {
  const { t } = useTranslation();
  const [mounts, setMounts] = useState<MountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<string | null>('mountPath');
  const [order, setOrder] = useState<SortOrder>('asc');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<MountItem | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<MountItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MountItem | null>(null);

  const load = async () => {
    const [mRes, pRes] = await Promise.all([
      apiFetch<{ mounts: MountItem[] }>('/api/admin/mounts'),
      apiFetch<{ providers: Provider[] }>('/api/admin/storage/providers'),
    ]);
    setMounts(mRes.data.mounts);
    setProviders(pRes.data.providers);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = async () => {
    try {
      await apiFetch('/api/admin/mounts', { method: 'POST', body: { ...form, priority: Number(form.priority ?? 0) } });
      toast('success', t('admin.storageMounts.added'));
      setShowCreate(false);
      setForm({});
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.addFailed'));
    }
  };

  const del = async (m: MountItem) => {
    try {
      await apiFetch(`/api/admin/mounts/${m.id}`, { method: 'DELETE' });
      toast('success', t('admin.deleted'));
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.deleteFailed'));
    }
    setConfirmDelete(null);
  };

  const openEdit = (m: MountItem) => {
    setEditing(m);
    setEditForm({
      mountPath: m.mountPath,
      name: m.name,
      providerId: m.providerId,
      sortBy: m.sortBy,
      sortOrder: m.sortOrder,
      priority: String(m.priority),
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await apiFetch(`/api/admin/mounts/${editing.id}`, {
        method: 'PUT',
        body: { ...editForm, priority: Number(editForm.priority ?? 0) },
      });
      toast('success', t('admin.updated'));
      setEditing(null);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.updateFailed'));
    }
  };

  const sortedRows = useMemo(() => {
    if (!sort) return mounts;
    return sortByKey(mounts, sort as keyof MountItem, order);
  }, [mounts, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('admin.mounts')} · {t('admin.itemCount', { n: mounts.length })}</p>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" /> {t('admin.addMount')}</Button>
      </div>


      <Card className="mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2"><SortableHeader title={t('admin.mountPath')} sortKey="mountPath" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title={t('files.name')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('admin.provider')}</th>
              <th className="px-4 py-2"><SortableHeader title={t('admin.sortBy')} sortKey="sortBy" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title={t('admin.priority')} sortKey="priority" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><TableSkeleton rows={5} cols={4} /></td></tr>
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={6}><EmptyState icon={<FolderOpen className="h-7 w-7" />} title={t('admin.storageMounts.emptyTitle')} description={t('admin.storageMounts.emptyDesc')} /></td></tr>
            ) : sortedRows.map((m) => (
              <tr key={m.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2 font-mono text-primary"><code>{m.mountPath}</code></td>
                <td className="px-4 py-2">{m.name}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{m.providerName} · {m.providerType}</td>
                <td className="px-4 py-2"><Badge variant="secondary">{m.sortBy} {m.sortOrder}</Badge></td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{m.priority}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setDetail(m)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" title={t('common.details')}><Eye className="h-4 w-4" /></button>
                    <button onClick={() => openEdit(m)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" title={t('common.edit')}><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => setConfirmDelete(m)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10" title={t('common.delete')}><Trash2 className="h-4 w-4" /></button>
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
            <Label>{t('files.name')}</Label>
            <Input className="mt-1" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder={t('admin.storageMounts.namePlaceholder')} />
          </div>
          <div>
            <Label>{t('admin.nav.storage')}</Label>
            <Select
              value={form.providerId ?? ''}
              onValueChange={(v) => set('providerId', v)}
              placeholder={t('admin.selectStorage')}
              className="mt-1"
              options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }))}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>{t('admin.sortBy')}</Label>
              <Select
                value={form.sortBy ?? 'name'}
                onValueChange={(v) => set('sortBy', v)}
                className="mt-1"
                options={[
                  { value: 'name', label: t('files.name') },
                  { value: 'time', label: t('admin.time') },
                  { value: 'size', label: t('files.size') },
                  { value: 'manual', label: t('admin.manual') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.sortOrder')}</Label>
              <Select
                value={form.sortOrder ?? 'asc'}
                onValueChange={(v) => set('sortOrder', v)}
                className="mt-1"
                options={[
                  { value: 'asc', label: t('files.sortAsc') },
                  { value: 'desc', label: t('files.sortDesc') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.priority')}</Label>
              <Input type="number" className="mt-1" value={form.priority ?? '0'} onChange={(e) => set('priority', e.target.value)} />
            </div>
          </div>
        </div>
      </Dialog>

      {/* 挂载点详情 */}
      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title={t('admin.storageMounts.detailTitle', { path: detail?.mountPath ?? '' })}
        footer={
          <>
            <Button variant="outline" onClick={() => setDetail(null)}>{t('common.close')}</Button>
          </>
        }
      >
        {detail && (
          <div className="space-y-3">
            {[
              [t('admin.mountPath'), detail.mountPath],
              [t('files.name'), detail.name],
              [t('admin.provider'), `${detail.providerName} (${detail.providerType})`],
              [t('admin.sortBy'), `${detail.sortBy} · ${detail.sortOrder === 'asc' ? t('files.sortAsc') : t('files.sortDesc')}`],
              [t('admin.priority'), String(detail.priority)],
              [t('admin.status'), detail.status],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b pb-2 text-sm last:border-0">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      {/* 编辑挂载点 */}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t('admin.storageMounts.editTitle', { path: editing?.mountPath ?? '' })}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button onClick={saveEdit}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>{t('admin.mountPath')}</Label>
            <Input className="mt-1" value={editForm.mountPath ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, mountPath: e.target.value }))} />
          </div>
          <div>
            <Label>{t('files.name')}</Label>
            <Input className="mt-1" value={editForm.name ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <Label>{t('admin.nav.storage')}</Label>
            <Select
              value={editForm.providerId ?? ''}
              onValueChange={(v) => setEditForm((f) => ({ ...f, providerId: v }))}
              className="mt-1"
              options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }))}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>{t('admin.sortBy')}</Label>
              <Select
                value={editForm.sortBy ?? 'name'}
                onValueChange={(v) => setEditForm((f) => ({ ...f, sortBy: v }))}
                className="mt-1"
                options={[
                  { value: 'name', label: t('files.name') },
                  { value: 'time', label: t('admin.time') },
                  { value: 'size', label: t('files.size') },
                  { value: 'manual', label: t('admin.manual') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.sortOrder')}</Label>
              <Select
                value={editForm.sortOrder ?? 'asc'}
                onValueChange={(v) => setEditForm((f) => ({ ...f, sortOrder: v }))}
                className="mt-1"
                options={[
                  { value: 'asc', label: t('files.sortAsc') },
                  { value: 'desc', label: t('files.sortDesc') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.priority')}</Label>
              <Input type="number" className="mt-1" value={editForm.priority ?? '0'} onChange={(e) => setEditForm((f) => ({ ...f, priority: e.target.value }))} />
            </div>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void del(confirmDelete)}
        title={t('admin.storageMounts.deleteTitle')}
        message={t('admin.storageMounts.deleteConfirm', { path: confirmDelete?.mountPath ?? '' })}
      />
    </div>
  );
}
