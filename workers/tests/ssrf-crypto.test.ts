// SSRF 防护与密码学工具：私网/保留地址拦截，WebCrypto 缺失时摘要与加密 fail-closed
import { describe, it, expect, afterEach } from 'vitest';
import { isPrivateHost, validateEndpoint } from '../src/utils/ssrf';
import { sha256Hex, encryptSecret, decryptSecret, randomDigits, __setCryptoOverrideForTests } from '../src/utils/crypto';

/** 脚本化 CSPRNG：按调用顺序回放预置字节序列（`loop` 序列循环取用），用完后的调用全部回 0 */
function scriptedCrypto(scripted: number[], loop: number[] = []): Crypto {
  let cursor = 0;
  return {
    getRandomValues(arr: Uint8Array): Uint8Array {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = cursor < scripted.length ? scripted[cursor] : loop[(cursor - scripted.length) % loop.length] ?? 0;
        cursor++;
      }
      return arr;
    },
  } as unknown as Crypto;
}

afterEach(() => {
  __setCryptoOverrideForTests(undefined);
});

describe('SSRF 防护', () => {
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

describe('密码学', () => {
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

// randomDigits 是注册 / 改密 / 换绑三处一次性验证码的同源生成器（替代 Math.random）。
// 下面锁死它的三条不变量：长度精确、剔除 >= 250 的拒绝采样（消除 % 10 偏置）、真实 CSPRNG 覆盖全数字集。
describe('randomDigits（一次性验证码生成器）', () => {
  it('长度精确且全为数字（length=0 与超长同样成立）', () => {
    __setCryptoOverrideForTests(scriptedCrypto([], []));
    for (const len of [0, 1, 6, 7, 12, 40]) {
      const code = randomDigits(len);
      expect(code, `length=${len}`).toHaveLength(len);
      expect(code, `length=${len}`).toMatch(/^\d*$/);
    }
  });

  it('拒绝采样：>= 250 的字节被丢弃，不参与取模（否则 0..5 会多出一档概率）', () => {
    // 第一轮整批返回 250（应被丢弃），第二轮才给有效字节；若实现未做拒绝采样，这里会得到 '000000'
    __setCryptoOverrideForTests(scriptedCrypto([250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250], [7]));
    expect(randomDigits(6)).toBe('777777');
  });

  it('偏置回归：剔除 250..255 后十个数字严格等频（各 25/250）', () => {
    // 先喂 16 个被剔除的 250，再循环 0..255：正确实现只取 0..249，各数字恰好 25 次；
    // 未剔除的实现会把 16 个 250 折成 0，使数字 0 变成 41 次。
    const cycle = Array.from({ length: 256 }, (_, i) => i);
    __setCryptoOverrideForTests(scriptedCrypto([250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250], cycle));
    const code = randomDigits(250);
    for (let d = 0; d <= 9; d++) {
      const count = code.split(String(d)).length - 1;
      expect(count, `数字 ${d} 的出现次数`).toBe(25);
    }
  });

  it('前导零保留（长度不因前导零而变短）', () => {
    __setCryptoOverrideForTests(scriptedCrypto([0, 0, 0, 0, 0, 0]));
    expect(randomDigits(6)).toBe('000000');
  });

  it('真实 CSPRNG：批量样本全部为 6 位数字且覆盖 0..9 全部数字', () => {
    __setCryptoOverrideForTests(undefined);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = randomDigits(6);
      expect(code).toMatch(/^\d{6}$/);
      for (const ch of code) seen.add(ch);
    }
    expect([...seen].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});
