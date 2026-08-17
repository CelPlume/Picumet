# Picumet - 多云对象存储管理平台 规格说明书

**版本**: 2.0  
**日期**: 2026-08-18  
**状态**: Draft  
**维护者**: Picumet Team

## 权限判定算法

### 核心设计原则

**路径判断规则**: 使用路径段相等或前缀判断，避免 `startsWith` 导致的跨边界问题。

**规则排序算法**: 主体特异度 > 路径特异度 > 显式优先级 > effect（deny > allow）

### 权限检查函数签名

```typescript
function checkPermission(
  principal: Principal,      // 用户 | 角色 | API密钥
  mount: Mount,              // 挂载点
  canonicalPath: string,     // 规范化路径（已标准化）
  action: Permission,        // 操作类型
  fileOwnerId?: string,      // 文件所有者ID（可选）
  conditions?: Conditions    // 额外条件（IP、时间等）
): 'allow' | 'deny';

// 路径段判断辅助函数
function isPathWithinBoundary(path: string, boundary: string): boolean {
  if (boundary === '/') return true;  // 根路径包含所有
  if (path === boundary) return true; // 完全相等
  
  // 必须是 boundary + '/' 前缀，确保路径段边界
  // 例如：/users/alice 不能访问 /users/alice2
  return path.startsWith(boundary + '/');
}
```

### 判定规则（优先级从高到低）

```typescript
// 1. 管理员特权（最高优先级，绕过所有检查）
if (principal.role === 'admin') {
  return 'allow';
}

// 2. 挂载边界检查（安全边界，不可绕过）
if (!isPathWithinBoundary(canonicalPath, mount.mountPath)) {
  return 'deny';
}

// 3. 用户根路径限制（安全边界，不可绕过）
if (principal.type === 'user' && principal.defaultPath !== '/') {
  const userRoot = normalizePath(principal.defaultPath);
  if (!isPathWithinBoundary(canonicalPath, userRoot)) {
    return 'deny';
  }
}

// 4. 收集所有匹配的规则
const allRules = findMatchingRules(canonicalPath, principal, action);

// 5. 规则排序：主体特异度 > 路径特异度 > 显式优先级 > effect
const sortedRules = allRules.sort((a, b) => {
  // 5.1 主体特异度（user > apiKey > role）
  const subjectScore = (rule: Rule) => {
    if (rule.userId) return 3;        // 用户特定规则
    if (rule.apiKeyId) return 2;      // API密钥特定规则
    return 1;                         // 角色规则
  };
  const subjectDiff = subjectScore(b) - subjectScore(a);
  if (subjectDiff !== 0) return subjectDiff;
  
  // 5.2 路径特异度（精确匹配 > 深层路径 > 浅层路径）
  const pathScore = (rule: Rule) => {
    if (rule.pathPattern === canonicalPath) return 1000; // 精确匹配
    return rule.pathPattern.split('/').length;           // 路径深度
  };
  const pathDiff = pathScore(b) - pathScore(a);
  if (pathDiff !== 0) return pathDiff;
  
  // 5.3 显式优先级
  const priorityDiff = (b.priority || 0) - (a.priority || 0);
  if (priorityDiff !== 0) return priorityDiff;
  
  // 5.4 effect（deny > allow）
  if (a.effect === 'deny' && b.effect === 'allow') return -1;
  if (a.effect === 'allow' && b.effect === 'deny') return 1;
  
  return 0;
});

// 6. 应用第一个匹配的规则
for (const rule of sortedRules) {
  // 检查操作是否在权限列表中
  if (!rule.permissions.includes(action)) {
    continue;
  }
  
  // 检查条件
  if (rule.requirePassword && !conditions?.passwordVerified) {
    return 'deny';
  }
  if (rule.allowedIps && !conditions?.ip) {
    return 'deny';
  }
  if (rule.allowedIps && !rule.allowedIps.includes(conditions.ip)) {
    return 'deny';
  }
  
  // 返回规则效果
  return rule.effect;
}

// 7. 文件所有者权限（无规则匹配时的回退）
if (principal.type === 'user' && fileOwnerId && fileOwnerId === principal.id) {
  const ownerPerms: Permission[] = ['read', 'update', 'delete', 'share', 'download'];
  if (ownerPerms.includes(action)) {
    return 'allow';
  }
}

// 8. 默认拒绝（无匹配规则且非所有者）
return 'deny';
```

### 规则查找函数

```typescript
function findMatchingRules(
  path: string, 
  principal: Principal,
  action: Permission
): Rule[] {
  const rules: Rule[] = [];
  
  // 从数据库查询所有可能匹配的规则
  const candidateRules = db.query(`
    SELECT * FROM path_rules
    WHERE status = 'active'
      AND (
        -- 用户特定规则
        (user_id = ? AND role IS NULL AND api_key_id IS NULL)
        -- 角色规则
        OR (role = ? AND user_id IS NULL AND api_key_id IS NULL)
        -- API密钥规则
        OR (api_key_id = ? AND user_id IS NULL AND role IS NULL)
      )
  `, [principal.id, principal.role, principal.apiKeyId]);
  
  // 过滤路径匹配的规则
  for (const rule of candidateRules) {
    if (pathMatches(path, rule.pathPattern)) {
      rules.push(rule);
    }
  }
  
  return rules;
}

// 路径模式匹配（支持通配符）
function pathMatches(path: string, pattern: string): boolean {
  // 精确匹配
  if (pattern === path) return true;
  
  // 单星号通配符：/images/* 匹配 /images/abc.jpg
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    if (path === prefix) return true;  // /images 匹配 /images/*
    return isPathWithinBoundary(path, prefix) && !path.slice(prefix.length + 1).includes('/');
  }
  
  // 双星号通配符：/images/** 匹配 /images/a/b/c.jpg
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || isPathWithinBoundary(path, prefix);
  }
  
  return false;
}
```

### 权限规则真值表（修正版）

**排序规则**: 主体特异度 > 路径特异度 > 显式优先级 > effect (deny > allow)

#### 场景1：用户规则 vs 角色规则（主体特异度）

| 用户规则 | 角色规则 | 结果 | 说明 |
|----------|----------|------|------|
| allow | allow | ✅ allow | 用户规则优先，返回allow |
| allow | deny | ✅ allow | 用户规则优先（主体特异度高） |
| deny | allow | ❌ deny | 用户规则优先（主体特异度高） |
| deny | deny | ❌ deny | 用户规则优先，返回deny |
| - | allow | ✅ allow | 无用户规则，使用角色规则 |
| - | deny | ❌ deny | 无用户规则，使用角色规则 |
| allow | - | ✅ allow | 仅用户规则 |
| deny | - | ❌ deny | 仅用户规则 |

#### 场景2：路径继承（路径特异度）

