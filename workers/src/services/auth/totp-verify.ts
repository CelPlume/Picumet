// 登录与敏感操作的 TOTP 动态码 / 备用码通用校验
import * as OTPAuth from 'otpauth';
import type { Db } from '../../db';
import { UserRepo, TotpBackupRepo } from '../../db';
import type { Env } from '../../shared/types';
import { decryptSecret } from '../../utils/crypto';

/**
 * 校验两步验证码：优先按 6 位动态口令校验，失败则尝试作为一次性备用码核销。
 * 防重放：动态码验证通过后原子递增时间步计数器，同步数重复提交被拒。
 */
export async function verifyTotpOrBackupCode(
  db: Db,
  env: Env,
  userId: string,
  rawCode: string
): Promise<boolean> {
  const code = rawCode.trim();
  if (!code) return false;

  // 1. 若为 6 位数字，优先尝试 TOTP 验证
  if (/^\d{6}$/.test(code)) {
    const totpInfo = await UserRepo.getTotpSecret(db, userId);
    if (totpInfo?.secretEnc && totpInfo.secretEnc.startsWith('enc:') && env.ENCRYPTION_KEY) {
      try {
        const secretBase32 = await decryptSecret(totpInfo.secretEnc.slice(4), env.ENCRYPTION_KEY);
        const totp = new OTPAuth.TOTP({
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          secret: OTPAuth.Secret.fromBase32(secretBase32),
        });
        const delta = totp.validate({ token: code, window: 1 });
        if (delta !== null) {
          const currentStep = Math.floor(Date.now() / 1000 / 30);
          const codeStep = currentStep + delta;
          // 防 30s 窗口内重放：步数必须严格大于上次使用记录
          if (codeStep > totpInfo.lastUsedCounter) {
            await UserRepo.updateTotpCounter(db, userId, codeStep);
            return true;
          }
        }
      } catch {
        // 解密失败或验证异常，进入备用码回退
      }
    }
  }

  // 2. 尝试作为一次性备用码核销（密文回读后常量时间比对，命中即单次消费）
  if (env.ENCRYPTION_KEY) {
    const consumed = await TotpBackupRepo.verifyAndConsumeCode(db, env.ENCRYPTION_KEY, userId, code);
    if (consumed) return true;
  }

  return false;
}
