// 文件管理器数据层：查询与变更
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { isImage, isVideo } from '@/lib/utils';
import { useTheme } from '@/stores/theme';
import type { FileListItem } from '@shared/types';

// ============ 缩略图 objectURL 缓存（LRU，跨组件实例/跨路由共享） ============
// 一次性令牌 → 单次 fetch → blob → objectURL 进缓存：同一文件（id+updatedAt）
// 在文件夹卡片 2x2 格、网格/列表缩略、视频抽帧之间只下载一次；退出文件夹再进入
// 直接命中缓存，不再重复下载（进入文件夹全部重新加载的流量浪费就此消失）。
// 淘汰顺序 = Map 插入序（LRU 语义靠命中时前移维持）；淘汰/替换时 revoke objectURL。
const THUMB_CACHE_MAX = 80;
const thumbCache = new Map<string, string>();

function thumbCacheGet(key: string): string | undefined {
  const url = thumbCache.get(key);
  if (url !== undefined) {
    thumbCache.delete(key);
    thumbCache.set(key, url);
  }
  return url;
}

function thumbCachePut(key: string, url: string) {
  const prev = thumbCache.get(key);
  if (prev === url) return;
  if (prev) URL.revokeObjectURL(prev);
  thumbCache.set(key, url);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldestKey = thumbCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = thumbCache.get(oldestKey);
    thumbCache.delete(oldestKey);
    if (oldest) URL.revokeObjectURL(oldest);
  }
}

/**
 * 卡片/列表/文件夹预览格的媒体缩略图地址。
 *
 * 流量门禁（个性化设置「文件夹图片/视频预览」，默认关闭，localStorage 持久化）：
 * 关闭时一律不签发令牌、不下载任何图片/视频字节，所有卡片只显示类型图标；
 * 开启后仅在渲染到的卡片处按需加载（列表分页天然限制了单页范围），且命中本地
 * 缓存的缩略图零流量。预览弹窗（显式用户动作）不受此开关限制。
 */