| 父路径规则 | 子路径规则 | 结果 | 说明 |
|------------|------------|------|------|
| allow /images | - | ✅ allow | 继承父路径 |
| deny /images | - | ❌ deny | 继承父路径拒绝 |
| allow /images | deny /images/private | ❌ deny | 子路径特异度高，优先 |
| deny /images | allow /images/public | ✅ allow | 子路径特异度高，优先 |
| allow /images/** | allow /images/a/b.jpg | ✅ allow | 精确路径优先 |

#### 场景3：同主体同路径不同effect（effect优先级）

| 规则1 | 规则2 | 结果 | 说明 |
|-------|-------|------|------|
| deny (priority 0) | allow (priority 0) | ❌ deny | 同特异度和优先级，deny优先 |
| allow (priority 5) | deny (priority 3) | ✅ allow | 显式优先级高的优先 |

#### 场景4：移动操作的双重检查

```typescript
// 移动文件需要同时检查两个权限
function checkMovePermission(
  principal: Principal,
  sourcePath: string,
  targetPath: string,
  fileOwnerId: string
): boolean {
  // 检查源路径的删除权限
  const canDeleteSource = checkPermission(
    principal, mount, sourcePath, 'delete', fileOwnerId
  ) === 'allow';
  
  // 检查目标路径的写入权限
  const canWriteTarget = checkPermission(
    principal, mount, targetPath, 'write', fileOwnerId
  ) === 'allow';
  
  return canDeleteSource && canWriteTarget;
}
```

#### 场景5：API密钥作为Principal（修正版）

**重要**: API密钥权限 = 密钥配置权限 ∩ 路径规则权限

| API密钥配置 | 路径规则 | 操作 | 结果 | 说明 |
|-------------|----------|------|------|------|
| ['write','read'] | allow:['write','read'] | write | ✅ allow | 两者都允许 |
| ['write'] | allow:['write','read'] | write | ✅ allow | 密钥在允许范围内 |
| ['write'] | allow:['write','read'] | read | ❌ deny | 密钥未配置read |
| ['write','read'] | allow:['write'] | read | ❌ deny | 路径规则未授予read |
| ['write'] | deny:['write'] | write | ❌ deny | 路径规则显式拒绝 |
| ['write'] | (无规则) | write | ❌ deny | 默认拒绝 |

**API密钥权限检查逻辑**:

```typescript
function checkPermission(principal: Principal, ...): 'allow' | 'deny' {
  // ... 前面的管理员、边界检查 ...
  
  // API密钥额外检查：必须在密钥配置的权限范围内
  if (principal.type === 'apiKey') {
    if (!principal.allowedPermissions.includes(action)) {
      return 'deny';  // 密钥本身不允许此操作
    }
  }
  
  // ... 继续路径规则检查 ...
}
```

### 路径模式匹配规则

```typescript
// 支持的模式
const patterns = {
  '/public/**':           // 递归匹配所有子路径
  '/users/:userId/*':     // 单层通配符 + 变量
  '/images/*.{jpg,png}':  // 扩展名匹配
  '/exact/path':          // 精确匹配
};

// 优先级：精确 > 变量 > 单层通配 > 递归通配
function matchPriority(pattern: string): number {
  if (!pattern.includes('*') && !pattern.includes(':')) return 1000;
  if (pattern.includes(':')) return 500;
  if (pattern.endsWith('/*')) return 100;
  if (pattern.includes('**')) return 10;
  return 0;
}
```

### 密码保护访问规则

```typescript
// 密码保护优先级：文件级 > 路径级
function checkPasswordProtection(
  filePath: string,
  fileMetadata: FileMetadata
): { required: boolean; hash?: string } {
  // 1. 文件级密码（最高优先级）
  if (fileMetadata.accessPassword) {
    return { required: true, hash: fileMetadata.accessPassword };
  }
  
  // 2. 路径规则密码
  const rule = findMatchingRule(filePath, { requirePassword: true });
  if (rule?.passwordHash) {
    return { required: true, hash: rule.passwordHash };
  }
  
  // 3. 无密码保护
  return { required: false };
}
```

### 完整权限检查示例

```typescript
// 示例：普通用户尝试下载 /private/data.pdf
const result = checkPermission(
  {
    type: 'user',
    id: 'user123',
    role: 'user',
    defaultPath: '/users/user123'
  },
  {
    id: 'mount1',
    mountPath: '/',
    provider: 'r2'
  },
  '/private/data.pdf',
  'download',
  {
    ip: '1.2.3.4',
    passwordVerified: true
  }
);

// 判定过程：
// 1. 不是管理员 → 继续
// 2. 路径在挂载内 (/private 在 / 下) → 继续
// 3. 路径不在用户根路径内 (/private 不在 /users/user123) → deny

// 结果：'deny'
```

## 文件操作状态机

### 上传流程：单文件上传

**状态机**: pending → uploading → verifying → completed | failed

**幂等键**: `(user_id, client_idempotency_key)` 唯一

```
┌─────────────────────────────────────┐
│ 1. 创建上传会话                     │
│    POST /api/files/upload/init      │
│    Input: {                         │
│      fileName, fileSize, mimeType,  │
│      targetPath,                    │
│      clientIdempotencyKey           │
│    }                                │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 2. 服务端原子操作                   │
│    BEGIN TRANSACTION;               │
│    - 检查幂等键是否已存在           │
│      - 存在且completed → 返回原结果 │
│      - 存在pending/uploading → 返回 │
│    - 检查权限: write on targetPath  │
│    - 原子预留配额:                  │
│      UPDATE user_quotas             │
│      SET quota_reserved += fileSize │
│      WHERE user_id = ?              │
│        AND used_storage +           │
│            quota_reserved +         │
│            fileSize <= max_storage  │
│    - INSERT upload_sessions:        │
│      status: 'pending'              │
│      quota_reserved: fileSize       │
│      expires_at: now() + 1h         │
│    - 生成预签名PUT URL (15分钟)    │
│    COMMIT;                          │
└──────┬──────────────────────────────┘
       │ 返回: { sessionId, uploadUrl }
       ▼
┌─────────────────────────────────────┐
│ 3. 前端直传到对象存储               │
│    PUT uploadUrl                    │
│    - 自动重试（指数退避）           │
│    - 获取响应ETag                   │
└──────┬──────────────────────────────┘
       │ 成功: 获得ETag
       ▼
┌─────────────────────────────────────┐
│ 4. 回调完成接口                     │
│    POST /api/files/upload/complete  │
│    Input: { sessionId, etag }       │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 5. 服务端校验与提交（原子）         │
│    - 检查session状态:               │
│      必须是 'pending'               │
│    - UPDATE status = 'uploading'    │
│    - 执行HEAD验证:                  │
│      HEAD <object-key>              │
│      验证: ETag匹配、Size匹配       │
│    - UPDATE status = 'verifying'    │
│    BEGIN TRANSACTION;               │
│    - INSERT file_metadata           │
│    - UPDATE user_quotas:            │
│      used_storage += actual_size    │
│      quota_reserved -= reserved     │
│      used_files += 1                │
│    - UPDATE upload_sessions:        │
│      status = 'completed'           │
│      completed_at = now()           │
│    - INSERT access_logs             │
│    COMMIT;                          │
└──────┬──────────────────────────────┘
       │ 成功
       ▼
  ┌─────────┐
  │ 完成    │
  └─────────┘

失败处理：
- 步骤2失败 → quota_reserved未扣减，无需回滚
- 步骤3失败 → 前端重试或放弃
- 步骤5 HEAD失败 → status='failed', 定时清理object
- 步骤5 事务失败 → status='failed', 定时清理object
```

**配额回滚（定时任务）**:

```typescript
// 每5分钟执行
async function releaseExpiredReservations() {
  const expiredSessions = await db.query(`
    SELECT id, user_id, quota_reserved
    FROM upload_sessions
    WHERE status IN ('pending', 'uploading')
      AND expires_at < ?
  `, [Date.now()]);
  
  for (const session of expiredSessions) {
    await db.transaction(async (tx) => {
      // 释放配额
      await tx.query(`
        UPDATE user_quotas
        SET quota_reserved = quota_reserved - ?
        WHERE user_id = ?
      `, [session.quota_reserved, session.user_id]);
      
      // 标记会话失败
      await tx.query(`
        UPDATE upload_sessions
        SET status = 'expired'
        WHERE id = ?
      `, [session.id]);
    });
  }
}
```

---

### 上传流程：分片上传

**状态机**: pending → uploading → parts_uploaded → completing → completed | failed

```
┌─────────────────────────────────────┐
│ 1. 初始化分片上传                   │
│    POST /api/files/upload/multipart │
│    Input: {                         │
│      fileName, totalSize, partSize, │
│      targetPath,                    │
│      clientIdempotencyKey           │
│    }                                │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 2. 服务端初始化                     │
│    BEGIN TRANSACTION;               │
│    - 幂等检查                       │
│    - 权限检查                       │
│    - 原子预留配额（同单文件）       │
│    - 调用对象存储API:               │
│      CreateMultipartUpload          │
│      获得 uploadId                  │
│    - INSERT upload_sessions:        │
│      status: 'pending'              │
│      upload_id: <uploadId>          │
│      total_parts: ceil(size/partSize)│
│    COMMIT;                          │
└──────┬──────────────────────────────┘
       │ 返回: { sessionId, uploadId, totalParts }
       ▼
┌─────────────────────────────────────┐
│ 3. 循环上传分片                     │
│    For partNumber in 1..totalParts: │
│      a. 请求签名URL:                │
│         POST /api/files/upload/     │
│              multipart/sign-part    │
│         Input: { sessionId,         │
│                  partNumber }       │
│      b. 服务端生成预签名URL:        │
│         UploadPart签名 (15分钟)     │
│      c. 前端上传分片:               │
│         PUT <signed-url>            │
│         获得ETag                    │
│      d. 记录分片ETag:               │
│         POST /api/files/upload/     │
│              multipart/record-part  │
│         Input: { sessionId,         │
│                  partNumber, etag } │
│         服务端记录到session元数据   │
└──────┬──────────────────────────────┘
       │ 所有分片上传完成
       ▼
┌─────────────────────────────────────┐
│ 4. 完成分片上传                     │
│    POST /api/files/upload/          │
│         multipart/complete          │
│    Input: { sessionId }             │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 5. 服务端合并与提交                 │
│    - 检查session状态:               │
│      必须是 'pending'               │
│    - 检查所有分片已上传             │
│    - UPDATE status = 'completing'   │
│    - 调用对象存储API:               │
│      CompleteMultipartUpload        │
│      Input: uploadId, parts[]       │
│    - HEAD验证最终对象               │
│    BEGIN TRANSACTION;               │
│    - INSERT file_metadata           │
│    - UPDATE user_quotas (同单文件)  │
│    - UPDATE upload_sessions:        │
│      status = 'completed'           │
│    COMMIT;                          │
└──────┬──────────────────────────────┘
       │ 成功
       ▼
  ┌─────────┐
  │ 完成    │
  └─────────┘

失败处理：
- 任意分片上传失败 → 前端重试该分片
- CompleteMultipartUpload失败 → status='failed'
- 事务失败 → 调用 AbortMultipartUpload, status='failed'

中止操作：
DELETE /api/files/upload/multipart/:sessionId
- 调用 AbortMultipartUpload
- 释放配额
- status='aborted'
```
┌─────────────┐
│  完成/失败  │
└─────────────┘
```

#### 上传伪造回调防护

```typescript
// 完成上传的严格校验
async function completeUpload(sessionId: string, clientEtag: string) {
  // 1. 查询会话
  const session = await db.getUploadSession(sessionId);
  if (!session || session.status !== 'uploading') {
    throw new Error('Invalid session');
  }
  
  // 2. 检查是否过期
  if (Date.now() > session.expiresAt) {
    throw new Error('Session expired');
  }
  
  // 3. HEAD请求验证对象是否真实存在
  const headResult = await s3Client.send(new HeadObjectCommand({
    Bucket: provider.bucket,
    Key: session.objectKey
  }));
  
  // 4. 验证ETag匹配
  if (headResult.ETag !== clientEtag) {
    throw new Error('ETag mismatch');
  }
  
  // 5. 验证文件大小
  if (headResult.ContentLength !== session.fileSize) {
    throw new Error('Size mismatch');
  }
  
  // 6. 对于分片上传，验证所有分片
  if (session.uploadId) {
    const parts = await s3Client.send(new ListPartsCommand({
      Bucket: provider.bucket,
      Key: session.objectKey,
      UploadId: session.uploadId
    }));
    
    if (parts.Parts.length !== session.partsCount) {
      throw new Error('Incomplete multipart upload');
    }
  }
  
  // 7. 开始数据库事务
  await db.transaction(async (tx) => {
    // 7.1 创建文件元数据
    await tx.insertFileMetadata({
      id: uuid(),
      mountId: session.mountId,
      objectKey: session.objectKey,
      path: session.path,
      name: session.fileName,
      type: 'file',
      mimeType: session.mimeType,
      size: session.fileSize,
      etag: headResult.ETag,
      checksumMd5: headResult.Metadata?.['md5'],
      ownerId: session.userId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    // 7.2 更新配额
    await tx.incrementUserQuota(session.userId, session.fileSize);
    
    // 7.3 标记会话完成
    await tx.updateUploadSession(sessionId, {
      status: 'completed',
      completedAt: Date.now()
    });
  });
  
  return { success: true };
}
```

#### 幂等性保证

```typescript
// 使用幂等键防止重复上传
const idempotencyKey = `upload:${userId}:${md5(path + fileName + timestamp)}`;

// 检查是否已存在
const existing = await db.getUploadSessionByIdempotencyKey(idempotencyKey);
if (existing) {
  if (existing.status === 'completed') {
    return { sessionId: existing.id, alreadyCompleted: true };
  }
  // 返回现有会话
  return { sessionId: existing.id };
}

// 创建新会话
await db.createUploadSession({
  id: uuid(),
  idempotencyKey,
  // ...
});
```

### 移动/重命名操作（状态机）

```
┌─────────────┐
│  用户请求   │
│   移动文件  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 1. 权限检查                         │
│    - checkPermission(source, delete)│
│    - checkPermission(target, write) │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 2. 创建operation_job                │
│    - type: move                     │
│    - status: pending                │
│    - state_data: { phase: 'init' } │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 3. 对象存储操作                     │
│    - CopyObject(source → target)    │
│    - 状态: running, phase: copying  │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 4. 验证复制成功                     │
│    - HEAD target检查                │
│    - 比对etag/size                  │
│    - phase: verifying               │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 5. 删除源对象                       │
│    - DeleteObject(source)           │
│    - phase: deleting                │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 6. 更新元数据                       │
│    - UPDATE file_metadata.path      │
│    - UPDATE file_metadata.object_key│
│    - 事务提交                       │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 7. 标记任务完成                     │
│    - status: completed              │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────┐
│    成功     │
└─────────────┘

       ❌ 任何阶段失败
       │
       ▼
┌─────────────────────────────────────┐
│ 失败恢复                            │
│ - phase=copying失败: 删除target     │
│ - phase=deleting失败: 保留source    │
│ - 标记status=failed, 记录error      │
└─────────────────────────────────────┘
```

---

### 移动流程（Saga模式）

**核心原则**: 复制 → 原子切换元数据 → 异步清理源对象

**状态机**: pending → copying → verifying → committing → completed (cleanup_pending)

```
┌─────────────────────────────────────┐
│ 1. 创建移动操作                     │
│    POST /api/files/:id/move         │
│    Input: { targetPath }            │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 2. 权限检查与任务创建               │
│    - checkPermission(source,'delete')│
│    - checkPermission(target,'write') │
│    - 检查循环引用（文件夹移动）     │
│    - INSERT operation_jobs:         │
│      type: 'move'                   │
│      status: 'pending'              │
│      state: {                       │
│        phase: 'init',               │
│        sourceObjectKey,             │
│        sourcePath,                  │
│        targetPath                   │
│      }                              │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 3. 复制对象到目标位置               │
│    - UPDATE state.phase='copying'   │
│    - 生成 targetObjectKey           │
│    - 同Provider复制:                │
│      CopyObject(source → target)    │
│    - 跨Provider复制:                │
│      流式下载 + 流式上传            │
│    - UPDATE state.targetObjectKey   │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 4. 验证目标对象                     │
│    - UPDATE state.phase='verifying' │
│    - HEAD targetObjectKey           │
│    - 验证: size匹配, ETag匹配       │
└──────┬──────────────────────────────┘
       │ ✅ 验证通过
       ▼
┌─────────────────────────────────────┐
│ 5. 原子切换元数据（关键）           │
│    - UPDATE state.phase='committing'│
│    BEGIN TRANSACTION;               │
│    - UPDATE file_metadata SET       │
│      path = targetPath,             │
│      object_key = targetObjectKey,  │
│      source_cleanup_pending = TRUE, │
│      old_object_key = sourceObjectKey│
│      WHERE id = fileId              │
│    - UPDATE operation_jobs          │
│      status = 'completed'           │
│    COMMIT;                          │
└──────┬──────────────────────────────┘
       │ ✅ 事务成功（移动完成）
       ▼
┌─────────────────────────────────────┐
│ 6. 异步清理源对象（后台任务）       │
│    - 定时任务扫描:                  │
│      source_cleanup_pending = TRUE  │
│    - DeleteObject(old_object_key)   │
│    - UPDATE file_metadata SET       │
│      source_cleanup_pending = FALSE,│
│      old_object_key = NULL          │
└──────┬──────────────────────────────┘
       │
       ▼
  ┌─────────┐
  │ 完全完成 │
  └─────────┘

失败处理（补偿）：
┌─────────────────────────────────────┐
│ Phase: copying 失败                 │
│ → 无需补偿，源对象未动              │
│ → 如果已创建目标，删除目标          │
│ → status = 'failed'                 │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Phase: verifying 失败               │
│ → 删除目标对象                      │
│ → status = 'failed'                 │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Phase: committing 事务失败          │
│ → 目标对象已存在，源对象未删        │
│ → 手动补偿: 删除目标对象            │
│ → status = 'failed'                 │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Phase: cleanup 失败                 │
│ → 移动已完成，用户可正常访问        │
│ → 源对象成为孤儿对象                │
│ → 对账任务稍后清理                  │
└─────────────────────────────────────┘
```

#### 移动操作代码示例

```typescript
async function moveFile(
  principal: Principal,
  fileId: string,
  targetPath: string
): Promise<OperationJob> {
  const file = await db.getFileById(fileId);
  const sourcePath = file.path;
  const sourceMount = await db.getMountById(file.mountId);
  const targetMount = await findMountForPath(targetPath);
  
  // 1. 权限检查
  if (checkPermission(principal, sourceMount, sourcePath, 'delete', file.ownerId) !== 'allow') {
    throw new ForbiddenError('No delete permission on source');
  }
  if (checkPermission(principal, targetMount, targetPath, 'write') !== 'allow') {
    throw new ForbiddenError('No write permission on target');
  }
  
  // 2. 循环检测（文件夹移动）
  if (file.type === 'folder' && isPathWithinBoundary(targetPath, sourcePath)) {
    throw new ValidationError('Cannot move folder into itself');
  }
  
  // 3. 创建操作任务
  const jobId = uuid();
  await db.createOperationJob({
    id: jobId,
    userId: principal.id,
    type: 'move',
    fileId: file.id,
    status: 'pending',
    state: {
      phase: 'init',
      sourceObjectKey: file.objectKey,
      sourcePath,
      targetPath,
      sourceMountId: sourceMount.id,
      targetMountId: targetMount.id
    }
  });
  
  // 4. 异步执行移动（后台Worker）
  await enqueueJob(jobId);
  
  return { id: jobId, status: 'pending' };
}

// 后台Worker执行
async function executeMoveJob(jobId: string) {
  const job = await db.getOperationJob(jobId);
  const { sourceObjectKey, targetPath, sourceMountId, targetMountId } = job.state;
  
  try {
    // Phase: copying
    await db.updateOperationJob(jobId, {
      status: 'running',
      state: { ...job.state, phase: 'copying' }
    });
    
    const targetObjectKey = generateObjectKey(targetPath);
    const sourceProvider = await getProvider(sourceMountId);
    const targetProvider = await getProvider(targetMountId);
    
    if (sourceMountId === targetMountId) {
      // 同Provider：使用CopyObject
      await sourceProvider.copyObject(sourceObjectKey, targetObjectKey);
    } else {
      // 跨Provider：流式复制
      const stream = await sourceProvider.getObjectStream(sourceObjectKey);
      await targetProvider.putObjectStream(targetObjectKey, stream);
    }
    
    // Phase: verifying
    await db.updateOperationJob(jobId, {
      state: { ...job.state, phase: 'verifying', targetObjectKey }
    });
    
    const targetHead = await targetProvider.headObject(targetObjectKey);
    const sourceFile = await db.getFileById(job.fileId);
    
    if (targetHead.size !== sourceFile.size) {
      throw new Error('Size mismatch after copy');
    }
    
    // Phase: committing（原子切换）
    await db.updateOperationJob(jobId, {
      state: { ...job.state, phase: 'committing' }
    });
    
    await db.transaction(async (tx) => {
      // 切换元数据
      await tx.query(`
        UPDATE file_metadata SET
          path = ?,
          object_key = ?,
          mount_id = ?,
          source_cleanup_pending = TRUE,
          old_object_key = ?,
          updated_at = ?
        WHERE id = ?
      `, [targetPath, targetObjectKey, targetMountId, sourceObjectKey, Date.now(), job.fileId]);
      
      // 标记完成
      await tx.query(`
        UPDATE operation_jobs SET
          status = 'completed',
          completed_at = ?
        WHERE id = ?
      `, [Date.now(), jobId]);
    });
    
    // 移动完成！源对象清理由定时任务处理
    
  } catch (error) {
    await compensateMoveFailed(job, error);
    throw error;
  }
}

// 补偿逻辑
async function compensateMoveFailed(job: OperationJob, error: Error) {
  const { phase, targetObjectKey, targetMountId } = job.state;
  
  // 如果已创建目标对象，删除它
  if ((phase === 'copying' || phase === 'verifying' || phase === 'committing') 
      && targetObjectKey) {
    try {
      const targetProvider = await getProvider(targetMountId);
      await targetProvider.deleteObject(targetObjectKey);
    } catch (cleanupError) {
      // 清理失败，记录为孤儿对象
      await db.createOrphanObject({
        objectKey: targetObjectKey,
        mountId: targetMountId,
        reason: 'move_compensation_failed'
      });
    }
  }
  
  // 更新任务状态
  await db.updateOperationJob(job.id, {
    status: 'failed',
    error: error.message,
    failedAt: Date.now()
  });
}

// 定时清理源对象（每5分钟）
async function cleanupOldObjects() {
  const files = await db.query(`
    SELECT id, old_object_key, mount_id
    FROM file_metadata
    WHERE source_cleanup_pending = TRUE
    LIMIT 100
  `);
  
  for (const file of files) {
    try {
      const provider = await getProvider(file.mount_id);
      await provider.deleteObject(file.old_object_key);
      
      await db.query(`
        UPDATE file_metadata SET
          source_cleanup_pending = FALSE,
          old_object_key = NULL
        WHERE id = ?
      `, [file.id]);
    } catch (error) {
      // 删除失败，下次重试
      console.error(`Failed to cleanup ${file.old_object_key}:`, error);
    }
  }
}
```

---

### 删除流程

**硬删除**: 立即删除元数据和对象，无回收站

```
┌─────────────────────────────────────┐
│ 1. 删除请求                         │
│    DELETE /api/files/:id            │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 2. 权限与依赖检查                   │
│    - checkPermission(path,'delete') │
│    - 文件夹：检查是否为空（可选）   │
│    - 文件夹：查询所有子项           │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ 3. 原子删除元数据（先删）           │
│    BEGIN TRANSACTION;               │
│    - 文件夹：DELETE FROM            │
│      file_metadata                  │
│      WHERE path LIKE 'folder/%'     │
│      OR path = 'folder'             │
│      RETURNING id, object_key,      │
│                size, owner_id       │
│    - 单文件：DELETE FROM            │
│      file_metadata WHERE id = ?     │
│      RETURNING object_key, size,    │
│                owner_id             │
│    - UPDATE user_quotas SET         │
│      used_storage -= total_size,    │
│      used_files -= file_count       │
│      WHERE user_id = owner_id       │
│    - INSERT access_logs (action:    │
│      'delete', without file_id FK)  │
│      仅记录: user_id, path, size    │
│    COMMIT;                          │
└──────┬──────────────────────────────┘
       │ ✅ 元数据已删除
       ▼
┌─────────────────────────────────────┐
│ 4. 异步删除对象存储（后台）         │
│    - 将返回的object_keys入队        │
│    - 后台Worker逐个删除:            │
│      For each objectKey:            │
│        DeleteObject(objectKey)      │
│    - 失败不影响用户操作             │
└──────┬──────────────────────────────┘
       │
       ▼
  ┌─────────┐
  │ 完成    │
  └─────────┘

失败处理：
┌─────────────────────────────────────┐
│ 事务失败                            │
│ → 元数据未删除，用户重试            │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 对象删除失败                        │
│ → 元数据已删除，用户已可用          │
│ → 对象成为孤儿对象                  │
│ → 对账任务稍后清理                  │
└─────────────────────────────────────┘
```

#### 删除操作代码示例

```typescript
async function deleteFile(
  principal: Principal,
  fileId: string
): Promise<{ deleted: number; size: number }> {
  const file = await db.getFileById(fileId);
  const mount = await db.getMountById(file.mountId);
  
  // 1. 权限检查
  if (checkPermission(principal, mount, file.path, 'delete', file.ownerId) !== 'allow') {
    throw new ForbiddenError('No delete permission');
  }
  
  let objectKeysToDelete: string[] = [];
  let totalSize = 0;
  let fileCount = 0;
  
  if (file.type === 'folder') {
    // 2a. 文件夹删除：收集所有子项
    const children = await db.query(`
      SELECT id, object_key, size, type
      FROM file_metadata
      WHERE (path LIKE ? OR path = ?)
        AND mount_id = ?
    `, [`${file.path}/%`, file.path, file.mountId]);
    
    objectKeysToDelete = children.map(c => c.objectKey);
    totalSize = children.reduce((sum, c) => sum + c.size, 0);
    fileCount = children.length;
    
  } else {
    // 2b. 单文件删除
    objectKeysToDelete = [file.objectKey];
    totalSize = file.size;
    fileCount = 1;
  }
  
  // 3. 原子删除元数据
  await db.transaction(async (tx) => {
    if (file.type === 'folder') {
      // 删除文件夹及所有子项
      await tx.query(`
        DELETE FROM file_metadata
        WHERE (path LIKE ? OR path = ?)
          AND mount_id = ?
      `, [`${file.path}/%`, file.path, file.mountId]);
    } else {
      // 删除单文件
      await tx.query(`
        DELETE FROM file_metadata
        WHERE id = ?
      `, [fileId]);
    }
    
    // 更新配额（注意：不使用file_id外键）
    await tx.query(`
      UPDATE user_quotas SET
        used_storage = used_storage - ?,
        used_files = used_files - ?
      WHERE user_id = ?
    `, [totalSize, fileCount, file.ownerId]);
    
    // 记录日志（无file_id外键，直接记录路径）
    await tx.query(`
      INSERT INTO access_logs (
        id, user_id, action, metadata, 
        bytes_transferred, created_at
      ) VALUES (?, ?, 'delete', ?, ?, ?)
    `, [
      uuid(),
      principal.id,
      JSON.stringify({ path: file.path, fileCount }),
      totalSize,
      Date.now()
    ]);
  });
  
  // 4. 异步删除对象存储
  await enqueueObjectDeletion({
    mountId: file.mountId,
    objectKeys: objectKeysToDelete
  });
  
  return {
    deleted: fileCount,
    size: totalSize
  };
}

// 后台Worker：批量删除对象
async function processObjectDeletion(job: DeletionJob) {
  const provider = await getProvider(job.mountId);
  
  for (const objectKey of job.objectKeys) {
    try {
      await provider.deleteObject(objectKey);
    } catch (error) {
      // 删除失败，记录孤儿对象
      await db.createOrphanObject({
        objectKey,
        mountId: job.mountId,
        reason: 'deletion_failed',
        error: error.message
      });
    }
  }
}
```

---

### 数据库Schema调整（修复外键问题）

**问题**: `access_logs.file_id` 外键会导致删除文件时日志写入失败

**解决方案**: 日志表不使用外键，改为存储路径快照

```sql
CREATE TABLE access_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,                       -- 用户ID（可为空，表示匿名）
  action TEXT NOT NULL,               -- 操作: view | download | upload | delete | share
  path TEXT,                          -- 操作的路径（快照）
  metadata TEXT,                      -- 额外元数据JSON（如文件名、类型等）
  ip_address TEXT,
  user_agent TEXT,
  bytes_transferred INTEGER DEFAULT 0,
  status_code INTEGER,
  created_at INTEGER NOT NULL,
  
  -- 仅保留用户外键，删除file_id外键
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_access_logs_user_id ON access_logs(user_id);
CREATE INDEX idx_access_logs_created_at ON access_logs(created_at DESC);
CREATE INDEX idx_access_logs_action ON access_logs(action);
CREATE INDEX idx_access_logs_path ON access_logs(path);  -- 新增路径索引
```

---
    
    const head = await s3Client.send(new HeadObjectCommand({
      Bucket: provider.bucket,
      Key: newObjectKey
    }));
    
    if (head.ContentLength !== file.size) {
      throw new Error('Copy verification failed');
    }
    
    // 5. 删除源对象
    await db.updateOperationJob(jobId, {
      stateData: JSON.stringify({ phase: 'deleting' })
    });
    
    await s3Client.send(new DeleteObjectCommand({
      Bucket: provider.bucket,
      Key: file.objectKey
    }));
    
    // 6. 更新元数据（事务）
    await db.transaction(async (tx) => {
      await tx.updateFileMetadata(fileId, {
        path: targetPath,
        objectKey: newObjectKey,
        updatedAt: Date.now()
      });
      
      await tx.updateOperationJob(jobId, {
        status: 'completed',
        completedAt: Date.now()
      });
    });
    
    return { success: true, jobId };
    
  } catch (error) {
    // 失败恢复
    const job = await db.getOperationJob(jobId);
    const state = JSON.parse(job.stateData);
    
    // 如果已经复制成功，清理目标对象
    if (state.phase === 'deleting' && state.newObjectKey) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: provider.bucket,
          Key: state.newObjectKey
        }));
      } catch (cleanupError) {
        console.error('Cleanup failed:', cleanupError);
      }
    }
    
    await db.updateOperationJob(jobId, {
      status: 'failed',
      errorMessage: error.message
    });
    
    throw error;
  }
}
```

### 删除机制（硬删除）

**设计决策**: 不使用回收站/软删除，删除操作立即永久删除文件。

**理由**:
1. 软删除会导致对象存储和数据库不一致
2. 对账逻辑会误判软删除对象为孤儿
3. 简化状态管理和配额计算
4. 用户需要恢复文件时可通过备份或版本控制

#### 删除流程

```typescript
async function deleteFile(fileId: string, userId: string) {
  const file = await db.getFileById(fileId);
  
  // 1. 权限检查
  if (!await checkPermission(userId, file.path, 'delete')) {
    throw new Error('FORBIDDEN');
  }
  
  // 2. 如果是文件夹，递归检查权限
  if (file.type === 'folder') {
    const children = await db.getChildFiles(file.path);
    for (const child of children) {
      if (!await checkPermission(userId, child.path, 'delete')) {
        throw new Error('FORBIDDEN: Cannot delete some children');
      }
    }
  }
  
  // 3. 在事务中执行删除
  await db.transaction(async (tx) => {
    // 3.1 删除数据库记录（级联删除子文件）
    await tx.deleteFileMetadata(fileId);
    
    // 3.2 更新配额
    await tx.decrementUserQuota(userId, file.size);
    
    // 3.3 记录操作日志
    await tx.createAccessLog({
      userId,
      fileId,
      action: 'delete',
      ipAddress: getClientIp(),
      createdAt: Date.now()
    });
  });
  
  // 4. 异步删除对象存储中的对象
  // 即使失败也不影响数据库，由对账任务清理
  try {
    const provider = await getProviderForFile(file);
    await s3Client.send(new DeleteObjectCommand({
      Bucket: provider.bucket,
      Key: file.objectKey
    }));
  } catch (error) {
    console.error('Failed to delete object:', error);
    // 不抛出错误，让对账任务处理
  }
  
  return { success: true };
}
```

#### 确认对话框（前端）

```typescript
// 删除前显示确认对话框
const confirmDelete = await showConfirmDialog({
  title: '确认删除',
  message: `确定要删除 "${file.name}" 吗？此操作无法撤销。`,
  confirmText: '删除',
  cancelText: '取消',
  variant: 'danger'
});

if (confirmDelete) {
  await deleteFile(file.id);
}
```

### 对账与孤儿对象清理

#### 定期对账流程

```typescript
// 每周对账：数据库 vs 对象存储
async function reconcileStorage(mountId: string) {
  const mount = await db.getMount(mountId);
  const provider = await db.getStorageProvider(mount.providerId);
  
  // 1. 列举对象存储中的所有对象
  const s3Objects = new Set<string>();
  let continuationToken: string | undefined;
  
  do {
    const result = await s3Client.send(new ListObjectsV2Command({
      Bucket: provider.bucket,
      Prefix: provider.pathPrefix,
      ContinuationToken: continuationToken
    }));
    
    result.Contents?.forEach(obj => s3Objects.add(obj.Key));
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  
  // 2. 查询数据库中的对象（不需要过滤deleted_at，因为已硬删除）
  const dbObjects = await db.query(
    'SELECT object_key FROM file_metadata WHERE mount_id = ?',
    [mountId]
  );
  const dbKeys = new Set(dbObjects.map(o => o.object_key));
  
  // 3. 找出孤儿对象（存在于S3但不在DB中）
  const orphans = [...s3Objects].filter(key => !dbKeys.has(key));
  
  // 4. 找出幽灵记录（存在于DB但不在S3中）
  const ghosts = [...dbKeys].filter(key => !s3Objects.has(key));
  
  // 5. 报告
  console.log(`Reconciliation for mount ${mountId}:`);
  console.log(`  S3 objects: ${s3Objects.size}`);
  console.log(`  DB records: ${dbKeys.size}`);
  console.log(`  Orphans: ${orphans.length}`);
  console.log(`  Ghosts: ${ghosts.length}`);
  
  // 6. 创建对账报告（不自动删除）
  const report = await db.createReconciliationReport({
    mountId,
    orphanObjects: orphans,
    ghostRecords: ghosts,
    createdAt: Date.now(),
    status: 'pending_review'
  });
  
  return report;
}

// 管理员审核后手动清理
async function cleanupOrphans(reportId: string, adminUserId: string) {
  const report = await db.getReconciliationReport(reportId);
  
  if (report.status !== 'pending_review') {
    throw new Error('Report already processed');
  }
  
  const provider = await db.getStorageProvider(report.mountId);
  
  // 清理孤儿对象
  for (const orphanKey of report.orphanObjects) {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: provider.bucket,
      Key: orphanKey
    }));
  }
  
  // 清理幽灵记录
  for (const ghostKey of report.ghostRecords) {
    await db.deleteFileMetadataByObjectKey(report.mountId, ghostKey);
  }
  
  // 标记报告为已处理
  await db.updateReconciliationReport(reportId, {
    status: 'completed',
    processedBy: adminUserId,
    processedAt: Date.now()
  });
}
```

**关键改进**:
- ✅ 不再误判删除的文件为孤儿
- ✅ 孤儿对象需要管理员审核才能删除
- ✅ 幽灵记录单独处理，避免数据丢失
- ✅ 完整的审计日志

## API设计

### 认证方式

| 方式 | Header | 适用场景 |
|------|--------|----------|
| **JWT Cookie** | `Cookie: auth_token=...` | Web前端 |
| **API Key Bearer** | `Authorization: Bearer pk_...` | PicGo/脚本上传 |
| **WebDAV Basic** | `Authorization: Basic base64(keyId:secret)` | WebDAV客户端 |

### 统一响应格式

```typescript
// 成功
interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  timestamp: number;
}

// 错误
interface ErrorResponse {
  success: false;
  error: {
    code: string;           // ERROR_CODE
    message: string;        // 用户友好消息
    details?: any;          // 详细信息（dev环境）
  };
  timestamp: number;
}

// 错误码
enum ErrorCode {
  // 认证
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  
  // 权限
  FORBIDDEN = 'FORBIDDEN',
  PASSWORD_REQUIRED = 'PASSWORD_REQUIRED',
  INVALID_PASSWORD = 'INVALID_PASSWORD',
  
  // 资源
  NOT_FOUND = 'NOT_FOUND',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  
  // 配额
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  
  // 限流
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  
  // 验证
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_PATH = 'INVALID_PATH',
  
  // 操作
  OPERATION_FAILED = 'OPERATION_FAILED',
  UPLOAD_SESSION_EXPIRED = 'UPLOAD_SESSION_EXPIRED',
}
```

### 核心API端点

#### 1. 认证 (Auth)

##### POST /api/auth/register
注册新用户

**请求**:
```typescript
{
  username: string;        // 3-20字符，字母数字下划线
  password: string;        // 最少8字符
  email: string;           // 必需
  inviteCode?: string;     // 邀请码（如果启用）
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    user: {
      id: string;
      username: string;
      email: string;
      emailVerified: false;
      role: 'user';
    };
    message: '验证邮件已发送到 xxx@example.com';
  }
}
```

**副作用**: 发送验证邮件到用户邮箱

##### GET /api/auth/verify-email?token=xxx
验证邮箱

**响应**: 重定向到登录页或显示成功页面

##### POST /api/auth/login
用户登录

**请求**:
```typescript
{
  username: string;
  password: string;
  turnstileToken?: string; // 如果启用Turnstile
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    user: {
      id: string;
      username: string;
      email: string;
      emailVerified: boolean;
      role: string;
      displayName: string;
      avatarUrl: string;
      defaultPath: string;
      locale: string;
      theme: string;
    };
  }
}
```

**副作用**: 设置HttpOnly Cookie `auth_token`

##### POST /api/auth/logout
登出

**响应**:
```typescript
{ success: true }
```

**副作用**: 清除Cookie

##### GET /api/auth/me
获取当前用户信息

**响应**:
```typescript
{
  success: true;
  data: {
    user: { /* ... */ };
    quota: {
      maxStorage: number;
      usedStorage: number;
      maxFiles: number;
      usedFiles: number;
      storagePercent: number;
      filesPercent: number;
    };
  }
}
```

## 前端页面

### 页面路由

```typescript
// 公开路由
/                          // 落地页（Hero + 功能介绍 + CTA）
/login                     // 登录/注册（合并页面，Tab切换）
/share/:id                 // 分享页面
/i/:id                     // 图床短链（密码保护图片）

