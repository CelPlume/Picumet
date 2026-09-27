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
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
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

    def presigned_put(self, url: str, data: bytes, content_type: str = 'application/octet-stream', timeout: float | None = None) -> tuple[int, dict[str, str]]:
        """直传预签名 URL（对象存储端点）：不带会话 Cookie，也无 CSRF"""
        req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': content_type})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return resp.status, dict(resp.headers)
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers)

    def get_bytes(self, url: str, headers: dict[str, str] | None = None, timeout: float | None = None) -> tuple[int, bytes, dict[str, str]]:
        """取原始字节（直链 / 下载网关 / 预签名下载），4xx-5xx 同样返回内容"""
        target = url if url.startswith('http') else f'{self.base_url}{url}'
        req = urllib.request.Request(target, method='GET', headers=headers or {})
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as err:
            return err.code, err.read(), dict(err.headers)


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


class LocalD1:
    """本地 D1 只读直连（sqlite 只读打开）。

    `wrangler d1 execute --local` 每次都要起一个 bun 进程（1–2 秒），E2E 断言密度下不可用；
    miniflare 的 D1 就是标准 SQLite（WAL），只读连接读得到已提交数据。
    找不到库或读失败时由调用方回退到 LocalDb（CLI）。
    """

    def __init__(self, workers_dir: pathlib.Path = DEFAULT_WORKERS_DIR) -> None:
        self.workers_dir = pathlib.Path(workers_dir)
        self.path = self._find()

    def _find(self) -> pathlib.Path:
        root = self.workers_dir / '.wrangler/state/v3/d1'
        candidates = [p for p in root.glob('**/*.sqlite') if 'metadata' not in p.name]
        if not candidates:
            raise VerifyError(f'未找到本地 D1 数据库（{root}）；先执行 migrations（--local）')
        return max(candidates, key=lambda p: p.stat().st_size)

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(f'file:{self.path}?mode=ro', uri=True, timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        con = self._connect()
        try:
            return [dict(row) for row in con.execute(sql, params)]
        finally:
            con.close()

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def scalar(self, sql: str, params: tuple = (), default=None):
        rows = self.query(sql, params)
        if not rows:
            return default
        return next(iter(rows[0].values()))


class S3:
    """本地 S3 兼容存储的对象级检查（走 scripts/lab/s3tool.ts，复用 workers 已装的 AWS SDK）。

    应用 API 观察不到「对象实际落在哪个桶」，容灾/拼好桶/回收链路必须直连桶核对。
    """

    def __init__(
        self,
        endpoint: str,
        access_key: str = 'minioadmin',
        secret_key: str = 'minioadmin',
        region: str = 'us-east-1',
        repo_root: pathlib.Path = REPO_ROOT,
    ) -> None:
        self.endpoint = endpoint.rstrip('/')
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.repo_root = pathlib.Path(repo_root)

    def _run(self, *args: str, timeout: float = 900) -> tuple[int, bytes, bytes]:
        proc = subprocess.run(
            ['bun', str(self.repo_root / 'scripts/lab/s3tool.ts'), *args],
            cwd=self.repo_root / 'workers',  # 依赖解析需要 workers/node_modules
            capture_output=True,
            timeout=timeout,
            env={**os.environ, 'S3_AK': self.access_key, 'S3_SK': self.secret_key, 'S3_REGION': self.region},
        )
        return proc.returncode, proc.stdout, proc.stderr

    def _json(self, *args: str, timeout: float = 900) -> dict:
        code, stdout, stderr = self._run(*args, timeout=timeout)
        if code != 0:
            raise VerifyError(f's3tool {args[0]} 失败：{stderr.decode("utf-8", "replace")[:300]}')
        lines = [ln for ln in stdout.decode('utf-8', 'replace').splitlines() if ln.strip()]
        if not lines:
            raise VerifyError(f's3tool {args[0]} 无输出')
        return json.loads(lines[-1])

    def ping(self) -> dict:
        return self._json('ping', self.endpoint)

    def mkbucket(self, bucket: str) -> dict:
        return self._json('mkbucket', self.endpoint, bucket)

    def ls(self, bucket: str, prefix: str = '') -> dict:
        return self._json('ls', self.endpoint, bucket, prefix)

    def keys(self, bucket: str, prefix: str = '') -> list[str]:
        return [item['key'] for item in self.ls(bucket, prefix)['keys']]

    def head(self, bucket: str, key: str) -> dict:
        return self._json('head', self.endpoint, bucket, key)

    def exists(self, bucket: str, key: str) -> bool:
        return bool(self.head(bucket, key).get('exists'))

    def get_bytes(self, bucket: str, key: str) -> bytes:
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / 'obj.bin'
            self._json('get', self.endpoint, bucket, key, str(out))
            return out.read_bytes()

    def get_to_file(self, bucket: str, key: str, out_file: pathlib.Path) -> dict:
        return self._json('get', self.endpoint, bucket, key, str(out_file), timeout=1800)

    def put_file(self, bucket: str, key: str, file: pathlib.Path) -> dict:
        return self._json('put', self.endpoint, bucket, key, str(file), timeout=1800)

    def rm(self, bucket: str, key: str) -> dict:
        return self._json('rm', self.endpoint, bucket, key)

    def copy_from(self, src: 'S3', src_bucket: str, src_key: str, dst_bucket: str, dst_key: str) -> dict:
        """把 src 端点上的对象复制到本端点（模拟外部镜像同步 / 制造副桶副本）"""
        return self._json('copy', src.endpoint, src_bucket, src_key, self.endpoint, dst_bucket, dst_key)


class Reporter:
    """结果采集器：feature 检查记录而不中断（失败也继续跑完，得到完整矩阵），前置条件才用 expect 硬失败。

    结果落到 `.tmp/lab-results/<name>.json`（.tmp/ 已被 .gitignore 忽略）。
    """

    def __init__(self, name: str, results_dir: pathlib.Path | None = None) -> None:
        self.name = name
        self.results: list[dict] = []
        self.results_dir = results_dir or (REPO_ROOT / '.tmp/lab-results')
        self.started = time.time()

    def check(self, ok: bool, label: str, detail: str = '') -> bool:
        ok = bool(ok)
        self.results.append({'type': 'check', 'ok': ok, 'label': label, 'detail': detail})
        print(f"  {'✓' if ok else '✗'} {label}" + (f' — {detail}' if detail and not ok else ''), flush=True)
        return ok

    def note(self, label: str, detail: str = '') -> None:
        self.results.append({'type': 'note', 'ok': True, 'label': label, 'detail': detail})
        print(f'  · {label}' + (f' — {detail}' if detail else ''), flush=True)

    def fail_detail(self) -> str:
        return '; '.join(r['label'] for r in self.results if r['type'] == 'check' and not r['ok'])

    def finish(self) -> bool:
        checks = [r for r in self.results if r['type'] == 'check']
        failed = [r for r in checks if not r['ok']]
        self.results_dir.mkdir(parents=True, exist_ok=True)
        (self.results_dir / f'{self.name}.json').write_text(
            json.dumps(
                {
                    'name': self.name,
                    'passed': len(checks) - len(failed),
                    'failed': len(failed),
                    'checks': len(checks),
                    'durationSec': round(time.time() - self.started, 1),
                    'results': self.results,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        print(f'\n[{self.name}] 检查 {len(checks)} 项：通过 {len(checks) - len(failed)}，失败 {len(failed)}', flush=True)
        for row in failed:
            print(f"  FAIL {row['label']} — {row['detail']}")
        return not failed


def trigger_scheduled(session: Session) -> bool:
    """触发一次 scheduled 任务（需 dev server 以 --test-scheduled 启动）"""
    status, _, _ = session.request('GET', '/cdn-cgi/handler/scheduled?cron=*+*+*+*+*', timeout=60)
    return status == 200


def hget(headers: dict[str, str], name: str) -> str:
    """按名取响应头（大小写不敏感；urllib 保留服务端原始大小写）"""
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return ''


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
