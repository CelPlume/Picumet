// Picumet 前后端共享类型定义
// 所有类型字段与 spec.md 保持一致

// ============ 用户与认证 ============

export type Role = 'admin' | 'user' | 'guest';

export interface User {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: Role;
  displayName?: string;
  avatarUrl?: string;
  defaultPath: string;
  locale: string;
  theme: string;
  status: 'active' | 'disabled' | 'banned';
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  /** 服务端内部字段，不返回前端 */
  passwordHash?: string;
  /** 会话版本：登出/改密/禁用时递增，使旧 JWT 立即失效（审计 H-05） */
  sessionVersion: number;
}

export interface Quota {
  maxStorage: number;
  usedStorage: number;
  maxFiles: number;
  usedFiles: number;
  storagePercent: number;
  filesPercent: number;
}

export interface AuthUserPayload {
  user: User;
  quota: Quota;
}

export interface RegisterInput {
  username: string;
  password: string;
  email: string;
  inviteCode?: string;
  turnstileToken?: string;
}

export interface LoginInput {
  username: string;
  password: string;
  turnstileToken?: string;
}

// ============ 权限 ============

export type Permission =
  | 'read'
  | 'write'
  | 'update'
  | 'delete'
  | 'share'
  | 'download'
  | 'admin';

export type RuleEffect = 'allow' | 'deny';

export interface Principal {
  type: 'user' | 'apiKey';
  id: string;
  role: Role;
  apiKeyId?: string;
  defaultPath: string;
  allowedPermissions?: Permission[];
}

export interface Mount {
  id: string;
  mountPath: string;
  name: string;
  providerId: string;
  sortBy: 'name' | 'time' | 'size' | 'manual';
  sortOrder: 'asc' | 'desc';
  priority: number;
  status: string;
}

export interface Conditions {
  ip?: string;
  passwordVerified?: boolean;
}

export interface PathRule {
  id: string;
  /** 挂载点 ID（NULL = 全局规则，适用于所有挂载；审计 H-01） */
  mountId?: string;
  pathPattern: string;
  effect: RuleEffect;
  role?: Role;
  userId?: string;
  apiKeyId?: string;
  permissions: Permission[];
  requirePassword: boolean;
  passwordHash?: string;
  allowedIps?: string[];
  priority: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

// ============ 文件 ============

export interface FileMetadata {
  id: string;
  mountId: string;
  objectKey: string;
  path: string;
  name: string;
  type: 'file' | 'folder';
  mimeType?: string;
  size: number;
  etag?: string;
  checksumMd5?: string;
  version: number;
  customTitle?: string;
  customColor?: string;
  coverUrl?: string;
  iconEmoji?: string;
  accessPassword?: string;
  manualPosition?: number;
  metadata?: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  sourceCleanupPending?: boolean;
  oldObjectKey?: string;
}

export interface FileListItem {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  mimeType?: string;
  customTitle?: string;
  customColor?: string;
  coverUrl?: string;
  iconEmoji?: string;
  hasPassword: boolean;
  manualPosition?: number;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileListData {
  items: FileListItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
  mount?: Mount | null;
}

export interface FileDetailData {
  file: FileMetadata;
  mount: Mount;
  permissions: Permission[];
  accessMode: 'private_gateway' | 'signed_redirect' | 'public_cdn';
  hasPassword: boolean;
}

// ============ 上传会话 ============

export type UploadSessionStatus =
  | 'pending'
  | 'uploading'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'aborted';

export interface UploadSession {
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
  status: UploadSessionStatus;
  idempotencyKey?: string;
  expiresAt: number;
  createdAt: number;
  completedAt?: number;
}

// ============ 分享 ============

export type ShareStatus = 'active' | 'expired' | 'revoked';

export interface Share {
  id: string;
  fileId: string;
  creatorId: string;
  title?: string;
  passwordHash?: string;
  expiresAt?: number;
  maxViews?: number;
  viewCount: number;
  maxDownloads?: number;
  downloadCount: number;
  allowPreview: boolean;
  allowDownload: boolean;
  createdAt: number;
  lastAccessedAt?: number;
  status: ShareStatus;
}

export interface SharePublicInfo {
  id: string;
  title: string;
  creatorName: string;
  file: FileListItem;
  allowPreview: boolean;
  allowDownload: boolean;
  expiresAt?: number;
  requiresPassword: boolean;
  viewCount: number;
  maxViews?: number;
}

// ============ API密钥 ============

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  keyId: string;
  permissions: Permission[];
  protocols: string[];
  uploadPath: string;
  allowedIps?: string[];
  expiresAt?: number;
  lastUsedAt?: number;
  createdAt: number;
  status: 'active' | 'revoked';
}

// ============ 存储与挂载 ============

export type ProviderType = 'r2' | 's3' | 'oracle';

export interface StorageProvider {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicDomain?: string;
  uploadDomain?: string;
  pathPrefix: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'disabled';
}

export interface MountConfig extends Mount {
  providerName: string;
  providerType: ProviderType;
}

// ============ 系统设置 ============

export interface SystemSettings {
  siteTitle: string;
  siteLogo?: string;
  siteFavicon?: string;
  allowRegistration: boolean;
  allowGuestAccess: boolean;
  requireEmailVerification: boolean;
  enableTurnstile: boolean;
  turnstileSiteKey?: string;
  rateLimitEnabled: boolean;
  rateLimitRequestsPerMinute: number;
  [key: string]: unknown;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  level: 'info' | 'warning' | 'danger';
  active: boolean;
  createdAt: number;
  expiresAt?: number;
}

// ============ 管理统计 ============

export interface AdminStats {
  users: { total: number; active: number };
  files: { total: number; size: number };
  storage: Array<{
    providerId: string;
    name: string;
    usedSpace: number;
    fileCount: number;
  }>;
  recentActivity: Array<{
    type: string;
    message: string;
    timestamp: number;
  }>;
}

// ============ 统一响应 ============

export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
  timestamp: number;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: number;
}

export type ApiResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  FORBIDDEN: 'FORBIDDEN',
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_PATH: 'INVALID_PATH',
  OPERATION_FAILED: 'OPERATION_FAILED',
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  USER_DISABLED: 'USER_DISABLED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SHARE_REVOKED: 'SHARE_REVOKED',
  SHARE_EXPIRED: 'SHARE_EXPIRED',
  SHARE_LIMIT_REACHED: 'SHARE_LIMIT_REACHED',
  DANGEROUS_FILE_TYPE: 'DANGEROUS_FILE_TYPE',
  DANGEROUS_MIME_TYPE: 'DANGEROUS_MIME_TYPE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