// 认证路由
/files                     // 文件管理器（默认路径）
/files/*                   // 文件夹浏览
/shares                    // 我的分享
/settings                  // 用户设置
/settings/profile          // 个人资料
/settings/security         // 安全设置
/settings/api-keys         // API密钥管理
/settings/appearance       // 外观设置

// 管理员路由
/admin                     // 管理员仪表板
/admin/users               // 用户管理
/admin/storage             // 存储配置
/admin/mounts              // 挂载点管理
/admin/permissions         // 权限规则
/admin/logs                // 访问日志
/admin/settings            // 系统设置
```

## 安全威胁模型

### 威胁分类与防护

#### 1. 认证与会话攻击

**威胁T1.1: 登录暴力破解**
- **场景**: 攻击者尝试大量密码组合
- **防护**:
  - 速率限制：5次失败后延迟增加（1s → 2s → 5s → 10s → 30s）
  - 账户锁定：10次失败后锁定30分钟
  - Turnstile验证码（可选）
  - 记录失败尝试到access_logs

**威胁T1.2: 会话劫持**
- **场景**: XSS或中间人攻击窃取Cookie
- **防护**:
  - HttpOnly Cookie（防止JS访问）
  - Secure Cookie（仅HTTPS）
  - SameSite=Strict（防止CSRF）
  - 短期JWT（7天过期）
  - User-Agent绑定（可选）

**威胁T1.3: JWT角色提升**
- **场景**: JWT内嵌角色，用户被禁用后仍可访问
- **防护**:
  ```typescript
  // 每次请求都检查用户状态
  async function authMiddleware(c: Context, next: Next) {
    const payload = await verifyToken(token);
    
    // 从数据库重新查询用户
    const user = await db.getUserById(payload.sub);
    
    // 检查用户状态
    if (!user || user.status !== 'active') {
      return c.json({ error: 'USER_DISABLED' }, 401);
    }
    
    // 检查角色是否改变
    if (user.role !== payload.role) {
      return c.json({ error: 'ROLE_CHANGED' }, 401);
    }
    
    c.set('userId', user.id);
    c.set('userRole', user.role);
    await next();
  }
  ```

**威胁T1.4: 密码找回攻击**
- **场景**: 攻击者利用找回密码流程
- **防护**:
  - 验证码保护
  - 邮件Token有效期15分钟
  - Token一次性使用
  - 速率限制：每小时最多3次请求

---

#### 2. 权限绕过攻击

**威胁T2.1: 路径遍历**
- **场景**: `../../../etc/passwd` 或双重编码
- **防护**:
  ```typescript
  function sanitizePath(path: string): string {
    // 1. URL解码（防止双重编码）
    let decoded = decodeURIComponent(path);
    
    // 2. Unicode NFC归一化
    decoded = decoded.normalize('NFC');
    
    // 3. 移除 .. 和 ~
    if (decoded.includes('..') || decoded.includes('~')) {
      throw new Error('INVALID_PATH');
    }
    
    // 4. 确保以/开头
    if (!decoded.startsWith('/')) {
      decoded = '/' + decoded;
    }
    
    // 5. 移除多余斜杠
    decoded = decoded.replace(/\/+/g, '/');
    
    // 6. 移除尾部斜杠
    decoded = decoded.replace(/\/+$/, '');
    
    return decoded || '/';
  }
  ```

**威胁T2.2: 越过用户根路径**
- **场景**: 用户defaultPath=/users/alice，尝试访问/users/bob
- **防护**:
  ```typescript
  // 在权限检查函数中强制边界
  if (principal.type === 'user' && principal.defaultPath !== '/') {
    const userRoot = normalizePath(principal.defaultPath);
    if (!canonicalPath.startsWith(userRoot)) {
      return 'deny'; // 硬边界，不可越过
    }
  }
  ```

**威胁T2.3: 密码保护绕过**
- **场景**: 直接访问签名URL绕过密码
- **防护**:
  - 生成URL前检查密码状态
  - 密码保护文件使用短期签名（15分钟）
  - 记录密码验证日志

---

#### 3. 注入攻击

**威胁T3.1: 存储型XSS**
- **场景**: 上传恶意HTML/SVG文件，其他用户预览时执行
- **防护**:
  - **HTML文件**: 强制下载，不预览
  - **SVG文件**: 设置`Content-Type: text/plain`或强制下载
  - **Markdown**: 仅显示纯文本，不渲染
  - **代码文件**: highlight.js纯文本高亮，不执行

**威胁T3.2: SQL注入**
- **场景**: 用户输入未过滤
- **防护**:
  - 使用参数化查询（Prepared Statements）
  - Zod验证所有输入
  ```typescript
  // ❌ 错误
  await db.query(`SELECT * FROM files WHERE name = '${fileName}'`);
  
  // ✅ 正确
  await db.prepare('SELECT * FROM files WHERE name = ?').bind(fileName).all();
  ```

**威胁T3.3: XXE（XML外部实体）**
- **场景**: WebDAV的XML解析
- **防护**:
  - 禁用外部实体解析
  ```typescript
  import { XMLParser } from 'fast-xml-parser';
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,  // 关键：禁用实体
    allowBooleanAttributes: true
  });
  ```

---

#### 4. SSRF（服务端请求伪造）

**威胁T4.1: 自定义endpoint攻击**
- **场景**: 管理员添加存储时，endpoint指向内网
- **防护**:
  ```typescript
  const BLOCKED_HOSTS = [
    'localhost', '127.0.0.1', '0.0.0.0',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    '169.254.0.0/16', // AWS metadata
  ];
  
  function validateEndpoint(endpoint: string): boolean {
    const url = new URL(endpoint);
    
    // 检查协议
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new Error('INVALID_PROTOCOL');
    }
    
    // 检查主机名
    const hostname = url.hostname;
    if (BLOCKED_HOSTS.some(blocked => hostname.includes(blocked))) {
      throw new Error('BLOCKED_HOST');
    }
    
    // 检查IP范围
    if (isPrivateIP(hostname)) {
      throw new Error('PRIVATE_IP_BLOCKED');
    }
    
    return true;
  }
  ```

**威胁T4.2: 封面URL抓取**
- **场景**: coverUrl指向内网服务
- **防护**: 同上endpoint验证

---

#### 5. 文件上传攻击

**威胁T5.1: 文件类型伪造**
- **场景**: 上传.exe改名为.jpg
- **防护**:
  ```typescript
  const DANGEROUS_MIME_TYPES = [
    'application/x-msdownload',    // .exe
    'application/x-executable',
    'application/x-sharedlib',     // .so
    'application/x-msdos-program',
    'text/html',                   // 防止XSS
    'application/xhtml+xml',
  ];
  
  function validateFile(fileName: string, mimeType: string) {
    // 1. 扩展名黑名单
    const ext = fileName.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (['.exe', '.bat', '.cmd', '.sh', '.php', '.asp', '.jsp'].includes(ext)) {
      throw new Error('DANGEROUS_FILE_TYPE');
    }
    
    // 2. MIME类型黑名单
    if (DANGEROUS_MIME_TYPES.includes(mimeType)) {
      throw new Error('DANGEROUS_MIME_TYPE');
    }
    
    return true;
  }
  ```

**威胁T5.2: 文件名注入**
- **场景**: 文件名包含特殊字符
- **防护**:
  ```typescript
  const FileNameSchema = z.string()
    .min(1)
    .max(255)
    .regex(/^[^<>:"/\\|?*\x00-\x1F]+$/, '文件名包含非法字符')
    .refine(name => !name.includes('..'), '不允许..')
    .refine(name => name !== '.' && name !== '..', '保留名称');
  ```

**威胁T5.3: Zip炸弹**
- **场景**: 上传极小的zip，解压后占满磁盘
- **防护**:
  - 禁止上传压缩包（推荐）
  - 或限制解压后大小检查

---

#### 6. CSRF（跨站请求伪造）

**威胁T6.1: Cookie认证的写操作**
- **场景**: 恶意网站诱导用户点击，利用Cookie执行操作
- **防护**:
  - SameSite=Strict Cookie
  - 关键操作添加CSRF Token
  ```typescript
  // 前端获取Token
  const csrfToken = await fetch('/api/csrf-token').then(r => r.json());
  
  // 写操作携带Token
  await fetch('/api/files/delete', {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrfToken.token
    },
    body: JSON.stringify({ fileId })
  });
  
  // 服务端验证
  async function csrfMiddleware(c: Context, next: Next) {
    if (['POST', 'PUT', 'DELETE'].includes(c.req.method)) {
      const token = c.req.header('X-CSRF-Token');
      const userId = c.get('userId');
      
      const stored = await env.KV.get(`csrf:${userId}`);
      if (token !== stored) {
        return c.json({ error: 'INVALID_CSRF' }, 403);
      }
    }
    
    await next();
  }
  ```

---

#### 7. 速率限制绕过

**威胁T7.1: 分布式攻击**
- **场景**: 使用代理池绕过IP限流
- **防护**:
  - 多层限流：IP + 用户 + API密钥
  ```typescript
  // 组合键
  const keys = [
    `ip:${ip}`,
    `user:${userId}`,
    `apikey:${apiKeyId}`
  ];
  
  for (const key of keys) {
    const result = await checkRateLimit(key, 50, 60); // 50次/分钟
    if (!result.allowed) {
      return c.json({ error: 'RATE_LIMIT_EXCEEDED' }, 429);
    }
  }
  ```

**威胁T7.2: KV非原子性**
- **场景**: 并发请求绕过计数器
- **防护**:
  - 使用Cloudflare Durable Objects（原子计数器）
  - 或接受小误差（性能优先）

---

#### 8. 数据泄露

**威胁T8.1: 日志泄露敏感信息**
- **场景**: 日志记录密码、Token
- **防护**:
  ```typescript
  function sanitizeForLog(data: any): any {
    const sensitive = ['password', 'token', 'secret', 'key', 'authorization'];
    
    if (typeof data !== 'object') return data;
    
    const sanitized = { ...data };
    for (const key in sanitized) {
      if (sensitive.some(s => key.toLowerCase().includes(s))) {
        sanitized[key] = '***REDACTED***';
      } else if (typeof sanitized[key] === 'object') {
        sanitized[key] = sanitizeForLog(sanitized[key]);
      }
    }
    
    return sanitized;
  }
  
  // 使用
  console.log('Request:', sanitizeForLog(request));
  ```

**威胁T8.2: 错误消息泄露**
- **场景**: 详细错误暴露内部结构
- **防护**:
  ```typescript
  // 生产环境隐藏详细信息
  function errorHandler(error: Error, c: Context) {
    const isDev = c.env.ENVIRONMENT === 'development';
    
    return c.json({
      success: false,
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message,
        details: isDev ? error.stack : undefined // 仅开发环境
      }
    }, error.statusCode || 500);
  }
  ```

---

#### 9. 密钥管理

**威胁T9.1: 密钥轮换缺失**
- **场景**: JWT_SECRET泄露，无法快速响应
- **防护**:
  - 支持多密钥验证（旧+新）
  ```typescript
  const JWT_SECRETS = [
    env.JWT_SECRET,        // 当前密钥（签发）
    env.JWT_SECRET_OLD     // 旧密钥（仅验证）
  ];
  
  async function verifyToken(token: string) {
    for (const secret of JWT_SECRETS) {
      try {
        const key = new TextEncoder().encode(secret);
        const { payload } = await jwtVerify(token, key);
        return payload;
      } catch (e) {
        continue;
      }
    }
    return null; // 全部失败
  }
  ```

**威胁T9.2: 数据库密钥明文存储**
- **场景**: storage_providers表的accessKey泄露
- **防护**: AES-GCM加密存储
  ```typescript
  async function encryptKey(plaintext: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.ENCRYPTION_KEY),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    
    // IV + 密文拼接后Base64
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    
    return btoa(String.fromCharCode(...combined));
  }
  ```

---

#### 10. 内容安全策略（CSP）

**修复后的CSP**:
```typescript
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'nonce-{NONCE}' https://challenges.cloudflare.com",
  "style-src 'self' 'nonce-{NONCE}'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.r2.cloudflarestorage.com",
  "media-src 'self' blob: https:",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests"
].join('; ');

// 生成Nonce
function generateNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

// 注入到HTML
const nonce = generateNonce();
const csp = CSP.replace(/{NONCE}/g, nonce);

headers.set('Content-Security-Policy', csp);

// 在HTML中使用
<script nonce="${nonce}">
  // 内联脚本
</script>
```

**移除**:
- ❌ `unsafe-inline`
- ❌ `unsafe-eval`
- ✅ 使用 `nonce` 或 `hash`

---

### 安全检查清单

#### 部署前检查

- [ ] JWT_SECRET 至少32字符随机字符串
- [ ] ENCRYPTION_KEY 至少32字符随机字符串
- [ ] 所有Secrets通过`wrangler secret put`设置，不在代码中
- [ ] CORS配置只允许信任的域名
- [ ] CSP不包含`unsafe-inline`和`unsafe-eval`
- [ ] 生产环境禁用详细错误信息
- [ ] 所有数据库查询使用参数化
- [ ] 文件上传校验扩展名和MIME类型
- [ ] 路径归一化和越界检查
- [ ] 速率限制启用
- [ ] Turnstile验证码配置（可选）
- [ ] SMTP配置正确（邮件验证）

#### 代码审查检查

- [ ] 权限检查覆盖所有写操作
- [ ] 移动操作检查源和目标权限
- [ ] 密码保护文件的URL生成逻辑正确
- [ ] 上传会话有过期时间
- [ ] 操作任务有失败恢复逻辑
- [ ] 日志不记录敏感信息
- [ ] 错误响应不泄露内部信息
- [ ] API密钥可撤销
- [ ] 分享链接可撤销

---

## 部署方案

### 唯一支持：Cloudflare Workers + Pages

#### 前置要求

**账户**:
- Cloudflare账户（免费或付费）
- GitHub账户（代码托管 + CI/CD）
- 域名（可选，可用`.pages.dev`）

**创建资源**:
```bash
# 安装Wrangler CLI
npm install -g wrangler

# 登录
wrangler login

# 创建D1数据库
wrangler d1 create picumet-db
# 输出: database_id: xxx-xxx-xxx

# 创建KV命名空间
wrangler kv:namespace create PICUMET_KV
# 输出: id: xxx

wrangler kv:namespace create PICUMET_KV --preview
# 输出: preview_id: xxx

# 创建R2存储桶
wrangler r2 bucket create picumet-storage
```

---

#### 项目结构

```
picumet/
├── frontend/                   # React前端
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── main.tsx
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── workers/                    # Cloudflare Workers API
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── services/
│   │   ├── utils/
│   │   └── index.ts
│   ├── migrations/
│   │   └── 0001_initial.sql
│   ├── wrangler.toml
│   ├── package.json
│   └── tsconfig.json
├── shared/                     # 共享类型
│   └── types.ts
├── .github/
│   └── workflows/
│       └── deploy.yml
└── README.md
```

---

#### wrangler.toml配置

```toml
name = "picumet-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"
account_id = "your_account_id"

# 路由
routes = [
  { pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }
]

[vars]
ENVIRONMENT = "production"

# D1数据库
[[d1_databases]]
binding = "DB"
database_name = "picumet-db"
database_id = "your_d1_database_id"

# KV存储
[[kv_namespaces]]
binding = "KV"
id = "your_kv_namespace_id"

# R2存储桶
[[r2_buckets]]
binding = "R2"
bucket_name = "picumet-storage"

# Analytics Engine
[[analytics_engine_datasets]]
binding = "ANALYTICS"

# Secrets（通过命令行设置）
# wrangler secret put JWT_SECRET
# wrangler secret put ENCRYPTION_KEY
# wrangler secret put TURNSTILE_SECRET_KEY
# wrangler secret put SMTP_HOST
# wrangler secret put SMTP_PORT
# wrangler secret put SMTP_USER
# wrangler secret put SMTP_PASS
# wrangler secret put SMTP_FROM

# 开发环境
[env.dev]
name = "picumet-api-dev"
vars = { ENVIRONMENT = "development" }

[[env.dev.d1_databases]]
binding = "DB"
database_name = "picumet-db-dev"
database_id = "your_dev_d1_database_id"

[[env.dev.kv_namespaces]]
binding = "KV"
preview_id = "your_preview_kv_namespace_id"
```

---

#### 部署步骤

##### 1. 初始化数据库

```bash
cd workers

# 本地开发环境
wrangler d1 execute picumet-db --local --file=./migrations/0001_initial.sql

# 生产环境
wrangler d1 execute picumet-db --file=./migrations/0001_initial.sql
```

##### 2. 设置Secrets

```bash
# 生成强随机字符串（至少32字符）
openssl rand -base64 32

# 设置JWT密钥
wrangler secret put JWT_SECRET
# 粘贴上面生成的随机字符串

# 设置加密密钥
wrangler secret put ENCRYPTION_KEY
# 再生成一个随机字符串

# 设置SMTP配置
wrangler secret put SMTP_HOST
# 输入: smtp.gmail.com

wrangler secret put SMTP_PORT
# 输入: 587

wrangler secret put SMTP_USER
# 输入: your-email@gmail.com

wrangler secret put SMTP_PASS
# 输入: your-app-password

wrangler secret put SMTP_FROM
# 输入: "Picumet" <noreply@yourdomain.com>

# 可选：Turnstile
wrangler secret put TURNSTILE_SECRET_KEY
```

##### 3. 部署Workers API

```bash
cd workers

# 安装依赖
npm install

# 部署
wrangler deploy

# 或部署到开发环境
wrangler deploy --env dev
```

##### 4. 部署前端到Pages

**方法1: Git集成（推荐）**

1. 推送代码到GitHub
2. Cloudflare Dashboard → Pages → Create project
3. 连接GitHub仓库
4. 构建配置:
   - Framework: Vite
   - Build command: `cd frontend && npm install && npm run build`
   - Build output: `frontend/dist`
   - Root directory: `/`
5. 环境变量:
   - `VITE_API_BASE_URL`: `https://api.yourdomain.com`
   - `VITE_TURNSTILE_SITE_KEY`: `your_site_key`
6. Deploy

**方法2: 命令行**

```bash
cd frontend
npm install
npm run build

npx wrangler pages deploy dist --project-name=picumet
```

##### 5. 配置域名

**DNS记录**:
| 类型 | 名称 | 内容 | 代理 |
|------|------|------|------|
| CNAME | @ | picumet.pages.dev | ✅ |
| CNAME | api | (Workers自动) | ✅ |

---

#### CI/CD（GitHub Actions）

`.github/workflows/deploy.yml`:
```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy-workers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install & Deploy Workers
        run: |
          cd workers
          npm ci
          npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  
  deploy-pages:
    runs-on: ubuntu-latest
    needs: deploy-workers
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Build Frontend
        run: |
          cd frontend
          npm ci
          npm run build
        env:
          VITE_API_BASE_URL: ${{ secrets.API_BASE_URL }}
      
      - name: Deploy to Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: picumet
          directory: frontend/dist
```

**GitHub Secrets**:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `API_BASE_URL`

---

#### 本地开发

```bash
# 终端1: Workers
cd workers
npm install
wrangler dev --local --persist
# 运行在 http://localhost:8787

# 终端2: 前端
cd frontend
npm install
npm run dev
# 运行在 http://localhost:5173
# Vite代理 /api → http://localhost:8787
```

---

#### 成本估算

**免费额度**:
- Workers: 100,000请求/天
- Pages: 无限构建和流量
- D1: 5GB存储 + 500万行读取/天
- KV: 100,000读/天 + 1,000写/天
- R2: 10GB存储/月 + 100万A类操作/月

**付费成本**（假设1000用户，100GB存储）:
- Workers: ~$10/月
- D1: $5/月
- R2: $1.50/月（存储）+ $5/月（请求）
- **总计**: ~$21.5/月

---

## 开发路线图

**说明**: 按照技术依赖和功能优先级排序，每个阶段完成后才能开始下一阶段

---

### 阶段0: 环境搭建

**依赖**: 无  
**输出**: 可运行的开发环境

**任务清单**:
1. 创建Cloudflare账户和配置Workers/Pages/D1/R2
2. 初始化前端项目（React + Vite + TypeScript + shadcn-ui）
3. 初始化Workers项目（Hono框架）
4. 配置wrangler.toml和环境变量
5. 设置本地开发环境
   - Workers本地开发服务器（`wrangler dev`）
   - 前端开发服务器（`npm run dev`）
   - API代理配置
6. 执行数据库迁移脚本（初始化D1）
7. 配置GitHub仓库和CI/CD（可选）

**验收标准**:
- ✅ 前端可访问 http://localhost:5173
- ✅ Workers API可访问 http://localhost:8787
- ✅ 数据库表已创建
- ✅ 可成功构建和部署到Cloudflare

---

### 阶段1: 认证系统

**依赖**: 阶段0完成  
**输出**: 用户可注册、登录、管理会话

**任务清单**:
1. 实现用户认证API
   - POST /api/auth/register（注册）
   - POST /api/auth/login（登录，设置HttpOnly Cookie）
   - POST /api/auth/logout（登出）
   - GET /api/auth/me（获取当前用户）
2. 实现JWT生成和验证（jose库）
3. 实现密码哈希（bcrypt）
4. 创建认证中间件（authMiddleware）
5. 前端：登录页面和注册页面
6. 前端：认证状态管理（React Context）
7. 前端：路由守卫（未登录跳转登录页）

**验收标准**:
- ✅ 用户可注册账户
- ✅ 用户可登录并获得JWT Cookie
- ✅ 未登录访问受保护路由会跳转登录页
- ✅ 登出后Cookie被清除

---

### 阶段2: 核心权限系统

**依赖**: 阶段1完成  
**输出**: 权限判定算法可用，支持管理员、用户、访客三级

**任务清单**:
1. 实现权限判定函数（checkPermission）
   - 路径段边界检查（isPathWithinBoundary）
   - 规则排序算法
   - 默认拒绝逻辑
2. 创建path_rules表和管理API
   - POST /api/admin/rules（创建规则）
   - GET /api/admin/rules（列出规则）
   - DELETE /api/admin/rules/:id（删除规则）
3. 实现角色中间件（adminMiddleware）
4. 前端：管理员权限管理页面
5. 编写权限测试用例

**验收标准**:
- ✅ 管理员可访问所有路径
- ✅ 用户只能访问授权路径
- ✅ /users/alice 不能访问 /users/alice2
- ✅ 规则优先级正确排序

---

### 阶段3: 对象存储连接（R2）

**依赖**: 阶段2完成  
**输出**: 可以连接Cloudflare R2，进行基础对象操作

**任务清单**:
1. 创建storage_configs表
2. 实现R2 Provider类
   - 初始化S3Client（@aws-sdk/client-s3）
   - listObjects（列出对象）
   - putObject（上传对象）
   - deleteObject（删除对象）
   - getObject（下载对象）
   - getSignedUrl（生成预签名URL）
3. 实现存储配置管理API
   - POST /api/admin/storage（添加R2配置）
   - GET /api/admin/storage（列出配置）
4. 前端：管理员存储配置页面

**验收标准**:
- ✅ 管理员可添加R2存储配置
- ✅ 可列出R2存储桶中的对象
- ✅ 可生成预签名URL

---

### 阶段4: 基础文件管理

**依赖**: 阶段3完成  
**输出**: 用户可浏览、上传、下载、删除文件

**任务清单**:
1. 创建file_metadata表
2. 实现文件列表API
   - GET /api/files?path=/（列出文件）
   - GET /api/files/:id（获取文件详情）
3. 实现上传流程（简单版，无分片）
   - POST /api/upload/init（创建上传会话）
   - 前端直接上传到预签名URL
   - POST /api/upload/complete（完成上传）
4. 实现下载流程
   - 统一授权函数（authorizeDownload）
   - GET /gateway/download/:token（下载代理）
   - POST /api/files/:id/copy-link（复制链接）
5. 实现删除流程（硬删除）
   - DELETE /api/files/:id
   - 原子删除元数据 + 异步清理对象
6. 前端：文件管理器主界面
   - 文件列表（卡片视图）
   - 上传按钮和进度条
   - 删除确认对话框
   - 面包屑导航

**验收标准**:
- ✅ 可浏览文件夹和文件
- ✅ 可上传文件（<100MB）
- ✅ 可下载文件
- ✅ 可删除文件（元数据立即删除，对象异步清理）
- ✅ 删除后配额正确更新

---

### 阶段5: 配额管理

**依赾**: 阶段4完成  
**输出**: 用户上传受配额限制

**任务清单**:
1. 创建user_quotas表
2. 实现配额检查和预留
   - 上传时原子预留配额
   - 上传完成/失败后更新/释放配额
3. 实现配额管理API
   - GET /api/quotas/me（获取我的配额）
   - PATCH /api/admin/users/:id/quota（管理员设置配额）
4. 实现定时任务：释放过期配额预留
5. 前端：配额显示组件（进度条）
6. 前端：管理员用户配额设置

**验收标准**:
- ✅ 用户上传超配额时被拒绝
- ✅ 并发上传不会超配额
- ✅ 删除文件后配额正确释放
- ✅ 管理员可设置用户配额

---

### 阶段6: 文件移动和重命名

**依赖**: 阶段5完成  
**输出**: 用户可移动、重命名文件

**任务清单**:
1. 实现Saga移动流程
   - POST /api/files/:id/move
   - 复制 → 验证 → 切换元数据 → 标记清理
2. 实现定时任务：清理移动源对象
3. 实现重命名（同路径移动）
   - POST /api/files/:id/rename
4. 前端：右键菜单（移动、重命名）
5. 前端：文件夹选择器组件

**验收标准**:
- ✅ 可移动文件到其他文件夹
- ✅ 移动失败时源文件不丢失
- ✅ 可重命名文件
- ✅ 移动后立即可访问新路径

---

### 阶段7: 密码保护和分享

**依赖**: 阶段6完成  
**输出**: 文件可设置密码，可创建分享链接

**任务清单**:
1. 实现文件密码设置
   - PATCH /api/files/:id（设置accessPassword）
   - POST /api/files/:id/verify-password（验证密码）
2. 创建shares表
3. 实现分享API
   - POST /api/shares（创建分享）
   - GET /api/shares（我的分享列表）
   - DELETE /api/shares/:id（删除分享）
   - GET /share/:token（访问分享）
4. 分享密码、过期时间、访问次数限制
5. 前端：创建分享弹窗
6. 前端：分享页面（密码输入）
7. 前端：我的分享列表页

**验收标准**:
- ✅ 可为文件设置访问密码
- ✅ 无密码无法访问受保护文件
- ✅ 可创建分享链接
- ✅ 分享次数限制生效
- ✅ 过期分享无法访问

---

### 阶段8: API密钥（脚本上传）

**依赖**: 阶段7完成  
**输出**: 用户可创建API密钥，用于脚本上传

**任务清单**:
1. 创建api_keys表（修复版，使用token_hash）
2. 实现API密钥管理
   - POST /api/keys（创建密钥，返回完整令牌）
   - GET /api/keys（列出我的密钥）
   - DELETE /api/keys/:id（撤销密钥）
3. 实现Bearer认证中间件
   - 验证 `Bearer pk_xxx.sk_yyy`
4. 实现WebDAV Basic Auth（PicGo兼容）
   - 验证 `Basic base64(keyId:secret)`
5. 前端：API密钥管理页面
6. 前端：创建成功显示完整令牌（仅一次）

**验收标准**:
- ✅ 可创建API密钥
- ✅ Bearer令牌可认证成功
- ✅ WebDAV方式可上传文件
- ✅ 撤销后立即失效
- ✅ 仅Key ID无法通过验证

---

### 阶段9: 高级UI功能

**依赖**: 阶段8完成  
**输出**: 完整的文件管理器体验

**任务清单**:
1. 列表视图（表格模式）
2. 文件选择（单选、多选、范围选择）
3. 批量操作（批量删除、批量移动）
4. 拖拽上传（DropZone）
5. 拖拽移动文件（Drag & Drop API）
6. 属性面板（编辑标题、颜色、封面）
7. 文件预览
   - 图片查看器（放大、缩小、旋转）
   - 视频播放器（DPlayer）
   - 代码高亮（highlight.js）
8. 搜索功能（D1 LIKE查询）
9. 排序和筛选

**验收标准**:
- ✅ 可切换卡片/列表视图
- ✅ 可多选文件进行批量操作
- ✅ 可拖拽文件到文件夹
- ✅ 可拖拽上传文件
- ✅ 图片可预览和缩放
- ✅ 视频可播放

---

### 阶段10: 外观定制和国际化

**依赖**: 阶段9完成  
**输出**: 用户可自定义外观和语言

**任务清单**:
1. 实现主题切换（light/dark/system）
2. 实现自定义强调色
3. 实现模糊效果开关
4. 实现自定义背景（localStorage）
5. 实现国际化（i18next）
   - 中文语言包
   - 英文语言包
6. 前端：外观设置页面
7. 前端：语言切换器

**验收标准**:
- ✅ 可切换深色/浅色主题
- ✅ 可自定义强调色
- ✅ 可切换中英文
- ✅ 设置保存到localStorage

---

### 阶段11: 管理员功能

**依赖**: 阶段10完成  
**输出**: 管理员仪表板和管理功能

**任务清单**:
1. 管理员仪表板
   - 用户统计
   - 存储使用统计
   - 访问日志图表
2. 用户管理
   - GET /api/admin/users（列出用户）
   - PATCH /api/admin/users/:id（编辑用户）
   - DELETE /api/admin/users/:id（删除用户）
3. 全局分享管理
   - GET /api/admin/shares（所有分享）
   - DELETE /api/admin/shares/:id（删除任意分享）
4. 访问日志查看
   - GET /api/admin/logs（查询日志）
5. 系统设置
   - 站点标题、Logo、Favicon
   - 公告管理
6. 前端：管理员页面集合

**验收标准**:
- ✅ 管理员可查看所有用户
- ✅ 管理员可设置用户配额
- ✅ 管理员可查看访问日志
- ✅ 管理员可管理全局分享
- ✅ 管理员可发布公告

---

### 阶段12: 安全加固

**依赖**: 阶段11完成  
**输出**: 生产环境安全措施

**任务清单**:
1. 实现速率限制（基于KV）
   - 每IP每分钟50次请求
   - 每用户每分钟100次请求
2. 实现热点文件检测
   - 5分钟内>100次访问自动限制
3. CSP头设置
4. 输入验证和清理
   - 路径验证（防目录遍历）
   - 文件名验证
   - 循环解码检测
5. 日志记录和监控
6. 定时对账任务

**验收标准**:
- ✅ 超速请求被拒绝
- ✅ 热点文件访问受限
- ✅ 路径遍历攻击被阻止
- ✅ XSS/CSRF防护生效
- ✅ 对账任务可识别不一致

---

### 阶段13: 分片上传（大文件支持）

**依赖**: 阶段12完成  
**输出**: 支持大文件上传（>100MB）

**任务清单**:
1. 实现分片上传API
   - POST /api/upload/multipart/init
   - POST /api/upload/multipart/parts（获取分片预签名URL）
   - POST /api/upload/multipart/complete
   - DELETE /api/upload/multipart/abort
2. 实现分片状态机
3. 前端：分片上传逻辑
4. 前端：断点续传支持

**验收标准**:
- ✅ 可上传>1GB文件
- ✅ 上传失败可续传
- ✅ 分片并发上传

---

### 阶段14: 扩展存储源

**依赖**: 阶段13完成  
**输出**: 支持AWS S3和Oracle Cloud

**任务清单**:
1. 实现AWS S3 Provider
2. 实现Oracle Cloud Provider
3. Provider工厂模式
4. 前端：存储类型选择器

**验收标准**:
- ✅ 可添加AWS S3配置
- ✅ 可添加Oracle Cloud配置
- ✅ 不同存储源可共存

---

### 阶段15: 自由模式（用户自带凭据）

**依赖**: 阶段14完成  
**输出**: 用户可输入自己的对象存储凭据进行临时操作

**任务清单**:
1. 实现临时会话存储（仅内存，不持久化）
2. 创建自由模式登录页面
   - 选择存储类型（R2/S3/Oracle）
   - 输入endpoint、accessKey、secretKey、bucket
   - 会话过期时间（1小时/4小时/8小时）
3. 实现临时Provider初始化
   - 凭据仅保存在Workers内存中
   - 绑定到会话token
   - 过期自动清理
4. 权限限制
   - 自由模式用户仅能访问自己的存储
   - 不能访问系统配置的存储
   - 不能创建分享链接
   - 不能使用API密钥
5. 前端：自由模式界面标识
   - 顶部显示"自由模式"徽章
   - 显示会话剩余时间
   - 退出时清除凭据

**验收标准**:
- ✅ 用户可输入R2凭据临时访问
- ✅ 会话过期后凭据自动清理
- ✅ 凭据不保存到localStorage或数据库
- ✅ 自由模式用户不能访问系统存储
- ✅ 退出登录后凭据立即清除

**安全要点**:
- ❌ 不在localStorage存储对象存储密钥
- ✅ 凭据仅在Workers内存中
- ✅ 使用加密传输（HTTPS）
- ✅ 会话token绑定IP地址
- ✅ 超时自动清理

---

### 阶段16: 测试和部署

**依赖**: 阶段15完成  
**输出**: 可部署到生产环境

**任务清单**:
1. 单元测试（核心逻辑）
2. 集成测试（API端点）
3. E2E测试（关键流程）
4. 性能测试（并发上传、大文件）
5. 安全测试（渗透测试）
6. 文档完善
   - API文档（OpenAPI）
   - 部署文档
   - 用户手册
7. 生产环境部署
   - 配置Cloudflare生产环境
   - DNS配置
   - 监控告警
8. 备份策略

**验收标准**:
- ✅ 测试覆盖率>80%
- ✅ 所有关键流程有E2E测试
- ✅ 性能满足要求（1000并发用户）
- ✅ 安全扫描无高危漏洞
- ✅ 生产环境可访问

---

## 开发顺序总结

```
阶段0: 环境搭建
   ↓
阶段1: 认证系统
   ↓
阶段2: 核心权限系统
   ↓
阶段3: 对象存储连接（R2）
   ↓
阶段4: 基础文件管理
   ↓
阶段5: 配额管理
   ↓
阶段6: 文件移动和重命名
   ↓
阶段7: 密码保护和分享
   ↓
阶段8: API密钥（脚本上传）
   ↓
阶段9: 高级UI功能
   ↓
阶段10: 外观定制和国际化
   ↓
阶段11: 管理员功能
   ↓
阶段12: 安全加固
   ↓
阶段13: 分片上传（大文件支持）
   ↓
阶段14: 扩展存储源（S3/Oracle）
   ↓
阶段15: 自由模式（用户自带凭据）
   ↓
阶段16: 测试和部署
```

**每个阶段的完成标志**: 所有验收标准通过

**建议开发节奏**:
- 阶段0-4: 2周（MVP核心）
- 阶段5-8: 2周（高级功能）
- 阶段9-11: 2周（完整体验）
- 阶段12-13: 1周（安全和大文件）
- 阶段14-15: 1周（扩展功能）
- 阶段16: 1周（测试部署）
- **总计**: 约9周完成全部功能

**关键里程碑**:
- 🎯 **M1**: 阶段4完成 = 可用的文件管理系统
- 🎯 **M2**: 阶段8完成 = 完整的API和分享功能
- 🎯 **M3**: 阶段11完成 = 多用户生产系统
- 🎯 **M4**: 阶段15完成 = 全功能版本
- 🎯 **M5**: 阶段16完成 = 正式发布

---

## 数据模型

### 核心表结构

参见前文"数据库设计"章节的完整Schema定义。

---

## 验收标准

### 核心功能验收

#### F1: 用户注册与登录

**Given** 新用户访问注册页面  
**When** 填写用户名、邮箱、密码并提交  
**Then** 发送验证邮件，显示"请检查邮箱"提示

**Given** 用户点击邮件中的验证链接  
**When** 访问验证URL  
**Then** 标记邮箱为已验证，重定向到登录页

**Given** 已验证用户输入正确凭据  
**When** 点击登录  
**Then** 设置HttpOnly Cookie，重定向到 `/files`

---

#### F2: 文件上传与一致性

**Given** 用户选择1个100KB的文件上传  
**When** 提交上传  
**Then** 创建upload_session，预留配额，返回预签名URL

**Given** 前端直传完成  
**When** 回调 `/api/files/upload-complete`  
**Then** Workers执行HEAD检查，验证ETag和大小，事务提交元数据+配额

**Given** 攻击者伪造upload-complete请求  
**When** 提交不存在的ETag  
**Then** HEAD检查失败，返回错误，不更新数据库

---

#### F3: 权限判定

**Given** 用户defaultPath=/users/alice  
**When** 尝试访问 `/users/bob/file.txt`  
**Then** 权限检查失败，返回403 FORBIDDEN

**Given** 文件设置了密码  
**When** 用户点击下载  
**Then** 弹出密码输入框

**Given** 用户输入正确密码  
**When** 提交验证  
**Then** 返回15分钟有效的签名URL

---

#### F4: 文件移动

**Given** 用户有 `/a/file.txt` 的删除权限和 `/b/` 的写入权限  
**When** 移动文件到 `/b/file.txt`  
**Then** 创建operation_job，复制对象，验证，删除源对象，更新元数据

**Given** 移动操作在"删除源对象"阶段失败  
**When** 失败恢复触发  
**Then** 保留源对象，标记任务为failed

---

#### F5: 分享链接

**Given** 用户创建分享链接，设置密码和7天过期  
**When** 其他人访问分享URL  
**Then** 显示密码输入页面

**Given** 访问者输入正确密码  
**When** 提交验证  
**Then** 显示文件预览和下载按钮

**Given** 分享创建者撤销分享  
**When** 访问者再次访问  
**Then** 显示"分享已撤销"

---

### 安全验收

#### S1: XSS防护

**Given** 用户上传HTML文件  
**When** 其他用户点击查看  
**Then** 强制下载，不在浏览器中打开

**Given** 用户上传SVG文件  
**When** 其他用户预览  
**Then** 设置Content-Type为text/plain或强制下载

---

#### S2: 路径遍历防护

**Given** 攻击者提交path=`../../../etc/passwd`  
**When** 请求文件列表  
**Then** 路径归一化后检查，返回INVALID_PATH错误

**Given** 攻击者提交双重编码path=`%252e%252e%252f`  
**When** 解码和归一化  
**Then** 检测到`..`，拒绝请求

---

#### S3: 上传伪造防护

**Given** 攻击者直接调用upload-complete API  
**When** 提交伪造的sessionId和etag  
**Then** HEAD请求验证失败，返回错误，不更新配额

---

#### S4: 速率限制

**Given** 用户在1分钟内发起51次请求  
**When** 第51次请求到达  
**Then** 返回429 RATE_LIMIT_EXCEEDED

---

### 性能验收

**P1**: 文件列表加载 < 500ms（100文件）  
**P2**: 文件上传（10MB）< 5秒（R2直传）  
**P3**: 图片预览打开 < 300ms  
**P4**: 权限检查 < 50ms  
**P5**: 首屏加载 < 2秒（LCP）

---

**文档版本**: 2.0  
**完成日期**: 2026-08-18  
**作者**: Picumet Team + AI Assistant

---

**END OF SPECIFICATION**

### 1. 落地页

**路径**: `/`  
**访问**: 公开

**布局**:
```
┌─────────────────────────────────────────┐
│ [Logo] Picumet      [功能] [定价] [登录]│
├─────────────────────────────────────────┤
│                                         │
│          Picumet                        │
│     多云对象存储管理平台                │
│   统一管理你的云端文件和图床            │
│                                         │
│     [开始使用 →] [GitHub]               │
│                                         │
├─────────────────────────────────────────┤
│  特性展示（3列卡片）                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐│
│  │ 🔐       │ │ 📦       │ │ 🚀       ││
│  │细粒度权限│ │多云支持  │ │边缘加速  ││
│  └──────────┘ └──────────┘ └──────────┘│
│                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐│
│  │ 🔗       │ │ 🎨       │ │ 🌐       ││
│  │分享链接  │ │自定义外观│ │国际化    ││
│  └──────────┘ └──────────┘ └──────────┘│
│                                         │
├─────────────────────────────────────────┤
│  立即开始                               │
│  免费开源，部署到Cloudflare             │
│  [查看文档] [开始部署]                  │
└─────────────────────────────────────────┘
```

**关键组件**:
- `HeroSection`: 大标题 + CTA按钮
- `FeatureGrid`: 特性展示（6个卡片）
- `CTASection`: 底部行动号召
- `Footer`: 页脚（GitHub、文档、版本）

---

### 2. 登录/注册页面

**路径**: `/login`  
**访问**: 公开

**布局**（Tab切换）:
```
┌─────────────────────────────────────────┐
│  [← 返回首页]                           │
│                                         │
│         ┌─────────────────────┐        │
│         │   [Logo] Picumet    │        │
│         │                     │        │
│         │  [登录] | [注册]    │  ← Tab│
│         │  ─────             │        │
│         │                     │        │
│         │  用户名             │        │
│         │  [__________]       │        │
│         │                     │        │
│         │  密码               │        │
│         │  [__________]       │        │
│         │                     │        │
│         │  □ 记住我           │        │
│         │                     │        │
│         │  [登录]             │        │
│         │                     │        │
│         │  忘记密码？         │        │
│         └─────────────────────┘        │
└─────────────────────────────────────────┘
```

**注册Tab额外字段**:
- 邮箱（必需）
- Turnstile验证码（如果启用）
- 邀请码（如果启用）

**验收标准**:
- Given 用户未登录  
  When 访问 `/files`  
  Then 重定向到 `/login?redirect=/files`
  
- Given 用户输入正确的用户名密码  
  When 点击登录  
  Then 设置Cookie并重定向到 `redirect` 或 `/files`
  
- Given 用户注册新账户  
  When 提交注册表单  
  Then 发送验证邮件并显示提示

---

### 3. 文件管理器

**路径**: `/files` 或 `/files/*`  
**访问**: 认证用户

**桌面布局**:
```
┌───────────────────────────────────────────────────────────┐
│ [Logo] [面包屑: 首页 > 图片]    [搜索] [@用户] [⚙️]       │
├──────┬────────────────────────────────────────────┬───────┤
│      │ Toolbar                                    │ Props │
│ 📁   │ [↑上传] [+新建] [卡片▾] [排序▾] [已选3项] │ Panel │
│ 全部 ├────────────────────────────────────────────┤       │
│      │                                            │ 文件名│
│ 📁   │  Files (卡片视图)                          │ ────  │
│ 图片 │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐        │ 类型  │
│      │  │ 📁  │ │ 📁  │ │ 🖼️  │ │ 📄  │        │ 大小  │
│ 🗂️   │  │文档 │ │视频 │ │bg.jpg│ │readme│        │ 修改  │
│ 文档 │  └─────┘ └─────┘ └─────┘ └─────┘        │       │
│      │  ┌─────┐ ┌─────┐ 🔒                      │ 🎨    │
│ ⭐   │  │ 📹  │ │ 🎵  │ data.pdf (需密码)       │ 颜色  │
│ 收藏 │  │video│ │music│                         │       │
│      │  └─────┘ └─────┘                         │ 封面  │
│ 🔗   │                                            │ [URL] │
│ 分享 │                                            │       │
│      │                                            │ 位置  │
│ 🔗   │                                            │ 手动  │
│ 分享 │                                            │ [↑↓] │
└──────┴────────────────────────────────────────────┴───────┘
```

**移动端布局**:
- 侧边栏折叠为汉堡菜单（Drawer）
- 属性面板改为底部Sheet
- 卡片视图改为2列
- 工具栏简化为浮动按钮

**核心交互**:

1. **文件选择**:
   - 单击：选中（显示Checkbox）
   - Ctrl/Cmd + 单击：多选
   - Shift + 单击：范围选择
   - Ctrl/Cmd + A：全选

2. **拖拽操作**:
   - 拖动文件到文件夹：移动
   - 拖动到侧边栏：移动到快捷路径
   - 拖动文件到上传区：上传
   - 拖动排序（sortBy=manual时）：调整位置

3. **双击操作**:
   - 文件夹：进入
   - 图片：预览
   - 视频/音频：播放
   - 其他文件：下载

4. **右键菜单**:
   - 打开
   - 下载
   - 重命名
   - 移动到...
   - 复制链接
   - 分享
   - 设置密码
   - 删除
   - 属性

5. **批量操作栏**（选中多项时显示）:
   ```
   ┌───────────────────────────────────────┐
   │ 已选 3 项  [移动] [删除] [取消选择]   │
   └───────────────────────────────────────┘
   ```

**验收标准**:
- Given 用户在 `/files/images`  
  When 拖动 `photo.jpg` 到 `/documents`  
  Then 检查两个路径权限，创建移动任务，显示进度

- Given 用户选中3个文件  
  When 点击批量删除  
  Then 显示确认对话框，确认后永久删除，刷新列表

- Given 文件设置了密码  
  When 用户点击下载  
  Then 弹出密码输入框，验证后返回URL

**关键组件**:
- `FileExplorer`: 主容器
- `Sidebar`: 侧边栏（文件树）
- `Toolbar`: 工具栏
- `FileGrid`: 卡片视图
- `FileList`: 列表视图（备选）
- `FileItem`: 单个文件卡片
- `PropertiesPanel`: 属性面板
- `BulkActionsBar`: 批量操作栏
- `ContextMenu`: 右键菜单
- `UploadDropzone`: 拖拽上传区

---

### 4. 上传弹窗

**触发**: 点击上传按钮 / 拖拽文件

**布局**:
```
┌─────────────────────────────────────┐
│ 上传文件                       [×]  │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐  │
│  │    📤                        │  │
│  │  拖拽文件到此处              │  │
│  │  或 [选择文件] [选择文件夹]  │  │
│  └─────────────────────────────┘  │
│                                     │
│  目标路径: /uploads/               │
│  [选择路径]                         │
│                                     │
│  正在上传 (2/5)                     │
│  ┌─────────────────────────────┐  │
│  │ 📄 document.pdf              │  │
│  │ ████████░░░░ 75% (2.3MB/3MB) │  │
│  │ [暂停] [取消]                │  │
│  └─────────────────────────────┘  │
│  ┌─────────────────────────────┐  │
│  │ 🖼️ image.jpg                 │  │
│  │ ██░░░░░░░░░░ 20% (500KB/2.5MB)│  │
│  │ [暂停] [取消]                │  │
│  └─────────────────────────────┘  │
│                                     │
│  已完成 (2)                         │
│  ✓ file1.txt                       │
│  ✓ file2.png                       │
│                                     │
│  失败 (1)                           │
│  ✗ toolarge.mp4 (超出配额)         │
│                                     │
│  [暂停全部] [清空列表] [完成]      │
└─────────────────────────────────────┘
```

**功能**:
- 多文件并发上传（3线程）
- 大文件自动分片（>100MB）
- 暂停/恢复
- 失败重试
- 上传前重命名
- 路径选择器

**关键组件**:
- `UploadModal`: 上传弹窗
- `UploadDropzone`: 拖拽区
- `UploadQueue`: 队列管理
- `UploadItem`: 单个任务进度条
- `PathSelector`: 路径选择器

---

### 5. 文件预览器

#### 图片预览（PhotoSwipe）

```
┌───────────────────────────────────────┐
│ [×]                    [⬇] [🔗]       │
│                                       │
│                                       │
│               🖼️                      │
│         (图片内容)                    │
│                                       │
│                                       │
│  [◀] 1/5 [▶]                         │
│  [🔍-] 100% [🔍+] [↻] [编辑Squoosh]  │
└───────────────────────────────────────┘
```

**功能**:
- 缩放（滚轮/手势）
- 旋转（90°增量）
- 左右切换（同目录图片）
- 下载原图
- 跳转Squoosh编辑（`https://squoosh.hxcn.dev/?url=...`）

**库**: PhotoSwipe 5

#### 视频/音频预览（DPlayer）

**功能**:
- 播放/暂停
- 进度拖动
- 音量控制
- 倍速播放（0.5x ~ 2x）
- 画中画（视频）
- 全屏

**库**: DPlayer

#### 代码文件预览（纯文本）

**功能**:
- 语法高亮（highlight.js）
- 行号显示
- 复制代码
- 下载文件
- **不渲染HTML/Markdown**（安全）

**支持语言**: JavaScript, TypeScript, Python, Go, Rust, Java, C++, HTML, CSS, Markdown, JSON, YAML

---

### 6. 分享页面

**路径**: `/share/:id` 或 `/i/:id`  
**访问**: 公开

**需要密码时**:
```
┌─────────────────────────────────┐
│  [Logo] Picumet                 │
│                                 │
│    🔒 此分享需要密码            │
│                                 │
│    标题: 重要文档.pdf           │
│    分享者: @alice               │
│                                 │
│    ┌─────────────────────┐    │
│    │  密码                │    │
│    │  [_______________]   │    │
│    │  [查看]              │    │
│    └─────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

**验证成功后**:
```
┌─────────────────────────────────────┐
│  [Logo] Picumet                     │
├─────────────────────────────────────┤
│                                     │
│  📄 重要文档.pdf                    │
│  ─────────────────────                │
│  大小: 2.3 MB                       │
│  分享者: @alice                     │
│  过期时间: 2026-08-25 12:00         │
│  访问次数: 23/100                   │
│                                     │
│  ┌─────────────────────────────┐  │
│  │   (文件预览)                 │  │
│  │   根据文件类型显示           │  │
│  └─────────────────────────────┘  │
│                                     │
│  [⬇ 下载] [🔗 复制链接] [📱 二维码]│
│                                     │
└─────────────────────────────────────┘
```

**验收标准**:
- Given 分享有密码  
  When 用户访问链接  
  Then 显示密码输入页面
  
- Given 用户输入正确密码  
  When 提交验证  
  Then 显示文件预览和下载按钮
  
- Given 分享已过期  
  When 访问链接  
  Then 显示"分享已过期"

---

### 7. 用户设置页面

**路径**: `/settings/*`  
**访问**: 认证用户

**侧边栏**:
```
┌──────────────┐
│ 个人资料     │
│ 安全设置     │
│ API密钥      │
│ 外观设置     │
└──────────────┘
```

#### 7.1 个人资料

**字段**:
- 头像（上传/URL）
- 显示名称
- 邮箱（已验证标识）
- 默认路径
- 语言（中文/English）

#### 7.2 安全设置

**功能**:
- 修改密码
- 当前会话列表
- 登出所有设备

#### 7.3 API密钥

**列表**:
```
┌─────────────────────────────────────┐
│ API密钥                  [+ 创建]   │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐│
│ │ 📌 PicGo上传密钥                ││
│ │ pk_abc...xyz                    ││
│ │ 协议: WebDAV, API               ││
│ │ 最后使用: 2小时前               ││
│ │ [查看配置] [撤销]               ││
│ └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

**创建弹窗**:
```
┌─────────────────────────────────────┐
│ 创建API密钥                    [×]  │
├─────────────────────────────────────┤
│ 名称: [PicGo上传]                   │
│                                     │
│ 支持协议:                           │
│ ☑ WebDAV (PicGo/PicList)            │
│ ☑ 自定义API                         │
│                                     │
│ 上传路径: [/uploads/{year}/{month}/]│
│                                     │
│ 权限:                               │
│ ☑ 上传  ☐ 删除                     │
│                                     │
│ 高级:                               │
│ IP白名单: [留空=不限]               │
│ 有效期: [永久 ▾]                    │
│                                     │
│ [取消] [创建]                       │
└─────────────────────────────────────┘
```

**创建成功显示**:
```
┌─────────────────────────────────────┐
│ ✅ API密钥已创建                    │
├─────────────────────────────────────┤
│ ⚠️ 密钥仅显示一次，请妥善保存！     │
│                                     │
│ Key ID: pk_abc123...                │
│ Secret: sk_xyz789... [📋 复制]     │
│                                     │
│ PicGo/PicList配置:                  │
│ ┌─────────────────────────────┐   │
│ │ 📦 WebDAV                    │   │
│ │ URL: https://api...com/webdav│   │
│ │ 用户名: pk_abc123...         │   │
│ │ 密码: sk_xyz789...           │   │
│ │ [📋 复制配置JSON]            │   │
│ └─────────────────────────────┘   │
│ ┌─────────────────────────────┐   │
│ │ 🔧 自定义API                 │   │
│ │ URL: https://api...com/upload│   │
│ │ Header: Bearer pk_abc123...  │   │
│ │ [📋 复制配置JSON]            │   │
│ └─────────────────────────────┘   │
│                                     │
│ [完成]                              │
└─────────────────────────────────────┘
```

#### 7.4 外观设置

**选项**:
- 主题: 浅色 / 深色 / 跟随系统
- 强调色: 色盘选择器（#3B82F6）
- 字体色: 色盘选择器（高级）
- 模糊效果: 开关
- 自定义背景:
  - 上传图片
  - URL输入
  - 纯色选择

**实现**: 存储在localStorage

```typescript
interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;     // HEX
  fontColor?: string;
  enableBlur: boolean;
  backgroundType: 'none' | 'image' | 'color';
  backgroundUrl?: string;
  backgroundColor?: string;
}
```

---

### 8. 管理员后台

**路径**: `/admin`  
**访问**: 管理员

**仪表板**:
```
┌─────────────────────────────────────────────────┐
│ [Logo] 管理控制台           [@admin] [退出]     │
├──────┬──────────────────────────────────────────┤
│      │ 概览统计                                 │
│ 📊   │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐        │
│ 仪表 │ │用户 │ │文件 │ │存储 │ │请求 │        │
│ 板   │ │123  │ │45.6K│ │2.3TB│ │1.2M │        │
│      │ └─────┘ └─────┘ └─────┘ └─────┘        │
│ 👥   │                                          │
│ 用户 │ 存储使用趋势                             │
│ 管理 │ ┌────────────────────────────────┐      │
│      │ │          📈                    │      │
│ 💾   │ │     (折线图 / 图表库)          │      │
│ 存储 │ │                                │      │
│ 配置 │ └────────────────────────────────┘      │
│      │                                          │
│ 🔗   │ 近期活动                                 │
│ 挂载 │ • 用户@alice上传了10个文件               │
│ 点   │ • 管理员@admin添加了新存储               │
│      │ • 系统清理了100个孤儿对象                │
│ 🔐   │                                          │
│ 权限 │                                          │
│ 规则 │                                          │
│      │                                          │
│ 📝   │                                          │
│ 日志 │                                          │
│      │                                          │
│ ⚙️   │                                          │
│ 设置 │                                          │
└──────┴──────────────────────────────────────────┘
```

**关键功能页面**:

1. **用户管理**: 表格 + 编辑弹窗
2. **存储配置**: 卡片列表 + 添加表单
3. **挂载点管理**: 列表 + 优先级调整
4. **权限规则**: 表格 + 可视化编辑器
5. **访问日志**: 表格 + 过滤器
6. **系统设置**: 分组表单

---

### 9. 响应式设计

**断点**:
```typescript
const breakpoints = {
  sm: '640px',    // 手机横屏
  md: '768px',    // 平板
  lg: '1024px',   // 小屏电脑
  xl: '1280px',   // 台式机
  '2xl': '1536px' // 大屏
};
```

**适配策略**:

| 屏幕尺寸 | 布局调整 |
|----------|----------|
| < 768px (移动) | 侧边栏→抽屉，属性面板→底部Sheet，卡片2列 |
| 768-1024px (平板) | 侧边栏可折叠，属性面板可隐藏，卡片3列 |
| > 1024px (桌面) | 三栏布局，卡片4-6列 |

**验收标准**:
- Given 屏幕宽度 < 768px  
  When 访问文件管理器  
  Then 侧边栏折叠，点击汉堡菜单打开Drawer
  
- Given 用户在移动端选择文件  
  When 点击"属性"  
  Then 从底部弹出Sheet显示属性

---

#### 2. 文件管理 (Files)

##### GET /api/files
列出文件

**查询参数**:
```typescript
{
  path?: string;           // 默认 "/"
  page?: number;           // 默认 1
  limit?: number;          // 默认 100，最大 1000
  sort?: 'name' | 'time' | 'size' | 'manual'; // 默认 name
  order?: 'asc' | 'desc';  // 默认 asc
  search?: string;         // 搜索关键词
  type?: 'file' | 'folder'; // 类型过滤
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    items: Array<{
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
      hasPassword: boolean;     // 是否需要密码
      manualPosition?: number;  // 手动排序位置
      ownerId: string;
      createdAt: number;
      updatedAt: number;
      deletedAt?: number;
    }>;
    pagination: {
      total: number;
      page: number;
      limit: number;
      pages: number;
    };
    mount: {
      id: string;
      name: string;
      sortBy: string;
      sortOrder: string;
    };
  }
}
```

##### POST /api/files/upload-session
创建上传会话（一致性保证）

**请求**:
```typescript
{
  path: string;            // 目标路径
  fileName: string;
  fileSize: number;
  mimeType: string;
  partCount?: number;      // 分片数（>100MB自动分片）
  idempotencyKey?: string; // 幂等键
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    sessionId: string;     // 会话ID
    uploadUrl?: string;    // 单次上传URL
    uploadId?: string;     // 分片上传ID
    parts?: Array<{        // 分片上传URLs
      partNumber: number;
      url: string;
    }>;
    expiresAt: number;     // 过期时间
    expiresIn: number;     // 有效期（秒）
  }
}
```

##### POST /api/files/upload-complete
完成上传（校验真实对象）

**请求**:
```typescript
{
  sessionId: string;
  etag: string;            // 对象ETag
  parts?: Array<{          // 分片信息
    partNumber: number;
    etag: string;
  }>;
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    file: {
      id: string;
      name: string;
      path: string;
      size: number;
      url: string;         // 访问URL
      createdAt: number;
    }
  }
}
```

**校验步骤**:
1. HEAD请求验证对象存在
2. 比对ETag和Size
3. 分片上传验证所有分片
4. 事务提交元数据+配额

##### GET /api/files/:id
获取文件详情

**响应**:
```typescript
{
  success: true;
  data: {
    file: { /* 文件对象 */ };
    mount: { /* 挂载信息 */ };
    permissions: string[];   // 当前用户对此文件的权限
    accessMode: string;      // private_gateway | signed_redirect | public_cdn
    hasPassword: boolean;
  }
}
```

##### POST /api/files/:id/verify-password
验证文件密码

**请求**:
```typescript
{
  password: string;
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    url: string;           // 访问URL（15分钟有效）
    expiresIn: number;
  }
}
```

##### GET /api/files/:id/download
获取下载链接

**响应**:
```typescript
{
  success: true;
  data: {
    url: string;
    expiresAt: number;
  }
}
```

##### GET /api/files/:id/copy-links
获取复制链接（多种格式）

**响应**:
```typescript
{
  success: true;
  data: {
    formats: {
      direct: string;      // 直链
      html: string;        // HTML img标签
      markdown: string;    // Markdown
      bbcode: string;      // BBCode
    };
    accessMode: string;
    needsPassword: boolean;
  }
}
```

##### DELETE /api/files/:id
删除文件（立即永久删除）

**查询参数**: 无

**响应**:
```typescript
{ success: true }
```

##### PUT /api/files/:id
更新文件元数据

**请求**:
```typescript
{
  name?: string;           // 重命名
  customTitle?: string;
  customColor?: string;
  coverUrl?: string;
  iconEmoji?: string;
  accessPassword?: string; // 设置文件密码（明文，服务端哈希）
  manualPosition?: number; // 手动排序位置
}
```

**响应**:
```typescript
{
  success: true;
  data: { file: { /* 更新后 */ } }
}
```

##### POST /api/files/:id/move
移动文件（状态机）

**请求**:
```typescript
{
  targetPath: string;
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    jobId: string;         // 操作任务ID
    status: 'pending';     // 异步操作
  }
}
```

##### GET /api/files/jobs/:jobId
查询操作任务状态

**响应**:
```typescript
{
  success: true;
  data: {
    job: {
      id: string;
      type: 'move' | 'copy' | 'delete';
      status: 'pending' | 'running' | 'completed' | 'failed';
      progress: number;    // 0-100
      errorMessage?: string;
      createdAt: number;
      completedAt?: number;
    }
  }
}
```

##### POST /api/files/batch
批量操作

**请求**:
```typescript
{
  action: 'delete' | 'move';
  fileIds: string[];
  targetPath?: string;     // move需要
  permanent?: boolean;     // delete时为true表示确认永久删除
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    succeeded: string[];
    failed: Array<{
      id: string;
      error: string;
    }>;
  }
}
```

---

#### 3. 分享 (Shares)

##### POST /api/shares
创建分享链接

**请求**:
```typescript
{
  fileId: string;
  title?: string;
  password?: string;       // 分享密码
  expiresIn?: number;      // 有效期（秒）
  maxViews?: number;
  maxDownloads?: number;
  allowPreview?: boolean;
  allowDownload?: boolean;
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    share: {
      id: string;          // 短ID
      url: string;         // 完整URL
      qrcode: string;      // 二维码Data URL
      expiresAt?: number;
      createdAt: number;
    }
  }
}
```

##### GET /api/shares/:id
获取分享信息

**查询参数**:
```typescript
{
  password?: string;       // 如果需要密码
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    share: {
      id: string;
      title: string;
      file: { /* 文件信息 */ };
      allowPreview: boolean;
      allowDownload: boolean;
      expiresAt?: number;
      requiresPassword: boolean;
    }
  }
}
```

##### DELETE /api/shares/:id
撤销分享

**响应**:
```typescript
{ success: true }
```

##### GET /api/shares
获取我的分享列表

**查询参数**:
```typescript
{
  page?: number;
  limit?: number;
  status?: 'active' | 'expired' | 'revoked';
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    items: Array<{ /* 分享对象 */ }>;
    pagination: { /* ... */ };
  }
}
```

---

#### 4. 用户设置 (Users)

##### GET /api/users/me/settings
获取用户设置

**响应**:
```typescript
{
  success: true;
  data: {
    profile: { /* 个人资料 */ };
    appearance: {
      theme: string;
      accentColor: string;
      fontColor: string;
      enableBlur: boolean;
      backgroundUrl: string;
    };
  }
}
```

##### PUT /api/users/me/settings
更新用户设置

**请求**:
```typescript
{
  displayName?: string;
  avatarUrl?: string;
  locale?: string;
  theme?: string;
  // ... 其他设置
}
```

**响应**:
```typescript
{ success: true }
```

##### PUT /api/users/me/password
修改密码

**请求**:
```typescript
{
  oldPassword: string;
  newPassword: string;
}
```

**响应**:
```typescript
{ success: true }
```

---

## API密钥认证

### 核心原则

**问题**: 旧设计将公开Key ID (`pk_xxx`) 作为Bearer令牌，服务端无法验证Secret

**修复**: Bearer令牌使用完整不透明令牌，格式 `pk_xxx.sk_yyy`，数据库仅存储哈希

### 令牌格式

```typescript
// 生成时（仅一次显示给用户）
const keyId = 'pk_' + randomString(24);    // 公开标识
const secret = 'sk_' + randomString(48);   // 密钥
const fullToken = `${keyId}.${secret}`;    // 完整令牌

