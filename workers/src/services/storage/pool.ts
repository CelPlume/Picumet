// 存储池（§E）：写路径按策略选桶，读/删路径按文件自身 provider_id 定位。
// 池成员在 mount_providers；成员为空时回退 mounts.provider_id（单桶语义）。
//
// 放置流程（§30）：策略只负责给出**候选次序**，落桶 = 按次序依次尝试成员级原子预留
// （条件 UPDATE 判定 `used(聚合) + quota_reserved + 待写大小 <= capacity_bytes`）的第一个成功者；
// 候选全部放不下 → ApiError(413, 'MOUNT_QUOTA_EXCEEDED')。容量是硬上限，五档策略一律受约束：
// 首选成员装不下待写对象时按策略次序回退到其余成员，而不是「先按策略选中、再看它是否已满」。
//
// 五档策略（与 shared/types.ts 的 PoolStrategy 一一对应）：
// 1. least_used（默认）ratio = (成员已用 + 1) / weight 取最小；平局按 provider_id 升序。
// 2. round_robin      KV 计数器轮转，均摊写入；计数器缺失从 0 开始。计数只在**预留成功**后推进，
//                     起始成员装不下时按轮转次序顺延（顺延不算一轮）。
// 3. hash             对「挂载内相对父目录路径」做 fnv1a 取模（挂载根 = '/'）→ 目录粘性：
//                     同目录文件落同一桶，便于按前缀查找/列举；成员集不变则落桶不变。
//                     基准取挂载内相对路径（与 object_key 基准一致）：管理员改挂载路径（迁移）时落桶不重排；
//                     若用绝对路径，改挂载路径会让所有目录的哈希整体重排、落桶全变。
//                     老文件不受影响（读路径按 file_metadata.provider_id 定位），只影响新写入。
//                     哈希命中的成员装不下时按取模次序顺延（粘性让位于容量硬上限）。
// 4. free_weighted    未配容量的成员 = 不限（余量 +∞），优先于任何有限余量，「不限」成员间按 weight 降序；
//                     配了容量的成员余量 = capacity − 已用 − 在途预留，评分 = 余量 × weight 降序。
//                     全部成员都未配容量 → 退化为 least_used（避免既有挂载点行为突变）。
// 5. ordered          按 sort_order 升序（同序按 provider_id）依次尝试；未配容量 = 不限 → 永远入选
//                     （即「填满一个再下一个」）。
//
// 用量口径：file_metadata 中 type='file' 的行按 provider_id 归属；存量行 provider_id IS NULL 回退主 provider。
// 候选次序的计算只看「已用」（一次 GROUP BY 聚合）；最终是否放得下由成员级预留的条件 UPDATE 原子裁定。
// 未配置池成员的存量挂载（mount_providers 无行）没有容量配置 → 不预留、不判满，与池化前行为一致。
//
// §32 备用桶不参与写入：候选集合 = 池内 `standby = 0` 的成员（writableMembers，见 db/repos/storage.ts），
// 策略次序/取模/评分/轮转计数全部只在该子集上计算；备用桶只作**读回退**候选（§G 用池成员全集）。
// 全部成员都被标为备用是配置错误（管理端保存时已拒绝）→ 万一发生（直改库）拒写 409 OPERATION_FAILED。
import type { Mount, StorageProvider } from '@shared/types';
import { Db, MountProviderQuotaRepo, MountProviderRepo, MountProviderRolePermissionsRepo, ProviderRepo, num, writableMembers, type MountProviderMember } from '../../db';
import type { Env } from '../../shared/types';
import { ApiError } from '../../shared/errors';
import { bucketMatrixDecision } from '../permissions/check';
import { getProvider } from './providers';
import type { StorageProviderInterface } from './types';

