# Invites Service（邀请码服务）

受邀注册机制（docs/PROGRESS.md「邀请码注册机制」）：管理员在系统设置「注册设置」分组控制
开关与生成权限，用户在个性化设置生成并管理自己的邀请码、查看受邀记录。

## 端点

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/invites` | 批量生成邀请码（`count` 缺省 1，`name` 可选备注）；受生成权限与累计数量上限约束 |
| GET | `/api/invites` | 自己的邀请码 + 按码聚合的受邀用户（用户名 / 所用码 / 注册时间） |

注册链路的邀请码校验收敛在 `invites.ts` 的 `resolveInviteCode`（`/api/auth/register` 与
第三方登录的补充注册 `/api/auth/sso/complete` 共用，错误码与语义单一来源）；
`loadInviteSettings` / `INVITE_CODE_PATTERN` 是设置与格式的唯一来源，
核销（`users.invited_by_code_id`）与建号在 `UserRepo.createUser` 的同一事务内原子完成。

## 设置键（system_settings）

| 键 | 默认 | 语义 |
| :--- | :--- | :--- |
| `invite_enabled` | false | 是否开启邀请码注册；关闭时注册不接受码 |
| `invite_required` | false | 开启后是否必填（必填 = 无码不可注册） |
| `invite_generation` | all_users | 生成权限：all_users / admin_only |
| `invite_max_per_user` | 5 | 每用户累计可生成数量上限 |

## 错误码

`INVITE_LIMIT`（403 超上限）、`INVITE_CODE_REQUIRED` / `INVITE_CODE_FORMAT` /
`INVITE_CODE_INVALID` / `INVITE_NOT_ENABLED`（400，注册链路）。

## 边界

- 码值 `[0-9A-Z]{6}`，crypto 随机（`randomString` 通道），UNIQUE 约束 + 碰撞重试；匹配区分大小写。
- 一个码可被多人核销；本次不做使用上限与过期。
- 数据模型：迁移 `0010_invite_codes.sql`（`invite_codes` 表 + `users.invited_by_code_id`）。
