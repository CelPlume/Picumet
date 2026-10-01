// Picumet 前后端共享类型定义
// 所有类型字段与 docs/ARCHITECTURE_CN.md 保持一致

// ============ 用户与认证 ============

export type Role = 'admin' | 'user' | 'guest' | (string & {});

/** 三级可见性：private 仅 owner/授权者；users 全部登录用户可读；public 另进 gallery 匿名面 */
export type Visibility = 'private' | 'users' | 'public';

/**
 * 文件级游客可见性：显式授予**匿名访客**的能力；
 * none = 一律拒绝；download = 可下载；view = 可查看（列表/预览）+ 下载。
 * NULL（未设置）不额外开放——匿名访客仍由站点 allow_guest_access 总闸、
 * role='guest' 规则与 visibility 合成规则决定（见 syntheticGuestRule）。
 */
export type GuestVisibility = 'none' | 'download' | 'view';

/** 公开审核状态：public 提交默认 pending，管理员 approved 后进 gallery */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** 能力位名称 */
export const CAPABILITIES = {
  publish: 'can_publish',
  share: 'can_share',
  grant: 'can_grant',
} as const;

export type CapabilityName = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

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
  /** 会话版本：登出/改密/禁用时递增，使旧 JWT 立即失效 */
  sessionVersion: number;
  /** 能力位 JSON（can_publish/can_share/can_grant）；NULL = 空集 */
  capabilities?: string[];
  /**
   * 用户个别默认权限（users.permissions）：
   * NULL/缺省 = 跟随角色默认（role_defaults.permissions）；空数组 = 显式不放行。
   * 保存角色默认设置时会被角色权限值覆盖（RoleDefaultsRepo.applyToRole）。
   */
  permissions: Permission[] | null;
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
  /** 邀请码（系统设置 invite_enabled 开启时校验；invite_required 决定必填语义） */
  inviteCode?: string;
}

export interface LoginInput {
  username: string;
  password: string;
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

/**
 * 默认权限矩阵（5 项）：查看/上传/修改/删除/下载。
 * 分享**不在矩阵内**——分享/发布/授权的唯一开关是能力位 can_share / can_publish / can_grant
 * （能力位优先于权限矩阵），故矩阵与能力位互不重复。
 */
export const PERMISSION_MATRIX = ['read', 'write', 'update', 'delete', 'download'] as const satisfies readonly Permission[];

/**
 * 角色默认权限兜底表（role_defaults.permissions 读不到/缺列时使用，与迁移种子一致）：
 * admin/user = 矩阵全量；guest 仅 download（匿名访客另有文件级 guest_visibility）。
 * 未登记的自定义角色按 user 语义处理。
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [...PERMISSION_MATRIX],
  user: [...PERMISSION_MATRIX],
  guest: ['download'],
};

export type RuleEffect = 'allow' | 'deny';

export interface Principal {
  type: 'user' | 'apiKey' | 'guest';
  id: string;
  role: Role;
  apiKeyId?: string;
  defaultPath: string;
  allowedPermissions?: Permission[];
  /**
   * 角色默认权限（role_defaults.permissions）：权限引擎第 8 步在用户默认路径内按此放行；
   * 缺省（未装载/存量库缺列）由引擎常量 DEFAULT_ROLE_PERMISSIONS 兜底。
   */
  defaultPermissions?: Permission[];
  /** 能力位（can_publish/can_share/can_grant）；admin 天然全量 */
  capabilities?: string[];
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
  /** 挂载容量上限（字节）；null = 不限 */
  maxStorage: number | null;
  /** 已用容量（字节），以 file_metadata 聚合为准 */
  usedStorage: number;
  /** 上传会话在途预留（字节） */
  quotaReserved: number;
  /** 创建时间（排序稳定平局决胜用） */
  createdAt: number;
  /** 存储池写入选桶策略（§29）；池成员见 mount_providers */
  poolStrategy: PoolStrategy;
  /** 挂载点展示容量（字节，仪表盘占用率）；null = 未设置 */
  capacityBytes: number | null;
  /**
   * 写入口模式（§28）：free 不额外约束 | user_space 写路径强制 <mountPath>/<用户名> |
   * flat 禁止新建文件夹（平铺上传）
   */
  uploadMode: UploadMode;
}

/** 挂载点写入口模式（§28）：公共上传区用 user_space 或 flat 消除跨用户命名冲突 */
export type UploadMode = 'free' | 'user_space' | 'flat';

