"""Picumet 本地验收脚本公共工具（仅标准库 + wrangler CLI）。

被 scripts/verify-content-addressing.py 与 scripts/verify-storage-failover.py 复用：
- HTTP 会话（cookie jar + CSRF + 网关密钥签发）
- multipart/form-data 组包（stdlib 上传）
- 本地 D1 查询（`bunx wrangler d1 execute --local --json`）
- 本地 R2 对象键枚举（读取 `.wrangler/state/v3/r2/**/*.sqlite` 的 `_mf_objects`，仅本地环境可用）

前置：本地开发栈已启动（`cd workers && bun run dev`），且本地 D1 已应用 migrations。
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_WORKERS_DIR = REPO_ROOT / 'workers'
DEFAULT_BASE_URL = 'http://localhost:8787'
DEFAULT_DB = 'picumet-db'


class VerifyError(RuntimeError):
    """验收断言失败（脚本以非零码退出）"""


class Session:
    """带 cookie jar 的极简 HTTP 客户端"""

    def __init__(self, base_url: str, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip('/')
        self.timeout = timeout
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> tuple[int, bytes, dict[str, str]]:
        url = path if path.startswith('http') else f'{self.base_url}{path}'
        req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as err:  # 4xx/5xx 也返回内容，由调用方断言
            return err.code, err.read(), dict(err.headers)

    def json_request(self, method: str, path: str, payload: dict | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict]:
        body = json.dumps(payload).encode() if payload is not None else None
        merged = {'Content-Type': 'application/json', **(headers or {})}
        status, raw, _ = self.request(method, path, body=body, headers=merged)
        try:
            return status, json.loads(raw or b'{}')
        except json.JSONDecodeError:
            return status, {'_raw': raw.decode('utf-8', 'replace')[:400]}


def require_server(session: Session, attempts: int = 3) -> None:
    """探活：任何 HTTP 响应（含 401）都视为服务可达；连接层异常重试后报错"""
    last: Exception | None = None
    for i in range(attempts):
        try:
            status, _, _ = session.request('GET', '/api/health', timeout=10)
        except OSError as err:
            last = err
            time.sleep(1.5)
            continue
        if status >= 500:
            raise VerifyError(f'{session.base_url}/api/health 返回 {status}')
        return
    raise VerifyError(f'无法连接 {session.base_url}（先启动 `cd workers && bun run dev`）：{last}')


def login(session: Session, username: str, password: str) -> None:
    status, data = session.json_request('POST', '/api/auth/login', {'username': username, 'password': password})
    if status != 200 or not data.get('success'):
        raise VerifyError(f'登录失败（{status}）：{data}')


def csrf(session: Session) -> str:
    status, data = session.json_request('GET', '/api/auth/csrf-token')
    if status != 200 or not data.get('success'):
        raise VerifyError(f'获取 CSRF 失败（{status}）：{data}')
    return data['data']['token']


def create_api_key(session: Session, name: str, permissions: list[str], upload_path: str = '/') -> dict:
    """签发网关密钥（用管理员账号，权限不受路径规则限制），返回 {keyId, fullToken}"""
    status, data = session.json_request(
        'POST',
        '/api/keys',
        {'name': name, 'permissions': permissions, 'protocols': ['api'], 'uploadPath': upload_path},
        headers={'X-CSRF-Token': csrf(session)},
    )
    if status != 201 or not data.get('success'):
        raise VerifyError(f'创建网关密钥失败（{status}）：{data}')
    key = data['data']['key']
    return {'keyId': key['keyId'], 'fullToken': key['fullToken']}


def multipart(fields: dict[str, str], file_field: str, filename: str, content: bytes, content_type: str = 'text/plain') -> tuple[bytes, str]:
    """构造 multipart/form-data 请求体"""
    boundary = f'----picumetverify{uuid.uuid4().hex}'
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    chunks.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f'Content-Type: {content_type}\r\n\r\n'.encode()
        + content
        + b'\r\n'
    )
    chunks.append(f'--{boundary}--\r\n'.encode())
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


class LocalDb:
    """本地 D1 / R2 只读探测（wrangler CLI + miniflare 的 sqlite 文件）"""

    def __init__(self, workers_dir: pathlib.Path = DEFAULT_WORKERS_DIR, db_name: str = DEFAULT_DB) -> None:
        self.workers_dir = workers_dir
        self.db_name = db_name

    def query(self, sql: str, retries: int = 3) -> list[dict]:
        last = ''
        for _ in range(retries):
            proc = subprocess.run(
                ['bunx', 'wrangler', 'd1', 'execute', self.db_name, '--local', '--json', '--command', sql],
                cwd=self.workers_dir,
                capture_output=True,
                text=True,
                timeout=180,
            )
            last = proc.stdout + proc.stderr
            try:
                return json.loads(proc.stdout)[0]['results']
            except (json.JSONDecodeError, IndexError, KeyError):
                time.sleep(1.5)
        raise VerifyError(f'D1 查询失败：{last[:300]}')

    def exec(self, sql: str) -> None:
        self.query(sql)

    def local_r2_keys(self, prefix: str) -> list[str] | None:
        """本地 R2 桶内对象键（读 miniflare sqlite）；非本地环境返回 None"""
        keys: list[str] = []
        found_db = False
        for path in (self.workers_dir / '.wrangler/state/v3/r2').glob('**/*.sqlite'):
            try:
                con = sqlite3.connect(path)
                tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if '_mf_objects' in tables:
                    found_db = True
                    keys += [row[0] for row in con.execute('SELECT key FROM _mf_objects WHERE key LIKE ?', (f'{prefix}%',))]
                con.close()
            except sqlite3.Error:
                continue
        return sorted(keys) if found_db else None


def trigger_scheduled(session: Session) -> bool:
    """触发一次 scheduled 任务（需 dev server 以 --test-scheduled 启动）"""
    status, _, _ = session.request('GET', '/cdn-cgi/handler/scheduled?cron=*+*+*+*+*', timeout=60)
    return status == 200


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise VerifyError(message)
    print(f'  ✓ {message}')


def section(title: str) -> None:
    print(f'\n== {title}')


def add_common_args(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    parser.add_argument('--base-url', default=DEFAULT_BASE_URL, help=f'开发服务器地址（默认 {DEFAULT_BASE_URL}）')
    parser.add_argument('--workers-dir', default=str(DEFAULT_WORKERS_DIR), help='workers 目录（含 wrangler.toml）')
    parser.add_argument('--username', default='admin', help='管理员账号（默认 admin，见 workers/src/seed.ts）')
    parser.add_argument('--password', default='admin123456', help='管理员密码（dev 默认 admin123456，可由 ADMIN_PASSWORD 覆盖）')
    return parser


def main_wrapper(fn) -> None:
    """统一错误处理：验收失败打印原因并以 1 退出"""
    try:
        fn()
    except VerifyError as err:
        print(f'\nFAIL: {err}', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    print('\nPASS')
