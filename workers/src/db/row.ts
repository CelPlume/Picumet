// 行映射辅助：DB 行（snake_case）→ TS 类型（camelCase）
import type { User, Quota, FileMetadata, FileListItem, PathRule, ApiKey, Share, Mount, StorageProvider, Role, Permission, ShareStatus, Announcement } from '@shared/types';

export type Row = Record<string, unknown>;

export const b = (v: unknown): boolean => v === 1 || v === true || v === '1' || v === 'true';
export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const str = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);
export function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}
export const toJson = (v: unknown): string => JSON.stringify(v ?? null);

export function mapUser(row: Row): User {
  return {
    id: str(row.id)!,
    username: str(row.username)!,
    email: str(row.email)!,
    emailVerified: b(row.email_verified),
    role: (str(row.role) ?? 'user') as Role,
    displayName: str(row.display_name),
    avatarUrl: str(row.avatar_url),
    defaultPath: str(row.default_path) ?? '/',
    locale: str(row.locale) ?? 'zh-CN',
    theme: str(row.theme) ?? 'system',
    status: (str(row.status) ?? 'active') as User['status'],
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    lastLoginAt: row.last_login_at ? num(row.last_login_at) : undefined,
    passwordHash: str(row.password_hash),
  };
}

export function mapQuota(row: Row): Quota {
  const maxStorage = num(row.max_storage);
  const usedStorage = num(row.used_storage);
  const maxFiles = num(row.max_files);
  const usedFiles = num(row.used_files);
  return {
    maxStorage,
    usedStorage,
    maxFiles,
    usedFiles,
    storagePercent: maxStorage > 0 ? Math.min(100, Math.round((usedStorage / maxStorage) * 1000) / 10) : 0,
    filesPercent: maxFiles > 0 ? Math.min(100, Math.round((usedFiles / maxFiles) * 1000) / 10) : 0,
  };
}

export function mapProvider(row: Row): StorageProvider {
  return {
    id: str(row.id)!,
    name: str(row.name)!,
    type: (str(row.type) ?? 'r2') as StorageProvider['type'],
    endpoint: str(row.endpoint) ?? '',
    region: str(row.region) ?? '',
    bucket: str(row.bucket) ?? '',
    accessKeyId: str(row.access_key_id) ?? '',
    secretAccessKey: str(row.secret_access_key) ?? '',
    publicDomain: str(row.public_domain),
    uploadDomain: str(row.upload_domain),
    pathPrefix: str(row.path_prefix) ?? '',
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    status: (str(row.status) ?? 'active') as StorageProvider['status'],
  };
}

export function mapMount(row: Row): Mount {
  return {
    id: str(row.id)!,
    mountPath: str(row.mount_path)!,
    name: str(row.name)!,
    providerId: str(row.provider_id)!,
    sortBy: (str(row.sort_by) ?? 'name') as Mount['sortBy'],
    sortOrder: (str(row.sort_order) ?? 'asc') as Mount['sortOrder'],
    priority: num(row.priority),
    status: (str(row.status) ?? 'active') as Mount['status'],
  };
}

export function mapFile(row: Row): FileMetadata {
  return {
    id: str(row.id)!,
    mountId: str(row.mount_id)!,
    objectKey: str(row.object_key)!,
    path: str(row.path)!,
    name: str(row.name)!,
    type: (str(row.type) ?? 'file') as FileMetadata['type'],
    mimeType: str(row.mime_type),
    size: num(row.size),
    etag: str(row.etag),
    checksumMd5: str(row.checksum_md5),
    version: num(row.version) || 1,
    customTitle: str(row.custom_title),
    customColor: str(row.custom_color),
    coverUrl: str(row.cover_url),
    iconEmoji: str(row.icon_emoji),
    accessPassword: str(row.access_password),
    manualPosition: row.manual_position === null || row.manual_position === undefined ? undefined : num(row.manual_position),
    metadata: str(row.metadata),
    ownerId: str(row.owner_id)!,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    sourceCleanupPending: b(row.source_cleanup_pending),
    oldObjectKey: str(row.old_object_key),
  };
}

