// 管理员：挂载点配置
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Pencil, Eye, FolderOpen, ArrowUp, ArrowDown, GripVertical, Check } from 'lucide-react';
import { Card, Button, Input, Label, Badge, Dialog, ConfirmDialog, EmptyState, Switch } from '@/components/ui/core';
import { Dropdown, DropdownItem } from '@/components/ui/dropdown';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { TableSkeleton } from '@/components/ui/skeleton';
import { revealDelay } from '@/components/ui/reveal';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';

/** 角色权限矩阵条目（挂载点级 / 桶级同一形状；角色名复用 admin.* 词条） */
interface RolePermissionEntry {
  role: string;
  permissions: string[];
}

interface PoolMember {
  providerId: string;
  name: string;
  weight?: number;
  /** 池成员容量上限（字节）；null/缺省 = 不限（§29） */
  capacityBytes?: number | null;
  /** 仅 ordered 策略使用的上传顺序（§29） */
  sortOrder?: number | null;
  /** 桶级备用标记（§31）：备用桶不参与写入择优 */
  standby?: boolean;
  /** 桶级角色权限矩阵（§31）：有条目即封闭集合，无条目回落挂载点级矩阵 */
  rolePermissions?: RolePermissionEntry[];
}

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
  poolMembers: PoolMember[];
  /** 上传模式：free（默认）/ user_space / flat */
  uploadMode?: string;
  /** 默认角色权限矩阵：有条目即封闭集合（未列出的动作一律拒绝），无条目则回落角色默认 */
  rolePermissions?: RolePermissionEntry[];
}

interface Provider {
  id: string;
  name: string;
  type: string;
}

/** 权限矩阵的角色顺序（与后端角色词表一致；角色名文案复用 admin.* 既有词条） */
const ROLE_KEYS = ['admin', 'user', 'guest'] as const;
type RoleKey = (typeof ROLE_KEYS)[number];
/** 矩阵可配置的动作词表；不含 share——分享由能力位 can_share 控制，不在此设置 */
const PERMISSION_KEYS = ['read', 'write', 'update', 'delete', 'download'] as const;
/** 每个角色的权限集合：null = 不配置（跟随角色默认），[] = 有配置但该挂载点内全部拒绝 */
type RolePermissions = Record<RoleKey, string[] | null>;

/** 全「不配置」矩阵：可安全共享（编辑器只会整体替换，不会原地改写） */
const INHERIT_MATRIX: RolePermissions = { admin: null, user: null, guest: null };

const emptyRolePermissions = (): RolePermissions => ({ ...INHERIT_MATRIX });

/** 接口矩阵（数组形态）→ 编辑态（null = 不配置）；空权限条目与无条目等价 */
const rolePermissionsFromApi = (entries?: RolePermissionEntry[]): RolePermissions => {
  const matrix = emptyRolePermissions();
  for (const entry of entries ?? []) {
    const role = ROLE_KEYS.find((r) => r === entry.role);
    if (role && entry.permissions.length > 0) matrix[role] = [...entry.permissions];
  }
  return matrix;
};

/** 编辑态 → 接口矩阵（数组形态）：不配置的角色不出现 */
const rolePermissionsPayload = (matrix: RolePermissions): RolePermissionEntry[] =>
  ROLE_KEYS.filter((role) => matrix[role] != null).map((role) => ({ role, permissions: matrix[role] ?? [] }));

/** 挂载点弹窗：字段多且桶级设置要竖版分栏，用横屏宽尺寸；主体分 tab 限高滚动 */
const MOUNT_DIALOG_WIDTH = 'max-w-[min(1180px,94vw)]';
/** 「存储池」tab 主体：整块限高滚动 */
const MOUNT_POOL_BODY = 'mt-3 max-h-[62vh] space-y-4 overflow-y-auto scrollbar-thin pr-1';
/** 「具体桶」tab 主体：固定高度，左竖版 tab / 右设置各自滚动 */
const MOUNT_BUCKET_BODY = 'mt-3 flex h-[58vh] gap-4';
const TAB_POOL = 'pool';
const TAB_BUCKETS = 'buckets';

