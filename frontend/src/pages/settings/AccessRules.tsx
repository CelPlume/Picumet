// 设置 → 访问规则（§4.4b UI）：管理自己创建的授权/禁止规则
// 创建入口在文件属性面板（选中文件上下文）；本页负责列表与撤销。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, User as UserIcon, Trash2 } from 'lucide-react';
import type { PathRule } from '@shared/types';
import { Card, Button, Badge, ConfirmDialog, EmptyState } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/utils';
import { SortableHeader, sortByKey, type SortOrder } from '@/components/ui/sortable-header';

interface UserRule extends PathRule {
  createdBy?: string;
}

export default function AccessRulesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<UserRule | null>(null);

  const targetLabel = (rule: UserRule): string => {
    if (rule.role === 'user') return t('settings.accessRules.allUsers');
    if (rule.userId) return t('settings.accessRules.targetUser', { id: rule.userId.slice(0, 8) });
    if (rule.apiKeyId) return t('settings.accessRules.targetApiKey', { id: rule.apiKeyId.slice(0, 8) });
    return t('settings.accessRules.unknown');
  };

  const { data, isLoading } = useQuery({
    queryKey: ['user-rules'],
    queryFn: async () => {
      const res = await apiFetch<{ rules: UserRule[] }>('/api/users/rules');
      return res.data.rules;
    },
  });

  const del = async (rule: UserRule) => {
    try {
      await apiFetch(`/api/users/rules/${rule.id}`, { method: 'DELETE' });
      toast('success', t('settings.accessRules.revoked'));
      await qc.invalidateQueries({ queryKey: ['user-rules'] });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('settings.accessRules.revokeFailed'));
    }
    setConfirmDelete(null);
  };

  const rules = data ?? [];
  const [sort, setSort] = useState<string | null>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const sortedRules = useMemo(
    () => sortByKey(rules, sort as keyof UserRule, order),
    [rules, sort, order]
  );

  return (
    <div>
      <p className="text-sm text-muted-foreground">
        {t('settings.accessRules.intro')}
      </p>

      <Card className="mt-3 overflow-x-auto py-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2"><SortableHeader title={t('settings.accessRules.path')} sortKey="pathPattern" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2"><SortableHeader title={t('admin.ruleEffect')} sortKey="effect" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('settings.accessRules.target')}</th>
              <th className="px-4 py-2">{t('settings.permissions')}</th>
              <th className="px-4 py-2"><SortableHeader title={t('settings.accessRules.createdAt')} sortKey="createdAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
              <th className="px-4 py-2">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6}><TableSkeleton rows={4} cols={5} /></td></tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon={<Users className="h-7 w-7" />}
                    title={t('settings.accessRules.noRules')}
                    description={t('settings.accessRules.noRulesDesc')}
                  />
                </td>
              </tr>
            ) : (
              sortedRules.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-2 font-mono text-xs">{r.pathPattern}</td>
                  <td className="px-4 py-2">
                    <Badge variant={r.effect === 'allow' ? 'success' : 'warning'}>
                      {r.effect === 'allow' ? t('settings.accessRules.allow') : t('settings.accessRules.deny')}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1.5 text-xs">
                      {r.role === 'user' ? <Users className="h-3.5 w-3.5" /> : <UserIcon className="h-3.5 w-3.5" />}
                      {targetLabel(r)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{r.permissions.join(' / ')}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => setConfirmDelete(r)}
                      className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                      title={t('settings.revoke')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void del(confirmDelete)}
        title={t('settings.accessRules.revokeTitle')}
        message={t('settings.accessRules.revokeMessage', {
          target: confirmDelete ? targetLabel(confirmDelete) : '',
          effect: confirmDelete?.effect === 'allow' ? t('settings.accessRules.allow') : t('settings.accessRules.deny'),
        })}
        confirmText={t('settings.revoke')}
        variant="destructive"
      />
    </div>
  );
}
