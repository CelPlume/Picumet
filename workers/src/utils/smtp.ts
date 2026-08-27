// 极简 SMTP 客户端（基于 Workers connect() TCP）：AUTH LOGIN 发送纯文本邮件

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

// Workers connect() 声明
declare function connect(options: { hostname: string; port: number }): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

export function hasSmtp(env: { SMTP_HOST?: string }): boolean {
  return Boolean(env.SMTP_HOST);
}

function encodeBase64Std(input: string): string {
  // Workers 有 btoa；Node 测试环境也有全局 btoa（v16+）
  return typeof btoa === 'function' ? btoa(input) : Buffer.from(input).toString('base64');
}

function readLine(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { data: string }): Promise<string> {
  const idx = buffer.data.indexOf('\n');
  if (idx >= 0) {
    const line = buffer.data.slice(0, idx).replace(/\r$/, '');
    buffer.data = buffer.data.slice(idx + 1);
    return Promise.resolve(line);
  }
  return new Promise((resolve) => {
    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) {
          resolve(buffer.data.trim());
          return;
        }
        buffer.data += new TextDecoder().decode(value);
        const nl = buffer.data.indexOf('\n');
        if (nl >= 0) {
          resolve(buffer.data.slice(0, nl).replace(/\r$/, ''));
          buffer.data = buffer.data.slice(nl + 1);
        } else {
          pump();
        }
      });
    };
    pump();
  });
}

async function expect(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { data: string }, code: string): Promise<string> {
  const line = await readLine(reader, buffer);
  if (!line.startsWith(code)) {
    throw new Error(`SMTP 期望 ${code} 响应，实际: ${line}`);
  }
  return line;
}

/**
 * 发送邮件（AUTH LOGIN，非加密）。
 * 失败抛出异常，调用方决定如何处理。
 */
export async function sendMail(config: SmtpConfig, to: string, subject: string, html: string): Promise<void> {
  const socket = connect({ hostname: config.host, port: config.port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const buffer = { data: '' };

  const write = async (line: string) => {
    await writer.write(new TextEncoder().encode(line + '\r\n'));
  };

  try {
    await expect(reader, buffer, '220');
    await write(`EHLO picumet`);
    // 读取多行 EHLO 响应
    for (;;) {
      const line = await readLine(reader, buffer);
      if (line.startsWith('250 ')) break;
    }
    if (config.user && config.pass) {
      await write('AUTH LOGIN');
      await expect(reader, buffer, '334');
      await write(encodeBase64Std(config.user));
      await expect(reader, buffer, '334');
      await write(encodeBase64Std(config.pass));
      await expect(reader, buffer, '235');
    }
    await write(`MAIL FROM:<${config.from.replace(/^.*<|>.*$/g, '')}>`);
    await expect(reader, buffer, '250');
    await write(`RCPT TO:<${to}>`);
    await expect(reader, buffer, '250');
    await write('DATA');
    await expect(reader, buffer, '354');
    const msg =
      `From: ${config.from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n${html}`;
    await write(msg.replace(/\r?\n/g, '\r\n') + '\r\n.');
    await expect(reader, buffer, '250');
    await write('QUIT');
  } finally {
    try {
      await writer.close();
    } catch {
      // ignore
    }
  }
}


// 解析 SMTP 配置：优先使用管理员在系统设置中配置的（密码经 enc: 前缀加密存储），回退环境变量
export async function resolveSmtpConfig(
  raw: Record<string, unknown>,
  env: { SMTP_HOST?: string; SMTP_PORT?: string; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string; ENCRYPTION_KEY: string }
): Promise<SmtpConfig | null> {
  const get = (key: string) => {
    const v = raw[key];
    if (v === undefined || v === null || v === 'null') return undefined;
    return String(v);
  };
  const host = get('smtp_host') || env.SMTP_HOST;
  if (!host) return null;
  let pass = get('smtp_password') || env.SMTP_PASS || '';
  if (pass.startsWith('enc:') && env.ENCRYPTION_KEY) {
    try {
      const { decryptSecret } = await import('./crypto');
      pass = await decryptSecret(pass.slice(4), env.ENCRYPTION_KEY);
    } catch {
      return null;
    }
  }
  return {
    host,
    port: Number(get('smtp_port') ?? env.SMTP_PORT ?? 587),
    user: get('smtp_user') || env.SMTP_USER || '',
    pass,
    from: get('smtp_from_email') || env.SMTP_FROM || '',
  };
}