/**
 * 存储池写入选桶策略（§29，五档；成员字段见 mount_providers）：
 * - `least_used`（默认）：ratio = (成员已用 + 1) / weight 取最小；平局按 provider_id 升序。
 * - `round_robin`：KV 计数器轮转，均摊新写入。
 * - `hash`：对挂载内相对父目录路径做 fnv1a 取模（挂载根 = `/`）→ 同目录粘性，便于按前缀查找/列举；
 *   成员集不变则落桶不变。老文件读路径不受影响（按 file_metadata.provider_id 定位）。
 * - `free_weighted`：未配容量的成员 = 不限，优先于任何有限余量（「不限」成员间按 weight 降序）；
 *   配了容量的成员「已用 >= capacity」视为满（排除），否则按 (capacity − 已用) × weight 取最大。
 *   全满 → 413 `MOUNT_QUOTA_EXCEEDED`（fail closed，清空 capacity 即回到不限）；全部未配容量 → 退化为 `least_used`。
 * - `ordered`：按 sort_order 升序（同序按 provider_id）取第一个未满成员；未配容量 = 不限 → 永远入选
 *   （即「填满一个再下一个」）；全满 → 413 `MOUNT_QUOTA_EXCEEDED`。
 */
export type PoolStrategy = 'least_used' | 'round_robin' | 'hash' | 'free_weighted' | 'ordered';

export interface Conditions {
  ip?: string;
  passwordVerified?: boolean;
}

export interface PathRule {
  id: string;
  /** 挂载点 ID（NULL = 全局规则，适用于所有挂载） */
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
  /** 规则来源：admin 管理员创建；user 用户自建（越权防线约束）；system 内存合成（visibility），不入库。缺省视为 admin（存量数据） */
  origin?: 'admin' | 'user' | 'system';
  /** user-origin 规则的创建者 */
  createdBy?: string;
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
  /** 三级可见性；folder 置可见性时级联到子树 */
  visibility: Visibility;
  /** 公开审核状态：仅 visibility=public 时进入 gallery 需 approved */
  reviewStatus: ReviewStatus;
  /** 文件级游客可见性；null = 未设置（匿名访客不额外开放） */
  guestVisibility: GuestVisibility | null;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  sourceCleanupPending?: boolean;
  oldObjectKey?: string;
  /** 实际落桶 provider（存储池）；NULL = 存量数据，读路径回退 mounts.provider_id */
  providerId?: string | null;
  /** 物理对象键（内容寻址）：<prefix>/picumet:blob/<h2>/<hash>；未内容寻址行 = object_key */
  physicalKey?: string | null;
  /** 内容 SHA-256；NULL = 未内容寻址（分片上传/存量数据） */
  blobHash?: string | null;
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
  visibility: Visibility;
  reviewStatus: ReviewStatus;
  /** 文件级游客可见性；null = 未设置（匿名访客不额外开放） */
  guestVisibility: GuestVisibility | null;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  /** 违规封禁：true = 已封禁（前端半透明禁用态，仅可删除） */
  banned?: boolean;
  /** 数据所在存储桶名（管理端全部文件列表按页批量补齐；用户端列表不返回） */
  buckets?: string[];
  /** 所在挂载点名（管理端全部文件列表按页批量补齐；用户端列表不返回） */
  mounts?: string[];
  /**
   * 媒体文件的签名直链缩略图（image/* 与 video/*、无密码时下发，1 小时签名）。
   * 前端网格/预览格直接消费，无需逐项请求下载令牌。
   */
  thumbUrl?: string;
  /**
   * 文件夹行的前 4 个子项（与列表同排序、同可见性过滤），文件夹卡片 2×2 预览格
   * 的数据源；子项可再带 thumbUrl。缺省时前端回退 per-folder 列表请求。
   */
  previewItems?: FileListItem[];
  /** 内容 SHA-256；null = 未内容寻址 */
  hash?: string | null;
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
  /** 存储池：会话选定落桶 provider（NULL = 回退挂载主 provider） */
  providerId?: string | null;
  /** 内容寻址：/upload/raw 阶段算出的内容 SHA-256 与物理键 */
  blobHash?: string | null;
  physicalKey?: string | null;
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
  /** 分享密码的 AES-GCM 密文（`enc:` 前缀）；服务端内部字段，仅创建者列表接口解密回看，公开响应一律不下发 */
  passwordCipher?: string;
  expiresAt?: number;
  maxViews?: number;
  viewCount: number;
  maxDownloads?: number;
  downloadCount: number;
  allowPreview: boolean;
  allowDownload: boolean;
  /** 仅登录用户可查看/下载 */
  requireLogin: boolean;
  /** 指定用户白名单（用户 id）；null = 不限 */
  allowedUserIds: string[] | null;
  createdAt: number;
  lastAccessedAt?: number;
  status: ShareStatus;
}

/** 分享项目视图（多项目分享）：文件列表项 + 所属根项目 id（share_items.file_id） */
export interface ShareItemView extends FileListItem {
  rootId: string;
}

export interface SharePublicInfo {
  id: string;
  title: string;
  creatorName: string;
  items: ShareItemView[];
  allowPreview: boolean;
  allowDownload: boolean;
  expiresAt?: number;
  requiresPassword: boolean;
  viewCount: number;
  maxViews?: number;
  downloadCount: number;
  maxDownloads?: number;
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
  /** S3 SigV4 网关验签需要可逆 secret：AES-GCM 加密密文（enc: 前缀），任何 API 响应不得返回 */
  secretCipher?: string;
}

