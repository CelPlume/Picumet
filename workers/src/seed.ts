// 启动种子：默认管理员、演示用户、默认 R2 绑定 Provider + 根挂载、演示文件夹
import { Db, UserRepo, MountRepo, ProviderRepo, FileRepo, QuotaRepo, MountQuotaRepo } from './db';
import { hashPassword } from './utils/crypto';
import { getProvider } from './services/storage/providers';
import { objectKeyFromPath } from './utils/path';
import type { Env } from './shared/types';
import { kvStoreFor } from './utils/kv-store';
const SEED_MARKER_KEY = 'seed:done';
const SEED_SETTING_KEY = 'seed_initialized';
const readyBindings = new WeakSet<object>();
const inFlight = new WeakMap<object, Promise<void>>();

/**
 * 初始化只在每个 D1 binding 首次请求执行；真值落在 D1，KV 仅作热路径提示。
 * KV 配额耗尽时不再每个请求重复跑 seedAll，也不再依赖 KV marker 才能通过启动门禁。
 */
export async function ensureSeed(env: Env): Promise<void> {
  const binding = env.DB as unknown as object;
  if (readyBindings.has(binding)) return;
  const pending = inFlight.get(binding);
  if (pending) return pending;

  const task = ensureSeedOnce(env);
  inFlight.set(binding, task);
  try {
    await task;
    readyBindings.add(binding);
  } finally {
    inFlight.delete(binding);
  }
}

async function ensureSeedOnce(env: Env): Promise<void> {
  const db = Db.fromAny(env.DB);
  let marker: string | null = null;
  try {
    marker = await kvStoreFor(env).get(env.KV, SEED_MARKER_KEY);
  } catch {
    // KV / fallback 表不可用时，继续用 D1 的持久化初始化标记判定。
  }
  if (marker === '1') {
    await markSeedInitialized(db);
    return;
  }

  const durable = await db.first('SELECT 1 AS initialized FROM system_settings WHERE key = ? AND value = ? LIMIT 1', [SEED_SETTING_KEY, '1']);
  if (durable) {
    try {
      await kvStoreFor(env).put(env.KV, SEED_MARKER_KEY, '1');
    } catch {
      // KV 只是加速提示，D1 标记已足够保证正确性。
    }
    return;
  }

  await seedAll(db, env);
  await markSeedInitialized(db);
  try {
    await kvStoreFor(env).put(env.KV, SEED_MARKER_KEY, '1');
  } catch {
    // 初始化已在 D1 完成；KV 配额恢复后再补回热路径 marker。
  }
}

async function markSeedInitialized(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO system_settings (key, value, description, updated_at)
     VALUES (?, '1', '初始化完成标记；KV 仅作缓存提示', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
    [SEED_SETTING_KEY, Date.now()]
  );
}

/** 就绪探针只读 D1 标记，不消耗 KV 读取配额。 */
export async function isSeedReady(env: Env): Promise<boolean> {
  const binding = env.DB as unknown as object;
  if (readyBindings.has(binding)) return true;
  const pending = inFlight.get(binding);
  if (pending) {
    try {
      await pending;
      return true;
    } catch {
      return false;
    }
  }
  const row = await Db.fromAny(env.DB).first('SELECT 1 AS initialized FROM system_settings WHERE key = ? AND value = ? LIMIT 1', [SEED_SETTING_KEY, '1']);
  if (row) readyBindings.add(binding);
  return Boolean(row);
}

const isProduction = (env: Env): boolean => (env.ENVIRONMENT ?? 'development') === 'production';

/**
 * 初始管理员密码解析：
 * - 生产：必须通过 env.ADMIN_PASSWORD 提供，强制强密码；缺失则不创建（fail-closed）
 * - 开发：默认 admin123456（本地便利），可用 env 覆盖
 */
function resolveAdminCredentials(env: Env): { username: string; password: string } | null {
  const username = (env.ADMIN_USERNAME ?? 'admin').trim() || 'admin';
  const password = (env.ADMIN_PASSWORD ?? '').trim();
  if (isProduction(env)) {
    if (!password) {
      console.error('[seed] 生产环境未配置 ADMIN_PASSWORD，跳过创建初始管理员（fail-closed）');
      return null;
    }
    // 强密码要求：至少 12 位，含字母和数字
    if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new Error('ADMIN_PASSWORD 必须是至少 12 位且包含字母和数字的强密码');
    }
    return { username, password };
  }
  // 开发：默认或 env 覆盖
  return { username, password: password || 'admin123456' };
}

