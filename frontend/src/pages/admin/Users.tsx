// 管理员：用户管理
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Pencil, Trash2, Settings2, Users } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, Input, Label, SEARCH_INPUT_GLASS, Switch } from '@/components/ui/core';
import { useMinLoading } from '@/hooks/useMinLoading';
import { cn } from '@/lib/utils';
import { TableSkeleton } from '@/components/ui/skeleton';
import { revealDelay, REVEAL_INNER_BASE, REVEAL_STEP } from '@/components/ui/reveal';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch, ApiError } from '@/lib/api';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';
import { formatBytes, formatDate } from '@/lib/utils';
import type { Permission, Quota, User } from '@shared/types';

interface UserRow extends User {
  quota: Quota | null;
}

/** GET /api/admin/roles 行：角色默认存储设置与成员数 */
interface RoleDefaults {
  role: string;
  defaultPath: string;
  maxStorage: number;
  maxFiles: number;
  isSystem: boolean;
  members: number;
  /** 后端灰度中的新字段：缺失时按 null/'active'/[] 兜底 */
  alias?: string | null;
  defaultStatus?: 'active' | 'disabled';
  capabilities?: string[];
  /** 角色默认权限（查看/上传/修改/删除/下载）；缺失时按角色兜底 */
  permissions?: Permission[];
}

const GB = 1024 ** 3;

/** 默认权限矩阵的可选项与展示顺序；不含 share——分享开关是能力位 can_share，避免同一件事两处设置 */
const PERMISSION_OPTIONS: Permission[] = ['read', 'write', 'update', 'delete', 'download'];

/** 后端未返回 permissions 时的兜底：admin/user 全量、guest 仅下载；未知角色按 user */
const FALLBACK_PERMISSIONS: Record<string, Permission[]> = {
  admin: [...PERMISSION_OPTIONS],
  user: [...PERMISSION_OPTIONS],
  guest: ['download'],
};
const DEFAULT_PERMISSIONS = FALLBACK_PERMISSIONS.user;

