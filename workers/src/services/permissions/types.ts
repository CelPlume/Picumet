// 权限服务类型（spec_refactored.md §权限服务）
import type { PathRule, Principal, Mount, Permission, Conditions, RuleEffect } from '@shared/types';

export type PermissionCheckResult = 'allow' | 'deny';

export type {
  PathRule,
  Principal,
  Mount,
  Permission,
  Conditions,
  RuleEffect,
};
