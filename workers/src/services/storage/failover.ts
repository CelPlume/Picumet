// 读路径容灾（§G）：文件落桶不可用时按「池成员」顺序轮询其余桶取回对象。
//
// 本模块只读不写副桶——镜像数据的写入/同步在项目之外（外部同步通道或云厂商侧复制），
// 后端在 A（文件落桶）读不到时改向 B（其余池成员）取回。三条规则：
// - 候选顺序：命中提示（物理键指纹一致才采纳）→ 文件落桶 → 其余池成员（weight 降序、id 升序）。
//   上游故障过的桶带 KV 熔断标记，排到候选末尾（仍留一次兜底尝试 = 恢复探测），
//   避免 A 悬挂时每个请求都先等满 8s 超时才转向 B。
// - 回退校验：非记录桶命中后先按元数据 size 校验，不符视作该候选不可用（宁可 404 也不给旧/坏内容）。
//   对象带 sha256 元数据且文件 blobHash 已知时再比对哈希。
//   etag 不参与判定：不同后端与上传路径（rclone 同步、multipart）的 etag 语义不同，硬拒会误杀合法镜像。
// - 读侧权限：调用方传入 principalRole 时，逐候选重判桶级（§31）与挂载点级（§28）矩阵；deny 的候选跳过，
//   无一成功且有被拒候选 → 403（写侧 pickWriteProvider 已在候选桶上判定，此处补齐读侧）。
// - 位置提示：副桶命中写提示（TTL 10 分钟、每次命中续期）；记录桶恢复供数时主动清除提示。
import { ApiError } from '../../shared/errors';
import type { Db } from '../../db';
import { MountProviderRepo, MountProviderRolePermissionsRepo, MountRepo, MountRolePermissionsRepo, ProviderRepo } from '../../db';
import type { Mount } from '@shared/types';
import type { Env } from '../../shared/types';
import { bucketMatrixDecision } from '../permissions/check';
import { mountMatrixDecision } from '../permissions/principal';
import { getProvider } from './providers';
import { serveObject } from './serve';
import { ProviderError } from './errors';
import type { ObjectBody, StorageProviderInterface } from './types';

/**
 * 单文件读取的候选上限：与 `PoolMemberSchema` 的 `max(20)` 对齐——合法池规模（5—20 成员）不再被静默截断。
 * 候选已有 KV 熔断把故障桶排到末尾，遍历成本受池规模上限约束。
 */
const MAX_CANDIDATES = 20;
/** 命中位置提示 TTL（秒）：命中即续期，记录桶恢复后最多这么久回到主桶 */
const HINT_TTL = 600;
/** 单个候选的单次尝试上限：主桶连接悬挂时不能拖死整个读请求（超时即换下一个候选） */
const ATTEMPT_TIMEOUT_MS = 8000;
/** 熔断标记 TTL（秒）：上游故障的桶在此期间排到候选末尾（兜底尝试仍会触发恢复探测） */
const DOWN_TTL = 45;
/**
 * 对象 sha256 元数据键：内容寻址写入方（content.ts）以此键把内容 SHA-256 写进对象
 * customMetadata；回退读取非记录桶命中时据此与文件 `blobHash` 比对。元数据缺失（未知哈希暂存路径、
 * 外部镜像/旧对象）时回落 size 校验——镜像同步在系统外，不能要求每个对象都带该元数据。
 */
export const OBJECT_HASH_METADATA_KEY = 'sha256';

/** 读取目标（文件行或下载令牌载荷都可用它表达） */
export interface FileObjectRef {
  /** 文件 id（可取时用于命中位置提示） */
  fileId?: string;
  mountId: string;
  /** 库内记录的落桶（NULL = 存量行，回退挂载主 provider） */
  providerId?: string | null;
  /** 物理对象键（§F） */
  physicalKey: string;
  /** 元数据记录的对象大小；回退命中时用它校验（缺省不校验） */
  size?: number;
  /** 元数据记录的内容 SHA-256（§F）；回退对象带 sha256 元数据时与之比对（缺省不比对） */
  blobHash?: string | null;
}

interface FailoverContext {
  db: Db;
  env: Env;
  ref: FileObjectRef;
  /** 已解析的挂载点（缺省按 ref.mountId 读取，避免调用方重复查询） */
  mount?: Mount;
  /**
   * §31/§28 读侧补判的发起者角色：传入时对**每个候选 provider** 判定桶级矩阵与挂载点级矩阵，
   * 条目明确 deny 该动作的候选跳过；没有任何候选成功且存在被权限拒绝的候选 → 403 FORBIDDEN。
   * 缺省（无主体语义的内部调用）不判定，行为与既有一致。写侧 `pickWriteProvider` 已在候选桶上判定，此处补齐读侧。
   */
  principalRole?: string | null;
  /** 读取动作（下载 'download'、预览/读 'read'），缺省 'read'；仅 principalRole 传入时参与判定 */
  action?: 'read' | 'download';
}