// 存储到数据库
const tokenHash = await sha256(fullToken);
await db.insert('api_keys', {
  id: uuid(),
  user_id: userId,
  key_id: keyId,              // 公开部分（显示用）
  token_hash: tokenHash,      // 完整令牌哈希（验证用）
  permissions: ['write'],
  created_at: Date.now()
});

// 返回给用户（仅此一次）
return {
  keyId: keyId,               // 公开部分
  secret: secret,             // 密钥部分
  fullToken: fullToken        // 完整令牌（用于Bearer）
};
```

### 认证方式

#### 方式1: Bearer Token（推荐，用于自定义API）

```http
Authorization: Bearer pk_abc123xyz.sk_def456uvw
```

**验证逻辑**:
```typescript
async function verifyBearerToken(authHeader: string): Promise<ApiKey | null> {
  const token = authHeader.replace('Bearer ', '');
  
  // 验证格式
  if (!token.match(/^pk_[a-zA-Z0-9]+\.sk_[a-zA-Z0-9]+$/)) {
    return null;
  }
  
  // 计算哈希
  const tokenHash = await sha256(token);
  
  // 查询数据库
  const apiKey = await db.query(`
    SELECT id, user_id, key_id, permissions, 
           allowed_ips, expires_at, status
    FROM api_keys
    WHERE token_hash = ?
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
  `, [tokenHash, Date.now()]);
  
  if (!apiKey) {
    return null;
  }
  
  // 更新最后使用时间
  await db.query(`
    UPDATE api_keys SET last_used_at = ?
    WHERE id = ?
  `, [Date.now(), apiKey.id]);
  
  return apiKey;
}
```

#### 方式2: WebDAV Basic Auth（PicGo/PicList兼容）

```http
Authorization: Basic base64(keyId:secret)
```

**示例**:
```typescript
// PicGo配置
const username = 'pk_abc123xyz';
const password = 'sk_def456uvw';
const basicAuth = btoa(`${username}:${password}`);

