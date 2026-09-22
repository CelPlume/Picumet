// 管理员：挂载点配置
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderTree, Plus, Trash2, Pencil, Eye, FolderOpen } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog, ConfirmDialog, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';

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
  maxStorage: number | null;
  usedStorage: number;
  quotaReserved: number;
  poolStrategy: string;
  poolMembers: Array<{ providerId: string; weight: number; name: string }>;
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
  const [poolIds, setPoolIds] = useState<string[]>([]);
  const [editPoolIds, setEditPoolIds] = useState<string[]>([]);
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
      await apiFetch('/api/admin/mounts', {
        method: 'POST',
        body: {
          ...form,
          priority: Number(form.priority ?? 0),
          maxStorage: form.maxStorageGb ? Math.round(Number(form.maxStorageGb) * 1024 ** 3) : null,
          poolStrategy: form.poolStrategy ?? 'least_used',
          poolProviderIds: poolIds,
        },
      });
      toast('success', t('admin.storageMounts.added'));
      setShowCreate(false);
      setForm({});
      setPoolIds([]);
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
      maxStorageGb: m.maxStorage == null ? '' : String(Math.round((m.maxStorage / 1024 ** 3) * 100) / 100),
      poolStrategy: m.poolStrategy,
    });
    setEditPoolIds(m.poolMembers.map((p) => p.providerId));
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await apiFetch(`/api/admin/mounts/${editing.id}`, {
        method: 'PUT',
        body: {
          ...editForm,
          priority: Number(editForm.priority ?? 0),
          maxStorage: editForm.maxStorageGb ? Math.round(Number(editForm.maxStorageGb) * 1024 ** 3) : null,
          poolStrategy: editForm.poolStrategy ?? 'least_used',
          poolProviderIds: editPoolIds,
        },
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


      <Card className="mt-3 min-h-0 flex-1 scrollbar-thin overflow-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.mountPath')} sortKey="mountPath" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('files.name')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('admin.provider')}</th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.sortBy')} sortKey="sortBy" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.priority')} sortKey="priority" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('admin.storageMounts.capacity')}</th>
              <th className={'px-4 py-2'}>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><TableSkeleton rows={5} cols={4} /></td></tr>
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={7}><EmptyState icon={<FolderOpen className="h-7 w-7" />} title={t('admin.storageMounts.emptyTitle')} description={t('admin.storageMounts.emptyDesc')} /></td></tr>
            ) : sortedRows.map((m) => (
              <tr key={m.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-2 font-mono text-primary"><code>{m.mountPath}</code></td>
                <td className="px-4 py-2">{m.name}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {m.providerName} · {m.providerType}
                  {m.poolMembers.length > 1 && (
                    <span className="ml-1 text-primary">+{m.poolMembers.length - 1} <span className="text-muted-foreground">({m.poolStrategy})</span></span>
                  )}
                </td>
                <td className="px-4 py-2"><Badge variant="secondary">{m.sortBy} {m.sortOrder}</Badge></td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{m.priority}</td>
                <td className="px-4 py-2">
                  <div className="min-w-28">
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {formatBytes(m.usedStorage + m.quotaReserved)} / {m.maxStorage == null ? t('admin.storageMounts.unlimited') : formatBytes(m.maxStorage)}
                    </div>
                    {m.maxStorage != null && (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-accent">
                        <div
                          className={`h-full ${m.usedStorage + m.quotaReserved >= m.maxStorage ? 'bg-destructive' : 'bg-primary'}`}
                          style={{ width: `${Math.min(100, Math.round(((m.usedStorage + m.quotaReserved) / m.maxStorage) * 100))}%` }}
                        />
                      </div>
                    )}
                  </div>
                </td>
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
          <div>
            <Label>{t('admin.storageMounts.capacity')}</Label>
            <Input
              type="number"
              className="mt-1"
              value={form.maxStorageGb ?? ''}
              onChange={(e) => set('maxStorageGb', e.target.value)}
              placeholder={t('admin.storageMounts.capacityPlaceholder')}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.capacityHint')}</p>
          </div>
          <div>
            <Label>{t('admin.storageMounts.poolStrategy')}</Label>
            <Select
              value={form.poolStrategy ?? 'least_used'}
              onValueChange={(v) => setForm((f) => ({ ...f, poolStrategy: v }))}
              className="mt-1"
              options={[
                { value: 'least_used', label: t('admin.storageMounts.strategyLeastUsed') },
                { value: 'round_robin', label: t('admin.storageMounts.strategyRoundRobin') },
                { value: 'hash', label: t('admin.storageMounts.strategyHash') },
              ]}
            />
          </div>
          <div>
            <Label>{t('admin.storageMounts.poolMembers')}</Label>
            <div className="mt-1 space-y-1.5">
              {providers.map((p) => {
                const primary = form.providerId === p.id;
                const selected = poolIds.includes(p.id);
                return (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={primary || selected}
                      disabled={primary}
                      onChange={(e) => setPoolIds((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)))}
                    />
                    <span className="truncate">{p.name} ({p.type})</span>
                    {primary && <span className="text-xs text-muted-foreground">{t('admin.storageMounts.poolPrimary')}</span>}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.poolHint')}</p>
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
              [
                t('admin.storageMounts.poolMembers'),
                detail.poolMembers.length > 0
                  ? `${detail.poolMembers.map((p) => p.name).join(' · ')}（${detail.poolStrategy}）`
                  : t('admin.storageMounts.unlimited'),
              ],
              [
                t('admin.storageMounts.capacity'),
                detail.maxStorage == null
                  ? t('admin.storageMounts.unlimited')
                  : `${formatBytes(detail.usedStorage + detail.quotaReserved)} / ${formatBytes(detail.maxStorage)}`,
              ],
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
          <div>
            <Label>{t('admin.storageMounts.capacity')}</Label>
            <Input
              type="number"
              className="mt-1"
              value={editForm.maxStorageGb ?? ''}
              onChange={(e) => setEditForm((f) => ({ ...f, maxStorageGb: e.target.value }))}
              placeholder={t('admin.storageMounts.capacityPlaceholder')}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.capacityHint')}</p>
          </div>
          <div>
            <Label>{t('admin.storageMounts.poolStrategy')}</Label>
            <Select
              value={editForm.poolStrategy ?? 'least_used'}
              onValueChange={(v) => setEditForm((f) => ({ ...f, poolStrategy: v }))}
              className="mt-1"
              options={[
                { value: 'least_used', label: t('admin.storageMounts.strategyLeastUsed') },
                { value: 'round_robin', label: t('admin.storageMounts.strategyRoundRobin') },
                { value: 'hash', label: t('admin.storageMounts.strategyHash') },
              ]}
            />
          </div>
          <div>
            <Label>{t('admin.storageMounts.poolMembers')}</Label>
            <div className="mt-1 space-y-1.5">
              {providers.map((p) => {
                const primary = editForm.providerId === p.id;
                const selected = editPoolIds.includes(p.id);
                return (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={primary || selected}
                      disabled={primary}
                      onChange={(e) => setEditPoolIds((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)))}
                    />
                    <span className="truncate">{p.name} ({p.type})</span>
                    {primary && <span className="text-xs text-muted-foreground">{t('admin.storageMounts.poolPrimary')}</span>}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.poolHint')}</p>
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
