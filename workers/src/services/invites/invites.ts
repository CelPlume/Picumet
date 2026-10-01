// 邀请码领域逻辑：设置读取、生成权限判定、码值生成（注册链路与 /api/invites 共用）
import type { Db } from '../../db';
import { SettingsRepo, InviteRepo, parseJson } from '../../db';
import { randomString } from '../../utils/crypto';
import { ApiError } from '../../shared/errors';

/** 码值格式：6 位数字 + 大写字母；匹配区分大小写（DB BINARY 排序 + 精确等值比较） */
export const INVITE_CODE_PATTERN = /^[0-9A-Z]{6}$/;
export const INVITE_CODE_LENGTH = 6;
const CODE_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 生成权限：all_users = 全部登录用户；admin_only = 仅管理员 */
export type InviteGeneration = 'all_users' | 'admin_only';

export interface InviteSettings {
  /** 是否开启邀请码注册 */
  enabled: boolean;
  /** 开启后邀请码是否必填（必填 = 无码不可注册） */
  required: boolean;
  generation: InviteGeneration;
  /** 每用户累计可生成的邀请码数量上限 */
  maxPerUser: number;
}

export const INVITE_DEFAULTS: InviteSettings = {
  enabled: false,
  required: false,
  generation: 'all_users',
  maxPerUser: 5,
};

/**
 * 读取注册设置（system_settings）。fail-safe 语义：
 * 开关缺行/脏值 = 关闭（不意外收紧注册）；生成权限缺行/脏值 = all_users（与迁移种子一致）；
 * 数量上限缺行/脏值/越界 = 默认 5。
 */
export async function loadInviteSettings(db: Db): Promise<InviteSettings> {
  const raw = await SettingsRepo.getAll(db);
  const bool = (key: string): boolean => {
    const v = raw[key];
    if (v === undefined) return false;
    const parsed = parseJson<unknown>(v, v);
    return parsed === true || parsed === 'true';
  };
  const genRaw = parseJson<unknown>(raw['invite_generation'], raw['invite_generation']);
  const generation: InviteGeneration = genRaw === 'admin_only' ? 'admin_only' : 'all_users';
  const maxRaw = Number(parseJson<unknown>(raw['invite_max_per_user'], raw['invite_max_per_user']));
  const maxPerUser = Number.isFinite(maxRaw) && maxRaw >= 1 ? Math.floor(maxRaw) : INVITE_DEFAULTS.maxPerUser;
  return { enabled: bool('invite_enabled'), required: bool('invite_required'), generation, maxPerUser };
}

/**
 * 生成权限判定（按角色分档，防越权）：
 * - 管理员：始终可生成（可在开启前预生成码值，与「注册设置」开关解耦）；
 * - guest 角色：一律不可——游客是「仅下载」的受限角色，签发邀请码等于授予「注册」能力；
 * - 其余登录用户：仅在「开启邀请码注册」且 `all_users` 时可生成。
 * 生成权限与开关同口径，API 门禁与前端区块显隐判定一致。
 */
export function canGenerateInvites(settings: InviteSettings, role: string): boolean {
  if (role === 'admin') return true;
  if (role === 'guest') return false;
  return settings.enabled && settings.generation === 'all_users';
}

/** crypto 随机码值（getRandomValues 通道，与 API 密钥/OTP 同源） */
export function generateInviteCode(): string {
  return randomString(INVITE_CODE_LENGTH, CODE_CHARSET);
}

/**
 * 邀请码门控（注册链路与第三方登录的补充注册共用）：
 * 返回应随建号事务核销的码行 id（null = 本次不带码）。
 * 语义：未开启时不接受码；开启 + 必填时无码不可注册；开启 + 选填时给了才校验。
 * 具体错误码让调用方按场景回传（INVITE_NOT_ENABLED / INVITE_CODE_REQUIRED / …）。
 */
export async function resolveInviteCode(db: Db, settings: InviteSettings, raw: string | undefined): Promise<string | null> {
  const code = raw?.trim();
  if (!settings.enabled) {
    if (code) throw new ApiError(400, 'INVITE_NOT_ENABLED', '站点未开启邀请码注册');
    return null;
  }
  if (!code) {
    if (settings.required) throw new ApiError(400, 'INVITE_CODE_REQUIRED', '注册需要邀请码');
    return null;
  }
  if (!INVITE_CODE_PATTERN.test(code)) {
    throw new ApiError(400, 'INVITE_CODE_FORMAT', '邀请码格式无效（6 位数字或大写字母）');
  }
  const invite = await InviteRepo.findByCode(db, code);
  if (!invite) throw new ApiError(400, 'INVITE_CODE_INVALID', '邀请码无效');
  return invite.id;
}