/** 角色权限矩阵编辑器：每行「不配置」开关 + 五个动作勾选（挂载点级与桶级共用，仅文案不同） */
function RoleMatrixEditor({
  value,
  onChange,
  label,
  inheritLabel,
  hint,
}: {
  value: RolePermissions;
  onChange: (next: RolePermissions) => void;
  label: string;
  inheritLabel: string;
  hint: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5 space-y-2">
        {ROLE_KEYS.map((role) => {
          const perms = value[role] ?? [];
          const inherit = value[role] == null;
          return (
            <div key={role} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span className="w-12 shrink-0 font-medium">{t(`admin.${role}`)}</span>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={inherit}
                  onChange={(e) => onChange({ ...value, [role]: e.target.checked ? null : [] })}
                  className="h-4 w-4 rounded border-border"
                />
                {inheritLabel}
              </label>
              <span className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', inherit && 'opacity-40')}>
                {PERMISSION_KEYS.map((perm) => (
                  <label key={perm} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      disabled={inherit}
                      checked={!inherit && perms.includes(perm)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...perms, perm] : perms.filter((p) => p !== perm);
                        // 后端把「有条目但权限为空」视为删除该角色条目（= 回落角色默认），这里直接落到不配置态
                        onChange({ ...value, [role]: next.length === 0 ? null : next });
                      }}
                      className="h-4 w-4 rounded border-border"
                    />
                    {t(`perm.${perm}`)}
                  </label>
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** 详情展示：逐角色权限摘要（无条目 = 跟随角色默认，空条目 = 全部拒绝）；compact = 单行摘要（桶总览用） */
function RoleMatrixSummary({ rolePermissions, compact }: { rolePermissions?: RolePermissionEntry[]; compact?: boolean }) {
  const { t } = useTranslation();
  const text = (role: RoleKey) => {
    const entry = (rolePermissions ?? []).find((r) => r.role === role);
    // 空权限条目与无条目等价（后端写入时会把空权限视为删除条目）
    return !entry || entry.permissions.length === 0
      ? t('admin.storageMounts.roleMatrixInherit')
      : entry.permissions.map((p) => t(`perm.${p}`)).join(' · ');
  };
  if (compact) {
    return (
      <span className="truncate">
        {ROLE_KEYS.map((role) => `${t(`admin.${role}`)}：${text(role)}`).join(' / ')}
      </span>
    );
  }
  return (
    <span className="space-y-1 text-right font-medium">
      {ROLE_KEYS.map((role) => (
        <span key={role} className="block">
          <span className="text-muted-foreground">{t(`admin.${role}`)}：</span>
          {text(role)}
        </span>
      ))}
    </span>
  );
}

/** 拼好桶写入策略（§29 五档） */
const POOL_STRATEGIES = ['least_used', 'round_robin', 'hash', 'free_weighted', 'ordered'] as const;
/** 策略 → 选项文案 / 行为说明的 i18n key 后缀 */
const STRATEGY_LABEL: Record<string, string> = {
  least_used: 'strategyLeastUsed',
  round_robin: 'strategyRoundRobin',
  hash: 'strategyHash',
  free_weighted: 'strategyFreeWeighted',
  ordered: 'strategyOrdered',
};
const STRATEGY_HINT: Record<string, string> = {
  least_used: 'strategyHintLeastUsed',
  round_robin: 'strategyHintRoundRobin',
  hash: 'strategyHintHash',
  free_weighted: 'strategyHintFreeWeighted',
  ordered: 'strategyHintOrdered',
};

/** 上传模式 → 当前档位说明的 i18n key 后缀（只显示所选档位的那一句，不并列三档） */
const UPLOAD_MODE_HINT: Record<string, string> = {
  free: 'Free',
  user_space: 'UserSpace',
  flat: 'Flat',
};

/** 池成员编辑态：容量上限按 GB 文本「留空 = 不限」，上传顺序按数字文本（缺省空 = 0），
    桶级矩阵按编辑态（null = 不配置），standby = 备用桶 */
type PoolMemberDraft = {
  selected: boolean;
  weight: number;
  capacityGb: string;
  sortOrder: string;
  standby: boolean;
  perms: RolePermissions;
  /** 回显时该桶是否已有桶级矩阵：后端把「缺省」当不改，把已配矩阵改回不配置必须显式下发 [] */
  loadedPerms: boolean;
};
type PoolDraft = Record<string, PoolMemberDraft>;

/** 合并单个成员的编辑态（缺省补全为未勾选 / 权重 1 / 不限 / 顺序空 / 非备用 / 不配置矩阵） */
const withMember = (draft: PoolDraft, id: string, patch: Partial<PoolMemberDraft>): PoolDraft => {
  const current: Partial<PoolMemberDraft> = draft[id];
  return {
    ...draft,
    [id]: {
      selected: false,
      weight: 1,
      capacityGb: '',
      sortOrder: '',
      standby: false,
      perms: INHERIT_MATRIX,
      loadedPerms: false,
      ...current,
      ...patch,
    },
  };
};

/** 由挂载点回显数据构造成员编辑态；未出现在池里的 provider 保持未勾选 */
const buildPoolDraft = (providerList: Provider[], members?: PoolMember[]): PoolDraft => {
  const byId: Record<string, PoolMember> = {};
  for (const m of members ?? []) byId[m.providerId] = m;
  const draft: PoolDraft = {};
  for (const p of providerList) {
    const m = byId[p.id];
    draft[p.id] = {
      selected: Boolean(m),
      weight: m?.weight ?? 1,
      capacityGb: m?.capacityBytes == null ? '' : String(Math.round((m.capacityBytes / 1024 ** 3) * 100) / 100),
      sortOrder: m?.sortOrder == null ? '' : String(m.sortOrder),
      standby: m?.standby ?? false,
      perms: rolePermissionsFromApi(m?.rolePermissions),
      loadedPerms: (m?.rolePermissions?.length ?? 0) > 0,
    };
  }
  return draft;
};

/** 已入池成员：按「顺序值升序 → 提供商列表次序」排列（顺序值为空串/非法一律按后端缺省 0）。
    首次重排前顺序值全为 0 时即按列表次序；重排后会归一化为去重的 1..N，与后端 ordered 的择优顺序一致；
    池内成员顺序也是「挂载的桶」列表的展示顺序。 */
const poolMemberIds = (providerList: Provider[], draft: PoolDraft): string[] => {
  const order = (id: string) => Number(draft[id]?.sortOrder ?? '') || 0;
  return providerList
    .map((p, index) => ({ id: p.id, index }))
    .filter((m) => draft[m.id]?.selected)
    .sort((a, b) => order(a.id) - order(b.id) || a.index - b.index)
    .map((m) => m.id);
};

/** 提交体：池成员全量替换（capacityBytes 留空 = 不限，sortOrder 缺省 0）。
    桶级矩阵：该桶配了矩阵或回显时本就有矩阵才下发（[] = 清空该桶矩阵）；两边都空则不下发（后端缺省 = 不改） */
const poolMembersPayload = (providerList: Provider[], draft: PoolDraft) =>
  providerList
    .filter((p) => draft[p.id]?.selected)
    .map((p) => {
      const m = draft[p.id];
      const gb = m?.capacityGb.trim() ?? '';
      const perms = rolePermissionsPayload(m?.perms ?? INHERIT_MATRIX);
      return {
        providerId: p.id,
        weight: m?.weight ?? 1,
        capacityBytes: gb === '' ? null : Math.round(Number(gb) * 1024 ** 3),
        sortOrder: m?.sortOrder ? Number(m.sortOrder) : 0,
        standby: Boolean(m?.standby),
        ...(perms.length > 0 || m?.loadedPerms ? { rolePermissions: perms } : {}),
      };
    });

/** GB 保留两位小数（校验提示与求和展示统一口径） */
const roundGb = (gb: number) => Math.round(gb * 100) / 100;

/** 总容量校验：各桶容量上限之和（仅统计已入池且设了上限的成员）+ 是否超限。
    挂载总上限应 ≤ 各桶容量总和；未设桶上限的桶不参与求和（无成员设上限时该规则不生效）。 */
const capCheck = (
  providerList: Provider[],
  draft: PoolDraft,
  maxStorageGb: string | undefined
): { sum: number; exceeded: boolean } => {
  let sum = 0;
  for (const id of poolMemberIds(providerList, draft)) {
    const raw = (draft[id]?.capacityGb ?? '').trim();
    const gb = Number(raw);
    if (raw !== '' && Number.isFinite(gb) && gb > 0) sum += gb;
  }
  const totalRaw = (maxStorageGb ?? '').trim();
  const total = Number(totalRaw);
  return { sum, exceeded: totalRaw !== '' && sum > 0 && Number.isFinite(total) && total > sum };
};

/** 写入策略下拉 + 当前档位的行为说明（ordered 档补一句去下方设置上传顺序的指引） */
function PoolStrategyField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <Label>{t('admin.storageMounts.poolStrategy')}</Label>
      <Select
        value={value}
        onValueChange={onChange}
        className="mt-1"
        options={POOL_STRATEGIES.map((s) => ({ value: s, label: t(`admin.storageMounts.${STRATEGY_LABEL[s]}`) }))}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        {t(`admin.storageMounts.${STRATEGY_HINT[value] ?? STRATEGY_HINT.least_used}`)}
        {value === 'ordered' && ` ${t('admin.storageMounts.orderedOrderHint')}`}
      </p>
    </div>
  );
}

/** 「添加桶」多选下拉：列出全部存储提供商，勾选即加入 / 取消勾选即移出存储池（统一菜单配方 + Portal 到 body）。 */
function AddBucketMenu({
  providers,
  value,
  onChange,
}: {
  providers: Provider[];
  value: PoolDraft;
  onChange: (next: PoolDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dropdown
      align="end"
      contentClass="min-w-[12rem]"
      trigger={
        <Button type="button" variant="outline" size="sm">
          <Plus className="h-4 w-4" />
          {t('admin.storageMounts.addBucket')}
        </Button>
      }
    >
      {providers.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('admin.storageMounts.bucketOverviewEmpty')}</div>
      ) : (
        providers.map((p) => {
          const selected = Boolean(value[p.id]?.selected);
          return (
            <DropdownItem
              key={p.id}
              selected={selected}
              onClick={() => onChange(withMember(value, p.id, { selected: !selected }))}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                )}
              >
                {selected && <Check className="h-3 w-3" />}
              </span>
              <span className="truncate">{p.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{p.type}</span>
            </DropdownItem>
          );
        })
      )}
    </Dropdown>
  );
}

/** 「挂载的桶」：只列**已入池**的桶（= 「具体桶」tab 的成员），按上传顺序排列。
    每行：拖动柄 + ↑↓ + 顺序值（仅 ordered 档可用）、容量上限、备用徽标；点行进入该桶的「具体桶」设置。
    加入 / 移出存储池由右上角「添加桶」多选下拉统一完成；主桶（后端 provider_id 锚点）不在此暴露。 */
function MountedBuckets({
  providers,
  value,
  onChange,
  ordered,
  onOpenBucket,
}: {
  providers: Provider[];
  value: PoolDraft;
  onChange: (next: PoolDraft) => void;
  ordered: boolean;
  onOpenBucket: (id: string) => void;
}) {
  const { t } = useTranslation();
  const sequence = poolMemberIds(providers, value);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  /** 重排后整体归一化为连续正整数 1..N */
  const renumber = (ids: string[]) =>
    ids.reduce((draft, memberId, index) => withMember(draft, memberId, { sortOrder: String(index + 1) }), value);

  /** 与相邻成员交换顺序（拖动之外保留键盘可达的排序方式） */
  const move = (id: string, delta: -1 | 1) => {
    const from = sequence.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= sequence.length) return;
    const next = [...sequence];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(renumber(next));
  };

  /** 拖放结束：把 fromId 落到 toId 的位置（拖动柄是唯一拖拽源，行只作落点） */
  const drop = (fromId: string, toId: string) => {
    if (!fromId || fromId === toId) return;
    const next = sequence.filter((id) => id !== fromId);
    const at = next.indexOf(toId);
    if (at < 0) return;
    next.splice(at, 0, fromId);
    onChange(renumber(next));
  };

  const moveUpLabel = t('admin.storageMounts.poolMemberMoveUp');
  const moveDownLabel = t('admin.storageMounts.poolMemberMoveDown');
  const dragLabel = t('admin.storageMounts.poolMemberDrag');
  const openLabel = t('admin.storageMounts.poolMemberOpen');

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Label>{t('admin.storageMounts.poolBuckets')}</Label>
        <AddBucketMenu providers={providers} value={value} onChange={onChange} />
      </div>
      {sequence.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{t('admin.storageMounts.poolBucketsEmpty')}</p>
      ) : (
        <div className="mt-1 space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-right">{!ordered && t('admin.storageMounts.poolMemberOrderHint')}</span>
            <span className="w-28 shrink-0">{t('admin.storageMounts.poolMemberCapacity')}</span>
            <span className="w-16 shrink-0 text-center">{t('admin.storageMounts.poolMemberOrder')}</span>
            <span className="w-14 shrink-0" />
          </div>
          {sequence.map((id, index) => {
            const provider = providers.find((x) => x.id === id);
            return (
              <div
                key={id}
                role="button"
                tabIndex={0}
                title={openLabel}
                onClick={() => onOpenBucket(id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenBucket(id);
                  }
                }}
                onDragOver={(e) => {
                  if (!dragging || dragging === id) return;
                  e.preventDefault();
                  setDragOver(id);
                }}
                onDragLeave={() => setDragOver((cur) => (cur === id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(e.dataTransfer.getData('text/plain'), id);
                  setDragging(null);
                  setDragOver(null);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md text-sm hover:bg-accent',
                  dragOver === id && 'bg-accent/60 ring-1 ring-primary/40',
                  dragging === id && 'opacity-50'
                )}
              >
                <span
                  tabIndex={-1}
                  draggable={ordered}
                  aria-label={dragLabel}
                  title={ordered ? dragLabel : t('admin.storageMounts.poolMemberOrderHint')}
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging(id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDragOver(null);
                  }}
                  className={cn(
                    'flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground',
                    ordered ? 'cursor-grab active:cursor-grabbing' : 'opacity-40'
                  )}
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{provider?.name ?? id} ({provider?.type ?? '—'})</span>
                  {value[id]?.standby && (
                    <Badge variant="warning" className="shrink-0">{t('admin.storageMounts.bucketStandby')}</Badge>
                  )}
                </span>
                <Input
                  type="number"
                  className="w-28 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                  value={value[id]?.capacityGb ?? ''}
                  onChange={(e) => onChange(withMember(value, id, { capacityGb: e.target.value }))}
                  placeholder={t('admin.storageMounts.poolMemberCapacityPlaceholder')}
                />
                <Input
                  type="number"
                  className="w-16 shrink-0"
                  disabled={!ordered}
                  onClick={(e) => e.stopPropagation()}
                  value={value[id]?.sortOrder ?? ''}
                  onChange={(e) => onChange(withMember(value, id, { sortOrder: e.target.value }))}
                  placeholder={String(index + 1)}
                />
                <span
                  className="flex w-14 shrink-0 items-center justify-end gap-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    disabled={!ordered || index === 0}
                    title={moveUpLabel}
                    aria-label={moveUpLabel}
                    onClick={() => move(id, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    disabled={!ordered || index === sequence.length - 1}
                    title={moveDownLabel}
                    aria-label={moveDownLabel}
                    onClick={() => move(id, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.poolHint')}</p>
    </div>
  );
}

/** 「具体桶」tab：左侧竖版 tab 只列**已入池**的桶（= 「挂载的桶」列表），右侧该桶的桶级矩阵 / 容量上限 / 备用开关。
    桶的加入 / 移出由「存储池」tab 的「添加桶」下拉完成。 */
function BucketSettings({
  providers,
  value,
  onChange,
  active,
  onActive,
}: {
  providers: Provider[];
  value: PoolDraft;
  onChange: (next: PoolDraft) => void;
  active: string;
  onActive: (id: string) => void;
}) {
  const { t } = useTranslation();
  const members = providers.filter((p) => value[p.id]?.selected);
  const currentId = members.some((p) => p.id === active) ? active : (members[0]?.id ?? '');
  const current = members.find((p) => p.id === currentId) ?? null;

  if (!current) {
    return <p className="text-sm text-muted-foreground">{t('admin.storageMounts.poolBucketsEmpty')}</p>;
  }

  const member = value[currentId];
  const matrix = member?.perms ?? INHERIT_MATRIX;
  const standby = Boolean(member?.standby);
  // 备用桶不参与写入择优：池内只剩最后一个非备用成员时禁止再标备用，否则写入没有落点
  const onlyActive = !standby && poolMemberIds(providers, value).filter((id) => !value[id]?.standby).length <= 1;

  return (
    <>
      {/* 左侧桶导航（样式对齐「默认用户设置」的角色竖 tab：active 用 text-primary + bg-primary/10） */}
      <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto scrollbar-thin pr-1">
        {members.map((p) => (
          <button
            key={p.id}
            type="button"
            data-active={currentId === p.id ? 'true' : 'false'}
            onClick={() => onActive(p.id)}
            className={cn(
              'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
              currentId === p.id
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <span className="block truncate">{p.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {p.type}
              {value[p.id]?.standby && ` · ${t('admin.storageMounts.bucketStandby')}`}
            </span>
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin pr-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{current.name}</span>
          <Badge variant="secondary">{current.type}</Badge>
          {standby && <Badge variant="warning">{t('admin.storageMounts.bucketStandby')}</Badge>}
        </div>

        <RoleMatrixEditor
          value={matrix}
          onChange={(next) => onChange(withMember(value, currentId, { perms: next }))}
          label={t('admin.storageMounts.bucketLevelMatrix')}
          inheritLabel={t('admin.storageMounts.inheritMountMatrix')}
          hint={t('admin.storageMounts.bucketMatrixHint')}
        />

        <div>
          <Label>{t('admin.storageMounts.poolMemberCapacity')}</Label>
          <Input
            type="number"
            className="mt-1"
            value={member?.capacityGb ?? ''}
            onChange={(e) => onChange(withMember(value, currentId, { capacityGb: e.target.value }))}
            placeholder={t('admin.storageMounts.poolMemberCapacityPlaceholder')}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.bucketHardCapHint')}</p>
        </div>

        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label>{t('admin.storageMounts.bucketStandby')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.bucketStandbyHint')}</p>
              {onlyActive && <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.standbyLastHint')}</p>}
            </div>
            <Switch
              checked={standby}
              disabled={onlyActive}
              onChange={(v) => onChange(withMember(value, currentId, { standby: v }))}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** 挂载点弹窗主体：新建与编辑共用同一套组件。
    「存储池」tab 左基础设置 / 右「挂载的桶」（+ 挂载点级默认矩阵）；「具体桶」tab 竖版选桶 + 桶级设置。 */
function MountDialogForm({
  providers,
  form,
  onField,
  pool,
  onPool,
  perms,
  onPerms,
  tab,
  onTab,
}: {
  providers: Provider[];
  form: Record<string, string>;
  onField: (key: string, value: string) => void;
  pool: PoolDraft;
  onPool: (next: PoolDraft) => void;
  perms: RolePermissions;
  onPerms: (next: RolePermissions) => void;
  tab: string;
  onTab: (next: string) => void;
}) {
  const { t } = useTranslation();
  const [activeBucket, setActiveBucket] = useState('');
  const strategy = form.poolStrategy ?? 'least_used';
  const cap = capCheck(providers, pool, form.maxStorageGb);
  const uploadMode = form.uploadMode ?? 'free';

  return (
    <Tabs value={tab} onValueChange={onTab} className="flex flex-col gap-3">
      <TabsList className="shrink-0 px-2">
        <TabsTrigger value={TAB_POOL}>{t('admin.storageMounts.tabPool')}</TabsTrigger>
        <TabsTrigger value={TAB_BUCKETS}>{t('admin.storageMounts.tabBuckets')}</TabsTrigger>
      </TabsList>

      <TabsContent value={TAB_POOL} className={MOUNT_POOL_BODY}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('admin.mountPath')}</Label>
                <Input className="mt-1" value={form.mountPath ?? ''} onChange={(e) => onField('mountPath', e.target.value)} placeholder="/images" />
              </div>
              <div>
                <Label>{t('files.name')}</Label>
                <Input className="mt-1" value={form.name ?? ''} onChange={(e) => onField('name', e.target.value)} placeholder={t('admin.storageMounts.namePlaceholder')} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>{t('admin.sortBy')}</Label>
                <Select
                  value={form.sortBy ?? 'name'}
                  onValueChange={(v) => onField('sortBy', v)}
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
                  onValueChange={(v) => onField('sortOrder', v)}
                  className="mt-1"
                  options={[
                    { value: 'asc', label: t('files.sortAsc') },
                    { value: 'desc', label: t('files.sortDesc') },
                  ]}
                />
              </div>
              <div>
                <Label>{t('admin.priority')}</Label>
                <Input type="number" className="mt-1" value={form.priority ?? '0'} onChange={(e) => onField('priority', e.target.value)} />
              </div>
            </div>
            <div>
              <Label>{t('admin.storageMounts.capacity')}</Label>
              <Input
                type="number"
                className="mt-1"
                value={form.maxStorageGb ?? ''}
                onChange={(e) => onField('maxStorageGb', e.target.value)}
                placeholder={t('admin.storageMounts.capacityPlaceholder')}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.capacityHint')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.bucketTotalCapHint')}</p>
              {cap.sum > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">{t('admin.storageMounts.bucketCapSum', { sum: roundGb(cap.sum) })}</p>
              )}
              {cap.exceeded && (
                <p className="mt-1 text-xs text-destructive">{t('admin.storageMounts.totalCapExceedsSum', { sum: roundGb(cap.sum) })}</p>
              )}
            </div>
            <PoolStrategyField value={strategy} onChange={(v) => onField('poolStrategy', v)} />
            <div>
              <Label>{t('admin.storageMounts.uploadMode')}</Label>
              <Select
                value={uploadMode}
                onValueChange={(v) => onField('uploadMode', v)}
                className="mt-1"
                options={[
                  { value: 'free', label: t('admin.storageMounts.uploadModeFree') },
                  { value: 'user_space', label: t('admin.storageMounts.uploadModeUserSpace') },
                  { value: 'flat', label: t('admin.storageMounts.uploadModeFlat') },
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(`admin.storageMounts.uploadModeHint${UPLOAD_MODE_HINT[uploadMode] ?? UPLOAD_MODE_HINT.free}`)}
              </p>
            </div>
          </div>

          <MountedBuckets
            providers={providers}
            value={pool}
            onChange={onPool}
            ordered={strategy === 'ordered'}
            onOpenBucket={(id) => {
              setActiveBucket(id);
              onTab(TAB_BUCKETS);
            }}
          />
        </div>

        {/* 挂载点级默认矩阵：桶级矩阵「不配置」的角色回落到这里 */}
        <div>
          <RoleMatrixEditor
            value={perms}
            onChange={onPerms}
            label={t('admin.storageMounts.roleMatrix')}
            inheritLabel={t('admin.storageMounts.roleMatrixInherit')}
            hint={t('admin.storageMounts.roleMatrixHint')}
          />
        </div>
      </TabsContent>

      <TabsContent value={TAB_BUCKETS} className={MOUNT_BUCKET_BODY}>
        <BucketSettings
          providers={providers}
          value={pool}
          onChange={onPool}
          active={activeBucket}
          onActive={setActiveBucket}
        />
      </TabsContent>
    </Tabs>
  );
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
  const [formPool, setFormPool] = useState<PoolDraft>({});
  const [editPool, setEditPool] = useState<PoolDraft>({});
  const [formPerms, setFormPerms] = useState<RolePermissions>(emptyRolePermissions);
  const [editPerms, setEditPerms] = useState<RolePermissions>(emptyRolePermissions);
  // 弹窗 tab 选中态：两个弹窗共用（同一时刻只开一个），每次打开重置回「存储池」
  const [dialogTab, setDialogTab] = useState<string>(TAB_POOL);
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
  const setEdit = (k: string, v: string) => setEditForm((f) => ({ ...f, [k]: v }));

  /** 提交体（新建 / 编辑共用）：挂载总上限、「挂载的桶」（池成员全量替换 + 桶级矩阵）与挂载点级矩阵。
      不下发 providerId（§32 主存储锚点）：后端按池内第一个非备用成员自行派生，UI 只管池成员。 */
  const mountPayload = (values: Record<string, string>, draft: PoolDraft, matrix: RolePermissions) => ({
    ...values,
    priority: Number(values.priority ?? 0),
    maxStorage: values.maxStorageGb ? Math.round(Number(values.maxStorageGb) * 1024 ** 3) : null,
    poolStrategy: values.poolStrategy ?? 'least_used',
    poolMembers: poolMembersPayload(providers, draft),
    uploadMode: values.uploadMode ?? 'free',
    rolePermissions: rolePermissionsPayload(matrix),
  });

  /** 提交前守卫：池内没有桶（无锚点）或总上限超各桶容量总和时，回到「存储池」tab 提示，不发请求 */
  const blockedByValidation = (draft: PoolDraft, values: Record<string, string>): boolean => {
    if (poolMemberIds(providers, draft).length === 0) {
      setDialogTab(TAB_POOL);
      toast('error', t('admin.storageMounts.poolBucketsRequired'));
      return true;
    }
    const cap = capCheck(providers, draft, values.maxStorageGb);
    if (!cap.exceeded) return false;
    setDialogTab(TAB_POOL);
    toast('error', t('admin.storageMounts.totalCapExceedsSum', { sum: roundGb(cap.sum) }));
    return true;
  };

  const create = async () => {
    if (blockedByValidation(formPool, form)) return;
    try {
      await apiFetch('/api/admin/mounts', {
        method: 'POST',
        body: mountPayload(form, formPool, formPerms),
      });
      toast('success', t('admin.storageMounts.added'));
      setShowCreate(false);
      setForm({});
      setFormPool({});
      setFormPerms(emptyRolePermissions());
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
    setDialogTab(TAB_POOL);
    setEditForm({
      mountPath: m.mountPath,
      name: m.name,
      sortBy: m.sortBy,
      sortOrder: m.sortOrder,
      priority: String(m.priority),
      maxStorageGb: m.maxStorage == null ? '' : String(Math.round((m.maxStorage / 1024 ** 3) * 100) / 100),
      poolStrategy: m.poolStrategy,
      uploadMode: m.uploadMode ?? 'free',
    });
    setEditPool(buildPoolDraft(providers, m.poolMembers));
    setEditPerms(rolePermissionsFromApi(m.rolePermissions));
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (blockedByValidation(editPool, editForm)) return;
    try {
      await apiFetch(`/api/admin/mounts/${editing.id}`, {
        method: 'PUT',
        body: mountPayload(editForm, editPool, editPerms),
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
        <Button onClick={() => { setDialogTab(TAB_POOL); setShowCreate(true); }}><Plus className="h-4 w-4" /> {t('admin.addMount')}</Button>
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
            ) : sortedRows.map((m, i) => (
              <tr key={m.id} className="reveal border-b last:border-0 hover:bg-accent/50" style={revealDelay(i, 'inner')}>
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
        width={MOUNT_DIALOG_WIDTH}
        title={t('admin.addMount')}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={create}>{t('common.create')}</Button>
          </>
        }
      >
        <MountDialogForm
          providers={providers}
          form={form}
          onField={set}
          pool={formPool}
          onPool={setFormPool}
          perms={formPerms}
          onPerms={setFormPerms}
          tab={dialogTab}
          onTab={setDialogTab}
        />
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
                t('admin.storageMounts.poolBuckets'),
                detail.poolMembers.length > 0
                  ? `${detail.poolMembers.map((p) => `${p.name}${p.standby ? `（${t('admin.storageMounts.bucketStandby')}）` : ''}`).join(' · ')}（${detail.poolStrategy}）`
                  : t('admin.storageMounts.unlimited'),
              ],
              [
                t('admin.storageMounts.capacity'),
                detail.maxStorage == null
                  ? t('admin.storageMounts.unlimited')
                  : `${formatBytes(detail.usedStorage + detail.quotaReserved)} / ${formatBytes(detail.maxStorage)}`,
              ],
              [
                t('admin.storageMounts.uploadMode'),
                t(`admin.storageMounts.uploadMode${detail.uploadMode === 'user_space' ? 'UserSpace' : detail.uploadMode === 'flat' ? 'Flat' : 'Free'}`),
              ],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b pb-2 text-sm last:border-0">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
            <div className="flex items-start justify-between gap-4 text-sm">
              <span className="shrink-0 text-muted-foreground">{t('admin.storageMounts.roleMatrix')}</span>
              <RoleMatrixSummary rolePermissions={detail.rolePermissions} />
            </div>
          </div>
        )}
      </Dialog>

      {/* 编辑挂载点 */}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        width={MOUNT_DIALOG_WIDTH}
        title={t('admin.storageMounts.editTitle', { path: editing?.mountPath ?? '' })}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button onClick={saveEdit}>{t('common.save')}</Button>
          </>
        }
      >
        <MountDialogForm
          providers={providers}
          form={editForm}
          onField={setEdit}
          pool={editPool}
          onPool={setEditPool}
          perms={editPerms}
          onPerms={setEditPerms}
          tab={dialogTab}
          onTab={setDialogTab}
        />
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