async function seedAll(db: Db, env: Env): Promise<void> {
  const now = Date.now();
  const dev = !isProduction(env);

  // 1. 默认管理员
  const adminCreds = resolveAdminCredentials(env);
  let admin = await UserRepo.getUserByUsername(db, 'admin');
  if (!admin && adminCreds) {
    admin = await UserRepo.createUser(db, {
      username: adminCreds.username,
      email: `${adminCreds.username}@picumet.local`,
      passwordHash: hashPassword(adminCreds.password),
      role: 'admin',
    });
    await QuotaRepo.setQuota(db, admin.id, 20 * 1024 * 1024 * 1024);
  }

  // 2. 演示用户（仅开发）
  let demo: Awaited<ReturnType<typeof UserRepo.getUserByUsername>> = null;
  if (dev) {
    demo = await UserRepo.getUserByUsername(db, 'demo');
    if (!demo) {
      demo = await UserRepo.createUser(db, {
        username: 'demo',
        email: 'demo@picumet.local',
        passwordHash: hashPassword((env.DEMO_PASSWORD ?? 'demo123456').trim() || 'demo123456'),
        role: 'user',
      });
    }
  }

  // 3. 默认 R2 绑定 Provider
  let provider = (await ProviderRepo.listProviders(db)).find((p) => p.name === '本地存储');
  if (!provider) {
    provider = await ProviderRepo.createProvider(db, {
      name: '本地存储',
      type: 'r2',
      endpoint: '',
      region: 'auto',
      bucket: 'picumet-storage',
      accessKeyId: '',
      secretAccessKey: '',
      pathPrefix: '',
    });
  }

  // 4. 根挂载点
  const allMounts = await MountRepo.allMounts(db);
  let rootMount = allMounts.find((m) => m.mountPath === '/') ?? null;
  if (!rootMount) {
    rootMount = await MountRepo.createMount(db, {
      providerId: provider.id,
      mountPath: '/',
      name: '根存储',
      priority: 100,
    });
  }

  // 5. 演示数据（仅开发环境且库为空时）
  if (dev) {
    const count = await db.first('SELECT COUNT(*) AS c FROM file_metadata');
    if (Number((count as { c?: unknown })?.c ?? 0) === 0 && demo) {
      await seedDemoFolder(db, env, rootMount.id, demo.id, '/图片', '图片');
      await seedDemoFolder(db, env, rootMount.id, demo.id, '/文档', '文档');
      await seedDemoFolder(db, env, rootMount.id, demo.id, '/视频', '视频');
      await seedDemoFile(db, env, rootMount.id, demo.id, '/', 'README.md', 'text/markdown', '这是 Picumet 演示环境。\n\n欢迎使用多云对象存储管理平台！\n');
      await seedDemoFile(db, env, rootMount.id, demo.id, '/文档', 'hello.txt', 'text/plain', 'Hello Picumet!\n');
    }
  }

  void admin;
  void demo;
}

async function seedDemoFolder(db: Db, env: Env, mountId: string, ownerId: string, path: string, name: string): Promise<void> {
  const existing = await FileRepo.getFileAtPath(db, mountId, path, name);
  if (existing) return;
  const objectKey = objectKeyFromPath('/', '', path);
  await FileRepo.createFile(db, {
    mountId,
    objectKey: `folder:${objectKey}`,
    path,
    name,
    type: 'folder',
    size: 0,
    ownerId,
  });
}

async function seedDemoFile(
  db: Db,
  env: Env,
  mountId: string,
  ownerId: string,
  parentPath: string,
  name: string,
  mime: string,
  content: string
): Promise<void> {
  const existing = await FileRepo.getFileAtPath(db, mountId, parentPath, name);
  if (existing) return;

  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) return;
  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) return;
  const provider = await getProvider(db, providerRow, env);

  const fullPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
  const objectKey = objectKeyFromPath(mount.mountPath, providerRow.pathPrefix, fullPath);
  const bytes = new TextEncoder().encode(content);
  await provider.putObject(objectKey, bytes, mime);
  const head = await provider.headObject(objectKey);

  const file = await FileRepo.createFile(db, {
    mountId,
    objectKey,
    path: parentPath,
    name,
    type: 'file',
    mimeType: mime,
    size: bytes.byteLength,
    etag: head?.etag,
    ownerId,
    providerId: providerRow.id,
  });
  await QuotaRepo.commitUsage(db, ownerId, file.size, 0);
  await MountQuotaRepo.commitUsage(db, mountId, file.size, 0);
}