export function useFilePreviewUrl(file: FileListItem | null | undefined): string | undefined {
  const enabled = useTheme((s) => s.mediaPreviewsEnabled);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const fileId = file?.id ?? null;
  const updatedAt = file?.updatedAt ?? null;
  const isMediaFile = !!file && file.type !== 'folder' && (isImage(file.name) || isVideo(file.name));
  const cacheKey = isMediaFile && fileId && updatedAt ? `${fileId}:${updatedAt}` : null;

  useEffect(() => {
    if (!cacheKey || !fileId) return;
    if (!enabled) {
      // 设置运行中被关闭：立即回落图标（正常路径下关闭后组件重挂载，此分支兜底）
      setUrl(undefined);
      return;
    }
    const cached = thumbCacheGet(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(undefined);
    let cancelled = false;
    // LAB 回归：缩略一律走一次性网关令牌（同源 /api，dev 经 Vite 代理、prod 同源）。
    // 不消费列表内联的 thumbUrl（直链）：S3 直链跨源、Worker 直链在 dev 被 Vite
    // SPA fallback 截胡成 HTML —— <img> 只会渲染成损坏图标而非真实图片。
    // 令牌唯一消费者 = 这里的单次 fetch；StrictMode 双跑各签发新令牌，第二跑命中缓存。
    apiFetch<{ url: string }>(`/api/files/${fileId}/download`)
      .then((res) => fetch(res.data.url, { credentials: 'include' }))
      .then((r) => {
        if (!r.ok) throw new Error(`thumb fetch failed: ${r.status}`);
        return r.blob();
      })
      .then((b) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(b);
        thumbCachePut(cacheKey, objectUrl);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* 静默回退类型图标（与旧行为一致） */
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, fileId, enabled]);
  return url;
}

export interface PreviewMediaUrl {
  url: string | null;
  /** true = 一次性令牌 URL，消费方需 fetch 一次转 blob 再交给媒体元素 */
  needsToken: boolean;
  /** 解析失败时的 HTTP 状态码（401/403/404/429 等），供错误提示区分文案 */
  errorStatus: number | null;
}

/**
 * 预览弹窗媒体/文本 URL：一律走一次性网关令牌（`/api/files/:id/download`）。
 *
 * LAB 回归（2026-09-28）：曾改为优先 `copy-links?signed=true` 的 formats.direct，但
 * ① S3 provider 的 direct 是**容器预签名 URL**（跨源，浏览器侧被 CORS/拓扑拦截）；
 * ② 同源 Worker 直链在 dev 下被 Vite SPA fallback 截胡（非 /api 路径返回 index.html）。
 * 令牌 → 单次 fetch → blob 的链路同源、可重复 Range（blob 本地寻址）、拓扑无关，
 * 是预览场景唯一在 dev/prod、本机/远程全部成立的表达。直链只保留给「复制链接」外贴。
 * 令牌一次性：不进任何缓存，每次打开重新签发。
 */
export function usePreviewMediaUrl(file: FileListItem | null | undefined): PreviewMediaUrl {
  const [state, setState] = useState<PreviewMediaUrl>({ url: null, needsToken: true, errorStatus: null });
  useEffect(() => {
    if (!file || file.hasPassword) {
      // 密码文件由 verify-password 流程发令牌（verifiedUrl），这里不解析
      setState({ url: null, needsToken: true, errorStatus: null });
      return;
    }
    let cancelled = false;
    apiFetch<{ url: string }>(`/api/files/${file.id}/download`)
      .then((res) => {
        if (!cancelled) setState({ url: res.data.url, needsToken: true, errorStatus: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ url: null, needsToken: false, errorStatus: e instanceof ApiError ? e.status : null });
      });
    return () => {
      cancelled = true;
    };
  }, [file?.id, file?.updatedAt, file?.hasPassword]);
  return state;
}

// 文件夹内部预览：按当前排序取最多 4 个子项（文件夹/文件/图片/视频混合）
export function useFolderPreviewFiles(path: string | undefined, opts: { sort?: string; order?: string } = {}) {
  return useQuery({
    queryKey: ['files', path ?? '/', 'preview', opts.sort ?? 'name', opts.order ?? 'asc'],
    queryFn: async () => {
      const q = new URLSearchParams({ path: path ?? '/', limit: '4' });
      if (opts.sort) q.set('sort', opts.sort);
      if (opts.order) q.set('order', opts.order);
      const res = await apiFetch<FileListResponse>(`/api/files?${q.toString()}`);
      return res.data.items;
    },
    enabled: !!path,
    staleTime: 60_000,
  });
}

export interface FileListResponse {
  items: FileListItem[];
  pagination: { total: number; page: number; limit: number; pages: number };
  mount?: { id: string; name: string; sortBy: string; sortOrder: string } | null;
}

/** 树视图 / 挂载点视图共享的行类型：文件列表项 + 管理端附加的属主名 */
export type TreeFileRow = FileListItem & { ownerName?: string };

/** 树视图数据源：当前挂载点整棵子树（文件行 path=父目录、文件夹行 path=自身全路径） */
export function useFilesTreeQuery(path: string, enabled = true) {
  return useQuery({
    queryKey: ['files-tree', path],
    queryFn: async () =>
      (await apiFetch<{ items: FileListItem[]; truncated: boolean }>(`/api/files/tree?path=${encodeURIComponent(path)}`)).data,
    enabled,
  });
}

/** 管理端树视图数据源：全命名空间（含属主名/封禁态）；与列表视图共用 5 项筛选 */
export function useAdminTreeQuery(
  filters: { mount?: string; bucket?: string; user?: string; visibility?: string; hash?: string } = {},
  enabled = true
) {
  return useQuery({
    queryKey: ['admin-files-tree', filters],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (filters.mount) q.set('mount', filters.mount);
      if (filters.bucket) q.set('bucket', filters.bucket);
      if (filters.user) q.set('user', filters.user);
      if (filters.visibility) q.set('visibility', filters.visibility);
      if (filters.hash) q.set('hash', filters.hash);
      return (await apiFetch<{ items: TreeFileRow[]; truncated: boolean }>(`/api/admin/files/tree?${q.toString()}`)).data;
    },
    enabled,
  });
}

/** 桶 → 挂载点树（挂载点视图骨架；与仪表盘 bucketTree 同源） */
export interface BucketMountNode {
  id: string;
  name: string;
  mountPath: string;
  status: string;
  capacityBytes: number | null;
  fileCount: number;
  usedSpace: number;
  role: 'primary' | 'member';
}
export interface BucketNode {
  id: string;
  name: string;
  bucket: string;
  type: string;
  fileCount: number;
  usedSpace: number;
  mounts: BucketMountNode[];
  standbys: Array<{
    mountId: string;
    mountName: string;
    mountPath: string;
    primaryProviderId: string;
    primaryProviderName: string;
  }>;
}
export function useMountTreeQuery(enabled = true) {
  return useQuery({
    queryKey: ['admin-mount-tree'],
    queryFn: async () => (await apiFetch<{ buckets: BucketNode[] }>('/api/admin/mount-tree')).data,
    enabled,
  });
}

/** 挂载点展开层：顶层文件夹 + 递归文件计数（可选按落桶过滤，仪表盘计数用） */
export function useMountFolderSummary(mountId: string | null, providerId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['admin-mount-folders', mountId, providerId],
    queryFn: async () => {
      const q = new URLSearchParams({ mountId: mountId ?? '' });
      if (providerId) q.set('providerId', providerId);
      return (
        await apiFetch<{
          mountId: string;
          providerId: string | null;
          rootFiles: { count: number; size: number };
          folders: Array<{ id: string; name: string; path: string; fileCount: number; usedSpace: number }>;
          truncated: boolean;
        }>(`/api/admin/dashboard/mount-folders?${q.toString()}`)
      ).data;
    },
    enabled: enabled && !!mountId,
  });
}

