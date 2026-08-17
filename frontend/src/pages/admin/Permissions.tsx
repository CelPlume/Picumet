// 管理员：权限规则管理
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Plus, Trash2 } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog, Switch } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';

interface Rule {
  id: string;
  pathPattern: string;
  effect: 'allow' | 'deny';
  role?: string;
  userId?: string;
  apiKeyId?: string;
  permissions: string[];
  requirePassword: boolean;
  allowedIps?: string[];
  priority: number;
  status: string;
}

const ALL_PERMS = ['read', 'write', 'update', 'delete', 'share', 'download'];

export default function AdminPermissions() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Rule[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string | boolean | string[]>>({
    pathPattern: '/public/**',
    effect: 'allow',
    subject: 'role',
    role: 'guest',
    priority: '0',
  });

  const load = async () => {
    const res = await apiFetch<{ rules: Rule[] }>('/api/admin/rules');
    setRules(res.data.rules);
  };

  useEffect(() => {
    void load();
  }, []);

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
    if (subject === 'role') body.role = form.role;
    if (subject === 'user') body.userId = form.userId;
    if (subject === 'guest') body.role = 'guest';
    if (form.password) body.password = form.password;
    try {
      await apiFetch('/api/admin/rules', { method: 'POST', body });
      toast('success', '已创建规则');
      setShowCreate(false);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '创建失败');
    }
  };

  const del = async (id: string) => {
    await apiFetch(`/api/admin/rules/${id}`, { method: 'DELETE' });
    toast('success', '已删除');
    await load();
  };

  const subjectLabel = (r: Rule) =>
    r.userId ? `用户:${r.userId}` : r.apiKeyId ? `密钥:${r.apiKeyId}` : `角色:${r.role ?? r.apiKeyId ?? '-'}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('admin.permissions')} · {rules.length} 条</p>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" /> {t('admin.addRule')}</Button>
      </div>

      <div className="space-y-2">
        {rules.map((r) => (
          <Card key={r.id} className="flex items-center gap-3 p-3">
            <ShieldCheck className={`h-5 w-5 shrink-0 ${r.effect === 'allow' ? 'text-emerald-500' : 'text-destructive'}`} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm"><code>{r.pathPattern}</code></p>
              <p className="text-xs text-muted-foreground">{subjectLabel(r)} · priority {r.priority}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {r.permissions.map((p) => <Badge key={p} variant="secondary">{p}</Badge>)}
              {r.requirePassword && <Badge variant="warning">密码</Badge>}
            </div>
            <Badge variant={r.effect === 'allow' ? 'success' : 'destructive'}>{r.effect}</Badge>
            <button onClick={() => del(r.id)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
              <Trash2 className="h-4 w-4" />
            </button>
          </Card>
        ))}
        {rules.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无权限规则</p>}
      </div>

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
        <div className="space-y-3">
          <div>
            <Label>{t('admin.rulePath')}</Label>
            <Input className="mt-1 font-mono" value={form.pathPattern as string} onChange={(e) => set('pathPattern', e.target.value)} placeholder="/public/**" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.ruleEffect')}</Label>
              <select value={form.effect as string} onChange={(e) => set('effect', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </div>
            <div>
              <Label>主体</Label>
              <select value={form.subject as string} onChange={(e) => set('subject', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="role">角色</option>
                <option value="user">用户 ID</option>
                <option value="guest">访客</option>
              </select>
            </div>
          </div>
          {form.subject === 'role' && (
            <div>
              <Label>角色</Label>
              <select value={form.role as string} onChange={(e) => set('role', e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="user">user</option>
                <option value="guest">guest</option>
                <option value="admin">admin</option>
              </select>
            </div>
          )}
          {form.subject === 'user' && (
            <div>
              <Label>用户 ID</Label>
              <Input className="mt-1" value={(form.userId as string) ?? ''} onChange={(e) => set('userId', e.target.value)} />
            </div>
          )}
          <div>
            <Label>{t('admin.rulePermissions')}</Label>
            <div className="mt-1 flex flex-wrap gap-3">
              {ALL_PERMS.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={((form.permissions as string[]) ?? []).includes(p)} onChange={() => togglePerm(p)} />
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
              <Label>密码</Label>
              <Input type="password" className="mt-1" value={(form.password as string) ?? ''} onChange={(e) => set('password', e.target.value)} />
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