export function toFileListItem(f: FileMetadata): FileListItem {
  return {
    id: f.id,
    name: f.name,
    path: f.path,
    type: f.type,
    size: f.size,
    mimeType: f.mimeType,
    customTitle: f.customTitle,
    customColor: f.customColor,
    coverUrl: f.coverUrl,
    iconEmoji: f.iconEmoji,
    hasPassword: !!f.accessPassword,
    manualPosition: f.manualPosition,
    ownerId: f.ownerId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

export function mapPathRule(row: Row): PathRule {
  return {
    id: str(row.id)!,
    pathPattern: str(row.path_pattern)!,
    effect: (str(row.effect) ?? 'allow') as PathRule['effect'],
    role: row.role ? (str(row.role) as Role) : undefined,
    userId: str(row.user_id),
    apiKeyId: str(row.api_key_id),
    permissions: parseJson<Permission[]>(row.permissions, []),
    requirePassword: b(row.require_password),
    passwordHash: str(row.password_hash),
    allowedIps: row.allowed_ips ? String(row.allowed_ips).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    priority: num(row.priority),
    status: str(row.status) ?? 'active',
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

export function mapApiKey(row: Row): ApiKey {
  return {
    id: str(row.id)!,
    userId: str(row.user_id)!,
    name: str(row.name)!,
    keyId: str(row.key_id)!,
    permissions: parseJson<Permission[]>(row.permissions, []),
    protocols: parseJson<string[]>(row.protocols, []),
    uploadPath: str(row.upload_path) ?? '/',
    allowedIps: row.allowed_ips ? String(row.allowed_ips).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    expiresAt: row.expires_at ? num(row.expires_at) : undefined,
    lastUsedAt: row.last_used_at ? num(row.last_used_at) : undefined,
    createdAt: num(row.created_at),
    status: (str(row.status) ?? 'active') as ApiKey['status'],
  };
}

export function mapShare(row: Row): Share {
  return {
    id: str(row.id)!,
    fileId: str(row.file_id)!,
    creatorId: str(row.creator_id)!,
    title: str(row.title),
    passwordHash: str(row.password_hash),
    expiresAt: row.expires_at ? num(row.expires_at) : undefined,
    maxViews: row.max_views !== null && row.max_views !== undefined ? num(row.max_views) : undefined,
    viewCount: num(row.view_count),
    maxDownloads: row.max_downloads !== null && row.max_downloads !== undefined ? num(row.max_downloads) : undefined,
    downloadCount: num(row.download_count),
    allowPreview: b(row.allow_preview),
    allowDownload: b(row.allow_download),
    createdAt: num(row.created_at),
    lastAccessedAt: row.last_accessed_at ? num(row.last_accessed_at) : undefined,
    status: (str(row.status) ?? 'active') as ShareStatus,
  };
}

export interface UploadSessionRow {
  id: string;
  userId: string;
  mountId: string;
  objectKey: string;
  path: string;
  fileName: string;
  mimeType?: string;
  fileSize: number;
  quotaReserved: number;
  uploadId?: string;
  totalParts?: number;
  partsCompleted?: Array<{ partNumber: number; etag: string }>;
  status: UploadSessionStatus;
  idempotencyKey?: string;
  expiresAt: number;
  createdAt: number;
  completedAt?: number;
}

type UploadSessionStatus =
  | 'pending' | 'uploading' | 'verifying' | 'completed' | 'failed' | 'expired' | 'aborted';

export function mapUploadSession(row: Row): UploadSessionRow {
  return {
    id: str(row.id)!,
    userId: str(row.user_id)!,
    mountId: str(row.mount_id)!,
    objectKey: str(row.object_key)!,
    path: str(row.path)!,
    fileName: str(row.file_name)!,
    mimeType: str(row.mime_type),
    fileSize: num(row.file_size),
    quotaReserved: num(row.quota_reserved),
    uploadId: str(row.upload_id),
    totalParts: row.total_parts !== null && row.total_parts !== undefined ? num(row.total_parts) : undefined,
    partsCompleted: row.parts_completed
      ? (parseJson<Array<{ partNumber: number; etag: string }>>(row.parts_completed as string, []))
      : undefined,
    status: (str(row.status) ?? 'pending') as UploadSessionStatus,
    idempotencyKey: str(row.idempotency_key),
    expiresAt: num(row.expires_at),
    createdAt: num(row.created_at),
    completedAt: row.completed_at ? num(row.completed_at) : undefined,
  };
}

export function mapAnnouncement(row: Row): Announcement {
  return {
    id: str(row.id)!,
    title: str(row.title)!,
    content: str(row.content)!,
    level: (str(row.level) ?? 'info') as Announcement['level'],
    active: b(row.active),
    createdAt: num(row.created_at),
    expiresAt: row.expires_at ? num(row.expires_at) : undefined,
  };
}