/** FNV-1a 32 位：稳定路径哈希（hash 策略的确定性路由，跨进程一致） */
function fnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 无容量配置的合成成员（未配置池成员的存量挂载 / 覆盖写粘住但已移出池的 provider） */
function soloMember(providerId: string): MountProviderMember {
  return { providerId, weight: 1, capacityBytes: null, sortOrder: 0, standby: false, quotaReserved: 0 };
}

/** 候选次序：把 members 旋转到 start 起始（start 可越界/为负，取模归一） */
function rotate(members: MountProviderMember[], start: number): MountProviderMember[] {
  if (members.length <= 1) return members;
  const i = ((start % members.length) + members.length) % members.length;
  return [...members.slice(i), ...members.slice(0, i)];
}

/** hash 粘性键：挂载内相对父目录路径（挂载根 = '/'，即文件行的 path 去掉文件名） */
function stickyDirKey(mount: Mount, targetPath: string): string {
  const rel =
    targetPath === mount.mountPath
      ? ''
      : targetPath.startsWith(`${mount.mountPath}/`)
        ? targetPath.slice(mount.mountPath.length)
        : targetPath;
  const cut = rel.lastIndexOf('/');
  return cut <= 0 ? '/' : rel.slice(0, cut);
}

/** 各成员已用字节：一次 GROUP BY 聚合；provider_id 为 NULL 的存量行记在主 provider 名下 */
async function usageByProvider(db: Db, mount: Mount, members: MountProviderMember[]): Promise<Map<string, number>> {
  const usage = new Map(members.map((m) => [m.providerId, 0]));
  const rows = await db.all(
    `SELECT provider_id AS pid, COALESCE(SUM(size), 0) AS s FROM file_metadata
     WHERE mount_id = ? AND type = 'file' GROUP BY provider_id`,
    [mount.id]
  );
  for (const row of rows) {
    const providerId = row.pid == null ? mount.providerId : String(row.pid);
    if (usage.has(providerId)) usage.set(providerId, (usage.get(providerId) ?? 0) + num(row.s));
  }
  return usage;
}

/** least_used：ratio = (已用 + 1) / weight 升序；平局按 provider_id 升序（稳定） */
async function orderLeastUsed(db: Db, mount: Mount, members: MountProviderMember[]): Promise<MountProviderMember[]> {
  const usage = await usageByProvider(db, mount, members);
  return [...members].sort((a, b) => {
    const ra = ((usage.get(a.providerId) ?? 0) + 1) / a.weight;
    const rb = ((usage.get(b.providerId) ?? 0) + 1) / b.weight;
    return ra !== rb ? ra - rb : a.providerId.localeCompare(b.providerId);
  });
}

/** free_weighted：不限容量成员优先（按 weight 降序），其余按「余量 × 权重」降序（余量含在途预留） */
async function orderFreeWeighted(db: Db, mount: Mount, members: MountProviderMember[]): Promise<MountProviderMember[]> {
  // 全部未配容量 = 无任何容量约束，退化为 least_used
  if (members.every((m) => m.capacityBytes == null)) return orderLeastUsed(db, mount, members);

  const usage = await usageByProvider(db, mount, members);
  const score = (m: MountProviderMember): number =>
    m.capacityBytes == null
      ? Number.POSITIVE_INFINITY
      : (m.capacityBytes - (usage.get(m.providerId) ?? 0) - m.quotaReserved) * m.weight;
  return [...members].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    // 同为不限容量（+∞）时按 weight 降序；有限余量并列时按 provider_id 升序
    return Number.isFinite(sa)
      ? a.providerId.localeCompare(b.providerId)
      : b.weight - a.weight || a.providerId.localeCompare(b.providerId);
  });
}

/** ordered：sort_order 升序（同序按 provider_id），未配容量成员先于满员成员 */
function orderOrdered(members: MountProviderMember[]): MountProviderMember[] {
  return [...members].sort((a, b) =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.providerId.localeCompare(b.providerId)
  );
}

