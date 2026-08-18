// SSRF 与密码学回归（审计 M-1/M-4）
import { describe, it, expect, afterEach } from 'vitest';
import { isPrivateHost, validateEndpoint } from '../src/utils/ssrf';
import { sha256Hex, encryptSecret, decryptSecret, __setCryptoOverrideForTests } from '../src/utils/crypto';

afterEach(() => {
  __setCryptoOverrideForTests(undefined);
});

describe('SSRF 防护（M-1）', () => {
  it('IPv4 私网/保留/回环/链路本地/文档/多播段全部拦截', () => {
    const blocked = [
      '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      '127.0.0.1', '169.254.0.1', '100.64.0.1', '0.0.0.0',
      '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.9', '203.0.113.9',
      '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ];
    for (const h of blocked) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it('公网 IPv4 放行', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
  });

  it('IPv6 回环/链路本地/ULA/文档/多播/内嵌 IPv4 全部拦截', () => {
    const blocked = [
      '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      '2001:db8::1', 'ff02::1',
      '::ffff:10.0.0.1', '64:ff9b::192.168.1.1', '2002:c0a8:0101::',
    ];
    for (const h of blocked) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    // 公网 IPv6 放行
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false);
  });

  it('主机名黑名单与内部后缀', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('metadata.google.internal')).toBe(true);
    expect(isPrivateHost('myhost.local')).toBe(true);
    expect(isPrivateHost('svc.internal')).toBe(true);
  });

  it('validateEndpoint：scheme/端口/userinfo/私网校验', () => {
    expect(validateEndpoint('http://10.0.0.1/x')).toBe(false);
    expect(validateEndpoint('https://example.com:444/x')).toBe(false);
    expect(validateEndpoint('https://user:pass@example.com/x')).toBe(false);
    expect(validateEndpoint('ftp://example.com/x')).toBe(false);
    expect(validateEndpoint('file:///etc/passwd')).toBe(false);
    expect(validateEndpoint('https://example.com/x')).toBe(true);
    expect(validateEndpoint('http://example.com:80/x')).toBe(true);
  });
});

describe('密码学（M-4）', () => {
  it('sha256Hex 在 WebCrypto 缺失时 fail-closed（不使用非密码学降级）', async () => {
    __setCryptoOverrideForTests({} as Crypto);
    await expect(sha256Hex('anything')).rejects.toThrow();
  });

  it('sha256Hex 正常输出标准 SHA-256', async () => {
    const h = await sha256Hex('abc');
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('HKDF 派生密钥：同密钥可解密，跨密钥不串用', async () => {
    const sealed = await encryptSecret('{"secret":"v"}', 'enc-key-aaaa');
    const roundtrip = await decryptSecret(sealed, 'enc-key-aaaa');
    expect(roundtrip).toBe('{"secret":"v"}');
    await expect(decryptSecret(sealed, 'enc-key-bbbb')).rejects.toThrow();
  });
});
