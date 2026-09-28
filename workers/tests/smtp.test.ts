// SMTP 客户端单测：mock cloudflare:sockets（workerd 专属模块，Node 测试环境不存在）。
// 覆盖：明文全流程（含点填充）、STARTTLS 升级（secure=true 强制、auto 机会式）、
// secure=true 且服务器不支持 STARTTLS 时 fail closed、无响应超时。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendMail, resolveSmtpConfig, type SmtpConfig } from '../src/utils/smtp';

type Responder = (cmd: string, tls: boolean) => string[] | null;

/** 构造 cloudflare:sockets 的假 connect：每次 startTls 返回全新流（与 workerd 语义一致，但问候只在首条连接发送） */
function makeFakeConnect(responder: Responder) {
  const commands: string[] = [];
  let tls = false;
  let firstSocket = true;
  const encoder = new TextEncoder();

  const makeSocket = (): Record<string, unknown> => {
    let readableCtl!: ReadableStreamDefaultController<Uint8Array>;
    const greet = firstSocket;
    firstSocket = false;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        readableCtl = c;
        if (greet) c.enqueue(encoder.encode('220 sink ready\r\n'));
      },
    });
    return {
      readable,
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          const text = new TextDecoder().decode(chunk);
          for (const line of text.split('\r\n').filter(Boolean)) {
            commands.push(`${tls ? '[tls] ' : ''}${line}`);
            const out = responder(line, tls);
            if (out) for (const l of out) readableCtl.enqueue(encoder.encode(l + '\r\n'));
          }
        },
      }),
      startTls() {
        tls = true;
        return makeSocket();
      },
      close() {},
    };
  };
  return {
    commands,
    connect: () => makeSocket(),
  };
}

function baseConfig(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return { host: '127.0.0.1', port: 1025, user: 'u', pass: 'p', from: 'Picumet <noreply@example.com>', ...overrides };
}

/** 标准对话：AUTH LOGIN 凭据按传入配置的 btoa 值应答 */
function makePlainResponder(cfg: SmtpConfig): Responder {
  const b64User = btoa(cfg.user ?? '');
  const b64Pass = btoa(cfg.pass ?? '');
  return (cmd) => {
    if (cmd === 'EHLO picumet') return ['250-localhost', '250-AUTH LOGIN PLAIN', '250 8BITMIME'];
    if (cmd === 'AUTH LOGIN') return ['334 VXNlcm5hbWU6'];
    if (cmd === b64User) return ['334 UGFzc3dvcmQ6'];
    if (cmd === b64Pass) return ['235 ok'];
    if (cmd.startsWith('MAIL FROM:') || cmd.startsWith('RCPT TO:')) return ['250 ok'];
    if (cmd === 'DATA') return ['354 go'];
    if (cmd === '.') return ['250 queued'];
    if (cmd === 'QUIT') return ['221 bye'];
    return null;
  };
}

describe('sendMail（mock cloudflare:sockets）', () => {
  afterEach(() => {
    vi.doUnmock('cloudflare:sockets');
    vi.useRealTimers();
  });

  it('明文流程（secure=false）：完整 SMTP 对话，消息做点填充', async () => {
    const cfg = baseConfig({ secure: false });
    const fake = makeFakeConnect(makePlainResponder(cfg));
    vi.doMock('cloudflare:sockets', () => ({ connect: fake.connect }));
    await sendMail(cfg, 'to@example.com', '测试主题', '<p>hi</p>\r\n.top line');
    expect(fake.commands.filter((c) => c.startsWith('EHLO')).length).toBe(1);
    expect(fake.commands.some((c) => c === 'STARTTLS')).toBe(false);
    expect(fake.commands.some((c) => c.includes('Subject: 测试主题'))).toBe(true);
    // 点填充：行首 '.' 翻倍，DATA 终止符仍是单个 '.'
    expect(fake.commands.some((c) => c === '..top line')).toBe(true);
    expect(fake.commands.some((c) => c === '.')).toBe(true);
  });

  it('auto（未设置 secure）+ 服务器宣告 STARTTLS：机会式升级并重新 EHLO', async () => {
    const cfg = baseConfig({ secure: undefined });
    const plain = makePlainResponder(cfg);
    const responder: Responder = (cmd, tls) => {
      if (cmd === 'STARTTLS') return ['220 go'];
      if (cmd === 'EHLO picumet') return tls ? ['250-localhost', '250 AUTH LOGIN PLAIN'] : ['250-localhost', '250-STARTTLS', '250 AUTH LOGIN'];
      return plain(cmd, tls);
    };
    const fake = makeFakeConnect(responder);
    vi.doMock('cloudflare:sockets', () => ({ connect: fake.connect }));
    await sendMail(cfg, 'to@example.com', 's', '<p>hi</p>');
    // 升级后的 EHLO 记录带 '[tls] ' 前缀
    expect(fake.commands.filter((c) => c.endsWith('EHLO picumet')).length).toBe(2);
    expect(fake.commands.filter((c) => c.startsWith('[tls] ')).length).toBeGreaterThan(0);
  });

  it('secure=true + 服务器宣告 STARTTLS：强制升级后投递成功', async () => {
    const cfg = baseConfig({ secure: true });
    const plain = makePlainResponder(cfg);
    const responder: Responder = (cmd, tls) => {
      if (cmd === 'STARTTLS') return ['220 go'];
      if (cmd === 'EHLO picumet') return tls ? ['250-localhost', '250 AUTH LOGIN'] : ['250-localhost', '250-STARTTLS', '250 AUTH'];
      return plain(cmd, tls);
    };
    const fake = makeFakeConnect(responder);
    vi.doMock('cloudflare:sockets', () => ({ connect: fake.connect }));
    await expect(sendMail(cfg, 'to@example.com', 's', '<p>hi</p>')).resolves.toBeUndefined();
  });

  it('secure=true + 服务器不支持 STARTTLS：拒绝明文发送（fail closed）', async () => {
    const fake = makeFakeConnect(makePlainResponder(baseConfig({ secure: true })));
    vi.doMock('cloudflare:sockets', () => ({ connect: fake.connect }));
    await expect(sendMail(baseConfig({ secure: true }), 'to@example.com', 's', '<p>hi</p>')).rejects.toThrow('STARTTLS');
  });

  it('服务器无响应：按操作超时抛错', async () => {
    // 真实短超时而非 fake timers：doMock 的动态 import 与 ReadableStream 调度跨真实
    // 宏任务边界，fake clock 会先喂给模块加载时序，互相纠缠。
    const fake = makeFakeConnect(() => null);
    vi.doMock('cloudflare:sockets', () => ({ connect: fake.connect }));
    const p = sendMail(baseConfig({ secure: false }), 'to@example.com', 's', '<p>hi</p>', { opMs: 100 });
    await expect(p).rejects.toThrow('SMTP 超时');
  });
});

describe('resolveSmtpConfig', () => {
  it('smtp_secure 落库字符串按布尔解析；未配置 = auto（undefined）', async () => {
    const env = { SMTP_HOST: undefined, ENCRYPTION_KEY: 'k' } as const;
    expect((await resolveSmtpConfig({ smtp_host: 'a', smtp_secure: 'false' }, env))?.secure).toBe(false);
    expect((await resolveSmtpConfig({ smtp_host: 'a', smtp_secure: 'true' }, env))?.secure).toBe(true);
    expect((await resolveSmtpConfig({ smtp_host: 'a' }, env))?.secure).toBeUndefined();
  });
});
