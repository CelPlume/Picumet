// 设置 → 访问规则（§4.4b UI）：管理自己创建的授权/禁止规则
// 创建入口在文件属性面板（选中文件上下文）；本页负责列表与撤销。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Users, User as UserIcon, Trash2 } from 'lucide-react';
import type { PathRule } from '@shared/types';
import { Card, Button, Badge, ConfirmDialog } from '@/components/ui/core';
import { TableSkeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/utils';

interface UserRule extends PathRule {
  createdBy?: string;
}

function targetLabel(rule: UserRule): string {
  if (rule.role === 'user') return '全部用户';
  if (rule.userId) return `用户 ${rule.userId.slice(0, 8)}`;
  if (rule.apiKeyId) return `API 密钥 ${rule.apiKeyId.slice(0, 8)}`;
  return '未知';
}

export default function AccessRulesPage() {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<UserRule | null>(null);

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
      toast('success', '已撤销规则');
      await qc.invalidateQueries({ queryKey: ['user-rules'] });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '撤销失败');
    }
    setConfirmDelete(null);
  };

  const rules = data ?? [];

  return (
    <div>
      <p className="text-sm text-muted-foreground">
        允许或禁止其他用户访问你的文件。创建入口：文件详情 → 属性面板 →「访问规则」。管理员规则优先级恒高于用户规则。
      </p>

      <Card className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2">路径</th>
              <th className="px-4 py-2">效果</th>
              <th className="px-4 py-2">目标</th>
              <th className="px-4 py-2">权限</th>
              <th className="px-4 py-2">创建时间</th>
              <th className="px-4 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6}><TableSkeleton rows={4} cols={5} /></td></tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  暂无规则
                </td>
              </tr>
            ) : (
              rules.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-2 font-mono text-xs">{r.pathPattern}</td>
                  <td className="px-4 py-2">
                    <Badge variant={r.effect === 'allow' ? 'success' : 'warning'}>
                      {r.effect === 'allow' ? '允许' : '禁止'}
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
                      title="撤销"
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
        title="撤销访问规则"
        message={`确认撤销针对「${confirmDelete ? targetLabel(confirmDelete) : ''}」的${confirmDelete?.effect === 'allow' ? '允许' : '禁止'}规则？该路径将立即恢复默认访问行为。`}
        confirmText="撤销"
        variant="destructive"
      />
    </div>
  );
}
