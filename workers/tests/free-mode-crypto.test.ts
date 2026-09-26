// 自由模式凭据加密落盘：KV 中只存密文（enc: 前缀 + AES-GCM），明文不落盘、可解密还原。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, type TestContext } from './helpers';
import { encryptSecret, decryptSecret } from '../src/utils/crypto';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('自由模式凭据加密落盘', () => {
  it('encryptSecret 密文不含明文凭据，且可正确解密回原值', async () => {
    const key = ctx.env.ENCRYPTION_KEY as string;
    const secretValue = 'super-secret-access-key-123';
    const payload = JSON.stringify({
      userId: 'u1',
      provider: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: secretValue, bucket: 'my-bucket' },
    });
    const sealed = await encryptSecret(payload, key);
    // 落盘密文不得包含任何明文凭据片段
    expect(sealed).not.toContain(secretValue);
    expect(sealed).not.toContain('AKIAEXAMPLE');
    expect(sealed).not.toContain('accessKeyId');
    expect(sealed).not.toContain('my-bucket');
    expect(sealed).not.toContain('super-secret');
    // 可解密回原值（会话凭据仅在内存中可用）
    const roundtrip = await decryptSecret(sealed, key);
    expect(roundtrip).toBe(payload);
  });

  it('错误密钥或篡改密文无法解密', async () => {
    const sealed = await encryptSecret('{"userId":"u1"}', ctx.env.ENCRYPTION_KEY as string);
    await expect(decryptSecret(sealed, 'wrong-key-00000000000000000000')).rejects.toThrow();
    // 篡改密文字节 → GCM 认证失败
    const buf = Buffer.from(sealed, 'base64');
    buf[5] ^= 0xff;
    await expect(decryptSecret(buf.toString('base64'), ctx.env.ENCRYPTION_KEY as string)).rejects.toThrow();
  });
});
