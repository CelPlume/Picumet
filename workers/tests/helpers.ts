// 测试辅助：内存版 D1/KV/R2 + 应用构建
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/index';
import { ensureSeed } from '../src/seed';
import type { Env } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = require('node:sqlite') as typeof import('node:sqlite');

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));

// ============ Mock KV ============
class MockKV {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<{ keys: Array<{ name: string }> }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })) };
  }
}

// ============ Mock R2 ============
interface MockObject {
  key: string;
  data: Uint8Array;
  etag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

class MockMultipartUpload {
  private parts = new Map<number, Uint8Array>();
  constructor(private bucket: MockR2, private key: string, private uploadId: string) {}
  async uploadPart(partNumber: number, body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>) {
    const data = await toUint8(body);
    this.parts.set(partNumber, data);
    return { etag: `etag-${this.uploadId}-${partNumber}` };
  }
  async complete(parts: Array<{ partNumber: number; etag: string }>) {
    const sorted = parts.sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Uint8Array[] = [];
    for (const p of sorted) {
      const d = this.parts.get(p.partNumber);
      if (d) chunks.push(d);
    }
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    this.bucket.putRaw(this.key, merged, {});
    this.bucket.mpu.delete(this.uploadId);
    return { etag: `merged-${this.uploadId}`, httpEtag: `merged-${this.uploadId}`, size: total };
  }
  async abort() {
    this.bucket.mpu.delete(this.uploadId);
  }
}

async function toUint8(body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

class MockR2 {
  private objects = new Map<string, MockObject>();
  private uploadCounter = 0;
  mpu = new Map<string, MockMultipartUpload>();

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ) {
    const data = await toUint8(value);
    this.putRaw(key, data, options ?? {});
    return { etag: `etag-${key}`, httpEtag: `etag-${key}`, size: data.byteLength };
  }
  putRaw(key: string, data: Uint8Array, options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
    this.objects.set(key, {
      key,
      data,
      etag: `etag-${key}`,
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
  }
  async get(key: string) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(obj.data);
        controller.close();
      },
    });
    return {
      key: obj.key,
      size: obj.data.byteLength,
      etag: obj.etag,
      httpEtag: obj.etag,
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
      body: stream,
    };
  }
  async head(key: string) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return {
      key: obj.key,
      size: obj.data.byteLength,
      etag: obj.etag,
      httpEtag: obj.etag,
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = opts?.prefix ?? '';
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
    return {
      objects: keys.map((k) => {
        const o = this.objects.get(k)!;
        return { key: k, size: o.data.byteLength, etag: o.etag, httpEtag: o.etag };
      }),
      truncated: false,
      cursor: undefined,
    };
  }
  async createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }) {
    const uploadId = `mpu-${++this.uploadCounter}`;
    this.mpu.set(uploadId, new MockMultipartUpload(this, key, uploadId));
    return { uploadId, key };
  }
  async resumeMultipartUpload(key: string, uploadId: string) {
    const mpu = this.mpu.get(uploadId);
    if (!mpu) throw new Error('No such upload');
    return mpu;
  }
}

// ============ 测试环境 ============
export interface TestContext {
  env: Env;
  kv: MockKV;
  r2: MockR2;
  db: DatabaseSync;
  app: typeof buildApp;
}

export function createTestContext(): TestContext {
  const db = new DatabaseSyncCtor(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  const kv = new MockKV();
  const r2 = new MockR2();
  const env = {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    R2: r2 as unknown as R2Bucket,
    ENVIRONMENT: 'development',
    APP_BASE_URL: 'http://localhost:8787',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    JWT_SECRET_OLD: '',
    ENCRYPTION_KEY: 'test-encryption-key-0123456789abcdef',
  } as unknown as Env;
  return { env, kv, r2, db, app: buildApp };
}

export async function initSeeded(ctx: TestContext): Promise<void> {
  await ensureSeed(ctx.env);
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown | string;
  cookie?: string;
}

export async function request(ctx: TestContext, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  let body: string | FormData | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) {
      body = opts.body;
    } else if (typeof opts.body === 'string') {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }
  const req = new Request(`http://localhost:8787${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body,
  });
  return ctx.app.fetch(req, ctx.env as unknown as Env, {} as ExecutionContext);
}

// 测试辅助的类型；json 返回结构由断言方指定
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function registerAndLogin(ctx: TestContext, username: string, password = 'password123') {
  await request(ctx, '/api/auth/register', {
    method: 'POST',
    body: { username, password, email: `${username}@test.local` },
  });
  const res = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  const data = (await json(res)) as { data: { user: { id: string; role: string } } };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  const authCookie = tokenMatch ? `auth_token=${tokenMatch[1]}` : '';
  return { userId: data.data.user.id, role: data.data.user.role, authCookie };
}

export async function getCsrf(ctx: TestContext, cookie: string): Promise<string> {
  const res = await request(ctx, '/api/auth/csrf-token', { cookie });
  const data = (await json(res)) as { data: { token: string } };
  return data.data.token;
}