/** 角色名规则：小写字母开头，仅小写字母/数字/-/_（与 admin.roles.nameInvalid 文案一致） */
const ROLE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** 「默认用户设置」弹窗：单个角色的默认设置表单（保存即覆盖该角色全部用户） */
function RoleDefaultsForm({
  data,
  refresh,
  onRequestDelete,
}: {
  data: RoleDefaults;
  refresh: () => Promise<void>;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  const [alias, setAlias] = useState(data.alias ?? '');
  const [defaultStatus, setDefaultStatus] = useState<string>(data.defaultStatus ?? 'active');
  const [capabilities, setCapabilities] = useState<string[]>(data.capabilities ?? []);
  const [permissions, setPermissions] = useState<Permission[]>(
    data.permissions ?? FALLBACK_PERMISSIONS[data.role] ?? DEFAULT_PERMISSIONS
  );
  const [path, setPath] = useState(data.defaultPath || '/');
  const [maxStorageS, setMaxStorageS] = useState(String(data.maxStorage / GB));
  const [maxFilesS, setMaxFilesS] = useState(String(data.maxFiles));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/admin/roles/${encodeURIComponent(data.role)}/defaults`, {
        method: 'PUT',
        body: {
          defaultPath: path,
          maxStorage: Number(maxStorageS) * GB,
          maxFiles: Number(maxFilesS),
          alias: alias.trim() || null,
          defaultStatus,
          capabilities,
          permissions,
        },
      });
      toast('success', t('admin.roles.defaultsSaved'));
      await refresh();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.saveFailed'));
    }
    setSaving(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <Label>{t('admin.roles.alias')}</Label>
        <Input className="mt-1" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t('admin.roles.aliasPlaceholder')} />
      </div>
      <div>
        <Label>{t('admin.roles.roleName')}</Label>
        <Input readOnly className="mt-1 font-mono" value={data.role} />
      </div>
      <div>
        <Label>{t('admin.userStatus')}</Label>
        <Select
          value={defaultStatus}
          onValueChange={setDefaultStatus}
          className="mt-1"
          options={[
            { value: 'active', label: t('admin.active') },
            { value: 'disabled', label: t('admin.disabled') },
          ]}
        />
      </div>
      <div>
        <Label>{t('admin.roles.permissions')}</Label>
        <div className="mt-1.5 flex flex-wrap gap-3 text-sm">
          {PERMISSION_OPTIONS.map((perm) => (
            <label key={perm} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={permissions.includes(perm)}
                onChange={(e) => {
                  setPermissions((prev) => (e.target.checked ? [...prev, perm] : prev.filter((p) => p !== perm)));
                }}
                className="h-4 w-4 rounded border-border"
              />
              {t(`perm.${perm}`)}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('admin.roles.permissionsHint')}</p>
      </div>
      <div>
        <Label>{t('admin.users.capabilities')}</Label>
        <div className="mt-1.5 flex flex-wrap gap-3 text-sm">
          {[
            { id: 'can_share', label: t('admin.users.canShare') },
            { id: 'can_publish', label: t('admin.users.canPublish') },
            { id: 'can_grant', label: t('admin.users.canGrant') },
          ].map((cap) => (
            <label key={cap.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={capabilities.includes(cap.id)}
                onChange={(e) => {
                  setCapabilities((prev) => (e.target.checked ? [...prev, cap.id] : prev.filter((c) => c !== cap.id)));
                }}
                className="h-4 w-4 rounded border-border"
              />
              {cap.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <Label>{t('admin.users.defaultPath')}</Label>
        <Input className="mt-1 font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/users/<username>" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t('admin.maxStorage')} (GB)</Label>
          <Input type="number" className="mt-1" value={maxStorageS} onChange={(e) => setMaxStorageS(e.target.value)} />
        </div>
        <div>
          <Label>{t('admin.maxFiles')}</Label>
          <Input type="number" className="mt-1" value={maxFilesS} onChange={(e) => setMaxFilesS(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        {data.isSystem ? (
          <Badge variant="secondary">{t('admin.roles.systemRole')}</Badge>
        ) : (
          <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10" onClick={onRequestDelete}>
            <Trash2 className="h-4 w-4" />
            {t('admin.roles.deleteRole')}
          </Button>
        )}
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">{t('admin.roles.overrideHint')}</p>
          <Button size="sm" loading={saving} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  // 骨架屏最短驻留：数据太快时也保证加载动画可见（§33）
  const showSkeleton = useMinLoading(loading);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<string | null>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [role, setRole] = useState('user');
  const [status, setStatus] = useState('active');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  // 用户级默认权限覆盖：override=false 表示跟随角色默认（提交 permissions: null）
  const [overridePerms, setOverridePerms] = useState(false);
  const [userPerms, setUserPerms] = useState<Permission[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [path, setPath] = useState('/');
  const [maxStorageS, setMaxStorageS] = useState('10');
  const [maxFilesS, setMaxFilesS] = useState('10000');
  // 「默认用户设置」弹窗：按角色 tabs 管理各角色默认值
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [roles, setRoles] = useState<RoleDefaults[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [activeRole, setActiveRole] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newAlias, setNewAlias] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmRole, setConfirmRole] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const q = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    if (search) q.set('search', search);
    const res = await apiFetch<{ users: UserRow[]; pagination: { total: number } }>(`/api/admin/users?${q}`);
    setUsers(res.data.users);
    setTotal(res.data.pagination.total);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search]);

  const save = async () => {
    if (!editing) return;
    try {
      await apiFetch(`/api/admin/users/${editing.id}`, {
        method: 'PUT',
        body: {
          role,
          status,
          capabilities,
          defaultPath: path,
          maxStorage: Number(maxStorageS) * GB,
          maxFiles: Number(maxFilesS),
          // 单独设置 = 提交矩阵；关闭 = null（清除个别设置，跟随角色默认）
          permissions: overridePerms ? userPerms : null,
        },
      });
      toast('success', t('common.saved'));
      setEditing(null);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.saveFailed'));
    }
  };

  const del = async (u: UserRow) => {
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      toast('success', t('common.deleted'));
      await load();
    } catch (err) {
      toast('error', t('common.deleteFailed'));
    }
    setConfirmDelete(null);
  };

  const openEdit = (u: UserRow) => {
    setEditing(u);
    setRole(u.role);
    setStatus(u.status);
    setCapabilities(u.capabilities ?? []);
    setOverridePerms(Array.isArray(u.permissions));
    setUserPerms(Array.isArray(u.permissions) ? u.permissions : [...PERMISSION_OPTIONS]);
    setPath(u.defaultPath || '/');
    setMaxStorageS(String((u.quota?.maxStorage ?? 10 * GB) / GB));
    setMaxFilesS(String(u.quota?.maxFiles ?? 10000));
  };

  const loadRoles = async () => {
    setRolesLoading(true);
    try {
      const res = await apiFetch<{ roles: RoleDefaults[] }>('/api/admin/roles');
      setRoles(res.data.roles);
      setActiveRole((prev) => (res.data.roles.some((r) => r.role === prev) ? prev : (res.data.roles[0]?.role ?? '')));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.operationFailed'));
    }
    setRolesLoading(false);
  };

  useEffect(() => {
    if (defaultsOpen) void loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsOpen]);

  const createRole = async () => {
    const name = newRole.trim();
    if (!ROLE_NAME_RE.test(name)) {
      toast('error', t('admin.roles.nameInvalid'));
      return;
    }
    setCreating(true);
    try {
      await apiFetch('/api/admin/roles', { method: 'POST', body: { role: name, alias: newAlias.trim() || null } });
      toast('success', t('admin.roles.created'));
      setNewRole('');
      setNewAlias('');
      await loadRoles();
      setActiveRole(name);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.saveFailed'));
    }
    setCreating(false);
  };

  const deleteRole = async (name: string) => {
    try {
      await apiFetch(`/api/admin/roles/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast('success', t('admin.roles.deleted'));
      await loadRoles();
    } catch (err) {
      // 403 内置角色 / 400 角色下仍有用户：后端 message 已含原因
      toast('error', err instanceof ApiError ? err.message : t('common.deleteFailed'));
    } finally {
      setConfirmRole(null);
    }
  };

  const sortedRows = useMemo(() => {
    if (!sort) return users;
    return sortByKey(users, sort as keyof UserRow, order);
  }, [users, sort, order]);

  // 左侧导航选中角色 → 右侧表单数据（保存/刷新后保留选中项）
  const activeRoleData = roles.find((r) => r.role === activeRole) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="reveal flex items-center justify-between gap-3" style={revealDelay(0)}>
        <p className="text-sm text-muted-foreground">{t('admin.users.total', { count: total })}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setDefaultsOpen(true)}>
            <Settings2 className="h-4 w-4" />
            {t('admin.users.defaultSettings')}
          </Button>
          <div className="relative w-64 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
            <Input className={cn('pl-8', SEARCH_INPUT_GLASS)} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('admin.users.searchPlaceholder')} />
          </div>
        </div>
      </div>

      <Card className="reveal mt-3 min-h-0 flex-1 scrollbar-thin overflow-auto py-0" style={revealDelay(1)}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className={'px-4 py-2 text-left'}><SortableHeader title={t('admin.user')} sortKey="username" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2 text-left'}><SortableHeader title={t('admin.userRole')} sortKey="role" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2 text-left'}><SortableHeader title={t('admin.userStatus')} sortKey="status" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2 text-left'}><SortableHeader title={t('admin.quota')} sortKey="usedStorage" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2 text-left'}><SortableHeader title={t('admin.users.registeredAt')} sortKey="createdAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className={'px-4 py-2 text-left'}>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {showSkeleton ? (
              <tr><td colSpan={6}><TableSkeleton rows={8} cols={6} /></td></tr>
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={6}><EmptyState icon={<Users className="h-7 w-7" />} title={t('admin.users.empty')} description={t('admin.users.emptyDesc')} /></td></tr>
            ) : (
            sortedRows.map((u, i) => (
              <tr key={u.id} className="reveal border-b hover:bg-accent/50" style={revealDelay(i, 'inner', REVEAL_INNER_BASE + REVEAL_STEP)}>
                <td className="px-4 py-2">
                  <p className="font-medium">{u.displayName || u.username}</p>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                </td>
                <td className="px-4 py-2">
                  <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                    {u.role === 'admin' ? t('admin.admin') : u.role === 'guest' ? t('admin.guest') : t('admin.user')}
                  </Badge>
                </td>
                <td className="px-4 py-2">
                  <Badge variant={u.status === 'active' ? 'success' : u.status === 'banned' ? 'destructive' : 'warning'}>
                    {u.status === 'active' ? t('admin.active') : u.status === 'banned' ? t('admin.banned') : t('admin.disabled')}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-xs">
                  <p>{formatBytes(u.quota?.usedStorage ?? 0)} / {formatBytes(u.quota?.maxStorage ?? 0)}</p>
                  <p className="text-muted-foreground">{u.quota?.usedFiles ?? 0} / {u.quota?.maxFiles ?? 0} {t('admin.users.filesUnit')}</p>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                <td className="px-4 py-2">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(u)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => setConfirmDelete(u)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))
            )}
          </tbody>
        </table>
      </Card>

