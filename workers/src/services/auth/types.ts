// 认证服务类型（docs/ARCHITECTURE_CN.md §认证服务）
import type { Role } from '@shared/types';
import type { RegisterRequest, LoginRequest } from './schemas';

// JWT 载荷
export interface JwtPayload {
  sub: string;              // user id
  username: string;
  role: Role;
}

export type RegisterInput = RegisterRequest;
export type LoginInput = LoginRequest;

export type { RegisterRequest, LoginRequest };
