// 管理员：权限规则管理
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Plus, Trash2 } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog, Switch, ConfirmDialog, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch, ApiError } from '@/lib/api';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';
import { revealDelay, innerDelay } from '@/components/ui/reveal';

interface Rule {
  id: string;
  mountId?: string;
  mountName?: string;
  pathPattern: string;
  effect: 'allow' | 'deny';
  role?: string;
  userId?: string;
  apiKeyId?: string;
  permissions: string[];
  requirePassword: boolean;
  allowedIps?: string[];
  priority: number;
  origin?: 'admin' | 'user' | 'system';
  createdBy?: string;
  status: string;
}

interface MountItem {
  id: string;
  mountPath: string;
  name: string;
}

const ALL_PERMS = ['read', 'write', 'update', 'delete', 'share', 'download'];

export default function AdminPermissions() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<string | null>(null);
  const [order, setOrder] = useState<SortOrder>('asc');
  const [mounts, setMounts] = useState<MountItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Rule | null>(null);
  const [editMode, setEditMode] = useState<'gui' | 'code'>('gui');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean | string[]>>({
    pathPattern: '/public/**',
    effect: 'allow',
    subject: 'role',
    role: 'guest',
    priority: '0',
    mountId: '',
  });

  const load = async () => {
    setLoading(true);
    const [rRes, mRes] = await Promise.all([
      apiFetch<{ rules: Rule[]; pagination: { total: number } }>(`/api/admin/rules?page=${page}&limit=${pageSize}`),
      apiFetch<{ mounts: MountItem[] }>('/api/admin/mounts'),
    ]);
    const mountById = new Map(mRes.data.mounts.map((m) => [m.id, m]));
    setRules(rRes.data.rules.map((r) => ({ ...r, mountName: r.mountId ? mountById.get(r.mountId)?.name : undefined })));
    setTotal(rRes.data.pagination.total);
    setMounts(mRes.data.mounts);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const togglePerm = (p: string) => {
    const perms = (form.permissions as string[]) ?? [];
    setForm((f) => ({
      ...f,
      permissions: perms.includes(p) ? perms.filter((x) => x !== p) : [...perms, p],
    }));
  };

  const create = async () => {
    const subject = form.subject as string;
    const body: Record<string, unknown> = {
      pathPattern: form.pathPattern,
      effect: form.effect,
      permissions: (form.permissions as string[]) ?? [],
      requirePassword: Boolean(form.requirePassword),
      priority: Number(form.priority ?? 0),
    };
    if (form.mountId) body.mountId = form.mountId;
    if (subject === 'role') body.role = form.role;
    if (subject === 'user') body.userId = form.userId;
    if (subject === 'guest') body.role = 'guest';
    if (form.password) body.password = form.password;
    try {
      await apiFetch('/api/admin/rules', { method: 'POST', body });
      toast('success', t('admin.permissions.created'));
      setShowCreate(false);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.permissions.createFailed'));
    }
  };

  const del = async (id: string) => {
    try {
      await apiFetch(`/api/admin/rules/${id}`, { method: 'DELETE' });
      toast('success', t('admin.permissions.deleted'));
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('admin.permissions.deleteFailed'));
    }
    setConfirmDelete(null);
  };

  const subjectLabel = (r: Rule) =>
    r.userId ? t('admin.permissions.targetUser', { id: r.userId.slice(0, 8) }) : r.apiKeyId ? t('admin.permissions.targetApiKey', { id: r.apiKeyId.slice(0, 8) }) : t('admin.permissions.targetRole', { role: r.role ?? '-' });
  const sortedRows = useMemo(() => {
    if (!sort) return rules;
    return sortByKey(rules, sort as keyof Rule, order);
  }, [rules, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="reveal shrink-0 flex items-center justify-between" style={revealDelay(0)}>
        <p className="text-sm text-muted-foreground">{t('admin.nav.permissions')} · {t('admin.permissions.ruleCount', { n: total })}</p>
        <Button onClick={() => { setShowCreate(true); setEditMode('gui'); setJsonError(null); setJsonText(''); }}><Plus className="h-4 w-4" /> {t('admin.addRule')}</Button>
      </div>


      <Card className="reveal mt-3 min-h-0 flex-1 scrollbar-thin overflow-auto py-0" style={revealDelay(1)}>
        <table className="w-full text-sm">
          <thead>
            <tr className="reveal-row whitespace-nowrap border-b text-left text-muted-foreground" style={innerDelay(1, 0)}>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.permissions.path')} sortKey="pathPattern" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('admin.permissions.subject')}</th>
              <th className={'px-4 py-2'}>{t('admin.permissions.source')}</th>
              <th className={'px-4 py-2'}>{t('settings.permissions')}</th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.permissions.priority')} sortKey="priority" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}><SortableHeader title={t('admin.permissions.effect')} sortKey="effect" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2'}>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><TableSkeleton rows={5} cols={4} /></td></tr>
            ) : rules.length === 0 ? (
              <tr><td colSpan={7}><EmptyState icon={<ShieldCheck className="h-7 w-7" />} title={t('admin.permissions.emptyTitle')} description={t('admin.permissions.emptyDesc')} /></td></tr>
            ) : sortedRows.map((r, i) => (
              <tr key={r.id} className="reveal-row border-b last:border-0 hover:bg-accent/50" style={innerDelay(1, i + 1)}>
                <td className="px-4 py-2 font-mono text-sm"><code>{r.pathPattern}</code></td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{subjectLabel(r)}{r.mountId ? ` · ${r.mountName ?? r.mountId}` : ''}</td>
                <td className="px-4 py-2 text-xs">
                  {r.origin === 'user' ? (
                    <Badge variant="warning">{t('admin.permissions.badgeUser')}{r.createdBy ? `:${r.createdBy.slice(0, 8)}` : ''}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('admin.permissions.badgeAdmin')}</Badge>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.permissions.map((p) => <Badge key={p} variant="secondary">{p}</Badge>)}
                    {r.requirePassword && <Badge variant="warning">{t('admin.permissions.badgePassword')}</Badge>}
                  </div>
                </td>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.priority}</td>
                <td className="px-4 py-2"><Badge variant={r.effect === 'allow' ? 'success' : 'destructive'}>{r.effect}</Badge></td>
                <td className="px-4 py-2">
                  <button onClick={() => setConfirmDelete(r)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10" title={t("common.delete")}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {total > 0 && (
  <div className="shrink-0 pt-2">
        <Pagination
          page={page}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
  </div>
      )}

      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t('admin.addRule')}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={create}>{t('common.create')}</Button>
          </>
        }
      >
        <Tabs value={editMode} onValueChange={(v) => setEditMode(v as 'gui' | 'code')}>
          <TabsList className="mb-3">
            <TabsTrigger value="gui">
              <span className="mr-1 text-base leading-none">◧</span> {t('admin.permissions.tabGui')}
            </TabsTrigger>
            <TabsTrigger value="code">
              <span className="mr-1 font-mono text-base leading-none">{'{}'}</span> {t('admin.permissions.tabCode')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="gui" className="mt-0 space-y-3">
          <div>
            <Label>{t('admin.rulePath')}</Label>
            <Input className="mt-1 font-mono" value={form.pathPattern as string} onChange={(e) => set('pathPattern', e.target.value)} placeholder="/public/**" />
          </div>
          <div>
            <Label>{t('admin.permissions.mount')}</Label>
            <Select
              value={form.mountId as string}
              onValueChange={(v) => set('mountId', v)}
              placeholder={t('admin.permissions.mountAll')}
              className="mt-1"
              options={[
                { value: '', label: t('admin.permissions.mountAll') },
                ...mounts.map((m) => ({ value: m.id, label: `${m.name} · ${m.mountPath}` })),
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.ruleEffect')}</Label>
              <Select
                value={form.effect as string}
                onValueChange={(v) => set('effect', v)}
                className="mt-1"
                options={[
                  { value: 'allow', label: 'allow' },
                  { value: 'deny', label: 'deny' },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.permissions.subject')}</Label>
              <Select
                value={form.subject as string}
                onValueChange={(v) => set('subject', v)}
                className="mt-1"
                options={[
                  { value: 'role', label: t('admin.permissions.subjectRole') },
                  { value: 'user', label: t('admin.permissions.subjectUser') },
                  { value: 'guest', label: t('admin.permissions.subjectGuest') },
                ]}
              />
            </div>
          </div>
          {form.subject === 'role' && (
            <div>
              <Label>{t('admin.permissions.role')}</Label>
              <Select
                value={form.role as string}
                onValueChange={(v) => set('role', v)}
                className="mt-1"
                options={[
                  { value: 'user', label: 'user' },
                  { value: 'guest', label: 'guest' },
                  { value: 'admin', label: 'admin' },
                ]}
              />
            </div>
          )}
          {form.subject === 'user' && (
            <div>
              <Label>{t('admin.permissions.subjectUser')}</Label>
              <Input className="mt-1" value={(form.userId as string) ?? ''} onChange={(e) => set('userId', e.target.value)} />
            </div>
          )}
          <div>
            <Label>{t('admin.rulePermissions')}</Label>
            <div className="mt-1 flex flex-wrap gap-3">
              {ALL_PERMS.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={((form.permissions as string[]) ?? []).includes(p)} onChange={() => togglePerm(p)} label={p} />
                  {p}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <div>
              <Label>{t('admin.rulePriority')}</Label>
              <Input type="number" className="mt-1" value={form.priority as string} onChange={(e) => set('priority', e.target.value)} />
            </div>
            <div className="flex items-center justify-between pb-1">
              <span className="text-sm">{t('admin.ruleRequirePassword')}</span>
              <Switch checked={Boolean(form.requirePassword)} onChange={(v) => set('requirePassword', v)} />
            </div>
          </div>
          {form.requirePassword && (
            <div>
              <Label>{t('admin.permissions.password')}</Label>
              <Input type="password" className="mt-1" value={(form.password as string) ?? ''} onChange={(e) => set('password', e.target.value)} />
            </div>
          )}
          </TabsContent>

          <TabsContent value="code" className="mt-0">
            <div>
              <Label>{t('admin.permissions.jsonLabel')}</Label>
              <textarea
                value={jsonText}
                onChange={(e) => {
                  const text = e.target.value;
                  setJsonText(text);
                  try {
                    const parsed = JSON.parse(text);
                    setJsonError(null);
                    // 同步回 GUI 表单
                    if (parsed.pathPattern !== undefined) set('pathPattern', String(parsed.pathPattern));
                    if (parsed.effect !== undefined) set('effect', String(parsed.effect));
                    if (parsed.mountId !== undefined) set('mountId', String(parsed.mountId));
                    if (parsed.subject !== undefined) set('subject', String(parsed.subject));
                    if (parsed.role !== undefined) set('role', String(parsed.role));
                    if (parsed.userId !== undefined) set('userId', String(parsed.userId));
                    if (parsed.priority !== undefined) set('priority', String(parsed.priority));
                    if (parsed.requirePassword !== undefined) set('requirePassword', Boolean(parsed.requirePassword));
                    if (Array.isArray(parsed.permissions)) setForm((f) => ({ ...f, permissions: parsed.permissions }));
                  } catch {
                    setJsonError(t('admin.permissions.jsonInvalid'));
                  }
                }}
                className="h-64 w-full rounded-md border border-input bg-transparent p-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
                placeholder='{"pathPattern": "/public/**", "effect": "allow", "permissions": ["read", "download"]}'
              />
              {jsonError && <p className="mt-2 text-sm text-destructive">{jsonError}</p>}
              <p className="mt-2 text-xs text-muted-foreground">
                {t('admin.permissions.jsonHelp')}
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void del(confirmDelete.id)}
        title={t('admin.permissions.deleteTitle')}
        message={t('admin.permissions.deleteMessage', { path: confirmDelete?.pathPattern ?? '' })}
      />
    </div>
  );
}