export interface GetFileObjectOptions extends FailoverContext {
  range?: { start: number; end: number };
}

/** 解析后的对象读取结果 */
export interface FileObjectResult {
  provider: StorageProviderInterface;
  providerId: string;
  object: ObjectBody;
}

function hintKey(fileId: string): string {
  return `serve:loc:${fileId}`;
}

function downKey(providerId: string): string {
  return `pool:down:${providerId}`;
}

/**
 * 候选 provider 顺序：KV 命中提示（物理键一致**且属于本挂载池**才采纳）→ 文件落桶 → 其余池成员
 * （weight 降序、id 升序）。去重后截断到 MAX_CANDIDATES；hinted 回带提示对象，供记录桶恢复后清提示。
 * 提示只校验物理键——跨挂载迁移（或历史数据）后提示可能指向**目标挂载池之外**的桶，
 * 候选顺序会脱离挂载的桶级矩阵语义；采纳前先校验其为本挂载成员（或文件当前落桶）。
 */
async function candidateProviderIds(
  env: Env,
  db: Db,
  mount: Mount,
  ref: FileObjectRef
): Promise<{ ids: string[]; hinted?: string }> {
  const primaryId = ref.providerId ?? mount.providerId;
  const members = await MountProviderRepo.listMembers(db, mount.id);
  const poolIds = new Set((members.length > 0 ? members : [{ providerId: mount.providerId, weight: 1 }]).map((m) => m.providerId));
  poolIds.add(primaryId);
  const ids: string[] = [];
  let hinted: string | undefined;

  if (ref.fileId) {
    try {
      const raw = await env.KV.get(hintKey(ref.fileId));
      if (raw) {
        const hint = JSON.parse(raw) as { p?: string; k?: string };
        // 物理键不一致说明文件已被改写/搬迁，提示作废；不属于本挂载池的提示同样作废
        if (hint.p && hint.k === ref.physicalKey && poolIds.has(hint.p)) {
          ids.push(hint.p);
          hinted = hint.p;
        }
      }
    } catch {
      // KV 异常不影响主流程（提示只是加速）
    }
  }

  ids.push(primaryId);
  const rest = (members.length > 0 ? members : [{ providerId: mount.providerId, weight: 1 }])
    .filter((m) => !ids.includes(m.providerId))
    .sort((a, b) => (a.weight !== b.weight ? b.weight - a.weight : a.providerId.localeCompare(b.providerId)));
  for (const member of rest) ids.push(member.providerId);
  return { ids: ids.slice(0, MAX_CANDIDATES), hinted };
}

/** 单次尝试加超时（超时视作该候选不可用；被放弃的请求后台自然结束） */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(502, 'UPSTREAM_ERROR', '存储上游超时')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** 熔断标记查询（KV 异常一律视作"未熔断"，熔断只是加速手段） */
async function isProviderDown(env: Env, providerId: string): Promise<boolean> {
  try {
    return (await env.KV.get(downKey(providerId))) !== null;
  } catch {
    return false;
  }
}

/** 标记上游故障：之后 DOWN_TTL 秒内该桶排到候选末尾 */
async function markProviderDown(env: Env, providerId: string): Promise<void> {
  try {
    await env.KV.put(downKey(providerId), '1', { expirationTtl: DOWN_TTL });
  } catch {
    // 忽略：熔断只是加速手段
  }
}

/** 清除熔断标记（兜底尝试命中即恢复） */
async function clearProviderDown(env: Env, providerId: string): Promise<void> {
  try {
    await env.KV.delete(downKey(providerId));
  } catch {
    // 忽略
  }
}

/** 记住副桶命中位置（带物理键指纹；写入失败只影响下次加速） */
async function rememberLocation(env: Env, ref: FileObjectRef, providerId: string): Promise<void> {
  if (!ref.fileId) return;
  try {
    await env.KV.put(hintKey(ref.fileId), JSON.stringify({ p: providerId, k: ref.physicalKey }), { expirationTtl: HINT_TTL });
  } catch {
    // 忽略：提示只是加速手段
  }
}

