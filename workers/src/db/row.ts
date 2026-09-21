// 行映射辅助：DB 行（snake_case）→ TS 类型（camelCase）
import type { User, Quota, FileMetadata, FileListItem, PathRule, ApiKey, Share, Mount, StorageProvider, Role, Permission, ShareStatus, Announcement, ShareItemView, GuestVisibility } from '@shared/types';
import { PERMISSION_MATRIX } from '@shared/types';

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

/**
 * 文件级游客可见性（§C）：列值仅接受 none/download/view，其余（NULL/脏值）一律按未设置处理。
 */
export function mapGuestVisibility(v: unknown): GuestVisibility | null {
  const s = str(v);
  return s === 'none' || s === 'download' || s === 'view' ? s : null;
}

/**
 * 默认权限 JSON 列 → 权限矩阵（§4.4）子集：非矩阵项（如历史值 share）一律过滤，非法/缺值 → []。
 * 矩阵只含 read/write/update/delete/download，分享由能力位 can_share 表达。
 */
export function parseMatrixPermissions(v: unknown): Permission[] {
  const parsed = parseJson<unknown>(v, []);
  if (!Array.isArray(parsed)) return [];
  const matrix: readonly Permission[] = PERMISSION_MATRIX;
  return parsed.map(String).filter((p): p is Permission => matrix.includes(p as Permission));
}

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
    sessionVersion: row.session_version === null || row.session_version === undefined ? 0 : num(row.session_version),
    capabilities: row.capabilities ? parseJson<string[]>(row.capabilities, []) : undefined,
    // NULL/缺列 = 跟随角色默认；显式数组（含 []）= 用户个别设置
    permissions:
      row.permissions === null || row.permissions === undefined ? null : parseMatrixPermissions(row.permissions),
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
    maxStorage: row.max_storage == null ? null : num(row.max_storage),
    usedStorage: num(row.used_storage),
    quotaReserved: num(row.quota_reserved),
    poolStrategy: (str(row.pool_strategy) ?? 'least_used') as Mount['poolStrategy'],
    capacityBytes: row.capacity_bytes == null ? null : num(row.capacity_bytes),
  };
}

/** §26 违规封禁：file_metadata.banned 随行映射（不进共享 FileMetadata 类型；列表展示与内容门禁使用） */
export type FileMetadataRow = FileMetadata & { banned?: boolean };

export function mapFile(row: Row): FileMetadataRow {
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
    visibility: (str(row.visibility) ?? 'private') as FileMetadata['visibility'],
    reviewStatus: (str(row.review_status) ?? 'approved') as FileMetadata['reviewStatus'],
    guestVisibility: mapGuestVisibility(row.guest_visibility),
    ownerId: str(row.owner_id)!,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    sourceCleanupPending: b(row.source_cleanup_pending),
    oldObjectKey: str(row.old_object_key),
    providerId: str(row.provider_id),
    physicalKey: str(row.physical_key),
    blobHash: str(row.blob_hash),
    banned: b(row.banned),
  };
}

export function toFileListItem(f: FileMetadataRow): FileListItem {
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
    visibility: f.visibility,
    reviewStatus: f.reviewStatus,
    guestVisibility: f.guestVisibility,
    ownerId: f.ownerId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    banned: !!f.banned,
    hash: f.blobHash ?? null,
  };
}

/**
 * 分享项目视图：文件列表项 + 所属根项目 id。
 * rootId 为该条目所属的 share_items.file_id —— 分享根项目取其自身 id，
 * 目录浏览（/:id/list）的子项取所属根文件夹项目 id。
 */
export function toShareItemView(f: FileMetadata, rootId: string): ShareItemView {
  return { ...toFileListItem(f), rootId };
}

export function mapPathRule(row: Row): PathRule {
  return {
    id: str(row.id)!,
    mountId: str(row.mount_id),
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
    origin: (str(row.origin) ?? 'admin') as PathRule['origin'],
    createdBy: str(row.created_by),
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
    secretCipher: str(row.secret_cipher),
  };
}

export function mapShare(row: Row): Share {
  return {
    id: str(row.id)!,
    fileId: str(row.file_id)!,
    creatorId: str(row.creator_id)!,
    title: str(row.title),
    passwordHash: str(row.password_hash),
    passwordCipher: str(row.password_cipher),
    expiresAt: row.expires_at ? num(row.expires_at) : undefined,
    maxViews: row.max_views !== null && row.max_views !== undefined ? num(row.max_views) : undefined,
    viewCount: num(row.view_count),
    maxDownloads: row.max_downloads !== null && row.max_downloads !== undefined ? num(row.max_downloads) : undefined,
    downloadCount: num(row.download_count),
    allowPreview: b(row.allow_preview),
    allowDownload: b(row.allow_download),
    requireLogin: b(row.require_login),
    allowedUserIds: row.allowed_user_ids ? parseJson<string[]>(row.allowed_user_ids, []) : null,
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
  /** §E 存储池：会话选定落桶 provider */
  providerId?: string | null;
  /** §F 内容寻址：内容 SHA-256 与实际物理键（/upload/raw 后写入） */
  blobHash?: string | null;
  physicalKey?: string | null;
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
    providerId: str(row.provider_id),
    blobHash: str(row.blob_hash),
    physicalKey: str(row.physical_key),
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
