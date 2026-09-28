// 极简 SMTP 客户端（cloudflare:sockets TCP）：AUTH LOGIN 发送 HTML 邮件。
//
// TLS 语义（secure 开关，来自系统设置 `smtp_secure` / 环境变量 `SMTP_SECURE`）：
// - true  ：强制加密。465 端口隐式 TLS；其余端口必须宣告 STARTTLS，否则失败（fail closed）。
// - false ：禁用 TLS（本地/内网明文 sink，如实验室 127.0.0.1:1025）。
// - 未设置 ：auto——465 隐式 TLS；其余端口在服务器宣告 STARTTLS 时升级（opportunistic），否则明文。
//
// 超时：单次读/写 10s、整封 30s，防止上游挂死占住 Worker 时间预算。
// 失败抛出异常（Error），调用方决定如何呈现——禁止把异常文本直接透给客户端。

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  /** TLS 模式：true=强制加密 / false=明文 / 缺省=auto（见文件头注释） */
  secure?: boolean;
}

export function hasSmtp(env: { SMTP_HOST?: string }): boolean {
  return Boolean(env.SMTP_HOST);
}

function encodeBase64Std(input: string): string {
  // Workers 有 btoa；Node 测试环境也有全局 btoa（v16+）
  return typeof btoa === 'function' ? btoa(input) : Buffer.from(input).toString('base64');
}

const SMTP_OP_TIMEOUT_MS = 10_000;
const SMTP_TOTAL_TIMEOUT_MS = 30_000;

/** cloudflare:sockets 的 TCPSocket 形状（结构化收窄，避免依赖其类型导出面） */
interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(options?: { expectedServerHostname?: string }): SmtpSocket;
  close(): void | Promise<void>;
}

interface Conn {
  socket: SmtpSocket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { data: string };
}

function resolveTlsMode(port: number, secure: boolean | undefined): 'implicit' | 'starttls' | 'opportunistic' | 'none' {
  if (port === 465) return 'implicit';
  if (secure === true) return 'starttls';
  if (secure === false) return 'none';
  return 'opportunistic';
}

