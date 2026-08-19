// 管理员：挂载点配置
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderTree, Plus, Trash2, Pencil, Eye } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
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

export function StorageMounts() {
  const { t } = useTranslation();
  const [mounts, setMounts] = useState<MountItem[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<MountItem | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<MountItem | null>(null);

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
      toast('success', '已更新');
      setEditing(null);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '更新失败');
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
            <button onClick={() => setDetail(m)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="详情">
              <Eye className="h-4 w-4" />
            </button>
            <button onClick={() => openEdit(m)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="编辑">
              <Pencil className="h-4 w-4" />
            </button>
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
            <Select
              value={form.providerId ?? ''}
              onValueChange={(v) => set('providerId', v)}
              placeholder="请选择存储..."
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
                  { value: 'name', label: '名称' },
                  { value: 'time', label: '时间' },
                  { value: 'size', label: '大小' },
                  { value: 'manual', label: '手动' },
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
                  { value: 'asc', label: '升序' },
                  { value: 'desc', label: '降序' },
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
        title={`挂载点详情 · ${detail?.mountPath ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setDetail(null)}>{t('common.close')}</Button>
          </>
        }
      >
        {detail && (
          <div className="space-y-3">
            {[
              ['挂载路径', detail.mountPath],
              ['名称', detail.name],
              ['存储提供商', `${detail.providerName} (${detail.providerType})`],
              ['排序方式', `${detail.sortBy} · ${detail.sortOrder === 'asc' ? '升序' : '降序'}`],
              ['优先级', String(detail.priority)],
              ['状态', detail.status],
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
        title={`编辑挂载点 · ${editing?.mountPath ?? ''}`}
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
            <Label>名称</Label>
            <Input className="mt-1" value={editForm.name ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <Label>{t('admin.storage')}</Label>
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
                  { value: 'name', label: '名称' },
                  { value: 'time', label: '时间' },
                  { value: 'size', label: '大小' },
                  { value: 'manual', label: '手动' },
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
                  { value: 'asc', label: '升序' },
                  { value: 'desc', label: '降序' },
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
    </div>
  );
}
