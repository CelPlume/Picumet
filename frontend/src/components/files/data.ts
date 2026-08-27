// 文件管理器数据层：查询与变更
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { isImage, isVideo } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

// 图片预览 URL 缓存（download 端点返回 {url}，需先解析网关地址；按文件缓存避免重复请求）
const imageUrlCache = new Map<string, string>();

export function useFilePreviewUrl(file: FileListItem | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(file?.coverUrl);
  useEffect(() => {
    const id = file?.id;
    if (!id || !file || file.type === 'folder') return;
    if (!isImage(file.name) && !isVideo(file.name)) return;
    const cached = imageUrlCache.get(id);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    apiFetch<{ url: string }>(`/api/files/${id}/download`)
      .then((res) => {
        if (cancelled) return;
        imageUrlCache.set(id, res.data.url);
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

export function useFilesQuery(path: string, opts: { search?: string; sort?: string; order?: string; enabled?: boolean } = {}) {
  const q = new URLSearchParams({ path });
  if (opts.search) q.set('search', opts.search);
  if (opts.sort) q.set('sort', opts.sort);
  if (opts.order) q.set('order', opts.order);
  return useQuery({
    queryKey: ['files', path, opts.search, opts.sort, opts.order],
    queryFn: async () => (await apiFetch<FileListResponse>(`/api/files?${q.toString()}`)).data,
    enabled: opts.enabled,
  });
}

export function useFolderOptions() {
  // 用于"移动到..."选择器：返回可用的顶级路径
  return useQuery({
    queryKey: ['folder-options'],
    queryFn: async () => (await apiFetch<FileListResponse>('/api/files?path=/&limit=200')).data,
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

export function useCopyLinks() {
  return useMutation({
    mutationFn: async ({ id, signed, expiresIn }: { id: string; signed?: boolean; expiresIn?: number }) => {
      const q = new URLSearchParams();
      if (signed) {
        q.set('signed', 'true');
        q.set('expiresIn', String(expiresIn ?? 3600));
      }
      const qs = q.toString();
      return (await apiFetch<{
        formats: { direct: string; html: string; markdown: string; bbcode: string };
        accessMode: string;
        needsPassword: boolean;
      }>(`/api/files/${id}/copy-links${qs ? `?${qs}` : ''}`)).data;
    },
  });
}

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