// ============ 存储与挂载 ============

// Provider 类型收敛：'r2' = Worker R2 绑定（endpoint 空），'s3' = S3 兼容端点（AWS/R2 S3 API/Oracle/MinIO）。
// 由「有无 endpoint」在后端推导，不再是用户选择项。
export type ProviderType = 'r2' | 's3';

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
  pathPrefix: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'disabled';
}

export interface MountConfig extends Mount {
  providerName: string;
  providerType: ProviderType;
}

// ============ 第三方登录（SSO / OIDC） ============

/**
 * 提供商类型（迁移 0012）。
 * - google / github = 内置端点，各自至多一条（部分唯一索引约束）
 * - oidc = 通用 OpenID Connect（issuer 由管理员填写，数量不限）
 */
export type SsoProviderKind = 'google' | 'github' | 'oidc';

/** 登录页可用的提供商（公开面：只有类型与显示名，无任何凭据） */
export interface SsoProviderPublic {
  id: string;
  kind: SsoProviderKind;
  name: string;
}

/** 公开设置 `sso` 字段：总开关关闭或没有启用的来源时 providers 为空数组 */
export interface SsoPublicConfig {
  enabled: boolean;
  providers: SsoProviderPublic[];
}

/** 管理端提供商视图：clientSecret 只回掩码（`******` 已配置 / `''` 未配置） */
export interface SsoProviderAdmin {
  id: string;
  kind: SsoProviderKind;
  name: string;
  /** kind='oidc' 的 issuer（discovery 基地址）；google/github 为 null */
  issuerUrl: string | null;
  clientId: string;
  clientSecret: string;
  /** 自定义 scope（空格分隔）；null = 按 kind 取默认 */
  scopes: string | null;
  enabled: boolean;
  /**
   * 是否信任提供方声明的邮箱验证（迁移 0013）：开启后，提供方声明「已验证」的邮箱
   * 可用于自动关联既有账号。内置 Google/GitHub 默认开启，自定义 OIDC 默认关闭。
   */
  trustEmailVerified: boolean;
  /** 需在提供方后台登记的回调地址（= 站点地址 + /api/auth/sso/{id}/callback） */
  redirectUri: string;
  createdAt: number;
  updatedAt: number;
}

/** 待完成注册的第三方档案（`GET /api/auth/sso/pending` 响应，不含任何令牌） */
export interface SsoPendingProfile {
  providerId: string;
  providerName: string;
  kind: SsoProviderKind;
  /** 提供方下发的邮箱（未下发为 null）；前端「使用 OIDC 提供的信息」据此预填 */
  email: string | null;
  /** 提供方是否**已验证**该邮箱（verified_email / email_verified 声明） */
  emailVerified: boolean;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** 本次注册是否必须通过邮箱验证码（服务端按站点设置与提供方邮箱验证状态判定） */
  emailVerificationRequired: boolean;
  /** 邀请码门控（与 /register 同源）：enabled 决定是否渲染输入、required 决定是否必填 */
  inviteEnabled: boolean;
  inviteRequired: boolean;
}

// ============ 系统设置 ============

export interface SystemSettings {
  siteTitle: string;
  siteLogo?: string;
  siteFavicon?: string;
  allowRegistration: boolean;
  allowGuestAccess: boolean;
  requireEmailVerification: boolean;
  /** 邀请码注册（0010 迁移；「注册设置」分组）：开关 / 必填 / 生成权限 / 每用户上限 */
  inviteEnabled: boolean;
  inviteRequired: boolean;
  inviteGeneration: 'all_users' | 'admin_only';
  inviteMaxPerUser: number;
  /** 第三方登录（0012 迁移；「注册设置」分组）：站点级总开关，来源在各提供商行上单独启用 */
  ssoEnabled: boolean;
  /** 访问统计（0011 迁移）：来源二选一（d1 = 网关审计 / umami = 前端行为统计）+ Umami 脚本面配置 */
  statsSource: 'd1' | 'umami';
  umamiEnabled: boolean;
  umamiScriptUrl: string;
  umamiWebsiteId: string;
  umamiHostUrl: string;
  umamiDomains: string;
  umamiPerformance: boolean;
  umamiExcludeSearch: boolean;
  umamiDoNotTrack: boolean;
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
  /** 显示时长策略（§27）：always 总是 / daily 当日 / interval 每 x 间隔 / until 到指定时间 / duration 发布后 x 间隔；toast 临时弹窗另支持 once 单次 */
  displayMode?: 'always' | 'daily' | 'interval' | 'until' | 'duration' | 'once';
  /** interval/duration 模式的间隔秒数 */
  intervalSeconds?: number;
  /** 呈现形态：banner 常驻横幅（默认）/ toast 临时弹窗（展示片刻自动关闭） */
  kind?: 'banner' | 'toast';
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
  RANGE_NOT_SATISFIABLE: 'RANGE_NOT_SATISFIABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
