// 第三方登录（SSO/OIDC）仓库：身份提供商配置 + 身份关联与令牌凭据
// 表结构与语义见 workers/migrations/0012_sso.sql、docs/ARCHITECTURE_CN.md「SSO / OIDC 登录服务」
import type { Db } from '../db';
import { b, num, str, type Row } from '../row';
import { uuid } from '../../utils/crypto';
import type { SsoProviderKind } from '@shared/types';

/** 提供商类型：google / github = 内置端点（单例）；oidc = 通用 OIDC（不限数量） */
export type { SsoProviderKind };

export interface SsoProviderRow {
  id: string;
  kind: SsoProviderKind;
  name: string;
  /** kind='oidc' 必填；google/github 为 null（端点内置） */
  issuerUrl: string | null;
  clientId: string;
  /** `enc:` 前缀的 AES-GCM 密文（仅在服务层解密，仓库层原样存取） */
  clientSecret: string;
  /** 自定义 scope（空格分隔）；null = 按 kind 取默认 */
  scopes: string | null;
  enabled: boolean;
  /**
   * 是否信任提供方声明的邮箱验证（迁移 0013）：
   * true = 提供方已验证的邮箱可用于自动关联既有账号；false = 一律走补充注册页。
   * 内置 google/github 默认为 true，自定义 oidc 默认为 false（需管理员显式开启）。
   */
  trustEmailVerified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SsoIdentityRow {
  id: string;
  providerId: string;
  userId: string;
  /** OIDC `sub` / GitHub 用户 id */
  subject: string;
  /** 提供方档案快照（关联当时） */
  email: string | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** `enc:` 前缀密文；提供方未下发时为 null */
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string | null;
  scope: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 提供方下发的令牌集合（服务层已加密，仓库只落库） */
export interface SsoTokenSet {
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string | null;
  scope: string | null;
  expiresAt: number | null;
}

function mapProvider(row: Row): SsoProviderRow {
  return {
    id: str(row.id)!,
    kind: str(row.kind) as SsoProviderKind,
    name: str(row.name)!,
    issuerUrl: str(row.issuer_url) ?? null,
    clientId: str(row.client_id)!,
    clientSecret: str(row.client_secret)!,
    scopes: str(row.scopes) ?? null,
    enabled: b(row.enabled),
    trustEmailVerified: b(row.trust_email_verified),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function mapIdentity(row: Row): SsoIdentityRow {
  return {
    id: str(row.id)!,
    providerId: str(row.provider_id)!,
    userId: str(row.user_id)!,
    subject: str(row.subject)!,
    email: str(row.email) ?? null,
    username: str(row.username) ?? null,
    displayName: str(row.display_name) ?? null,
    avatarUrl: str(row.avatar_url) ?? null,
    accessToken: str(row.access_token) ?? null,
    refreshToken: str(row.refresh_token) ?? null,
    tokenType: str(row.token_type) ?? null,
    scope: str(row.scope) ?? null,
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : num(row.expires_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

export const SsoProviderRepo = {
  /** 管理端列表：创建时间升序（配置顺序 = 登录按钮顺序） */
  async list(db: Db): Promise<SsoProviderRow[]> {
    const rows = await db.all('SELECT * FROM sso_providers ORDER BY created_at ASC');
    return rows.map(mapProvider);
  },
  async getById(db: Db, id: string): Promise<SsoProviderRow | null> {
    const row = await db.first('SELECT * FROM sso_providers WHERE id = ?', [id]);
    return row ? mapProvider(row) : null;
  },
  /** 登录面可用提供商：总开关 + 单源开关都由调用方判定，这里只取启用的行 */
  async listEnabled(db: Db): Promise<SsoProviderRow[]> {
    const rows = await db.all('SELECT * FROM sso_providers WHERE enabled = 1 ORDER BY created_at ASC');
    return rows.map(mapProvider);
  },
  /** 单例占用检查（google/github 各至多一条）：返回已存在的行 id 或 null */
  async findSingletonKind(db: Db, kind: SsoProviderKind, excludeId?: string): Promise<string | null> {
    const row = await db.first(
      `SELECT id FROM sso_providers WHERE kind = ? ${excludeId ? 'AND id != ?' : ''} LIMIT 1`,
      excludeId ? [kind, excludeId] : [kind]
    );
    return row ? str(row.id)! : null;
  },
  async create(
    db: Db,
    p: {
      kind: SsoProviderKind;
      name: string;
      issuerUrl: string | null;
      clientId: string;
      clientSecret: string;
      scopes: string | null;
      enabled: boolean;
      trustEmailVerified: boolean;
    }
  ): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO sso_providers (id, kind, name, issuer_url, client_id, client_secret, scopes, enabled, trust_email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.kind, p.name, p.issuerUrl, p.clientId, p.clientSecret, p.scopes, p.enabled ? 1 : 0, p.trustEmailVerified ? 1 : 0, now, now]
    );
    return id;
  },
  async update(
    db: Db,
    id: string,
    fields: Partial<{
      name: string;
      issuerUrl: string | null;
      clientId: string;
      clientSecret: string;
      scopes: string | null;
      enabled: boolean;
      trustEmailVerified: boolean;
    }>
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const column = {
      name: 'name',
      issuerUrl: 'issuer_url',
      clientId: 'client_id',
      clientSecret: 'client_secret',
      scopes: 'scopes',
      enabled: 'enabled',
      trustEmailVerified: 'trust_email_verified',
    } as const;
    const sets = entries.map(([k]) => `${column[k as keyof typeof column]} = ?`).join(', ');
    await db.run(`UPDATE sso_providers SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)),
      Date.now(),
      id,
    ]);
  },
  /** 删除提供商：身份关联行随外键 ON DELETE CASCADE 一并删除（重新添加同一来源需重新关联） */
  async remove(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM sso_providers WHERE id = ?', [id]);
  },
};

export const SsoIdentityRepo = {
  /** 回调第一步：按 (provider_id, subject) 定位已有身份关联 */
  async findByProviderSubject(db: Db, providerId: string, subject: string): Promise<SsoIdentityRow | null> {
    const row = await db.first('SELECT * FROM sso_identities WHERE provider_id = ? AND subject = ?', [providerId, subject]);
    return row ? mapIdentity(row) : null;
  },
  /** 账号关联列表（用户维度）：按创建时间升序 */
  async listByUser(db: Db, userId: string): Promise<SsoIdentityRow[]> {
    const rows = await db.all('SELECT * FROM sso_identities WHERE user_id = ? ORDER BY created_at ASC', [userId]);
    return rows.map(mapIdentity);
  },
  async create(
    db: Db,
    i: {
      providerId: string;
      userId: string;
      subject: string;
      email: string | null;
      username: string | null;
      displayName: string | null;
      avatarUrl: string | null;
    } & SsoTokenSet
  ): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO sso_identities
         (id, provider_id, user_id, subject, email, username, display_name, avatar_url,
          access_token, refresh_token, token_type, scope, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, i.providerId, i.userId, i.subject, i.email, i.username, i.displayName, i.avatarUrl,
        i.accessToken, i.refreshToken, i.tokenType, i.scope, i.expiresAt, now, now,
      ]
    );
    return id;
  },
  /** 再次登录：刷新令牌与档案快照（不回填 subject/provider，避免身份漂移） */
  async refresh(
    db: Db,
    id: string,
    i: { email: string | null; username: string | null; displayName: string | null; avatarUrl: string | null } & SsoTokenSet
  ): Promise<void> {
    await db.run(
      `UPDATE sso_identities
         SET email = ?, username = ?, display_name = ?, avatar_url = ?,
             access_token = ?, refresh_token = ?, token_type = ?, scope = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`,
      [i.email, i.username, i.displayName, i.avatarUrl, i.accessToken, i.refreshToken, i.tokenType, i.scope, i.expiresAt, Date.now(), id]
    );
  },
};