// 请求
fetch('https://api.picumet.com/webdav/uploads/', {
  method: 'PUT',
  headers: {
    'Authorization': `Basic ${basicAuth}`
  },
  body: fileContent
});
```

**验证逻辑**:
```typescript
async function verifyBasicAuth(authHeader: string): Promise<ApiKey | null> {
  const base64Creds = authHeader.replace('Basic ', '');
  const [keyId, secret] = atob(base64Creds).split(':');
  
  // 重构为完整令牌
  const fullToken = `${keyId}.${secret}`;
  const tokenHash = await sha256(fullToken);
  
  // 后续逻辑同Bearer验证
  return await findApiKeyByHash(tokenHash);
}
```

### 数据库Schema（修复版）

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- 用户备注名称
  key_id TEXT UNIQUE NOT NULL,            -- 公开Key ID (pk_xxx)
  token_hash TEXT UNIQUE NOT NULL,        -- 完整令牌SHA256哈希
  permissions TEXT NOT NULL,              -- 权限JSON: ["read","write","delete"]
  upload_path TEXT DEFAULT '/',           -- 默认上传路径
  allowed_ips TEXT,                       -- IP白名单（逗号分隔）
  expires_at INTEGER,                     -- 过期时间（NULL=永久）
  last_used_at INTEGER,                   -- 最后使用时间
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',           -- 状态: active | revoked
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_token_hash ON api_keys(token_hash);
CREATE INDEX idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX idx_api_keys_status ON api_keys(status);
```

