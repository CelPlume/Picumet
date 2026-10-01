// 「OIDC 设置」弹窗（系统设置 → 注册设置）：第三方登录来源 CRUD。
// 形态对齐 admin/Users.tsx 的「默认用户设置」弹窗：说明文字 + 列表 + 内联编辑区 + 删除二次确认。
// 来源类型：Google / GitHub 各只能一个（后端 409 兜底），自定义 OIDC 不限；密钥写入后只回掩码。
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Dialog, Input, Label, Switch } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { TableSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import type { SsoProviderAdmin, SsoProviderKind } from '@shared/types';

interface ProviderForm {
  kind: SsoProviderKind;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
  /** 信任提供方的邮箱验证声明（自动关联既有账号的依据；自定义 OIDC 默认关闭） */
  trustEmailVerified: boolean;
}

const EMPTY_FORM: ProviderForm = {
  kind: 'oidc',
  name: '',
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: '',
  enabled: true,
  trustEmailVerified: false,
};

export function SsoProvidersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SsoProviderAdmin[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  /** null = 新建；非空 = 编辑该来源 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SsoProviderAdmin | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: SsoProviderAdmin[] }>('/api/admin/sso/providers');
      setItems(res.data.items);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.operationFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const kindLabel = (kind: SsoProviderKind): string =>
    kind === 'google' ? t('admin.ssoKindGoogle') : kind === 'github' ? t('admin.ssoKindGithub') : t('admin.ssoKindOidc');

  const startCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const startEdit = (p: SsoProviderAdmin) => {
    setEditingId(p.id);
    setForm({
      kind: p.kind,
      name: p.name,
      issuerUrl: p.issuerUrl ?? '',
      clientId: p.clientId,
      // 密钥不回读：留空 = 保持原值
      clientSecret: '',
      scopes: p.scopes ?? '',
      enabled: p.enabled,
      trustEmailVerified: p.trustEmailVerified,
    });
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) return toast('error', t('admin.ssoNameRequired'));
    if (!form.clientId.trim()) return toast('error', t('admin.ssoClientIdRequired'));
    if (!editingId && !form.clientSecret) return toast('error', t('admin.ssoSecretRequired'));
    if (form.kind === 'oidc' && !form.issuerUrl.trim()) return toast('error', t('admin.ssoIssuerRequired'));
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        clientId: form.clientId.trim(),
        scopes: form.scopes.trim() || null,
        enabled: form.enabled,
        trustEmailVerified: form.trustEmailVerified,
      };
      if (form.kind === 'oidc') payload.issuerUrl = form.issuerUrl.trim();
      if (editingId) {
        // 空串 = 保持原密钥（后端同语义）
        if (form.clientSecret) payload.clientSecret = form.clientSecret;
        await apiFetch(`/api/admin/sso/providers/${editingId}`, { method: 'PATCH', body: payload });
      } else {
        payload.kind = form.kind;
        payload.clientSecret = form.clientSecret;
        await apiFetch('/api/admin/sso/providers', { method: 'POST', body: payload });
      }
      toast('success', t('common.saved'));
      setFormOpen(false);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (p: SsoProviderAdmin, enabled: boolean) => {
    try {
      await apiFetch(`/api/admin/sso/providers/${p.id}`, { method: 'PATCH', body: { enabled } });
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.saveFailed'));
    }
  };

  const remove = async (p: SsoProviderAdmin) => {
    try {
      await apiFetch(`/api/admin/sso/providers/${p.id}`, { method: 'DELETE' });
      toast('success', t('common.deleted'));
      if (editingId === p.id) setFormOpen(false);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('common.deleteFailed'));
    } finally {
      setConfirmDelete(null);
    }
  };

  const copyRedirect = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('success', t('common.copied'));
    } catch {
      toast('error', t('common.operationFailed'));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} width="max-w-4xl w-[calc(100vw-2rem)]" title={t('admin.ssoProviders')}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('admin.ssoProvidersHint')}</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t('admin.ssoSingleHint')}</p>
          <Button variant="outline" onClick={startCreate}>
            <Plus className="h-4 w-4" />
            {t('admin.ssoAdd')}
          </Button>
        </div>

        {loading ? (
          <TableSkeleton rows={2} cols={3} />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('admin.ssoEmpty')}</p>
        ) : (
          <div className="divide-y">
            {items.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <Badge variant="secondary">{kindLabel(p.kind)}</Badge>
                  </div>
                  {/* 回调地址需在提供方后台登记：给出可复制的权威值（含站点地址与来源 id） */}
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate" title={p.redirectUri}>{p.redirectUri}</span>
                    <button
                      type="button"
                      className="shrink-0 transition-colors hover:text-foreground"
                      onClick={() => void copyRedirect(p.redirectUri)}
                      title={t('admin.ssoCallback')}
                      aria-label={t('admin.ssoCallback')}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <Switch checked={p.enabled} onChange={(v) => void toggleEnabled(p, v)} />
                <Button variant="ghost" size="sm" onClick={() => startEdit(p)} aria-label={t('common.edit')}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(p)} aria-label={t('common.delete')}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {formOpen && (
          <div className="space-y-3 border-t pt-3">
            <p className="text-sm font-medium">{editingId ? t('admin.ssoEdit') : t('admin.ssoAdd')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>{t('admin.ssoKind')}</Label>
                <Select
                  className="mt-1"
                  value={form.kind}
                  disabled={!!editingId}
                  onValueChange={(v: string) =>
                    setForm((f) => {
                      const kind = v as SsoProviderKind;
                      // 新建时按类型给默认值（内置来源端点固定、邮箱验证由提供方保证）；编辑时不改
                      return { ...f, kind, trustEmailVerified: editingId ? f.trustEmailVerified : kind !== 'oidc' };
                    })
                  }
                  options={[
                    { value: 'oidc', label: t('admin.ssoKindOidc') },
                    { value: 'google', label: t('admin.ssoKindGoogle') },
                    { value: 'github', label: t('admin.ssoKindGithub') },
                  ]}
                />
              </div>
              <div>
                <Label>{t('admin.ssoName')}</Label>
                <Input
                  className="mt-1"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('admin.ssoNamePlaceholder')}
                />
              </div>
              {form.kind === 'oidc' && (
                <div className="sm:col-span-2">
                  <Label>{t('admin.ssoIssuer')}</Label>
                  <Input
                    className="mt-1"
                    value={form.issuerUrl}
                    onChange={(e) => setForm((f) => ({ ...f, issuerUrl: e.target.value }))}
                    placeholder="https://idp.example.com"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('admin.ssoIssuerHint')}</p>
                </div>
              )}
              <div>
                <Label>{t('admin.ssoClientId')}</Label>
                <Input className="mt-1" value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} />
              </div>
              <div>
                <Label>{t('admin.ssoClientSecret')}</Label>
                <Input
                  className="mt-1"
                  type="password"
                  value={form.clientSecret}
                  onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
                  placeholder={editingId ? '******' : ''}
                />
                {editingId && <p className="mt-1.5 text-xs text-muted-foreground">{t('admin.ssoSecretKeep')}</p>}
              </div>
              <div className="sm:col-span-2">
                <Label>{t('admin.ssoScopes')}</Label>
                <Input className="mt-1" value={form.scopes} onChange={(e) => setForm((f) => ({ ...f, scopes: e.target.value }))} placeholder="openid email profile" />
                <p className="mt-1.5 text-xs text-muted-foreground">{t('admin.ssoScopesHint')}</p>
              </div>
              <div className="flex items-center justify-between sm:col-span-2">
                <span className="text-sm">{t('admin.ssoSourceEnabled')}</span>
                <Switch checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
              </div>
              {/* 自动关联的依据：只有真的验证邮箱的提供方才能宣称 email_verified
                  （内置 Google/GitHub 默认开启，自定义 OIDC 默认关闭） */}
              <div className="space-y-1.5 border-t pt-3 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t('admin.ssoTrustEmail')}</span>
                  <Switch
                    checked={form.trustEmailVerified}
                    onChange={(v) => setForm((f) => ({ ...f, trustEmailVerified: v }))}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('admin.ssoTrustEmailHint')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title={t('common.delete')}
        message={t('admin.ssoDeleteConfirm', { name: confirmDelete?.name ?? '' })}
      />
    </Dialog>
  );
}
