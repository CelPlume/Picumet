#!/usr/bin/env python3
"""极简 SMTP 收件箱（sink）：接收邮件、落盘 JSON，供 E2E 断言读取。

为什么自研而不是 MailHog/Mailpit：本机的 Docker registry mirror 无法拉取外部镜像
（见 scripts/lab/env/s3/Dockerfile 注释），而 python:3.11-slim 已在本地，stdlib 足够实现
一个「接收 + 落盘 + 可断言」的 SMTP 端。支持 Picumet 实际使用的命令集：

  EHLO/HELO · AUTH LOGIN · AUTH PLAIN · MAIL FROM · RCPT TO · DATA · RSET · NOOP · QUIT

邮件写入 <out-dir>/mailbox.jsonl（一行一封，便于 jq 断言）与 <out-dir>/mail-<seq>.json。
同时在 stdout 打印完整 SMTP 对话，便于核对客户端实现（这是审计 SEC-05 的证据面）。
"""
from __future__ import annotations

import argparse
import base64
import json
import pathlib
import socket
import socketserver
import threading
import time

CRLF = '\r\n'


def b64decode_safe(value: str) -> str:
    try:
        return base64.b64decode(value.strip(), validate=False).decode('utf-8', 'replace')
    except Exception:  # noqa: BLE001 — 收件端尽力而为，解码失败不影响会话
        return ''


def decode_transfer_encoding(body: str, encoding: str) -> str:
    enc = encoding.strip().lower()
    if enc == 'base64':
        try:
            return base64.b64decode(''.join(body.split()), validate=False).decode('utf-8', 'replace')
        except Exception:  # noqa: BLE001
            return body
    if enc == 'quoted-printable':
        import quopri

        return quopri.decodestring(body.encode()).decode('utf-8', 'replace')
    return body


def parse_message(raw: str) -> dict:
    """从原始报文提取常用字段；不追求完整 RFC 822 兼容，只覆盖断言所需。"""
    head, _, body = raw.partition('\r\n\r\n' if '\r\n\r\n' in raw else '\n\n')
    headers: dict[str, str] = {}
    for line in head.replace('\r\n', '\n').split('\n'):
        if not line or line[0] in ' \t':
            continue
        if ':' in line:
            key, value = line.split(':', 1)
            headers[key.strip().lower()] = value.strip()
    body = decode_transfer_encoding(body, headers.get('content-transfer-encoding', ''))
    return {
        'subject': headers.get('subject', ''),
        'from': headers.get('from', ''),
        'to': headers.get('to', ''),
        'contentType': headers.get('content-type', ''),
        'body': body.rstrip('\r\n'),
        'rawSize': len(raw),
    }


class Mailbox:
    def __init__(self, out_dir: pathlib.Path) -> None:
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.seq = 0

    def store(self, sender: str, recipients: list[str], raw: str) -> dict:
        with self.lock:
            self.seq += 1
            seq = self.seq
        parsed = parse_message(raw)
        record = {
            'seq': seq,
            'receivedAt': int(time.time() * 1000),
            'envelopeFrom': sender,
            'envelopeTo': recipients,
            **parsed,
        }
        (self.out_dir / f'mail-{seq}.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        with (self.out_dir / 'mailbox.jsonl').open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + '\n')
        print(f"[sink] 收到邮件 #{seq} → {recipients} subject={parsed['subject']!r} ({len(raw)} bytes)", flush=True)
        return record


class SmtpSession(socketserver.StreamRequestHandler):
    timeout = 300

    def log(self, direction: str, line: str) -> None:
        print(f'[sink] {direction} {line}', flush=True)

    def send(self, line: str) -> None:
        self.log('S>>', line)
        self.wfile.write((line + CRLF).encode())
        self.wfile.flush()

    def readline(self) -> str | None:
        raw = self.rfile.readline()
        if not raw:
            return None
        line = raw.decode('utf-8', 'replace').rstrip('\r\n')
        self.log('C>>', line)
        return line

    def handle(self) -> None:  # noqa: C901 — SMTP 状态机，线性分支更易读
        sender = ''
        recipients: list[str] = []
        self.send('220 picumet-smtp-sink ESMTP ready')
        while True:
            line = self.readline()
            if line is None:
                return
            verb, _, rest = line.partition(' ')
            verb = verb.upper()

            if verb in ('EHLO', 'HELO'):
                self.send('250-picumet-smtp-sink')
                self.send('250-AUTH LOGIN PLAIN')
                self.send('250-8BITMIME')
                self.send('250-SIZE 10485760')
                self.send('250 OK')
            elif verb == 'AUTH':
                mech = rest.split(' ')[0].upper() if rest else ''
                extra = rest.split(' ', 1)[1] if ' ' in rest else ''
                if mech == 'LOGIN':
                    if extra:
                        user = b64decode_safe(extra)
                    else:
                        self.send('334 VXNlcm5hbWU6')
                        user_line = self.readline() or ''
                        user = b64decode_safe(user_line)
                    self.send('334 UGFzc3dvcmQ6')
                    pass_line = self.readline() or ''
                    _ = b64decode_safe(pass_line)
                    self.send(f'235 2.7.0 Authentication successful (user={user})')
                elif mech == 'PLAIN':
                    payload = extra
                    if not payload:
                        self.send('334 ')
                        payload = self.readline() or ''
                    _ = b64decode_safe(payload)
                    self.send('235 2.7.0 Authentication successful')
                else:
                    self.send('504 Unrecognized authentication type')
            elif verb == 'MAIL':
                sender = rest.split(':', 1)[1].strip() if ':' in rest else rest
                sender = sender.strip('<>')
                recipients = []
                self.send('250 2.1.0 OK')
            elif verb == 'RCPT':
                target = rest.split(':', 1)[1].strip() if ':' in rest else rest
                recipients.append(target.strip('<>'))
                self.send('250 2.1.5 OK')
            elif verb == 'DATA':
                self.send('354 End data with <CR><LF>.<CR><LF>')
                chunks: list[str] = []
                while True:
                    data_line = self.readline()
                    if data_line is None:
                        return
                    if data_line == '.':
                        break
                    # 点填充（dot-stuffing）还原
                    chunks.append(data_line[1:] if data_line.startswith('..') else data_line)
                raw = CRLF.join(chunks)
                self.server.mailbox.store(sender, recipients, raw)  # type: ignore[attr-defined]
                self.send('250 2.0.0 OK queued')
            elif verb == 'RSET':
                sender, recipients = '', []
                self.send('250 2.0.0 OK')
            elif verb == 'NOOP':
                self.send('250 2.0.0 OK')
            elif verb == 'QUIT':
                self.send('221 2.0.0 Bye')
                return
            elif verb == 'STARTTLS':
                # 明确不支持：Picumet 当前实现也不协商 STARTTLS（审计 SEC-05）
                self.send('454 4.7.0 TLS not available')
            else:
                self.send('502 5.5.2 Command not implemented')


class SmtpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], mailbox: Mailbox) -> None:
        self.mailbox = mailbox
        super().__init__(address, SmtpSession)


def main() -> None:
    parser = argparse.ArgumentParser(description='Picumet 实验室 SMTP 收件箱')
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=1025)
    parser.add_argument('--out', default='/mailbox', help='邮件落盘目录')
    args = parser.parse_args()

    mailbox = Mailbox(pathlib.Path(args.out))
    server = SmtpServer((args.host, args.port), mailbox)
    print(f'[sink] listening on {args.host}:{args.port}, mailbox={args.out}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    socket.setdefaulttimeout(None)
    main()
