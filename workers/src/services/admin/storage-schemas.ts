// 管理服务存储 Zod schemas（存储提供商、挂载点、权限规则）
import { z } from 'zod';
import { isPrivateHost } from '../../utils/ssrf';

// 公网/上传域名必须为合法 URL，且生产仅允许 https（本地 localhost 允许 http）。
// 防止管理员误配 http/非预期主机导致混合内容或数据外传。
function httpsUrl(message: string) {
  return z
    .string()
    .trim()
    .url(message)
    .refine((v) => {
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return false;
      }
      if (url.protocol === 'https:') return true;
      // 仅本地开发允许 http://localhost / http://127.0.0.1
      if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        return true;
      }
      return false;
    }, '仅允许 https 公网地址（本地开发可使用 http://localhost）')
    .refine((v) => {
      // publicDomain 是浏览器直接访问的公开对象域名，禁止把内网/保留地址下发给用户浏览器。
      // localhost / 127.0.0.1 沿用上方「本地开发」口径豁免；https 公网域名不允许内网/保留地址。
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return false;
      }
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
      return !isPrivateHost(url.hostname);
    }, '公网域名不允许内网/保留地址');
}

// 存储提供商（§5.2 单表单平铺）：
// type 由「有无 endpoint」在后端推导，不再是入参；绑定模式 = endpoint/AK/SK 全留空。
export const ProviderSchemaBase = z.object({
  name: z.string().min(1).max(100),
  endpoint: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(500).optional(),
  publicDomain: httpsUrl('公网域名格式不正确').nullable().optional(),
  pathPrefix: z.string().max(500).optional(),
  // 可选：提交时同事务创建挂载点（添加存储一步完成，§2.5 交互合并）
  mountPath: z.string().max(500).optional(),
});

// 创建用：endpoint/AK/SK 必须同填同空
export const ProviderSchema = ProviderSchemaBase.superRefine((data, ctx) => {
  const filled = [data.endpoint?.trim(), data.accessKeyId?.trim(), data.secretAccessKey?.trim()].filter(Boolean).length;
  if (filled !== 0 && filled !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'Endpoint、Access Key ID、Secret Access Key 需同时填写或同时留空（留空 = 使用 R2 绑定）',
    });
  }
});

// 挂载点级默认角色权限矩阵条目（§28）：动作词表 = 权限矩阵 5 项；
// share 由能力位 can_share 表达，矩阵不接受（与 role_defaults.permissions 一致）；
// permissions 传 [] = 删除该条目（配合全量替换即「该角色不设矩阵」）。
export const MountRolePermissionSchema = z.object({
  role: z.enum(['admin', 'user', 'guest']),
  permissions: z.array(z.enum(['read', 'write', 'update', 'delete', 'download'])).max(5),
});

// 存储池成员（§E）：weight = 加权系数（least_used / free_weighted）；
// capacityBytes = 成员容量上限（null/缺省 = 不限）；sortOrder = ordered 队列次序（升序，同序按 provider_id）。
// §31：standby = 显式「作为备用桶」标记（缺省 false）；rolePermissions = 该桶的桶级默认角色权限矩阵，
// 全量替换语义——缺省 = 不改该桶矩阵；[] = 清空；单条 permissions=[] = 删除该角色条目。
// §32：standby = 备用桶**不参与写入放置**（只作 §G 读回退候选），故「除备用桶外都是主桶」；
// 保存后池内必须至少留 1 个非备用成员（否则 400），主存储锚点由后端按池内第一个非备用成员派生。
export const PoolMemberSchema = z.object({
  providerId: z.string().min(1),
  weight: z.number().int().min(1).max(1000).optional(),
  capacityBytes: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  standby: z.boolean().optional(),
  rolePermissions: z.array(MountRolePermissionSchema).max(3).optional(),
});

// 挂载点
export const MountSchema = z.object({
  // §32 主存储锚点（内部字段，不再由用户选择）：缺省 = 取 poolMembers 第一个桶（二者都缺 → 400）。
  // 请求里显式给的可写成员优先保留；其余情况由后端按「池内第一个非备用成员」派生。
  providerId: z.string().min(1).optional(),
  mountPath: z.string().min(1),
  name: z.string().min(1).max(100),
  sortBy: z.enum(['name', 'time', 'size', 'manual']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  priority: z.number().int().optional(),
  // 挂载容量（字节）；null = 不限（默认）；§31：设了上限时不得超过各桶上限之和（应用层校验）
  maxStorage: z.number().int().positive().nullable().optional(),
  // 展示容量（§26 仪表盘占用率，字节）；null/缺省 = 未设置
  capacityBytes: z.number().int().min(0).nullable().optional(),
  // 存储池（§E）：写入选桶策略 + 池成员（缺省 = 仅主 provider）
  poolStrategy: z.enum(['least_used', 'round_robin', 'hash', 'free_weighted', 'ordered']).optional(),
  // 池成员全量替换：缺省 = 不改；[] = 清空（回到仅主 provider 单桶语义）。§32：池 = 入参成员集
  // （主 provider 不再强制保留，主存储锚点随后按池内第一个非备用成员派生）。
  // §31：成员可带 standby（显式备用标记）与 rolePermissions（该桶桶级矩阵，全量替换）
  poolMembers: z.array(PoolMemberSchema).max(20).optional(),
  // 旧简写：等价于 weight=1 / 不限容量 / sortOrder=0 的 poolMembers（两者同时给时 poolMembers 优先）
  poolProviderIds: z.array(z.string().min(1)).max(20).optional(),
  // §28 写入口模式（缺省 = free，保持现状）
  uploadMode: z.enum(['free', 'user_space', 'flat']).optional(),
  // §28 挂载点级默认角色权限矩阵：全量替换语义——缺省 = 不改；[] = 清空矩阵；单条 [] = 删除该角色条目
  rolePermissions: z.array(MountRolePermissionSchema).max(3).optional(),
});

// 权限规则
// 不接受 requirePassword/password/allowedIps——条件接口从未接入生产调用链，
// 允许配置只会造成「看似生效」的锁死。存量行不受影响：引擎第 6 步对未验证/未匹配条件 fail-closed（deny）。
export const RuleSchema = z.object({
  pathPattern: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  mountId: z.string().nullable().optional(),
  role: z.enum(['admin', 'user', 'guest']).nullable().optional(),
  userId: z.string().nullable().optional(),
  apiKeyId: z.string().nullable().optional(),
  permissions: z.array(z.enum(['read', 'write', 'update', 'delete', 'share', 'download'])).min(1),
  priority: z.number().int().optional(),
});

export type ProviderRequest = z.infer<typeof ProviderSchema>;
export type MountRequest = z.infer<typeof MountSchema>;
export type RuleRequest = z.infer<typeof RuleSchema>;
