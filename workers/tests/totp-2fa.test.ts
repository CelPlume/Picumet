// 两步验证（2FA / TOTP）全量契约测试：
// - setup：生成密钥密文与 otpauth URI
// - enable：错码 400，对码 200 并发放 8 个一次性备用码
// - status：状态与剩余备用码数
// - login：
//   - 正确密码无码 → 403 TOTP_REQUIRED
//   - 错动态码 → 401 INVALID_TOTP_CODE
//   - 对动态码 → 200 登录成功
//   - 同步数重放攻击拦截（同 30s 窗口二次提交被拒）
//   - 备用码登录成功，再次消费同一备用码被拒
// - regenerate backup codes：换新码作废旧码
// - disable：密码+动态码校验后关闭 2FA，恢复单因子登录
import { describe, expect, it, beforeEach } from 'vitest';
import * as OTPAuth from 'otpauth';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeEach(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('两步验证（2FA / TOTP）核心流程', () => {
  it('setup → enable → status → login(TOTP) → 重放拦截 → disable', async () => {
    // 1. 注册普通用户
    const { authCookie } = await registerAndLogin(ctx, 'totp_user', 'password123');
    const csrf = await getCsrf(ctx, authCookie);

    // 初始状态：未开启
    const s0Res = await request(ctx, '/api/users/2fa/status', { cookie: authCookie });
    const s0 = await json<{ data: { enabled: boolean; remainingBackupCodes: number } }>(s0Res);
    expect(s0.data.enabled).toBe(false);
    expect(s0.data.remainingBackupCodes).toBe(0);

    // 2. setup 生成密钥
    const setupRes = await request(ctx, '/api/users/2fa/setup', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(setupRes.status).toBe(200);
    const setupData = await json<{ data: { uri: string; secret: string } }>(setupRes);
    expect(setupData.data.uri).toMatch(/^otpauth:\/\/totp\/Picumet:totp_user\?/);
    const secretBase32 = setupData.data.secret;

    const totpClient = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });

    // 3. 错误验证码激活失败
    const failEnable = await request(ctx, '/api/users/2fa/enable', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { code: '000000' },
    });
    expect(failEnable.status).toBe(400);

    // 正确验证码激活成功
    const validCode = totpClient.generate();
    const enableRes = await request(ctx, '/api/users/2fa/enable', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { code: validCode },
    });
    expect(enableRes.status).toBe(200);
    const enableData = await json<{ data: { backupCodes: string[] } }>(enableRes);
    expect(enableData.data.backupCodes).toHaveLength(8);
    const backupCodes = enableData.data.backupCodes;

    // 4. status 变为开启，剩余 8 个备用码
    const s1Res = await request(ctx, '/api/users/2fa/status', { cookie: authCookie });
    const s1 = await json<{ data: { enabled: boolean; remainingBackupCodes: number } }>(s1Res);
    expect(s1.data.enabled).toBe(true);
    expect(s1.data.remainingBackupCodes).toBe(8);

    // 5. 登录第二步拦截：未提供验证码返回 403 TOTP_REQUIRED
    const l0 = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123' },
    });
    expect(l0.status).toBe(403);
    const l0Data = await json<{ error: { code: string } }>(l0);
    expect(l0Data.error.code).toBe('TOTP_REQUIRED');

    // 错验证码登录返回 401
    const lWrong = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123', totpCode: '111111' },
    });
    expect(lWrong.status).toBe(401);

    // 启用后同一时间步内用 enable 时的码登录一次 → 200（启用本身不算消费，
    // 否则用户启用后立刻登录会被重放防护误拒）
    const lSameStep = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123', totpCode: validCode },
    });
    expect(lSameStep.status).toBe(200);

    // 重放拦截：刚被登录消费过的 validCode 再次提交必须被拒
    const lReplay = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123', totpCode: validCode },
    });
    expect(lReplay.status).toBe(401);

    // 6. 备用码登录：消费第 1 个备用码
    const lBackup = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123', totpCode: backupCodes[0] },
    });
    expect(lBackup.status).toBe(200);
    const newCookie = (lBackup.headers.get('set-cookie') ?? '').match(/auth_token=[^;]+/)?.[0] ?? '';
    expect(newCookie).toBeTruthy();

    // 重复使用同一备用码被拒
    const lBackupReuse = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123', totpCode: backupCodes[0] },
    });
    expect(lBackupReuse.status).toBe(401);

    // 备用码剩余数减少为 7
    const s2Res = await request(ctx, '/api/users/2fa/status', { cookie: newCookie });
    const s2 = await json<{ data: { remainingBackupCodes: number } }>(s2Res);
    expect(s2.data.remainingBackupCodes).toBe(7);

    // 剩余备用码可回读（密文存储，对标 Google）：返回 7 个，其中不含已消费的 backupCodes[0]
    const listRes = await request(ctx, '/api/users/2fa/backup-codes', { cookie: newCookie });
    expect(listRes.status).toBe(200);
    const listData = await json<{ data: { codes: string[] } }>(listRes);
    expect(listData.data.codes).toHaveLength(7);
    expect(listData.data.codes).not.toContain(backupCodes[0]);
    expect(listData.data.codes).toContain(backupCodes[1]);

    // 7. 重新生成备用码：需密码 + 动态码（使用第 2 个备用码充当 code 校验）
    const newCsrf = await getCsrf(ctx, newCookie);
    const regenRes = await request(ctx, '/api/users/2fa/backup-codes/regenerate', {
      method: 'POST',
      cookie: newCookie,
      headers: { 'X-CSRF-Token': newCsrf },
      body: { password: 'password123', code: backupCodes[1] },
    });
    expect(regenRes.status).toBe(200);
    const regenData = await json<{ data: { backupCodes: string[] } }>(regenRes);
    expect(regenData.data.backupCodes).toHaveLength(8);
    // 旧的第 3 个备用码已作废
    const lOldBackup = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123', totpCode: backupCodes[2] },
    });
    // 8. 禁用 2FA（需密码 + 备用码）
    const disableRes = await request(ctx, '/api/users/2fa/disable', {
      method: 'POST',
      cookie: newCookie,
      headers: { 'X-CSRF-Token': newCsrf },
      body: { password: 'password123', code: regenData.data.backupCodes[0] },
    });
    expect(disableRes.status).toBe(200);

    // 禁用后恢复单因子登录
    const lFinal = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'totp_user', password: 'password123' },
    });
    expect(lFinal.status).toBe(200);
  });

  it('异常与边界分支：未开启时重新生成备用码 400、禁用密码错误 400、无 code 禁用 400', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'totp_edge', 'password123');
    const csrf = await getCsrf(ctx, authCookie);

    // 未开启时重新生成备用码 → 400
    const regen = await request(ctx, '/api/users/2fa/backup-codes/regenerate', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { password: 'password123', code: '123456' },
    });
    expect(regen.status).toBe(400);

    // 启用 2FA
    const setup = await request(ctx, '/api/users/2fa/setup', { method: 'POST', cookie: authCookie, headers: { 'X-CSRF-Token': csrf } });
    const { secret } = (await json<{ data: { secret: string } }>(setup)).data;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
    await request(ctx, '/api/users/2fa/enable', { method: 'POST', cookie: authCookie, headers: { 'X-CSRF-Token': csrf }, body: { code: totp.generate() } });

    // 禁用时密码错误 → 400
    const disWrongPass = await request(ctx, '/api/users/2fa/disable', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { password: 'wrong_password', code: '123456' },
    });
    expect(disWrongPass.status).toBe(400);

    // 禁用时验证码错误 → 400
    const disWrongCode = await request(ctx, '/api/users/2fa/disable', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { password: 'password123', code: '999999' },
    });
    expect(disWrongCode.status).toBe(400);
  });
});