/** 清除位置提示：记录桶重新供数后不再优先走副桶 */
async function forgetLocation(env: Env, ref: FileObjectRef): Promise<void> {
  if (!ref.fileId) return;
  try {
    await env.KV.delete(hintKey(ref.fileId));
  } catch {
    // 忽略
  }
}

/**
 * 回退命中的内容校验：以元数据 size 为准（记录侧未记大小、或上游未回报大小时放行，保证可用性）。
 * 不符 = 该候选不可用：镜像同步不完整或对象被顶替时，宁可 404 也不把旧/坏内容给用户。
 */
function contentMatches(ref: FileObjectRef, actualSize: number | undefined): boolean {
  if (ref.size == null || ref.size <= 0) return true;
  if (actualSize == null) return true;
  return actualSize === ref.size;
}

/**
 * 回退命中的内容哈希校验：对象带 sha256 元数据且文件 blobHash 已知时，两者不一致 = 该候选
 * 不可用（镜像同步滞后/对象被顶替）。任一侧缺失 → true（回落 size 校验，镜像与写入路径不保证带元数据）。
 */
function hashMatches(ref: FileObjectRef, metadata: Record<string, string> | undefined): boolean {
  const actual = metadata?.[OBJECT_HASH_METADATA_KEY];
  if (!actual || !ref.blobHash) return true;
  return actual.toLowerCase() === ref.blobHash.toLowerCase();
}

/** 校验不通过时丢弃已读回的响应体（只有 serve 路径会拿到 Response），避免连接悬挂 */
async function disposeRejected(value: unknown): Promise<void> {
  if (!(value instanceof Response)) return;
  try {
    await value.body?.cancel();
  } catch {
    // 忽略：连接已断开
  }
}

/**
 * 按候选顺序执行读取；「对象不存在（null）」与 404/502/上游故障都触发回退，
 * 其余错误（如 416 越界）原样抛出。候选全失败时抛出最后一次的 404/502。
 *
 * 熔断只对「上游故障」生效：对象缺失是数据状态而非桶健康问题，不标记、不改变顺序。
 * 回退命中（非记录桶）先过 verify 再返回。
 * 传入 principalRole 时，逐候选判定桶级（§31）+ 挂载点级（§28）矩阵：deny 的候选跳过（写侧
 * pickWriteProvider 已在候选桶上判定，此处补齐读侧）；没有任何候选成功且
 * 存在被权限拒绝的候选 → 403（不把「备用桶拒绝」当成「对象不存在」，也不从被拒桶读出）。
 */
async function tryCandidates<T>(
  ctx: FailoverContext,
  attempt: (provider: StorageProviderInterface, providerId: string, isRecorded: boolean) => Promise<T | null>,
  verify?: (value: T) => boolean
): Promise<{ provider: StorageProviderInterface; providerId: string; value: T }> {
  const { db, env, ref } = ctx;
  const mount = ctx.mount ?? (await MountRepo.getMountById(db, ref.mountId));
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const primaryId = ref.providerId ?? mount.providerId;
  const { ids, hinted } = await candidateProviderIds(env, db, mount, ref);
  // §28/§31 读侧候选桶权限：挂载点级矩阵对整个挂载生效，加载一次；桶级矩阵逐候选判定。
  // 未传 principalRole（无主体语义的内部调用）时完全不查矩阵，行为与既有一致。
  const role = ctx.principalRole;
  const action = ctx.action ?? 'read';
  const mountMatrix = role ? await MountRolePermissionsRepo.getMatrix(db, mount.id) : undefined;
  const mountDenied = role ? mountMatrixDecision(role, action, mountMatrix) === 'deny' : false;
  const downFlags = await Promise.all(ids.map(async (id) => ((await isProviderDown(env, id)) ? id : null)));
  const down = new Set(downFlags.filter((id): id is string => id !== null));
  // 健康的在前，熔断的兜底在后（保留恢复探测的机会）
  const ordered = [...ids.filter((id) => !down.has(id)), ...ids.filter((id) => down.has(id))];
  let lastErr: unknown = null;
  let permissionDenied = 0;

  for (const id of ordered) {
    if (role) {
      const bucketMatrix = await MountProviderRolePermissionsRepo.getMatrix(db, mount.id, id);
      if (mountDenied || bucketMatrixDecision(role, action, bucketMatrix) === 'deny') {
        permissionDenied += 1;
        console.warn(`[failover] 候选因权限被跳过 file=${ref.fileId ?? '-'} provider=${id} role=${role} action=${action}`);
        continue;
      }
    }
    const row = await ProviderRepo.getProviderById(db, id);
    if (!row) continue;
    const provider = await getProvider(db, row, env);
    const isRecorded = id === primaryId;
    try {
      const value = await withTimeout(attempt(provider, id, isRecorded), ATTEMPT_TIMEOUT_MS);
      if (value === null) {
        // 该桶没有对象（未复制的池成员或已被清理），继续尝试下一个；桶本身是健康的
        lastErr = new ApiError(404, 'NOT_FOUND', '文件对象不存在或已被删除');
        continue;
      }
      if (!isRecorded && verify && !verify(value)) {
        await disposeRejected(value);
        console.warn(`[failover] 备用桶候选校验失败（size/sha256 不符） file=${ref.fileId ?? '-'} provider=${id}`);
        lastErr = new ApiError(404, 'NOT_FOUND', '备用桶对象与元数据不一致');
        continue;
      }
      if (down.has(id)) await clearProviderDown(env, id);
      if (isRecorded) {
        // 记录桶重新供数：清掉指向副桶的提示，下个请求回到主桶
        if (hinted && hinted !== primaryId) await forgetLocation(env, ref);
      } else {
        await rememberLocation(env, ref, id);
      }
      console.info(`[failover] 候选命中 file=${ref.fileId ?? '-'} provider=${id} recorded=${isRecorded}`);
      return { provider, providerId: id, value };
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        lastErr = err;
        continue;
      }
      if (err instanceof ApiError && err.statusCode === 502) {
        lastErr = err;
        await markProviderDown(env, id);
        continue;
      }
      if (err instanceof ProviderError) {
        lastErr = new ApiError(502, 'UPSTREAM_ERROR', `存储上游错误（${err.kind}）`);
        await markProviderDown(env, id);
        continue;
      }
      throw err;
    }
  }

  // 权限优先于 404/502：有候选被矩阵明确拒绝且无一成功 → 403（回退不得绕过桶级/挂载点级矩阵）
  if (permissionDenied > 0) {
    throw new ApiError(403, 'FORBIDDEN', '当前存储桶/挂载点的角色权限不允许此操作');
  }
  if (lastErr instanceof ApiError) throw lastErr;
  throw new ApiError(502, 'UPSTREAM_ERROR', '存储上游错误，且备桶未命中');
}