/** 策略候选次序（首个 = 策略首选；单成员池不经过策略，故调用方对 members.length === 1 短路） */
async function orderCandidates(
  db: Db,
  mount: Mount,
  targetPath: string,
  env: Env,
  members: MountProviderMember[]
): Promise<MountProviderMember[]> {
  switch (mount.poolStrategy) {
    case 'hash':
      return rotate(members, fnv1a(stickyDirKey(mount, targetPath)));
    case 'round_robin': {
      const current = Number((await env.KV.get(`pool:rr:${mount.id}`)) ?? '0') || 0;
      return rotate(members, current);
    }
    case 'free_weighted':
      return orderFreeWeighted(db, mount, members);
    case 'ordered':
      return orderOrdered(members);
    default:
      return orderLeastUsed(db, mount, members);
  }
}

/** round_robin：只在预留成功后推进计数器（落桶成员的下一个位置） */
async function advanceRoundRobin(
  env: Env,
  mount: Mount,
  members: MountProviderMember[],
  placedProviderId: string
): Promise<void> {
  const idx = members.findIndex((m) => m.providerId === placedProviderId);
  await env.KV.put(`pool:rr:${mount.id}`, String(((idx < 0 ? 0 : idx + 1) % members.length)));
}

export interface PickWriteOpts {
  /** 覆盖写：原落桶成员作为首选候选（装不下才按策略回退）；缺省无偏好 */
  preferProviderId?: string | null;
  /**
   * false = 只做容量判定、不持有成员预留。
   * 供「用量在事务内同步转移、不存在在途窗口」的入口使用（跨挂载移动，与 MountQuotaRepo.transferUsage 同语义）；
   * 写路径一律保持缺省 true，由调用方在成功/失败/补偿处释放。
   */
  reserve?: boolean;
  /**
   * §31 发起者的角色：传入时在候选循环里判定桶级矩阵——候选桶对该角色**明确禁止该动作** → 跳过该候选
   * （等价于放不下，策略依旧只决定候选次序）；全部候选都被桶级矩阵拒绝 → 403 FORBIDDEN（而非 413）。
   * 缺省（无主体语义的调用）不判定，行为与既有一致。
   */
  principalRole?: string | null;
}

/**
 * 写路径选桶：返回 provider 配置行（调用方用它算对象键 pathPrefix + 实例化写入），
 * 并在选中的池成员上原子预留 size 字节（size = 待写对象大小；未知传 0）。
 * 候选按策略次序逐个尝试：桶级矩阵拒绝（§31）与容量放不下（§30）都跳过该候选，
 * 全部候选都被桶级矩阵拒绝 → 403 FORBIDDEN；其余全放不下 → 413；成员的 provider 行全部缺失才 404。
 */
