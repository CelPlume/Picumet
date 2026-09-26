// 用户自建访问规则校验（§4.4 越权防线，纯函数便于单测）
// 防线：能力位门禁 / 权限白名单 / 主体白名单 / 边界与所有权 / 优先级与 IP 压制
import type { Permission } from '@shared/types';

/** user-origin 规则允许授予的权限白名单：写入类权限永不开放给用户级授权 */
export const USER_RULE_ALLOWED_PERMISSIONS: Permission[] = ['read', 'download'];

export interface UserRuleInput {
  itemId: string;
  effect: 'allow' | 'deny';
  /** 目标主体：指定用户 ID，或 allUsers = role 'user'（针对全部用户） */
  targetUserId?: string;
  allUsers?: boolean;
  permissions: string[];
}

export interface CreatorContext {
  id: string;
  defaultPath: string;
  capabilities: string[];
  isAdmin: boolean;
}

/** 目标文件/文件夹行（由 itemId 解析；不存在由 handler 抛 404） */
export interface TargetItem {
  mountId: string;
  ownerId: string;
  path: string;
  name: string;
  type: 'file' | 'folder';
}

export type UserRuleValidation =
  | {
      ok: true;
      normalized: {
        mountId: string;
        pathPattern: string;
        effect: 'allow' | 'deny';
        role?: 'user';
        userId?: string;
        permissions: Permission[];
        priority: 0;
        origin: 'user';
        createdBy: string;
      };
    }
  | { ok: false; status: number; code: string; message: string };

function fail(status: number, code: string, message: string): UserRuleValidation {
  return { ok: false, status, code, message };
}

/** 文件行 path = 父目录；文件夹行 path = 自身全路径 */
export function itemFullPath(item: Pick<TargetItem, 'path' | 'name' | 'type'>): string {
  if (item.type === 'folder') return item.path;
  return item.path === '/' ? `/${item.name}` : `${item.path}/${item.name}`;
}

export function validateUserRule(
  input: UserRuleInput,
  creator: CreatorContext,
  item: TargetItem
): UserRuleValidation {
  // 防线 5：能力位门禁
  if (!creator.isAdmin && !creator.capabilities.includes('can_grant')) {
    return fail(403, 'FORBIDDEN', '需要 can_grant 能力位才能创建访问规则');
  }

  // 防线 2：权限白名单（⊆ [read, download]）
  const perms = [...new Set(input.permissions)];
  const invalid = perms.filter((p) => !USER_RULE_ALLOWED_PERMISSIONS.includes(p as Permission));
  if (perms.length === 0 || invalid.length > 0) {
    return fail(400, 'VALIDATION_ERROR', `用户规则仅允许授予 ${USER_RULE_ALLOWED_PERMISSIONS.join(' / ')} 权限`);
  }

  // effect
  if (input.effect !== 'allow' && input.effect !== 'deny') {
    return fail(400, 'VALIDATION_ERROR', 'effect 仅允许 allow / deny');
  }

  // 防线 3：主体白名单——目标只能是具体用户或全部登录用户（role='user'），且二选一
  const subjectCount = [input.targetUserId, input.allUsers].filter((v) => v !== undefined && v !== false).length;
  if (subjectCount !== 1) {
    return fail(400, 'VALIDATION_ERROR', '规则必须且只能指定一个目标：targetUserId 或 allUsers');
  }

  // 防线 1：创建边界——只能授权自己拥有的路径（item 属主 + defaultPath 边界）
  if (item.ownerId !== creator.id) {
    return fail(403, 'FORBIDDEN', '只能对自己拥有的文件创建访问规则');
  }
  const pattern = itemFullPath(item);
  const root = creator.defaultPath === '/' ? '/' : creator.defaultPath.replace(/\/+$/, '');
  const withinBoundary = root === '/' || pattern === root || pattern.startsWith(`${root}/`);
  if (!withinBoundary) {
    return fail(403, 'FORBIDDEN', '规则路径超出你的空间边界');
  }

  // mount 隔离锚点：规则必须绑定挂载点，缺失则无法限定作用范围
  if (!item.mountId) {
    return fail(400, 'VALIDATION_ERROR', '目标缺少挂载点');
  }

  return {
    ok: true,
    normalized: {
      mountId: item.mountId,
      pathPattern: pattern,
      effect: input.effect,
      ...(input.allUsers ? { role: 'user' as const } : { userId: input.targetUserId as string }),
      permissions: perms as Permission[],
      priority: 0,
      origin: 'user',
      createdBy: creator.id,
    },
  };
}
