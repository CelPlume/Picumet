// 文件管理器数据层：查询与变更
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { isImage, isVideo } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

// 图片预览 URL 缓存（download 端点返回 {url}，需先解析网关地址；按文件缓存避免重复请求）
// 网关地址内的访问令牌 15 分钟过期，这里按 10 分钟 TTL 主动失效，过期后重新拉取并覆盖
const IMAGE_URL_TTL_MS = 10 * 60 * 1000;
const imageUrlCache = new Map<string, { url: string; expiresAt: number }>();

export function useFilePreviewUrl(file: FileListItem | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(file?.coverUrl);
  useEffect(() => {
    const id = file?.id;
    if (!id || !file || file.type === 'folder') return;
    if (!isImage(file.name) && !isVideo(file.name)) return;
    const cached = imageUrlCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      setUrl(cached.url);
      return;
    }
    let cancelled = false;
    apiFetch<{ url: string }>(`/api/files/${id}/download`)
      .then((res) => {
        if (cancelled) return;
        imageUrlCache.set(id, { url: res.data.url, expiresAt: Date.now() + IMAGE_URL_TTL_MS });
        setUrl(res.data.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file?.id]);
  return url;
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

export async function completeUpload(input: { sessionId: string; etag: string; parts?: Array<{ partNumber: number; etag: string }> }) {
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