export function useFilesQuery(
  path: string,
  opts: { search?: string; sort?: string; order?: string; enabled?: boolean; page?: number; limit?: number } = {}
) {
  const q = new URLSearchParams({ path });
  if (opts.search) q.set('search', opts.search);
  if (opts.sort) q.set('sort', opts.sort);
  if (opts.order) q.set('order', opts.order);
  if (opts.page !== undefined) q.set('page', String(opts.page));
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  return useQuery({
    queryKey: ['files', path, opts.search, opts.sort, opts.order, opts.page ?? 1, opts.limit ?? 0],
    queryFn: async () => (await apiFetch<FileListResponse>(`/api/files?${q.toString()}`)).data,
    enabled: opts.enabled,
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; name: string }) =>
      (await apiFetch(`/api/files/folder`, { method: 'POST', body: input })).data as { file: FileListItem },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['files'] });
    },
  });
}

export function useRenameFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string }) =>
      (await apiFetch(`/api/files/${input.id}`, { method: 'PUT', body: { name: input.name } })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files'] }),
  });
}

export function useUpdateFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; fields: Record<string, unknown> }) =>
      (await apiFetch(`/api/files/${input.id}`, { method: 'PUT', body: input.fields })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files'] }),
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiFetch(`/api/files/${id}`, { method: 'DELETE' })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files'] }),
  });
}

export function useMoveFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; targetPath: string }) =>
      (await apiFetch(`/api/files/${input.id}/move`, { method: 'POST', body: { targetPath: input.targetPath } })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files'] }),
  });
}

export function useBatchDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fileIds: string[]) =>
      (await apiFetch(`/api/files/batch`, { method: 'POST', body: { action: 'delete', fileIds, permanent: true } })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files'] }),
  });
}

export function useVerifyPassword() {
  return useMutation({
    mutationFn: async (input: { id: string; password: string }) =>
      (await apiFetch<{ url: string; expiresIn: number }>(`/api/files/${input.id}/verify-password`, {
        method: 'POST',
        body: { password: input.password },
      })).data,
  });
}

/** useCopyLinks 的返回契约：复制链接 mutation（供弹窗等消费方按名引用） */
export interface CopyLinksResult {
  formats: { direct: string; html: string; markdown: string; bbcode: string };
  accessMode: string;
  needsPassword: boolean;
}

export function useCopyLinks() {
  return useMutation({
    mutationFn: async ({ id, signed, expiresIn }: { id: string; signed?: boolean; expiresIn?: number }) => {
      const q = new URLSearchParams();
      if (signed) {
        q.set('signed', 'true');
        q.set('expiresIn', String(expiresIn ?? 3600));
      }
      const qs = q.toString();
      return (await apiFetch<CopyLinksResult>(`/api/files/${id}/copy-links${qs ? `?${qs}` : ''}`)).data;
    },
  });
}

export type CopyLinksMutator = ReturnType<typeof useCopyLinks>;

export interface UploadResult {
  sessionId: string;
  uploadUrl: string | null;
  uploadId?: string;
  uploadMode: 'presigned' | 'worker';
  totalParts?: number;
  /** 分片预签名 URL（仅 S3 预签名分片会话下发；R2/Worker 分片会话为空，走代理分片端点） */
  parts?: Array<{ partNumber: number; url: string }>;
  expiresAt: number;
}

export async function initUploadSession(input: {
  path: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}): Promise<UploadResult> {
  return (await apiFetch<UploadResult>('/api/files/upload-session', { method: 'POST', body: input })).data;
}

export async function completeUpload(input: {
  sessionId: string;
  etag?: string;
  parts?: Array<{ partNumber: number; etag: string }>;
}) {
  return (await apiFetch('/api/files/upload-complete', { method: 'POST', body: input })).data as {
    file: { id: string; name: string; path: string; size: number };
  };
}

/** 从 URL 提取文件名 */
export function nameFromContentDisposition(res: Response): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename="?([^";]+)"?/);
  return m ? m[1] : 'file';
}