export async function pickWriteProvider(
  db: Db,
  mount: Mount,
  targetPath: string,
  env: Env,
  size: number,
  opts: PickWriteOpts = {}
): Promise<StorageProvider> {
  const reserve = opts.reserve !== false;
  const memberRows = await MountProviderRepo.listMembers(db, mount.id);
  const members = memberRows.length > 0 ? memberRows : [soloMember(mount.providerId)];
  // §32 写入只落「非备用桶」：备用桶是读回退候选（§G 用池成员全集），不参与放置。
  // 成员集与次序都只在可写子集上计算（策略次序、round_robin 计数器、hash 取模、评分口径全部只含非备用成员）。
  const writable = writableMembers(members);
  if (writable.length === 0) {
    // 只可能来自「绕过管理端校验直改库」（保存时已保证至少一个非备用桶）：配置坏掉 → 拒写而不是静默落备用桶
    throw new ApiError(
      409,
      'OPERATION_FAILED',
      '存储池没有可用于写入的非备用桶（全部成员都被标记为备用），请至少保留一个非备用桶'
    );
  }
  // 未配置池成员的存量挂载（表为空）没有容量配置：不预留、不判满（回归池化前行为）
  const poolMemberIds = new Set(memberRows.map((m) => m.providerId));
  const ordered = writable.length === 1 ? writable : await orderCandidates(db, mount, targetPath, env, writable);
  // 覆盖写偏好：原落桶成员作为首选候选（装不下才按策略回退）；它已被移出池时保持粘性，
  // 但它若仍在池内且被标为备用，则不再优先（备用桶不参与写入）。
  const preferred = opts.preferProviderId
    ? (writable.find((m) => m.providerId === opts.preferProviderId) ??
      (poolMemberIds.has(opts.preferProviderId) ? null : soloMember(opts.preferProviderId)))
    : null;
  const candidates = preferred ? [preferred, ...ordered.filter((m) => m.providerId !== preferred.providerId)] : ordered;

  let sawMemberRow = false;
  let judged = 0;
  let bucketDenied = 0;
  for (const member of candidates) {
    const row = await ProviderRepo.getProviderById(db, member.providerId);
    if (!row) continue; // 池成员行残留但 provider 已删除 → 换下一个候选
    sawMemberRow = true;
    judged += 1;
    // §31 桶级矩阵：该候选桶对当前角色明确禁止此动作 → 跳过（等价于放不下；策略次序不变）
    if (opts.principalRole) {
      const bucketMatrix = await MountProviderRolePermissionsRepo.getMatrix(db, mount.id, member.providerId);
      if (bucketMatrixDecision(opts.principalRole, 'write', bucketMatrix) === 'deny') {
        bucketDenied += 1;
        continue;
      }
    }
    // 非池成员（覆盖写粘住的原落桶 provider 已被移出池）与未配容量的成员都没有硬上限 →
    // 跳过成员级预留（不判满、不记账），直接放行（保持粘性语义与池化前行为）
    if (poolMemberIds.has(member.providerId) && member.capacityBytes != null) {
      const placeable = reserve
        ? await MountProviderQuotaRepo.reserve(db, mount.id, member.providerId, mount.providerId, size)
        : await MountProviderQuotaRepo.fits(db, mount.id, member.providerId, mount.providerId, size);
      if (!placeable) continue;
    }
    // round_robin 计数器在**可写成员**上推进（备用桶不占轮转位，成员集变化时次序仍确定）
    if (reserve && writable.length > 1 && mount.poolStrategy === 'round_robin') {
      await advanceRoundRobin(env, mount, writable, member.providerId);
    }
    return row;
  }

  if (!sawMemberRow) {
    // 池成员的 provider 行全部缺失：回退挂载主 provider（与池化前的单桶行为一致；它也没有容量配置可判）
    const fallback = await ProviderRepo.getProviderById(db, mount.providerId);
    if (!fallback) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
    return fallback;
  }
  // 全部候选都被桶级矩阵拒绝（无一放行到容量判定）→ 403；否则是容量问题 → 413
  if (bucketDenied > 0 && bucketDenied === judged) {
    throw new ApiError(403, 'FORBIDDEN', '当前存储桶的角色权限不允许此操作');
  }
  throw new ApiError(413, 'MOUNT_QUOTA_EXCEEDED', '存储池成员容量不足');
}

/** 读/删路径定位：文件实际落桶优先，缺失回退挂载主 provider */
export async function resolveFileProviderId(db: Db, file: { providerId?: string | null }, mount: Mount): Promise<string> {
  const providerId = file.providerId ?? mount.providerId;
  const row = await ProviderRepo.getProviderById(db, providerId);
  return row ? providerId : mount.providerId;
}

/** 读路径实例化：按文件落桶 provider 构造实例（池内文件分散时读路径与写路径解耦） */
export async function getProviderForFile(
  db: Db,
  file: { providerId?: string | null },
  mount: Mount,
  env: Env
): Promise<StorageProviderInterface> {
  const providerId = await resolveFileProviderId(db, file, mount);
  const row = await ProviderRepo.getProviderById(db, providerId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return getProvider(db, row, env);
}