/** 取回对象（含副桶回退） */
export async function getFileObject(opts: GetFileObjectOptions): Promise<FileObjectResult> {
  const result = await tryCandidates(
    opts,
    (provider) => provider.getObject(opts.ref.physicalKey, opts.range ? { range: opts.range } : undefined),
    // 非记录桶校验：size 与 sha256 元数据；两者都放行的对象才算镜像命中
    (object) => contentMatches(opts.ref, object.totalSize ?? object.size) && hashMatches(opts.ref, object.metadata)
  );
  return { provider: result.provider, providerId: result.providerId, object: result.value };
}

export interface ServeFileOptions extends FailoverContext {
  name: string;
  mimeType?: string;
  rangeHeader?: string | null;
  totalSize?: number;
  forceAttachment?: boolean;
  cacheControl?: string;
}

/** 从响应头取全对象大小：206 看 Content-Range 的 total，200 看 Content-Length */
function responseTotalSize(res: Response): number | undefined {
  const total = res.headers.get('Content-Range')?.split('/')[1];
  if (total) return Number(total);
  const length = res.headers.get('Content-Length');
  return length ? Number(length) : undefined;
}

/**
 * 读取对象并构建 HTTP 响应（带副桶回退）。
 * Range 语义与 `serveObject` 一致（206/416/200），失败分类同样保持 404/502 区分。
 */
export async function serveFileObject(opts: ServeFileOptions): Promise<Response> {
  const result = await tryCandidates(
    opts,
    (provider, providerId, isRecorded) =>
      serveObject({
        provider,
        objectKey: opts.ref.physicalKey,
        name: opts.name,
        mimeType: opts.mimeType,
        rangeHeader: opts.rangeHeader,
        totalSize: opts.totalSize ?? opts.ref.size,
        forceAttachment: opts.forceAttachment,
        cacheControl: opts.cacheControl,
        // 非记录桶（镜像回退）命中时先按对象 sha256 元数据与文件 blobHash 比对，不符则弃用该候选
        verifyObject: isRecorded
          ? undefined
          : (obj) => {
              if (hashMatches(opts.ref, obj.metadata)) return true;
              console.warn(`[failover] 备用桶对象 sha256 与元数据不符 file=${opts.ref.fileId ?? '-'} provider=${providerId}`);
              return false;
            },
      }),
    (res) => contentMatches(opts.ref, responseTotalSize(res))
  );
  return result.value;
}
