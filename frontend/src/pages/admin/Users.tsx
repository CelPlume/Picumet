// 管理员：用户管理
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Pencil, Trash2 } from 'lucide-react';
import { Card, Button, Input, Badge, Dialog, Label, Switch } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/utils';
import type { Quota, User } from '@shared/types';

interface UserRow extends User {
  quota: Quota | null;
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [role, setRole] = useState('user');
  const [status, setStatus] = useState('active');
  const [maxStorage, setMaxStorage] = useState('10');
  const [maxFiles, setMaxFiles] = useState('10000');

  const load = async () => {
    const q = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) q.set('search', search);
    const res = await apiFetch<{ users: UserRow[]; pagination: { total: number } }>(`/api/admin/users?${q}`);
    setUsers(res.data.users);
    setTotal(res.data.pagination.total);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search]);

  const save = async () => {
    if (!editing) return;
    try {
      await apiFetch(`/api/admin/users/${editing.id}`, {
        method: 'PUT',
        body: { role, status, maxStorage: Number(maxStorage) * 1024 * 1024 * 1024, maxFiles: Number(maxFiles) },
      });
      toast('success', '已保存');
      setEditing(null);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '保存失败');
    }
  };

  const del = async (u: UserRow) => {
    if (!confirm(`确定删除用户 ${u.username}？其文件和配额将一并删除。`)) return;
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      toast('success', '已删除');
      await load();
    } catch (err) {
      toast('error', '删除失败');
    }
  };

  const openEdit = (u: UserRow) => {
    setEditing(u);
    setRole(u.role);
    setStatus(u.status);
    setMaxStorage(String((u.quota?.maxStorage ?? 10 * 1024 ** 3) / 1024 ** 3));
    setMaxFiles(String(u.quota?.maxFiles ?? 10000));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">共 {total} 个用户</p>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索用户名/邮箱" />
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">用户</th>
              <th className="px-4 py-2 font-medium">{t('admin.userRole')}</th>
              <th className="px-4 py-2 font-medium">{t('admin.userStatus')}</th>
              <th className="px-4 py-2 font-medium">{t('admin.quota')}</th>
              <th className="px-4 py-2 font-medium">注册时间</th>
              <th className="px-4 py-2 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
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
                    <button onClick={() => del(u)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-end gap-2 text-sm">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
        <span className="text-muted-foreground">{page}</span>
        <Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>下一页</Button>
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
              <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="admin">{t('admin.admin')}</option>
                <option value="user">{t('admin.user')}</option>
                <option value="guest">{t('admin.guest')}</option>
              </select>
            </div>
            <div>
              <Label>{t('admin.userStatus')}</Label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="active">{t('admin.active')}</option>
                <option value="disabled">{t('admin.disabled')}</option>
                <option value="banned">{t('admin.banned')}</option>
              </select>
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
        </div>
      </Dialog>
    </div>
  );
}