<div className="shrink-0 pt-2">
      <Pagination
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      />
</div>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        width="max-w-xl w-[calc(100vw-2rem)]"
        title={t('admin.users.editTitle', { name: editing?.username ?? '' })}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => void save()}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t('admin.userRole')}</Label>
              <Select
                value={role}
                onValueChange={setRole}
                className="mt-1"
                options={[
                  { value: 'admin', label: t('admin.admin') },
                  { value: 'user', label: t('admin.user') },
                  { value: 'guest', label: t('admin.guest') },
                ]}
              />
            </div>
            <div>
              <Label>{t('admin.userStatus')}</Label>
              <Select
                value={status}
                onValueChange={setStatus}
                className="mt-1"
                options={[
                  { value: 'active', label: t('admin.active') },
                  { value: 'disabled', label: t('admin.disabled') },
                  { value: 'banned', label: t('admin.banned') },
                ]}
              />
            </div>
          </div>
          <div>
            <Label>{t('admin.users.capabilities')}</Label>
            <div className="mt-1.5 flex flex-wrap gap-3 text-sm">
              {[
                { id: 'can_share', label: t('admin.users.canShare') },
                { id: 'can_publish', label: t('admin.users.canPublish') },
                { id: 'can_grant', label: t('admin.users.canGrant') },
              ].map((cap) => (
                <label key={cap.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={capabilities.includes(cap.id)}
                    onChange={(e) => {
                      setCapabilities((prev) => (e.target.checked ? [...prev, cap.id] : prev.filter((c) => c !== cap.id)));
                    }}
                    className="h-4 w-4 rounded border-border"
                  />
                  {cap.label}
                </label>
              ))}
            </div>
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('admin.roles.permissions')}</span>
              <Switch checked={overridePerms} onChange={setOverridePerms} />
            </div>
            {overridePerms ? (
              <div className="flex flex-wrap gap-3 text-sm">
                {PERMISSION_OPTIONS.map((perm) => (
                  <label key={perm} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={userPerms.includes(perm)}
                      onChange={(e) => {
                        setUserPerms((prev) => (e.target.checked ? [...prev, perm] : prev.filter((p) => p !== perm)));
                      }}
                      className="h-4 w-4 rounded border-border"
                    />
                    {t(`perm.${perm}`)}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('admin.roles.permissionsHint')}</p>
            )}
          </div>
          </div>
          <div>
            <Label>{t('admin.users.defaultPath')}</Label>
            <Input className="mt-1 font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/users/<username>" />
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.users.defaultPathHint')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t('admin.maxStorage')} (GB)</Label>
              <Input type="number" className="mt-1" value={maxStorageS} onChange={(e) => setMaxStorageS(e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.maxFiles')}</Label>
              <Input type="number" className="mt-1" value={maxFilesS} onChange={(e) => setMaxFilesS(e.target.value)} />
            </div>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={defaultsOpen}
        onClose={() => setDefaultsOpen(false)}
        width="max-w-4xl w-[calc(100vw-2rem)]"
        title={t('admin.users.defaultSettings')}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('admin.users.defaultSettingsHint')}</p>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              placeholder={t('admin.roles.roleName')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createRole();
              }}
            />
            <Input
              className="flex-1"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder={t('admin.roles.aliasPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createRole();
              }}
            />
            <Button variant="outline" loading={creating} onClick={() => void createRole()}>
              {t('admin.roles.addRole')}
            </Button>
          </div>

          {rolesLoading ? (
            <TableSkeleton rows={3} cols={3} />
          ) : (
            <div className="flex gap-4">
              {/* 左侧角色导航（样式对齐 SettingsLayout 侧栏：active 用 text-primary + bg-primary/10） */}
              <div className="flex w-40 shrink-0 flex-col gap-1">
                {roles.map((r) => {
                  const perms = r.permissions ?? FALLBACK_PERMISSIONS[r.role] ?? DEFAULT_PERMISSIONS;
                  const permSummary = PERMISSION_OPTIONS.filter((p) => perms.includes(p))
                    .map((p) => t(`perm.${p}`))
                    .join('·');
                  return (
                    <button
                      key={r.role}
                      type="button"
                      data-active={activeRole === r.role ? 'true' : 'false'}
                      onClick={() => setActiveRole(r.role)}
                      title={`${r.alias || r.role} · ${permSummary}`}
                      className={cn(
                        'w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors',
                        activeRole === r.role
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                      )}
                    >
                      <span className="block truncate">{`${r.alias || r.role} · ${t('admin.roles.members', { count: r.members })}`}</span>
                      <span className="block truncate text-xs text-muted-foreground">{permSummary}</span>
                    </button>
                  );
                })}
              </div>
              <div className="min-w-0 flex-1">
                {activeRoleData ? (
                  <RoleDefaultsForm
                    key={activeRoleData.role}
                    data={activeRoleData}
                    refresh={loadRoles}
                    onRequestDelete={() => setConfirmRole(activeRoleData.role)}
                  />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void del(confirmDelete)}
        title={t('admin.users.deleteTitle')}
        message={t('admin.users.deleteConfirm', { name: confirmDelete?.username ?? '' })}
      />

      <ConfirmDialog
        open={!!confirmRole}
        onClose={() => setConfirmRole(null)}
        onConfirm={() => confirmRole && void deleteRole(confirmRole)}
        title={t('admin.roles.deleteRole')}
        message={t('admin.roles.deleteConfirm', { role: confirmRole ?? '' })}
      />
    </div>
  );
}