/** 单次 I/O 超时包装；超时/失败一律关断 socket，避免悬挂连接 */
async function withOpTimeout<T>(p: Promise<T>, socket: SmtpSocket, ms: number, label: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`SMTP 超时：${label}`)), ms);
  try {
    return await Promise.race([p, promise]);
  } catch (err) {
    try {
      socket.close();
    } catch {
      // ignore
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function readLine(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { data: string }): Promise<string> {
  const idx = buffer.data.indexOf('\n');
  if (idx >= 0) {
    const line = buffer.data.slice(0, idx).replace(/\r$/, '');
    buffer.data = buffer.data.slice(idx + 1);
    return Promise.resolve(line);
  }
  const { promise, resolve } = Promise.withResolvers<string>();
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
  return promise;
}

async function expect(conn: Conn, code: string, ms: number): Promise<string> {
  const line = await withOpTimeout(readLine(conn.reader, conn.buffer), conn.socket, ms, `等待 ${code} 响应`);
  if (!line.startsWith(code)) {
    throw new Error(`SMTP 期望 ${code} 响应，实际: ${line}`);
  }
  return line;
}

async function writeLine(conn: Conn, line: string, ms: number): Promise<void> {
  await withOpTimeout(conn.writer.write(new TextEncoder().encode(line + '\r\n')), conn.socket, ms, '写入命令');
}

/** EHLO 并返回宣告的扩展集合（大写）；非 250 系列响应视为失败 */
async function ehlo(conn: Conn, ms: number): Promise<Set<string>> {
  await writeLine(conn, 'EHLO picumet', ms);
  const extensions = new Set<string>();
  for (;;) {
    const line = await withOpTimeout(readLine(conn.reader, conn.buffer), conn.socket, ms, '读取 EHLO 响应');
    if (line.startsWith('250 ')) break;
    if (line.startsWith('250-')) {
      extensions.add(line.slice(4).split(/[\s=]/)[0]?.toUpperCase() ?? '');
      continue;
    }
    throw new Error(`SMTP EHLO 失败: ${line}`);
  }
  extensions.delete('');
  return extensions;
}

/**
 * 发送邮件（AUTH LOGIN）。
 * 失败抛出异常，调用方决定如何处理。
 * timeouts：单步/整体超时覆盖（默认 10s/30s；慢速中继可调大，测试可调小）。
 */
export async function sendMail(
  config: SmtpConfig,
  to: string,
  subject: string,
  html: string,
  timeouts?: { opMs?: number; totalMs?: number }
): Promise<void> {
  const opBase = timeouts?.opMs ?? SMTP_OP_TIMEOUT_MS;
  const deadline = Date.now() + (timeouts?.totalMs ?? SMTP_TOTAL_TIMEOUT_MS);
  const opMs = () => Math.max(50, Math.min(opBase, deadline - Date.now()));
  const mode = resolveTlsMode(config.port, config.secure);

  // cloudflare:sockets 仅存在于 workerd 运行时；动态导入避免 Node 测试环境在模块加载期崩
  const sockets = (await import('cloudflare:sockets')) as unknown as {
    connect(opts: { hostname: string; port: number }): unknown;
  };
  let conn: Conn;
  try {
    let socket = sockets.connect({ hostname: config.host, port: config.port }) as SmtpSocket;
    if (mode === 'implicit') socket = socket.startTls({ expectedServerHostname: config.host });
    conn = {
      socket,
      writer: socket.writable.getWriter(),
      reader: socket.readable.getReader(),
      buffer: { data: '' },
    };
  } catch (err) {
    throw new Error(`SMTP 连接失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await expect(conn, '220', opMs());
    let extensions = await ehlo(conn, opMs());

    // STARTTLS 升级（隐式 TLS 已在连接时完成；none/未宣告按模式跳过）
    if ((mode === 'starttls' || mode === 'opportunistic') && extensions.has('STARTTLS')) {
      await writeLine(conn, 'STARTTLS', opMs());
      await expect(conn, '220', opMs());
      const tlsSocket = conn.socket.startTls({ expectedServerHostname: config.host });
      conn = {
        socket: tlsSocket,
        writer: tlsSocket.writable.getWriter(),
        reader: tlsSocket.readable.getReader(),
        buffer: { data: '' },
      };
      extensions = await ehlo(conn, opMs()); // TLS 握手后必须重新 EHLO
    } else if (mode === 'starttls') {
      throw new Error('SMTP 服务器不支持 STARTTLS，已拒绝明文发送（smtp_secure=true）');
    }

    if (config.user && config.pass) {
      await writeLine(conn, 'AUTH LOGIN', opMs());
      await expect(conn, '334', opMs());
      await writeLine(conn, encodeBase64Std(config.user), opMs());
      await expect(conn, '334', opMs());
      await writeLine(conn, encodeBase64Std(config.pass), opMs());
      await expect(conn, '235', opMs());
    }
    await writeLine(conn, `MAIL FROM:<${config.from.replace(/^.*<|>.*$/g, '')}>`, opMs());
    await expect(conn, '250', opMs());
    await writeLine(conn, `RCPT TO:<${to}>`, opMs());
    await expect(conn, '250', opMs());
    await writeLine(conn, 'DATA', opMs());
    await expect(conn, '354', opMs());
    const msg =
      `From: ${config.from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n${html}`;
    // SMTP 点填充：行首 '.' 翻倍，防止提前结束 DATA
    await writeLine(conn, msg.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..') + '\r\n.', opMs());
    await expect(conn, '250', opMs());
    await writeLine(conn, 'QUIT', opMs());
  } finally {
    try {
      await conn.writer.close();
    } catch {
      // ignore
    }
  }
}

// 解析 SMTP 配置：优先使用管理员在系统设置中配置的（密码经 enc: 前缀加密存储），回退环境变量
export async function resolveSmtpConfig(
  raw: Record<string, unknown>,
  env: { SMTP_HOST?: string; SMTP_PORT?: string; SMTP_SECURE?: string; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string; ENCRYPTION_KEY: string }
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
  const secureRaw = get('smtp_secure') ?? env.SMTP_SECURE;
  return {
    host,
    port: Number(get('smtp_port') ?? env.SMTP_PORT ?? 587),
    user: get('smtp_user') || env.SMTP_USER || '',
    pass,
    from: get('smtp_from_email') || env.SMTP_FROM || '',
    // 布尔设置按字符串落库（'true'/'false'）；未配置 = auto（undefined）
    secure: secureRaw == null || secureRaw === '' ? undefined : secureRaw !== 'false',
  };
}
