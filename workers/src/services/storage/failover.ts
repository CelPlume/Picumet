// 读路径容灾（§G）：文件落桶不可用时按「池成员」顺序轮询其余桶取回对象。
//
// 背景：跨桶复制（把对象真正写进副桶）由未来的 Go 后端负责；当前后端只做**读回退**——
// 文件在库内记录的落桶取不到（对象缺失 = 404 / 上游故障 = 502）时，依次尝试该挂载点的其他
// 池成员；一旦在副桶命中，把命中位置写进 KV 提示（含物理键指纹，文件被改写后自动失效），
// 后续请求直接优先访问该桶。全部候选都不可用才向外抛 404/502。
import { ApiError } from '../../shared/errors';
import type { Db } from '../../db';
import { MountProviderRepo, MountRepo, ProviderRepo } from '../../db';
import type { Mount } from '@shared/types';
import type { Env } from '../../shared/types';
import { getProvider } from './providers';
import { serveObject } from './serve';
import { ProviderError } from './errors';
import type { ObjectBody, StorageProviderInterface } from './types';

/** 单文件读取的候选上限（防止挂载点成员过多时放大延迟） */
const MAX_CANDIDATES = 4;
/** 命中位置提示 TTL：副桶命中的缓存时长（秒） */
const HINT_TTL = 3600;
/** 单个候选的单次尝试上限：主桶连接悬挂时不能拖死整个读请求（超时即换下一个候选） */
const ATTEMPT_TIMEOUT_MS = 8000;

/** 读取目标（文件行或下载令牌载荷都可用它表达） */
export interface FileObjectRef {
  /** 文件 id（可取时用于命中位置提示） */
  fileId?: string;
  mountId: string;
  /** 库内记录的落桶（NULL = 存量行，回退挂载主 provider） */
  providerId?: string | null;
  /** 物理对象键（§F） */
  physicalKey: string;
  size?: number;
}

interface FailoverContext {
  db: Db;
  env: Env;
  ref: FileObjectRef;
  /** 已解析的挂载点（缺省按 ref.mountId 读取，避免调用方重复查询） */
  mount?: Mount;
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

/**
 * 候选 provider 顺序：KV 命中提示（物理键一致才采纳）→ 文件落桶 → 其余池成员（weight 降序、id 升序）。
 * 去重后截断到 MAX_CANDIDATES。
 */
async function candidateProviderIds(env: Env, db: Db, mount: Mount, ref: FileObjectRef): Promise<string[]> {
  const primaryId = ref.providerId ?? mount.providerId;
  const ids: string[] = [];

  if (ref.fileId) {
    try {
      const raw = await env.KV.get(hintKey(ref.fileId));
      if (raw) {
        const hint = JSON.parse(raw) as { p?: string; k?: string };
        // 物理键不一致说明文件已被改写/搬迁，提示作废
        if (hint.p && hint.k === ref.physicalKey) ids.push(hint.p);
      }
    } catch {
      // KV 异常不影响主流程（提示只是加速）
    }
  }

  ids.push(primaryId);
  const members = await MountProviderRepo.listMembers(db, mount.id);
  const rest = (members.length > 0 ? members : [{ providerId: mount.providerId, weight: 1 }])
    .filter((m) => !ids.includes(m.providerId))
    .sort((a, b) => (a.weight !== b.weight ? b.weight - a.weight : a.providerId.localeCompare(b.providerId)));
  for (const member of rest) ids.push(member.providerId);
  return ids.slice(0, MAX_CANDIDATES);
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

/** 记住副桶命中位置（带物理键指纹；写入失败只影响下次加速） */
async function rememberLocation(env: Env, ref: FileObjectRef, providerId: string): Promise<void> {
  if (!ref.fileId) return;
  try {
    await env.KV.put(hintKey(ref.fileId), JSON.stringify({ p: providerId, k: ref.physicalKey }), { expirationTtl: HINT_TTL });
  } catch {
    // 忽略：提示只是加速手段
  }
}

/**
 * 按候选顺序执行读取；「对象不存在（null）」与 404/502/上游故障都触发回退，
 * 其余错误（如 416 越界）原样抛出。候选全失败时抛出最后一次的 404/502。
 */
async function tryCandidates<T>(
  ctx: FailoverContext,
  attempt: (provider: StorageProviderInterface, providerId: string) => Promise<T | null>
): Promise<{ provider: StorageProviderInterface; providerId: string; value: T }> {
  const { db, env, ref } = ctx;
  const mount = ctx.mount ?? (await MountRepo.getMountById(db, ref.mountId));
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const primaryId = ref.providerId ?? mount.providerId;
  const ids = await candidateProviderIds(env, db, mount, ref);
  let lastErr: unknown = null;

  for (const id of ids) {
    const row = await ProviderRepo.getProviderById(db, id);
    if (!row) continue;
    const provider = await getProvider(db, row, env);
    try {
      const value = await withTimeout(attempt(provider, id), ATTEMPT_TIMEOUT_MS);
      if (value === null) {
        // 该桶没有对象（未复制的池成员或已被清理），继续尝试下一个
        lastErr = new ApiError(404, 'NOT_FOUND', '文件对象不存在或已被删除');
        continue;
      }
      if (id !== primaryId) await rememberLocation(env, ref, id);
      return { provider, providerId: id, value };
    } catch (err) {
      if (err instanceof ApiError && (err.statusCode === 404 || err.statusCode === 502)) {
        lastErr = err;
        continue;
      }
      if (err instanceof ProviderError) {
        lastErr = new ApiError(502, 'UPSTREAM_ERROR', `存储上游错误（${err.kind}）`);
        continue;
      }
      throw err;
    }
  }

  if (lastErr instanceof ApiError) throw lastErr;
  throw new ApiError(502, 'UPSTREAM_ERROR', '存储上游错误，且备桶未命中');
}

/** 取回对象（含副桶回退） */
export async function getFileObject(opts: GetFileObjectOptions): Promise<FileObjectResult> {
  const result = await tryCandidates(opts, (provider) =>
    provider.getObject(opts.ref.physicalKey, opts.range ? { range: opts.range } : undefined)
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

/**
 * 读取对象并构建 HTTP 响应（带副桶回退）。
 * Range 语义与 `serveObject` 一致（206/416/200），失败分类同样保持 404/502 区分。
 */
export async function serveFileObject(opts: ServeFileOptions): Promise<Response> {
  const result = await tryCandidates(opts, (provider) =>
    serveObject({
      provider,
      objectKey: opts.ref.physicalKey,
      name: opts.name,
      mimeType: opts.mimeType,
      rangeHeader: opts.rangeHeader,
      totalSize: opts.totalSize ?? opts.ref.size,
      forceAttachment: opts.forceAttachment,
      cacheControl: opts.cacheControl,
    })
  );
  return result.value;
}
