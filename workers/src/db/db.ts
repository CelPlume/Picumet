// 数据库访问层：统一 D1（生产）与 node:sqlite（测试）接口
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastRowId?: number;
}

export interface Tx {
  query(sql: string, params?: unknown[]): Promise<RunResult>;
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  first(sql: string, params?: unknown[]): Promise<Row | null>;
}

interface Backend {
  all(sql: string, params: unknown[]): Promise<Row[]>;
  first(sql: string, params: unknown[]): Promise<Row | null>;
  run(sql: string, params: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

// ---------- D1 后端（Cloudflare Workers 生产） ----------

class D1Backend implements Backend {
  constructor(private db: D1Database) {}

  private prepare(sql: string, params: unknown[]) {
    let stmt = this.db.prepare(sql);
    // D1 不接受 undefined 绑定值，统一转为 null
    const clean = params.map((p) => (p === undefined ? null : p));
    if (clean.length > 0) stmt = stmt.bind(...clean);
    return stmt;
  }

  async all(sql: string, params: unknown[]): Promise<Row[]> {
    const res = await this.prepare(sql, params).all();
    return res.results as Row[];
  }

  async first(sql: string, params: unknown[]): Promise<Row | null> {
    const res = await this.prepare(sql, params).first();
    return (res as Row | null) ?? null;
  }

  async run(sql: string, params: unknown[]): Promise<RunResult> {
    const res = await this.prepare(sql, params).run();
    return { changes: res.meta.changes ?? 0, lastRowId: res.meta.last_row_id };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // D1：使用 batch 收集器保证原子性（事务内仅允许写操作）
    const ops: Array<{ sql: string; params: unknown[] }> = [];
    const tx: Tx = {
      query: async (sql, params = []) => {
        ops.push({ sql, params });
        return { changes: 1, lastRowId: 0 };
      },
      all: async () => {
        throw new Error('D1 transaction does not support read (all) inside transaction');
      },
      first: async () => {
        throw new Error('D1 transaction does not support read (first) inside transaction');
      },
    };
    const result = await fn(tx);
    if (ops.length > 0) {
      const stmts = ops.map((op) => this.prepare(op.sql, op.params));
      await this.db.batch(stmts);
    }
    return result;
  }
}

// ---------- node:sqlite 后端（本地测试） ----------

type SqlParam = string | number | bigint | null | Uint8Array;

function castParams(params: unknown[]): SqlParam[] {
  return params.map((p) => {
    if (p === null || p === undefined) return null;
    if (typeof p === 'string' || typeof p === 'number' || typeof p === 'bigint') return p as SqlParam;
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return String(p);
  });
}

class SqliteBackend implements Backend {
  constructor(private db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  async all(sql: string, params: unknown[]): Promise<Row[]> {
    const s = this.stmt(sql);
    const args = castParams(params);
    return (args.length > 0 ? s.all(...args) : s.all()) as Row[];
  }

  async first(sql: string, params: unknown[]): Promise<Row | null> {
    const s = this.stmt(sql);
    const args = castParams(params);
    return (args.length > 0 ? s.get(...args) : s.get()) as Row | null;
  }

  async run(sql: string, params: unknown[]): Promise<RunResult> {
    const s = this.stmt(sql);
    const args = castParams(params);
    const res = args.length > 0 ? s.run(...args) : s.run();
    return { changes: Number(res.changes ?? 0), lastRowId: Number(res.lastInsertRowid ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const tx: Tx = {
        query: async (sql, params = []) => this.run(sql, params),
        all: async (sql, params = []) => this.all(sql, params),
        first: async (sql, params = []) => this.first(sql, params),
      };
      const result = await fn(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    }
  }
}

// ---------- 统一 Db ----------

export class Db {
  constructor(private backend: Backend) {}

  static fromD1(db: D1Database): Db {
    return new Db(new D1Backend(db));
  }

  static fromSqlite(db: DatabaseSync): Db {
    return new Db(new SqliteBackend(db));
  }

  /** 自动识别：D1（有 .bind）或 node:sqlite */
  static fromAny(db: D1Database | DatabaseSync): Db {
    const probe = (db as D1Database).prepare('SELECT 1');
    if (typeof (probe as { bind?: unknown }).bind === 'function') {
      return Db.fromD1(db as D1Database);
    }
    return Db.fromSqlite(db as DatabaseSync);
  }

  all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.backend.all(sql, params);
  }
  first(sql: string, params: unknown[] = []): Promise<Row | null> {
    return this.backend.first(sql, params);
  }
  run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.backend.run(sql, params);
  }
  /** query 是 run 的别名（与事务 Tx.query 一致的写接口） */
  query(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.backend.run(sql, params);
  }
  exec(sql: string): Promise<void> {
    return this.backend.exec(sql);
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.backend.transaction(fn);
  }
}
