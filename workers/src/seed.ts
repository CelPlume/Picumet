// 启动种子：默认管理员、演示用户、默认 R2 绑定 Provider + 根挂载、演示文件夹
import { Db, UserRepo, MountRepo, ProviderRepo, FileRepo, QuotaRepo } from './db';
import { hashPassword } from './utils/crypto';
import { getProvider } from './providers';
import { objectKeyFromPath } from './utils/path';
import type { Env } from './types';

export async function ensureSeed(env: Env): Promise<void> {
  if (await env.KV.get('seed:done')) return;
  const db = Db.fromAny(env.DB);
  await seedAll(db, env);
  await env.KV.put('seed:done', '1');
}

async function seedAll(db: Db, env: Env): Promise<void> {
  const now = Date.now();

  // 1. 默认管理员
  let admin = await UserRepo.getUserByUsername(db, 'admin');
  if (!admin) {
    admin = await UserRepo.createUser(db, {
      username: 'admin',
      email: 'admin@picumet.local',
      passwordHash: hashPassword('admin123456'),
      role: 'admin',
    });
    await QuotaRepo.setQuota(db, admin.id, 20 * 1024 * 1024 * 1024);
  }

  // 2. 演示用户
  let demo = await UserRepo.getUserByUsername(db, 'demo');
  if (!demo) {
    demo = await UserRepo.createUser(db, {
      username: 'demo',
      email: 'demo@picumet.local',
      passwordHash: hashPassword('demo123456'),
      role: 'user',
    });
  }

  // 3. 默认 R2 绑定 Provider
  let provider = (await ProviderRepo.listProviders(db)).find((p) => p.name === '本地存储');
  if (!provider) {
    provider = await ProviderRepo.createProvider(db, {
      name: '本地存储',
      type: 'r2',
      endpoint: '__binding__',
      region: 'auto',
      bucket: 'picumet-storage',
      accessKeyId: '__binding__',
      secretAccessKey: '__binding__',
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
  if ((env.ENVIRONMENT ?? 'development') === 'development') {
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
  });
  await QuotaRepo.commitUsage(db, ownerId, file.size, 0);
}
