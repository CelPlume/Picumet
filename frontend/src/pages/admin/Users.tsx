// 管理员：用户管理
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Pencil, Trash2 } from 'lucide-react';
import { Card, Button, Input, Badge, Dialog, Label, Switch, ConfirmDialog } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch, ApiError } from '@/lib/api';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';
import { formatBytes, formatDate } from '@/lib/utils';
import type { Quota, User } from '@shared/types';

interface UserRow extends User {
  quota: Quota | null;
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<string | null>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [role, setRole] = useState('user');
  const [status, setStatus] = useState('active');
  const [maxStorage, setMaxStorage] = useState('10');
  const [maxFiles, setMaxFiles] = useState('10000');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);

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
        body: { role, status, maxStorage: Number(maxStorage) * 1024 * 1024 * 1024, maxFiles: Number(maxFiles), capabilities },
      });
      toast('success', '已保存');
      setEditing(null);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '保存失败');
    }
  };

  const del = async (u: UserRow) => {
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      toast('success', '已删除');
      await load();
    } catch (err) {
      toast('error', '删除失败');
    }
    setConfirmDelete(null);
  };

  const openEdit = (u: UserRow) => {
    setEditing(u);
    setRole(u.role);
    setStatus(u.status);
    setMaxStorage(String((u.quota?.maxStorage ?? 10 * 1024 ** 3) / 1024 ** 3));
    setMaxFiles(String(u.quota?.maxFiles ?? 10000));
    setCapabilities(u.capabilities ?? []);
  };

  const sortedRows = useMemo(() => {
    if (!sort) return users;
    return sortByKey(users, sort as keyof UserRow, order);
  }, [users, sort, order]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">共 {total} 个用户</p>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索用户名/邮箱" />
        </div>
      </div>

      <Card className="mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-auto">
        {loading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2 text-left"><SortableHeader title="用户" sortKey="username" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2 text-left"><SortableHeader title={t('admin.userRole')} sortKey="role" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2 text-left"><SortableHeader title={t('admin.userStatus')} sortKey="status" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2 text-left"><SortableHeader title={t('admin.quota')} sortKey="usedStorage" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2 text-left"><SortableHeader title="注册时间" sortKey="createdAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2 text-left">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((u) => (
              <tr key={u.id} className="border-b hover:bg-accent/50">
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
                  <p className="text-muted-foreground">{u.quota?.usedFiles ?? 0} / {u.quota?.maxFiles ?? 0} 文件</p>
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
            ))}
          </tbody>
        </table>
        )}
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
        title={`编辑用户：${editing?.username ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button onClick={save}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.maxStorage')} (GB)</Label>
              <Input type="number" value={maxStorage} onChange={(e) => setMaxStorage(e.target.value)} />
            </div>
            <div>
              <Label>{t('admin.maxFiles')}</Label>
              <Input type="number" value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>能力位</Label>
            <div className="mt-1.5 flex flex-wrap gap-3 text-sm">
              {[
                { id: 'can_share', label: '可分享（can_share）' },
                { id: 'can_publish', label: '可公开发布（can_publish）' },
                { id: 'can_grant', label: '可创建访问规则（can_grant）' },
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
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void del(confirmDelete)}
        title="删除用户"
        message={`确定删除用户 ${confirmDelete?.username ?? ''}？其文件和配额将一并删除，该操作不可恢复。`}
      />
    </div>
  );
}
