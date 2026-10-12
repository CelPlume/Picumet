// 用户两步验证（2FA / TOTP）路由：setup、enable、disable、status、regenerate backup codes
import { Hono } from 'hono';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import type { AppBindings } from '../../shared/types';
import { UserRepo, TotpBackupRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { verifyPassword, encryptSecret, decryptSecret, hmacSha256Hex, randomString } from '../../utils/crypto';
import { verifyTotpOrBackupCode } from '../auth/totp-verify';

export const totpRoutes = new Hono<AppBindings>();

const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 8;
const BACKUP_CODE_CHARSET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 生成 10 个高熵一次性备用码 */
function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    codes.push(randomString(BACKUP_CODE_LENGTH, BACKUP_CODE_CHARSET));
  }
  return codes;
}

/** 2FA 状态查询 */
totpRoutes.get('/status', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  const remaining = user.totpEnabled ? await TotpBackupRepo.countRemaining(db, userId) : 0;
  return ok(c, {
    enabled: user.totpEnabled,
    remainingBackupCodes: remaining,
  });
});

/** 生成新的 TOTP 密钥与 URI（未激活态，需调 /enable 校验通过才激活） */
totpRoutes.post('/setup', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!c.env.ENCRYPTION_KEY) throw ApiError.internal('服务加密配置缺失');

  const secret = new OTPAuth.Secret({ size: 20 });
  const base32 = secret.base32;
  const totp = new OTPAuth.TOTP({
    issuer: 'Picumet',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  const encrypted = await encryptSecret(base32, c.env.ENCRYPTION_KEY);
  await UserRepo.setTotpSecret(db, userId, `enc:${encrypted}`);

  return ok(c, {
    uri: totp.toString(),
    secret: base32,
  });
});

/** 校验首个动态码并激活 2FA，生成 10 个一次性备用码（仅此一次返回明文） */
totpRoutes.post('/enable', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!c.env.ENCRYPTION_KEY) throw ApiError.internal('服务加密配置缺失');

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ code: z.string().regex(/^\d{6}$/, '验证码必须为 6 位数字') }).safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '验证码格式错误');

  const totpInfo = await UserRepo.getTotpSecret(db, userId);
  if (!totpInfo?.secretEnc || !totpInfo.secretEnc.startsWith('enc:')) {
    throw ApiError.badRequest('请先生成两步验证密钥');
  }

  const base32 = await decryptSecret(totpInfo.secretEnc.slice(4), c.env.ENCRYPTION_KEY);
  const totp = new OTPAuth.TOTP({
    issuer: 'Picumet',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32),
  });

  const delta = totp.validate({ token: parsed.data.code, window: 1 });
  if (delta === null) {
    throw ApiError.badRequest('验证码错误或已过期');
  }

  const currentStep = Math.floor(Date.now() / 1000 / 30);
  const codeStep = currentStep + delta;

  // 生成备用码并加密落库（保留密文以支持「查看剩余备用码」）
  const backupCodes = generateBackupCodes();
  await UserRepo.enableTotp(db, userId, Math.max(0, codeStep - 1));
  await TotpBackupRepo.saveCodes(db, c.env.ENCRYPTION_KEY, userId, backupCodes);

  return ok(c, { backupCodes });
});

/** 禁用两步验证（需主密码 + 当前动态码或备用码） */
totpRoutes.post('/disable', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    password: z.string().min(1, '请输入密码'),
    code: z.string().min(1, '请输入两步验证码或备用码').optional(),
  }).safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '参数无效');

  if (!verifyPassword(parsed.data.password, user.passwordHash ?? '')) {
    throw ApiError.badRequest('密码错误');
  }

  if (user.totpEnabled) {
    if (!parsed.data.code) {
      throw ApiError.badRequest('请输入两步验证码或备用码');
    }
    const codeValid = await verifyTotpOrBackupCode(db, c.env, userId, parsed.data.code);
    if (!codeValid) {
      throw ApiError.badRequest('两步验证码或备用码错误');
    }
  }

  await UserRepo.disableTotp(db, userId);
  await TotpBackupRepo.deleteCodes(db, userId);

  return ok(c, { message: '两步验证已禁用' });
});

/** 重新生成备用码（需主密码 + 当前动态码） */
totpRoutes.post('/backup-codes/regenerate', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!user.totpEnabled) throw ApiError.badRequest('未开启两步验证');
  if (!c.env.ENCRYPTION_KEY) throw ApiError.internal('服务加密配置缺失');

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    password: z.string().min(1, '请输入密码'),
    code: z.string().min(1, '请输入当前两步验证码'),
  }).safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '参数无效');

  if (!verifyPassword(parsed.data.password, user.passwordHash ?? '')) {
    throw ApiError.badRequest('密码错误');
  }

  const codeValid = await verifyTotpOrBackupCode(db, c.env, userId, parsed.data.code);
  if (!codeValid) {
    throw ApiError.badRequest('两步验证码错误');
  }

  const backupCodes = generateBackupCodes();
  await TotpBackupRepo.saveCodes(db, c.env.ENCRYPTION_KEY, userId, backupCodes);

  return ok(c, { backupCodes });
});

/** 回读未消费的剩余备用码（对标 Google：剩余备用码可随时查看） */
totpRoutes.get('/backup-codes', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!user.totpEnabled) throw ApiError.badRequest('未开启两步验证');
  if (!c.env.ENCRYPTION_KEY) throw ApiError.internal('服务加密配置缺失');
  const codes = await TotpBackupRepo.listRemaining(db, c.env.ENCRYPTION_KEY, userId);
  return ok(c, { codes });
});