**关键变更**:
- ❌ 删除 `key_prefix` 和 `key_hash` 分离字段
- ✅ 新增 `token_hash` 存储完整令牌哈希
- ✅ 保留 `key_id` 仅用于显示

### API端点（修复版）

#### POST /api/keys - 创建API密钥

**请求**:
```typescript
{
  name: string;
  permissions: Permission[];  // ['read', 'write', 'delete']
  uploadPath?: string;
  allowedIps?: string[];
  expiresIn?: number;         // 有效期（秒）
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    key: {
      id: string;
      keyId: string;            // pk_abc123...（公开显示）
      secret: string;           // sk_xyz789...（⚠️仅此次显示）
      fullToken: string;        // pk_abc.sk_xyz（完整令牌）
      name: string;
      permissions: string[];
      uploadPath: string;
      createdAt: number;
    };
    configs: {
      // Bearer方式（自定义API）
      bearer: {
        url: 'https://api.picumet.com';
        header: 'Authorization: Bearer pk_abc.sk_xyz';
      };
      // WebDAV方式（PicGo）
      webdav: {
        url: 'https://api.picumet.com/webdav';
        username: 'pk_abc123...';
        password: 'sk_xyz789...';
      };
    };
  }
}
```

**安全提示**:
```typescript
// 前端显示警告
const warning = {
  title: '⚠️ 密钥仅显示一次',
  message: '请立即复制并妥善保存。关闭此窗口后将无法再次查看。',
  actions: ['复制完整令牌', '复制Bearer格式', '复制WebDAV配置']
};
```

#### GET /api/keys - 列出API密钥

**响应**:
```typescript
{
  success: true;
  data: {
    keys: Array<{
      id: string;
      name: string;
      keyId: string;            // pk_abc...（仅显示前缀）
      permissions: string[];
      uploadPath: string;
      lastUsedAt?: number;
      expiresAt?: number;
      createdAt: number;
      status: string;
      // ❌ 不返回secret或token_hash
    }>
  }
}
```

#### DELETE /api/keys/:id - 撤销API密钥

**操作**:
```typescript
await db.query(`
  UPDATE api_keys SET
    status = 'revoked',
    revoked_at = ?
  WHERE id = ? AND user_id = ?
`, [Date.now(), keyId, userId]);
```

---
      api: {
        url: 'https://api.picumet.com/api/upload';
        authorization: 'Bearer pk_abc123...';
      };
    }
  }
}
```

##### DELETE /api/keys/:id
撤销API密钥

**响应**:
```typescript
{ success: true }
```

---

#### 6. 管理员 (Admin)

##### GET /admin/dashboard
仪表板统计

**响应**:
```typescript
{
  success: true;
  data: {
    stats: {
      users: { total: number; active: number; };
      files: { total: number; size: number; };
      storage: Array<{
        providerId: string;
        name: string;
        usedSpace: number;
        fileCount: number;
      }>;
    };
    recentActivity: Array<{
      type: string;
      message: string;
      timestamp: number;
    }>;
  }
}
```

##### GET /admin/users
用户列表

**查询参数**:
```typescript
{
  page?: number;
  limit?: number;
  role?: string;
  status?: string;
  search?: string;
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    users: Array<{ /* 用户对象 */ }>;
    pagination: { /* ... */ };
  }
}
```

##### PUT /admin/users/:id
编辑用户

**请求**:
```typescript
{
  role?: string;
  status?: string;
  defaultPath?: string;
  quota?: {
    maxStorage?: number;
    maxFiles?: number;
  };
}
```

**响应**:
```typescript
{ success: true }
```

##### GET /admin/storage/providers
存储提供商列表

**响应**:
```typescript
{
  success: true;
  data: {
    providers: Array<{
      id: string;
      name: string;
      type: string;
      bucket: string;
      publicDomain: string;
      status: string;
    }>
  }
}
```

##### POST /admin/storage/providers
添加存储提供商

**请求**:
```typescript
{
  name: string;
  type: 'r2' | 's3' | 'oracle';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicDomain?: string;
  pathPrefix?: string;
}
```

**响应**:
```typescript
{
  success: true;
  data: { provider: { /* ... */ } }
}
```

##### POST /admin/storage/providers/:id/test
测试存储连接

**响应**:
```typescript
{
  success: true;
  data: {
    connected: boolean;
    message: string;
    latency?: number;       // 毫秒
  }
}
```

##### GET /admin/mounts
挂载点列表

**响应**:
```typescript
{
  success: true;
  data: {
    mounts: Array<{
      id: string;
      mountPath: string;
      name: string;
      providerId: string;
      providerName: string;
      priority: number;
      status: string;
    }>
  }
}
```

##### POST /admin/mounts
创建挂载点

**请求**:
```typescript
{
  providerId: string;
  mountPath: string;
  name: string;
  sortBy?: string;
  sortOrder?: string;
  priority?: number;
}
```

**响应**:
```typescript
{
  success: true;
  data: { mount: { /* ... */ } }
}
```

##### GET /admin/path-rules
路径规则列表

**响应**:
```typescript
{
  success: true;
  data: {
    rules: Array<{
      id: string;
      pathPattern: string;
      effect: 'allow' | 'deny';
      role?: string;
      userId?: string;
      permissions: string[];
      requirePassword: boolean;
      priority: number;
      status: string;
    }>
  }
}
```

##### POST /admin/path-rules
创建路径规则

**请求**:
```typescript
{
  pathPattern: string;     // /public/**
  effect: 'allow' | 'deny';
  role?: string;           // 或 userId
  userId?: string;
  permissions: string[];   // ['read', 'write']
  requirePassword?: boolean;
  password?: string;       // 明文，服务端哈希
  priority?: number;
}
```

**响应**:
```typescript
{
  success: true;
  data: { rule: { /* ... */ } }
}
```

##### GET /admin/logs
访问日志

**查询参数**:
```typescript
{
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  startDate?: number;
  endDate?: number;
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    logs: Array<{
      id: string;
      user?: { username: string; };
      file?: { name: string; path: string; };
      action: string;
      ipAddress: string;
      bytesTransferred: number;
      statusCode: number;
      createdAt: number;
    }>;
    pagination: { /* ... */ };
  }
}
```

##### GET /admin/settings
系统设置

**响应**:
```typescript
{
  success: true;
  data: {
    settings: Record<string, any>;
  }
}
```

##### PUT /admin/settings
更新系统设置

**请求**:
```typescript
{
  [key: string]: any;
}
```

**响应**:
```typescript
{ success: true }
```

---

## 兼容协议

### WebDAV接口（OpenList兼容）

#### 支持的方法

| 方法 | 路径 | 说明 |
|------|------|------|
| `PROPFIND` | `/webdav/` | 列举目录 |
| `GET` | `/webdav/path/file` | 下载文件 |
| `HEAD` | `/webdav/path/file` | 获取文件信息 |
| `PUT` | `/webdav/path/file` | 上传文件 |
| `DELETE` | `/webdav/path/file` | 删除文件 |
| `MKCOL` | `/webdav/path/folder` | 创建目录 |
| `MOVE` | `/webdav/path/file` | 移动文件 |
| `COPY` | `/webdav/path/file` | 复制文件 |

#### 认证方式

```http
Authorization: Basic base64(keyId:secret)
```

#### PROPFIND响应示例

```xml
<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/webdav/image.jpg</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>image.jpg</D:displayname>
        <D:getcontentlength>1024000</D:getcontentlength>
        <D:getcontenttype>image/jpeg</D:getcontenttype>
        <D:getlastmodified>Mon, 18 Aug 2026 12:00:00 GMT</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>
```

#### PicGo/PicList配置示例

```json
{
  "webdav": {
    "url": "https://api.picumet.com/webdav",
    "username": "pk_abc123def456xyz",
    "password": "sk_xyz789uvw456rst",
    "uploadPath": "/uploads/{year}/{month}/",
    "customUrl": "https://cdn.example.com"
  }
}
```

### 自定义上传API

#### POST /api/upload
Bearer Token认证的简单上传

**Headers**:
```http
Authorization: Bearer pk_abc123def456xyz
Content-Type: multipart/form-data
```

**Body**:
```
file: (binary)
path: /uploads/
```

**响应**:
```typescript
{
  success: true;
  data: {
    url: string;           // 文件URL
    path: string;
    name: string;
    size: number;
  }
}
```

#### PicGo自定义上传配置

```json
{
  "customUpload": {
    "url": "https://api.picumet.com/api/upload",
    "paramName": "file",
    "jsonPath": "data.url",
    "customHeader": {
      "Authorization": "Bearer pk_abc123def456xyz"
    },
    "customBody": {
      "path": "/uploads/"
    }
  }
}
```

---

## 访问模式与密码保护

### 访问模式定义

```typescript
enum AccessMode {
  // 私有网关：所有请求经过Workers，严格ACL
  PRIVATE_GATEWAY = 'private_gateway',
  
  // 签名重定向：签发前检查权限，跳转到签名URL（默认）
  SIGNED_REDIRECT = 'signed_redirect',
  
  // 公开CDN：无权限检查，用于图床（配置custom_domain时）
  PUBLIC_CDN = 'public_cdn'
}

interface AccessConfig {
  mode: AccessMode;
  signExpires?: number;       // 签名有效期（秒，默认3600）
  cdnDomain?: string;         // CDN域名（public_cdn需要）
  requirePassword?: boolean;  // 是否需要密码
}
```

### 访问模式对比

| 模式 | 权限检查 | 流量计费 | 速度限制 | 即时撤销 | 精确统计 | 适用场景 |
|------|----------|----------|----------|----------|----------|----------|
| **private_gateway** | ✅ 实时 | ✅ Workers | ✅ 支持 | ✅ 支持 | ✅ 精确 | 敏感文件 |
| **signed_redirect** | ⚠️ 签发时 | ⚠️ 对象存储 | ❌ 不支持 | ⚠️ 延迟 | ⚠️ 粗略 | 普通文件 |
| **public_cdn** | ❌ 无 | ❌ CDN | ❌ 不支持 | ❌ 不支持 | ❌ 无 | 公开图床 |

### 密码保护访问流程

#### 场景1：文件列表中显示但需密码下载

```
用户访问 /files/private
  ↓
