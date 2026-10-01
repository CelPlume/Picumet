// 邀请码服务视图类型（API 响应形状，docs/API_CN.md「邀请码」）

/** 邀请码条目（POST /api/invites 创建响应） */
export interface InviteCodeView {
  id: string;
  code: string;
  name: string | null;
  createdAt: number;
}

/** 受邀用户条目：用户名 + 所用邀请码 + 注册时间（毫秒时间戳，前端按 YYYYMMDD 展示） */
export interface InvitedUserView {
  username: string;
  code: string;
  registeredAt: number;
}

/** 邀请码 + 按码聚合的受邀记录（GET /api/invites） */
export interface InviteCodeWithInvited extends InviteCodeView {
  invitedUsers: InvitedUserView[];
}

export interface InviteListData {
  codes: InviteCodeWithInvited[];
  /** 当前设置下每用户累计可生成数量上限 */
  max: number;
}