Workers: 检查READ权限 → ✅ 允许
  ↓
返回文件列表（包含加锁标识）
┌─────────────────────────┐
│ 📄 document.pdf  🔒     │  ← 显示锁图标
│ 📄 public.txt           │
└─────────────────────────┘

用户点击下载 document.pdf
  ↓
前端: 检查file.accessPassword
  ↓
弹出密码输入框
  ↓
用户输入密码 → POST /api/files/:id/verify-password
  ↓
Workers: bcrypt.compare(input, file.accessPassword)
  ↓
✅ 密码正确 → 返回15分钟有效的签名URL
  ↓
前端跳转下载
```

#### 场景2：图床密码保护

```
图床链接: https://picumet.com/i/abc123
  ↓
Workers: 查询文件元数据
  ↓
检查accessPassword → 🔒 需要密码
  ↓
返回密码验证页面
┌─────────────────────────┐
│  🔒 该图片需要密码      │
│  [输入密码]             │
│  [查看]                 │
└─────────────────────────┘
  ↓
用户输入密码 → 验证
  ↓
✅ 正确 → 跳转到CDN直链或显示图片
```

### URL生成策略

```typescript
// 根据访问模式生成URL
async function generateFileUrl(
  file: FileMetadata,
  mount: Mount,
  provider: StorageProvider,
  accessMode: AccessMode
): Promise<string> {
  
  // 1. 公开CDN模式（图床）
  if (accessMode === 'public_cdn' && provider.publicDomain) {
    // 无权限检查，直接拼接
    return `https://${provider.publicDomain}/${file.objectKey}`;
  }
  
  // 2. 签名重定向模式（默认）
  if (accessMode === 'signed_redirect') {
    // 生成S3预签名URL
    const command = new GetObjectCommand({
      Bucket: provider.bucket,
      Key: file.objectKey
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600 // 1小时
    });
    
    return signedUrl;
  }
  
  // 3. 私有网关模式
  if (accessMode === 'private_gateway') {
    // 返回经过Workers的代理URL
    return `https://api.picumet.com/gateway/files/${file.id}/download`;
  }
  
  throw new Error('Invalid access mode');
}

// 复制链接API：返回多种格式
async function getCopyLinkFormats(fileId: string, userId: string) {
  const file = await db.getFileById(fileId);
  const mount = await db.getMount(file.mountId);
  const provider = await db.getStorageProvider(mount.providerId);
  
  // 判断访问模式
  const hasPassword = !!file.accessPassword;
  const hasPublicDomain = !!provider.publicDomain;
  
  let url: string;
  let accessMode: AccessMode;
  
  if (hasPassword) {
    // 有密码 → 必须走平台验证
    url = `https://picumet.com/i/${file.id}`;
    accessMode = 'private_gateway';
  } else if (hasPublicDomain) {
    // 无密码 + 有CDN → 公开链接
    url = `https://${provider.publicDomain}/${file.objectKey}`;
    accessMode = 'public_cdn';
  } else {
    // 无密码 + 无CDN → 签名URL
    url = await generateFileUrl(file, mount, provider, 'signed_redirect');
    accessMode = 'signed_redirect';
  }
  
  return {
    url,
    accessMode,
    formats: {
      direct: url,
      html: `<img src="${url}" alt="${file.name}" />`,
      markdown: `![${file.name}](${url})`,
      bbcode: `[img]${url}[/img]`,
      needsPassword: hasPassword
    }
  };
}
```

---

## 下载授权与链接生成

### 核心原则

**问题**: 旧设计直接返回CDN URL，绕过ACL、分享控制和下载计数

**修复**: 统一下载授权函数，区分公开对象和受控对象

### 统一下载授权函数

```typescript
/**
 * 统一下载授权检查
 * 所有下载、复制链接、分享访问必须通过此函数
 */
async function authorizeDownload(
  principal: Principal | null,  // null表示匿名访问
  fileId: string,
  context: {
    shareToken?: string;         // 分享令牌
    password?: string;           // 文件/路径密码
    ip?: string;
    userAgent?: string;
  }
): Promise<DownloadAuthorization> {
  
  const file = await db.getFileById(fileId);
  if (!file) {
    throw new NotFoundError('File not found');
  }
  
  const mount = await db.getMountById(file.mountId);
  const provider = await getProvider(mount.providerId);
  
  // 1. 检查文件是否标记为公开
  if (file.isPublic === true) {
    // 公开文件：可直接返回CDN URL（如果配置了）
    if (provider.publicDomain) {
      return {
        authorized: true,
        accessMode: 'public_cdn',
        url: `https://${provider.publicDomain}/${file.objectKey}`,
        needsPassword: false,
        allowDirectLink: true
      };
    }
  }
  
  // 2. 分享访问检查
  if (context.shareToken) {
    const share = await db.getShareByToken(context.shareToken);
    
    if (!share || share.status !== 'active') {
      throw new ForbiddenError('Invalid share link');
    }
    
    if (share.fileId !== fileId) {
      throw new ForbiddenError('Share token mismatch');
    }
    
    // 检查分享是否过期
    if (share.expiresAt && share.expiresAt < Date.now()) {
      throw new ForbiddenError('Share link expired');
    }
    
    // 检查访问次数限制
    if (share.maxViews && share.viewCount >= share.maxViews) {
      throw new ForbiddenError('Share link view limit reached');
    }
    
    // 检查下载次数限制
    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
      throw new ForbiddenError('Share link download limit reached');
    }
    
    // 分享密码验证
    if (share.passwordHash && !context.password) {
      return {
        authorized: false,
        needsPassword: true,
        accessMode: 'share_password_required'
      };
    }
    
    if (share.passwordHash) {
      const valid = await verifyPassword(context.password, share.passwordHash);
      if (!valid) {
        throw new ForbiddenError('Incorrect password');
      }
    }
    
    // 分享授权通过，生成短期令牌
    const downloadToken = await generateDownloadToken(fileId, {
      shareId: share.id,
      expiresIn: 900  // 15分钟
    });
    
    // 增加访问计数
    await db.incrementShareViewCount(share.id);
    
    return {
      authorized: true,
      accessMode: 'private_gateway',
      url: `https://api.picumet.com/gateway/download/${downloadToken}`,
      needsPassword: false,
      allowDirectLink: false,
      expiresIn: 900
    };
  }
  
  // 3. 用户访问检查
  if (!principal) {
    throw new UnauthorizedError('Authentication required');
  }
  
  // 4. 权限检查：download权限
  const hasPermission = checkPermission(
    principal,
    mount,
    file.path,
    'download',
    file.ownerId
  );
  
  if (hasPermission !== 'allow') {
    throw new ForbiddenError('No download permission');
  }
  
  // 5. 密码保护检查
  const passwordRequired = await checkPasswordRequired(file.path, file);
  if (passwordRequired.required && !context.password) {
    return {
      authorized: false,
      needsPassword: true,
      accessMode: 'password_required'
    };
  }
  
  if (passwordRequired.required) {
    const valid = await verifyPassword(context.password, passwordRequired.hash);
    if (!valid) {
      throw new ForbiddenError('Incorrect password');
    }
  }
  
  // 6. 授权通过，生成下载令牌
  const downloadToken = await generateDownloadToken(fileId, {
    userId: principal.id,
    expiresIn: 900  // 15分钟
  });
  
  // 7. 记录访问日志
  await db.insertAccessLog({
    id: uuid(),
    userId: principal.id,
    action: 'download',
    path: file.path,
    metadata: JSON.stringify({ fileId, fileName: file.name }),
    bytesTransferred: file.size,
    ipAddress: context.ip,
    userAgent: context.userAgent,
    createdAt: Date.now()
  });
  
  // 8. 更新用户流量配额（如果将来需要）
  // await db.incrementUserBandwidth(principal.id, file.size);
  
  return {
    authorized: true,
    accessMode: 'private_gateway',
    url: `https://api.picumet.com/gateway/download/${downloadToken}`,
    needsPassword: false,
    allowDirectLink: false,
    expiresIn: 900
  };
}

interface DownloadAuthorization {
  authorized: boolean;
  accessMode: 'public_cdn' | 'private_gateway' | 'password_required' | 'share_password_required';
  url?: string;
  needsPassword: boolean;
  allowDirectLink: boolean;  // 是否允许直接在HTML/Markdown中使用
  expiresIn?: number;        // URL有效期（秒）
}
```

### 下载令牌生成

```typescript
async function generateDownloadToken(
  fileId: string,
  options: {
    userId?: string;
    shareId?: string;
    expiresIn: number;  // 秒
  }
): Promise<string> {
  const token = randomString(32);
  const payload = {
    fileId,
    userId: options.userId,
    shareId: options.shareId,
    expiresAt: Date.now() + options.expiresIn * 1000
  };
  
  // 存储到KV（短期存储）
  await env.KV.put(
    `download:${token}`,
    JSON.stringify(payload),
    { expirationTtl: options.expiresIn }
  );
  
  return token;
}
```

### 下载网关实现

```typescript
// GET /gateway/download/:token
async function handleDownloadGateway(token: string, c: Context) {
  // 1. 验证令牌
  const payloadJson = await env.KV.get(`download:${token}`);
  if (!payloadJson) {
    return c.json({ error: 'Invalid or expired token' }, 403);
  }
  
  const payload = JSON.parse(payloadJson);
  
  // 2. 获取文件信息
  const file = await db.getFileById(payload.fileId);
  const mount = await db.getMountById(file.mountId);
  const provider = await getProvider(mount.providerId);
  
  // 3. 生成对象存储签名URL（短期）
  const signedUrl = await provider.getSignedUrl(file.objectKey, {
    expiresIn: 300  // 5分钟
  });
  
  // 4. 更新下载计数（如果是分享）
  if (payload.shareId) {
    await db.incrementShareDownloadCount(payload.shareId);
  }
  
  // 5. 重定向到签名URL
  return c.redirect(signedUrl, 302);
}
```

### 复制链接API（修复版）

```typescript
// POST /api/files/:id/copy-link
async function getCopyLinkFormats(
  fileId: string,
  principal: Principal,
  context: Context
) {
  // 1. 统一授权检查
  const auth = await authorizeDownload(principal, fileId, {
    ip: context.req.header('CF-Connecting-IP')
  });
  
  if (!auth.authorized) {
    if (auth.needsPassword) {
      return {
        needsPassword: true,
        message: '此文件需要密码访问'
      };
    }
    throw new ForbiddenError('Access denied');
  }
  
  // 2. 根据授权结果返回链接
  const file = await db.getFileById(fileId);
  
  let displayUrl: string;
  let warning: string | undefined;
  
  if (auth.accessMode === 'public_cdn') {
    // 公开CDN：直接URL
    displayUrl = auth.url;
    warning = undefined;
  } else {
    // 私有网关：短期令牌URL
    displayUrl = auth.url;
    warning = `此链接${auth.expiresIn / 60}分钟后过期`;
  }
  
  return {
    url: displayUrl,
    formats: {
      direct: displayUrl,
      html: `<img src="${displayUrl}" alt="${file.name}" />`,
      markdown: `![${file.name}](${displayUrl})`,
      bbcode: `[img]${displayUrl}[/img]`
    },
    accessMode: auth.accessMode,
    expiresIn: auth.expiresIn,
    warning
  };
}
```

### 文件isPublic标记

**数据库字段**:
```sql
ALTER TABLE file_metadata ADD COLUMN is_public INTEGER DEFAULT 0;
CREATE INDEX idx_file_metadata_is_public ON file_metadata(is_public);
```

**设置接口**:
```typescript
// PATCH /api/files/:id
{
  isPublic: boolean;  // 仅管理员可设置
}
```

**权限要求**:
- 只有管理员可以标记文件为公开
- 公开文件可绕过权限检查，直接使用CDN URL
- 非公开文件必须走授权流程

### 访问模式决策树

```
                    ┌────────────┐
                    │  请求下载  │
                    └──────┬─────┘
                           │
                    ┌──────▼──────────┐
                    │ file.isPublic?  │
                    └──────┬──────────┘
                      YES  │  NO
              ┌────────────┴──────────┐
              ▼                       ▼
       ┌──────────────┐      ┌──────────────┐
       │ 有CDN域名?   │      │ 有shareToken?│
       └──────┬───────┘      └──────┬───────┘
         YES  │  NO            YES  │  NO
     ┌────────┴─────┐      ┌───────┴────────┐
     ▼              ▼      ▼                ▼
┌─────────┐  ┌─────────┐ ┌────────┐  ┌──────────┐
│公开CDN  │  │签名URL │ │分享检查│  │权限检查  │
│直接访问 │  │(短期)  │ │        │  │          │
└─────────┘  └─────────┘ └───┬────┘  └────┬─────┘
                             │           │
                          ┌──▼───────────▼──┐
                          │ 需要密码?       │
                          └──┬──────────┬───┘
                        YES  │          │  NO
                     ┌───────┴──┐   ┌───▼────────┐
                     ▼          │   │生成下载令牌│
               ┌────────┐      │   └───┬────────┘
               │返回需要│      │       │
               │密码提示│      │   ┌───▼────────┐
               └────────┘      │   │私有网关URL │
                               │   └────────────┘
                               │
                          ┌────▼────┐
                          │验证密码 │
                          └────┬────┘
                               │
                          ┌────▼────────┐
                          │生成下载令牌 │
                          └────┬────────┘
                               │
                          ┌────▼────────┐
                          │私有网关URL  │
                          └─────────────┘
```

### 密码验证辅助函数

```typescript
async function checkPasswordRequired(
  path: string,
  file: FileMetadata
): Promise<{ required: boolean; hash?: string }> {
  // 1. 检查文件级密码
  if (file.accessPassword) {
    return { required: true, hash: file.accessPassword };
  }
  
  // 2. 检查路径规则密码
  const rules = await db.getPathRules();
  const matchingRule = rules
    .filter(r => r.requirePassword && isPathWithinBoundary(path, r.pathPattern))
    .sort((a, b) => b.priority - a.priority)[0];
  
  if (matchingRule?.passwordHash) {
    return { required: true, hash: matchingRule.passwordHash };
  }
  
  return { required: false };
}
```

---

### 密码保护API设计

```typescript
// POST /api/files/:id/verify-password
interface VerifyPasswordRequest {
  password: string;
}

interface VerifyPasswordResponse {
  success: boolean;
  url?: string;           // 验证成功返回访问URL
  expiresIn?: number;     // URL有效期（秒）
}

// 实现
async function verifyFilePassword(
  fileId: string,
  password: string,
  principal: Principal,
  context: Context
) {
  // 使用统一授权函数，传入密码
  const auth = await authorizeDownload(principal, fileId, {
    password,
    ip: context.ip,
    userAgent: context.userAgent
  });
  
  if (!auth.authorized) {
    throw new ForbiddenError('Password verification failed');
  }
  
  return {
    success: true,
    url: auth.url,
    expiresIn: auth.expiresIn
  };
}
```

---

## 数据模型

### 核心表结构

#### 1. users（用户表）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                    -- UUID
  username TEXT UNIQUE NOT NULL,          -- 用户名（3-20字符）
  email TEXT UNIQUE NOT NULL,             -- 邮箱（必需，用于验证）
  email_verified INTEGER DEFAULT 0,       -- 邮箱是否验证（0=否，1=是）
  password_hash TEXT NOT NULL,            -- bcrypt哈希
  role TEXT NOT NULL DEFAULT 'user',      -- admin | user | guest
  display_name TEXT,                      -- 显示名称
  avatar_url TEXT,                        -- 头像URL
  default_path TEXT NOT NULL DEFAULT '/', -- 用户根路径（安全边界）
  locale TEXT DEFAULT 'zh-CN',            -- zh-CN | en-US
  theme TEXT DEFAULT 'system',            -- light | dark | system
  created_at INTEGER NOT NULL,            -- Unix时间戳（毫秒）
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  status TEXT DEFAULT 'active',           -- active | disabled | banned
  CONSTRAINT chk_default_path CHECK (default_path LIKE '/%')
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);
```

#### 2. user_quotas（用户配额表）

```sql
CREATE TABLE user_quotas (
  user_id TEXT PRIMARY KEY,
  max_storage INTEGER DEFAULT 10737418240,  -- 10GB
  used_storage INTEGER DEFAULT 0,
  max_files INTEGER DEFAULT 10000,
  used_files INTEGER DEFAULT 0,
  -- 移除 max_bandwidth, used_bandwidth, max_download_speed
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_quotas_user_id ON user_quotas(user_id);
```

#### 3. storage_providers（存储提供商表）

```sql
CREATE TABLE storage_providers (
  id TEXT PRIMARY KEY,                      -- UUID
  name TEXT NOT NULL,                       -- 显示名称（如 "主存储"）
  type TEXT NOT NULL,                       -- r2 | s3 | oracle
  endpoint TEXT NOT NULL,                   -- S3端点URL
  region TEXT NOT NULL,                     -- 区域（R2用'auto'）
  bucket TEXT NOT NULL,                     -- 存储桶名称
  access_key_id TEXT NOT NULL,              -- Access Key（加密存储）
  secret_access_key TEXT NOT NULL,          -- Secret Key（加密存储）
  public_domain TEXT,                       -- 公开CDN域名（图床用）
  upload_domain TEXT,                       -- 上传域名
  path_prefix TEXT DEFAULT '',              -- 路径前缀（如 /prod/）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',             -- active | disabled
  CONSTRAINT chk_type CHECK (type IN ('r2', 's3', 'oracle'))
);

CREATE INDEX idx_storage_providers_type ON storage_providers(type);
CREATE INDEX idx_storage_providers_status ON storage_providers(status);
```

#### 4. mounts（挂载点表）

```sql
CREATE TABLE mounts (
  id TEXT PRIMARY KEY,                      -- UUID
  provider_id TEXT NOT NULL,                -- 关联storage_providers.id
  mount_path TEXT NOT NULL,                 -- 虚拟路径（如 /images）
  name TEXT NOT NULL,                       -- 挂载点名称
  sort_by TEXT DEFAULT 'name',              -- name | time | size | manual
  sort_order TEXT DEFAULT 'asc',            -- asc | desc
  priority INTEGER DEFAULT 0,               -- 路径冲突时的优先级
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (provider_id) REFERENCES storage_providers(id) ON DELETE CASCADE,
  CONSTRAINT chk_mount_path CHECK (mount_path LIKE '/%'),
  CONSTRAINT chk_sort_by CHECK (sort_by IN ('name', 'time', 'size', 'manual'))
);

-- 移除唯一索引，允许同路径多挂载（按priority排序）
CREATE INDEX idx_mounts_mount_path ON mounts(mount_path, priority DESC);
CREATE INDEX idx_mounts_provider_id ON mounts(provider_id);
CREATE INDEX idx_mounts_status ON mounts(status);
```

#### 5. file_metadata（文件元数据表）

```sql
CREATE TABLE file_metadata (
  id TEXT PRIMARY KEY,                      -- UUID
  mount_id TEXT NOT NULL,                   -- 关联mounts.id
  object_key TEXT NOT NULL,                 -- 对象存储中的实际key
  path TEXT NOT NULL,                       -- 虚拟路径（含挂载路径）
  name TEXT NOT NULL,                       -- 文件名
  type TEXT NOT NULL,                       -- file | folder
  mime_type TEXT,                           -- MIME类型
  size INTEGER DEFAULT 0,                   -- 文件大小（字节）
  etag TEXT,                                -- ETag（用于校验）
  checksum_md5 TEXT,                        -- MD5校验和
  version INTEGER DEFAULT 1,                -- 版本号（用于乐观锁）
  custom_title TEXT,                        -- 自定义标题
  custom_color TEXT,                        -- 自定义颜色（HEX）
  cover_url TEXT,                           -- 封面URL
  icon_emoji TEXT,                          -- 图标Emoji
  access_password TEXT,                     -- 文件级密码（bcrypt，可选）
  manual_position INTEGER,                  -- 手动排序位置
  metadata TEXT,                            -- 额外JSON元数据
  owner_id TEXT NOT NULL,                   -- 所有者用户ID
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_type CHECK (type IN ('file', 'folder')),
  UNIQUE (mount_id, object_key)             -- 添加唯一约束
);

CREATE INDEX idx_file_metadata_mount_path ON file_metadata(mount_id, path);
CREATE INDEX idx_file_metadata_owner_id ON file_metadata(owner_id);
CREATE INDEX idx_file_metadata_name ON file_metadata(name);  -- 搜索用
CREATE INDEX idx_file_metadata_type ON file_metadata(type);
CREATE INDEX idx_file_metadata_manual_position ON file_metadata(manual_position); -- 手动排序用
```

#### 6. upload_sessions（上传会话表，解决P0一致性问题）

```sql
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,                      -- UUID（会话ID）
  user_id TEXT NOT NULL,                    -- 上传用户
  mount_id TEXT NOT NULL,                   -- 目标挂载点
  object_key TEXT NOT NULL,                 -- 对象存储key
  path TEXT NOT NULL,                       -- 虚拟路径
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  upload_id TEXT,                           -- 分片上传ID（多片上传用）
  parts_count INTEGER,                      -- 预期分片数
  parts_uploaded TEXT,                      -- 已上传分片JSON数组
  quota_reserved INTEGER NOT NULL,          -- 预留的配额（字节）
  idempotency_key TEXT UNIQUE,              -- 幂等键
  status TEXT DEFAULT 'pending',            -- pending | uploading | verifying | completed | failed
  expires_at INTEGER NOT NULL,              -- 会话过期时间（15分钟）
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  CONSTRAINT chk_status CHECK (status IN ('pending', 'uploading', 'verifying', 'completed', 'failed'))
);

CREATE INDEX idx_upload_sessions_user_id ON upload_sessions(user_id);
CREATE INDEX idx_upload_sessions_status ON upload_sessions(status);
CREATE INDEX idx_upload_sessions_expires_at ON upload_sessions(expires_at);
CREATE INDEX idx_upload_sessions_idempotency_key ON upload_sessions(idempotency_key);
```

#### 7. operation_jobs（操作任务表，用于异步操作）

```sql
CREATE TABLE operation_jobs (
  id TEXT PRIMARY KEY,                      -- UUID
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                       -- move | copy | delete
  source_path TEXT NOT NULL,
  target_path TEXT,                         -- move/copy需要
  mount_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',            -- pending | running | completed | failed | rollback
  progress INTEGER DEFAULT 0,               -- 0-100
  error_message TEXT,
  state_data TEXT,                          -- 状态机数据（JSON）
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  CONSTRAINT chk_type CHECK (type IN ('move', 'copy', 'delete')),
  CONSTRAINT chk_status CHECK (status IN ('pending', 'running', 'completed', 'failed', 'rollback'))
);

CREATE INDEX idx_operation_jobs_user_id ON operation_jobs(user_id);
CREATE INDEX idx_operation_jobs_status ON operation_jobs(status);
CREATE INDEX idx_operation_jobs_created_at ON operation_jobs(created_at DESC);
```

#### 8. path_rules（路径权限规则表）

```sql
CREATE TABLE path_rules (
  id TEXT PRIMARY KEY,                      -- UUID
  path_pattern TEXT NOT NULL,               -- 路径模式（如 /public/**）
  effect TEXT NOT NULL DEFAULT 'allow',     -- allow | deny
  role TEXT,                                -- 目标角色（NULL=特定用户）
  user_id TEXT,                             -- 特定用户ID（NULL=角色）
  permissions TEXT NOT NULL,                -- JSON数组: ["read","write",...]
  require_password INTEGER DEFAULT 0,       -- 是否需要密码
  password_hash TEXT,                       -- 路径级密码（bcrypt）
  allowed_ips TEXT,                         -- IP白名单（逗号分隔）
  priority INTEGER DEFAULT 0,               -- 数字越大越优先
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_effect CHECK (effect IN ('allow', 'deny'))
);

CREATE INDEX idx_path_rules_path_pattern ON path_rules(path_pattern);
CREATE INDEX idx_path_rules_role ON path_rules(role);
CREATE INDEX idx_path_rules_user_id ON path_rules(user_id);
CREATE INDEX idx_path_rules_priority ON path_rules(priority DESC);
CREATE INDEX idx_path_rules_status ON path_rules(status);
```

#### 9. api_keys（API密钥表）

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                      -- UUID
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                       -- 密钥名称（备注）
  key_id TEXT UNIQUE NOT NULL,              -- 公开的Key ID（如 pk_abc...）
  key_secret_encrypted TEXT NOT NULL,       -- 可解密的Secret（用于WebDAV）
  key_hash TEXT UNIQUE NOT NULL,            -- Secret的SHA256（用于Bearer验证）
  protocols TEXT NOT NULL,                  -- JSON数组: ["webdav","api"]
  upload_path TEXT DEFAULT '/',             -- 默认上传路径
  permissions TEXT NOT NULL,                -- JSON数组: ["write"]
  allowed_ips TEXT,                         -- IP白名单
  expires_at INTEGER,                       -- 过期时间
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',             -- active | revoked
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_status ON api_keys(status);
```

#### 10. shares（分享链接表）

```sql
CREATE TABLE shares (
  id TEXT PRIMARY KEY,                      -- 短ID（如 abc123）
  file_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  title TEXT,
  password_hash TEXT,                       -- 分享密码
  expires_at INTEGER,
  max_views INTEGER,
  view_count INTEGER DEFAULT 0,
  max_downloads INTEGER,
  download_count INTEGER DEFAULT 0,
  allow_preview INTEGER DEFAULT 1,
  allow_download INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  status TEXT DEFAULT 'active',             -- active | expired | revoked
  FOREIGN KEY (file_id) REFERENCES file_metadata(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_shares_file_id ON shares(file_id);
CREATE INDEX idx_shares_creator_id ON shares(creator_id);
CREATE INDEX idx_shares_status ON shares(status);
CREATE INDEX idx_shares_expires_at ON shares(expires_at);
```

#### 11. access_logs（访问日志表）

```sql
CREATE TABLE access_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  file_id TEXT,
  mount_id TEXT,
  action TEXT NOT NULL,                     -- view | download | upload | delete | share
  ip_address TEXT,
  user_agent TEXT,
  bytes_transferred INTEGER DEFAULT 0,
  status_code INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (file_id) REFERENCES file_metadata(id) ON DELETE CASCADE,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_access_logs_user_id ON access_logs(user_id);
CREATE INDEX idx_access_logs_file_id ON access_logs(file_id);
CREATE INDEX idx_access_logs_created_at ON access_logs(created_at DESC);
CREATE INDEX idx_access_logs_action ON access_logs(action);
```

#### 12. system_settings（系统设置表）

```sql
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                      -- JSON字符串
  description TEXT,
  updated_at INTEGER NOT NULL
);

-- 预置设置
INSERT INTO system_settings (key, value, description, updated_at) VALUES
('site_title', '"Picumet"', '网站标题', unixepoch() * 1000),
('site_logo', 'null', 'Logo URL', unixepoch() * 1000),
('allow_registration', 'true', '是否允许注册', unixepoch() * 1000),
('allow_guest_access', 'false', '是否允许访客访问', unixepoch() * 1000),
('require_email_verification', 'true', '是否需要邮箱验证', unixepoch() * 1000),
('enable_turnstile', 'false', '是否启用Turnstile', unixepoch() * 1000),
('turnstile_site_key', 'null', 'Turnstile Site Key', unixepoch() * 1000),
('rate_limit_enabled', 'true', '是否启用速率限制', unixepoch() * 1000),
('rate_limit_requests_per_minute', '50', '每分钟最大请求数', unixepoch() * 1000);
```

---

## 文档目录

1. [项目概述与决策记录](#项目概述与决策记录)
2. [术语表与范围定义](#术语表与范围定义)
3. [用户模型与角色](#用户模型与角色)
4. [部署架构](#部署架构)
5. [对象存储Provider能力矩阵](#对象存储provider能力矩阵)
6. [权限判定算法](#权限判定算法)
7. [数据模型](#数据模型)
8. [文件操作状态机](#文件操作状态机)
9. [访问模式与密码保护](#访问模式与密码保护)
10. [API设计](#api设计)
11. [兼容协议](#兼容协议)
12. [前端页面](#前端页面)
13. [安全威胁模型](#安全威胁模型)
14. [部署方案](#部署方案)
15. [开发路线图](#开发路线图)
16. [验收标准](#验收标准)

---

## 项目概述与决策记录

### 核心定位

Picumet 是一个**云端文件管理平台 + 图床服务**，运行在 Cloudflare 边缘网络，为个人用户和小团队提供：

- **统一的文件管理界面**：像本地文件管理器一样操作对象存储
- **细粒度权限控制**：路径级ACL + 密码保护
- **图床API接入**：WebDAV/自定义API对接PicGo/PicList
- **公开CDN加速**：图床直链走CDN，无流量计费
- **密码保护访问**：文件可见但需密码下载

### 明确不做的事项

❌ **多平台部署**：仅支持 Cloudflare Workers + Pages，不支持 Vercel/EdgeOne  
❌ **S3协议完整网关**：不实现完整S3 SigV4签名验证  
❌ **OSS协议兼容**：不支持阿里云OSS/腾讯云COS协议  
❌ **客户端加密**：不提供端到端加密功能  
❌ **流量限速/配额**：取消下载速度限制和月流量限制  
❌ **文件版本控制**：不保存历史版本  
❌ **回收站功能**：删除即永久删除，不提供恢复功能  
❌ **从URL抓取元信息**：不实现URL元数据自动抓取  
❌ **自定义文件URL**：不提供短链接或别名功能  

### 关键架构决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| **部署平台** | Cloudflare Workers + Pages | 边缘网络、零运维、免费额度充足 |
| **数据库** | D1(SQLite) / Supabase(PG) / PostgreSQL | 部署时三选一，D1优先 |
| **对象存储** | MVP: R2 only; Phase 2: S3, Oracle | R2免费额度高，后续按需扩展 |
| **上传协议** | WebDAV + 自定义API | PicGo/PicList主流方案，简单可靠 |
| **访问模式** | 密码保护 + 公开CDN | 图床走CDN，文件管理用签名URL |
| **前端框架** | React + Vite + shadcn-ui | 生态成熟、开发效率高 |
| **认证方式** | JWT + HttpOnly Cookie + API Key | 安全且适合边缘环境 |
| **邮件验证** | SMTP配置（注册/登录） | 防止滥用注册 |

### 技术栈

#### 前端
- **React 18** + **TypeScript 5** + **Vite 5**
- **shadcn-ui**（Radix UI + Tailwind CSS）
- **React Router 6** + **TanStack Query 5** + **Zustand 4**
- **PhotoSwipe 5**（图片预览）+ **DPlayer**（视频/音频）
- **highlight.js**（代码高亮，纯文本）
- **i18next**（中英文国际化）

#### 后端
- **Cloudflare Workers**（Hono 4框架）
- **Cloudflare D1**（SQLite，主推）
- **Supabase** / **PostgreSQL**（可选）
- **@aws-sdk/client-s3**（S3协议操作R2）
- **jose**（JWT）+ **zod**（验证）

#### 部署与监控
- **Cloudflare Pages**（前端托管）
- **Cloudflare KV**（会话缓存、限流）
- **Cloudflare Analytics Engine**（访问日志）
- **Cloudflare R2**（对象存储）

---

## 术语表与范围定义

### 核心术语

| 术语 | 定义 |
|------|------|
| **Principal** | 权限主体：用户（User）、角色（Role）、API密钥（ApiKey） |
| **Mount** | 挂载点：将对象存储映射到虚拟路径（如 `/images` → R2 bucket） |
| **Canonical Path** | 规范路径：经过归一化的绝对路径（如 `/a/b/../c` → `/a/c`） |
| **Access Mode** | 访问模式：`private`（密码保护）、`public_cdn`（公开CDN） |
| **Upload Session** | 上传会话：服务端签发的临时上传凭证，用于一致性校验 |
| **Operation Job** | 操作任务：移动/复制等异步操作的状态机记录 |
| **Provider** | 对象存储提供商：R2、S3、Oracle等 |

### 路径规则

#### 路径归一化
```typescript
function normalizePath(path: string): string {
  // 1. 移除多余斜杠： //a///b -> /a/b
  // 2. 解析相对路径： /a/b/../c -> /a/c
  // 3. 移除尾部斜杠： /a/b/ -> /a/b
  // 4. 确保以/开头
  // 5. Unicode NFC归一化
  return normalized;
}
```

#### 路径模板变量（上传路径配置）
```typescript
const templates = {
  '{year}':    '2026',
  '{month}':   '08',
  '{day}':     '18',
  '{uuid}':    'a1b2c3d4-...',
  '{hash}':    'sha256前8位',
  '{ext}':     '文件扩展名',
  '{mime}':    'image/jpeg',
  '{username}': '当前用户名'
};

// 示例：/uploads/{year}/{month}/{uuid}.{ext}
// 结果：/uploads/2026/08/a1b2c3d4.jpg
```

### 用户类型

| 类型 | 说明 | 认证方式 | 默认权限 |
|------|------|----------|----------|
| **管理员 (Admin)** | 超级用户，全部权限 | 用户名+密码 | 全部 |
| **注册用户 (User)** | 需要邮箱验证的账户 | 用户名+密码+邮箱 | 受限 |
| **访客 (Guest)** | 匿名访问（可选开启） | 无需认证 | 最小 |
| **API密钥 (ApiKey)** | 脚本/PicGo上传 | Bearer Token | 配置时指定 |

---

## 用户模型与角色

### 角色定义

```typescript
enum Role {
  ADMIN = 'admin',   // 管理员：绕过所有权限检查
  USER = 'user',     // 普通用户：遵循路径规则
  GUEST = 'guest'    // 访客：仅公开路径
}

enum Permission {
  READ = 'read',           // 列出文件、查看详情
  WRITE = 'write',         // 上传、创建文件夹
  UPDATE = 'update',       // 重命名、移动、编辑元数据
  DELETE = 'delete',       // 永久删除
  SHARE = 'share',         // 创建分享链接
  DOWNLOAD = 'download',   // 下载文件（可能需要密码）
  ADMIN = 'admin'          // 管理权限（查看日志、修改配置）
}
```

### 默认权限矩阵

| 角色 | 默认路径 | READ | WRITE | UPDATE | DELETE | SHARE | DOWNLOAD | RESTORE | ADMIN |
|------|----------|------|-------|--------|--------|-------|----------|---------|-------|
| Admin | / | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| User | /users/:userId | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Guest | /public | ✅ | ❌ | ❌ | ❌ | ❌ | ✅* | ❌ | ❌ |
| ApiKey | 配置时指定 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

*Guest下载需符合路径规则且无密码保护

---

## 部署架构

### 唯一支持平台：Cloudflare

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare 全球边缘网络                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌────────────┐         ┌────────────┐                    │
│  │  Pages     │         │  Workers   │                    │
│  │  (前端)    │◄────────│  (API)     │                    │
│  └────────────┘         └──────┬─────┘                    │
│                                 │                           │
│  ┌──────────┬──────────┬───────┼──────┬─────────────┐    │
│  │          │          │       │      │             │    │
│  ▼          ▼          ▼       ▼      ▼             ▼    │
│ ┌──┐     ┌──┐      ┌──┐    ┌──┐  ┌──────┐    ┌──────┐  │
│ │D1│     │KV│      │R2│    │AE│  │Turnstle│  │Email │  │
│ │数据库 │会话缓存│对象存储│日志│  │验证码  │  │Routes│  │
│ └──┘     └──┘      └──┘    └──┘  └──────┘    └──────┘  │
└─────────────────────────────────────────────────────────────┘
         │                                  │
         │ 可选外部数据库                  │ CDN加速
         ▼                                  ▼
  ┌─────────────┐                   ┌──────────────┐
  │  Supabase   │                   │ 自定义域名   │
  │  PostgreSQL │                   │ (图床直链)   │
  └─────────────┘                   └──────────────┘
```

### 运行时绑定

```typescript
// Cloudflare Workers Env
interface Env {
  // 必需绑定
  DB: D1Database;              // D1数据库（或通过连接字符串访问外部PG）
  KV: KVNamespace;             // KV存储（会话、限流）
  R2: R2Bucket;                // R2对象存储（主存储）
  ANALYTICS: AnalyticsEngineDataset; // 访问日志
  
  // Secrets（通过wrangler secret设置）
  JWT_SECRET: string;          // JWT签名密钥（至少32字符）
  ENCRYPTION_KEY: string;      // 数据库密钥加密密钥
  TURNSTILE_SECRET_KEY: string; // Turnstile验证码密钥
  SMTP_HOST: string;           // SMTP服务器
  SMTP_PORT: string;           // SMTP端口
  SMTP_USER: string;           // SMTP用户名
  SMTP_PASS: string;           // SMTP密码
  SMTP_FROM: string;           // 发件人邮箱
  
  // 可选：外部数据库（如使用Supabase）
  DATABASE_URL?: string;       // PostgreSQL连接字符串
  
  // 环境变量
  ENVIRONMENT: string;         // production | development
}
```

### 数据库选择（部署时决定）

| 选项 | 场景 | 优势 | 限制 |
|------|------|------|------|
| **Cloudflare D1** | 小型部署 | 零配置、免费额度、低延迟 | 单库10GB、查询延迟5-50ms |
| **Supabase** | 中型部署 | 实时订阅、全文搜索、行级安全 | 需额外配置、跨区延迟 |
| **自托管PostgreSQL** | 大型部署 | 完全控制、无限存储 | 需要运维、地理延迟 |

**部署时环境变量**：
```bash
# .env.production
DATABASE_TYPE=d1          # d1 | supabase | postgres
DATABASE_URL=             # 仅当使用supabase/postgres时填写
```

---

## 对象存储Provider能力矩阵

### 支持的Provider

| Provider | 状态 | 协议 | 免费额度 | 特殊说明 |
|----------|------|------|----------|----------|
| **Cloudflare R2** | ✅ MVP | S3 | 10GB/月 + 100万A类操作 | 无出站流量费 |
| **AWS S3** | 🔄 Phase 2 | S3 | 5GB + 20K读写 | 标准S3协议 |
| **Oracle Cloud** | 🔄 Phase 2 | S3 | 10GB + 5万请求 | 兼容S3 API |
| ~~阿里云OSS~~ | ❌ | OSS | - | 不支持（协议不兼容） |
| ~~腾讯云COS~~ | ❌ | COS | - | 不支持（协议不兼容） |

### Provider能力矩阵

| 能力 | R2 | S3 | Oracle | 说明 |
|------|----|----|--------|------|
| **List Objects** | ✅ | ✅ | ✅ | 列举对象 |
| **Head Object** | ✅ | ✅ | ✅ | 获取元数据 |
| **Get Object** | ✅ | ✅ | ✅ | 下载对象 |
| **Range Get** | ✅ | ✅ | ✅ | 范围下载 |
| **Put Object** | ✅ | ✅ | ✅ | 上传对象 |
| **Multipart Upload** | ✅ | ✅ | ✅ | 分片上传 |
| **Abort Multipart** | ✅ | ✅ | ✅ | 取消分片 |
| **Copy Object** | ✅ | ✅ | ✅ | 服务端复制 |
| **Delete Object** | ✅ | ✅ | ✅ | 删除对象 |
| **Presigned URL** | ✅ | ✅ | ✅ | 预签名URL |
| **Public URL** | ✅ | ✅ | ✅ | 公开URL（需配置） |
| **Custom Domain** | ✅ | ✅ | ⚠️ | 自定义域名 |
| **Checksum (MD5)** | ✅ | ✅ | ✅ | 完整性校验 |

⚠️ Oracle需通过CloudFront等CDN绑定自定义域名

### Provider凭据模型

```typescript
// 统一S3协议配置
interface StorageProvider {
  type: 'r2' | 's3' | 'oracle';
  name: string;               // 显示名称
  endpoint: string;           // 端点URL
  region: string;             // 区域（R2用'auto'）
  bucket: string;             // 存储桶名称
  accessKeyId: string;        // Access Key（加密存储）
  secretAccessKey: string;    // Secret Key（加密存储）
  publicDomain?: string;      // 公开CDN域名（图床用）
  uploadDomain?: string;      // 上传域名（可能不同于CDN）
  pathPrefix?: string;        // 路径前缀（如 /prod/）
}

// 不需要discriminated union，都用S3协议
```

---

