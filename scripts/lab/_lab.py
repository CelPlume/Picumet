"""Picumet 实验室门面（Lab）：把 HTTP API 契约封装成测试可直接调用的高层动作。

上层测试模块（scripts/lab/0X_*.py）只表达「场景 + 断言」，不再重复 CSRF / 预签名分片 /
幂等重试 / D1 核对等机械细节。所有硬失败（接口不可用、前置缺失）以 VerifyError 抛出；
feature 断言统一走 Reporter.check，失败不中断，保证一轮跑出完整矩阵。
"""
from __future__ import annotations

import json
import mimetypes
import pathlib
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import (  # noqa: E402
    DEFAULT_BASE_URL,
    DEFAULT_WORKERS_DIR,
    LocalD1,
    S3,
    Session,
    VerifyError,
    multipart,
)

PART_SIZE = 8 * 1024 * 1024
MULTIPART_THRESHOLD = 100 * 1024 * 1024


def guess_mime(filename: str) -> str:
    return mimetypes.guess_type(filename)[0] or 'application/octet-stream'


def uid(prefix: str = '') -> str:
    return f'{prefix}{uuid.uuid4().hex[:10]}'


class Lab:
    """一个 Lab 实例 = 一个本地开发栈（Workers API + 本地 D1 + 四个 S3 桶）。"""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        workers_dir: pathlib.Path | str = DEFAULT_WORKERS_DIR,
        admin_user: str = 'admin',
        admin_password: str = 'admin123456',
        session_timeout: float = 600,
    ) -> None:
        self.base_url = base_url.rstrip('/')
        self.workers_dir = pathlib.Path(workers_dir)
        self.admin_user = admin_user
        self.admin_password = admin_password
        self.session_timeout = session_timeout
        self._sessions: dict[str, Session] = {}
        self._csrf: dict[int, str] = {}
        self._db: LocalD1 | None = None

    # ---------------------------------------------------------------- 基础设施

    @property
    def db(self) -> LocalD1:
        if self._db is None:
            self._db = LocalD1(self.workers_dir)
        return self._db

    def new_session(self, timeout: float | None = None) -> Session:
        return Session(self.base_url, timeout=timeout or self.session_timeout)

    def session(self, key: str) -> Session:
        """按 key 复用已登录会话（避免重复登录触发认证限流）"""
        if key not in self._sessions:
            raise VerifyError(f'尚未登录：{key}')
        return self._sessions[key]

    def csrf(self, s: Session) -> str:
        cached = self._csrf.get(id(s))
        if cached:
            return cached
        status, data = s.json_request('GET', '/api/auth/csrf-token')
        if status != 200 or not data.get('success'):
            raise VerifyError(f'获取 CSRF 失败（{status}）：{data}')
        token = data['data']['token']
        self._csrf[id(s)] = token
        return token

    def h(self, s: Session, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {'X-CSRF-Token': self.csrf(s), **(extra or {})}

    def login(self, username: str, password: str, *, key: str | None = None, attempts: int = 4) -> Session:
        if key and key in self._sessions:
            return self._sessions[key]
        last = ''
        for attempt in range(attempts):
            s = self.new_session()
            status, data = s.json_request('POST', '/api/auth/login', {'username': username, 'password': password})
            if status == 200 and data.get('success'):
                if key:
                    self._sessions[key] = s
                return s
            last = f'{status} {json.dumps(data, ensure_ascii=False)[:200]}'
            if status == 429:
                time.sleep(12)  # 认证限流窗口
                continue
            break
        raise VerifyError(f'登录 {username} 失败：{last}')

    def admin(self) -> Session:
        return self.login(self.admin_user, self.admin_password, key='__admin__')

    def ensure_ready(self) -> None:
        status, data = self.new_session(timeout=15).json_request('GET', '/api/public/health/ready')
        if status != 200 or not data.get('ready'):
            raise VerifyError(f'服务未就绪（{status}）：{data}')

    # ---------------------------------------------------------------- 认证 / 用户

    def register(self, username: str, password: str, email: str | None = None) -> dict:
        s = self.new_session()
        status, data = s.json_request(
            'POST',
            '/api/auth/register',
            {'username': username, 'password': password, 'email': email or f'{username}@lab.test'},
        )
        if status not in (200, 201) or not data.get('success'):
            raise VerifyError(f'注册 {username} 失败（{status}）：{data}')
        return data['data']['user']

    def list_users(self, search: str | None = None, limit: int = 100) -> list[dict]:
        q = f'?limit={limit}' + (f'&search={search}' if search else '')
        status, data = self.admin().json_request('GET', f'/api/admin/users{q}')
        if status != 200:
            raise VerifyError(f'列出用户失败（{status}）：{data}')
        return data['data']['users']

    def find_user(self, username: str) -> dict | None:
        return next((u for u in self.list_users(search=username) if u['username'] == username), None)

    def admin_update_user(self, user_id: str, **fields) -> dict:
        status, data = self.admin().json_request('PUT', f'/api/admin/users/{user_id}', fields, headers=self.h(self.admin()))
        if status != 200:
            raise VerifyError(f'更新用户 {user_id} 失败（{status}）：{data}')
        return data

    def ensure_user(
        self,
        username: str,
        password: str = 'labpass123456',
        *,
        role: str = 'user',
        default_path: str | None = None,
        capabilities: list[str] | None = None,
        max_storage: int | None = None,
        max_files: int | None = None,
        permissions: list[str] | None = None,
    ) -> dict:
        """注册（若不存在）并把角色/能力/默认路径对齐到目标状态。

        注册是唯一的建号入口（管理端无 create-user）；角色或状态变更会 bump sessionVersion，
        因此本方法在更新后不缓存会话，调用方需重新 login。
        """
        user = self.find_user(username)
        if user is None:
            user = self.register(username, password)
        fields: dict = {
            'role': role,
            'status': 'active',
            'defaultPath': default_path if default_path is not None else f'/users/{username}',
            'capabilities': capabilities if capabilities is not None else ['can_share', 'can_publish', 'can_grant'],
        }
        if max_storage is not None:
            fields['maxStorage'] = max_storage
        if max_files is not None:
            fields['maxFiles'] = max_files
        if permissions is not None:
            fields['permissions'] = permissions
        self.admin_update_user(user['id'], **fields)
        fresh = self.find_user(username)
        if fresh is None:
            raise VerifyError(f'用户 {username} 创建后不可见')
        return fresh

    def delete_user(self, user_id: str) -> None:
        status, data = self.admin().json_request('DELETE', f'/api/admin/users/{user_id}', headers=self.h(self.admin()))
        if status != 200:
            raise VerifyError(f'删除用户失败（{status}）：{data}')
        self._sessions.pop('__admin__', None)  # 会话仍然有效，仅清理缓存键

    def me_settings(self, s: Session) -> dict:
        status, data = s.json_request('GET', '/api/users/me/settings')
        if status != 200:
            raise VerifyError(f'读取我的设置失败（{status}）：{data}')
        return data['data']

    def my_capabilities(self, s: Session) -> list[str]:
        return list(self.me_settings(s)['profile'].get('capabilities') or [])

    # ---------------------------------------------------------------- 存储提供商 / 挂载点

    def list_providers(self) -> list[dict]:
        status, data = self.admin().json_request('GET', '/api/admin/storage/providers')
        if status != 200:
            raise VerifyError(f'列出 provider 失败（{status}）：{data}')
        return data['data']['providers']

    def find_provider(self, name: str) -> dict | None:
        return next((p for p in self.list_providers() if p['name'] == name), None)

    def ensure_provider(
        self,
        name: str,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        *,
        region: str = 'us-east-1',
        path_prefix: str = '',
        public_domain: str | None = None,
    ) -> dict:
        existing = self.find_provider(name)
        if existing:
            return existing
        body = {
            'name': name,
            'endpoint': endpoint,
            'region': region,
            'bucket': bucket,
            'accessKeyId': access_key,
            'secretAccessKey': secret_key,
            'pathPrefix': path_prefix,
        }
        if public_domain:
            body['publicDomain'] = public_domain
        status, data = self.admin().json_request('POST', '/api/admin/storage/providers', body, headers=self.h(self.admin()))
        if status != 201:
            raise VerifyError(f'创建 provider {name} 失败（{status}）：{data}')
        pid = data['data']['provider']['id']
        found = next((p for p in self.list_providers() if p['id'] == pid), None)
        return found or {'id': pid, 'name': name}

    def test_provider(self, provider_id: str) -> tuple[int, dict]:
        return self.admin().json_request(
            'POST', f'/api/admin/storage/providers/{provider_id}/test', None, headers=self.h(self.admin())
        )

    def delete_provider(self, provider_id: str) -> tuple[int, dict]:
        return self.admin().json_request(
            'DELETE', f'/api/admin/storage/providers/{provider_id}', headers=self.h(self.admin())
        )

    def update_provider(self, provider_id: str, **fields) -> tuple[int, dict]:
        return self.admin().json_request(
            'PUT', f'/api/admin/storage/providers/{provider_id}', fields, headers=self.h(self.admin())
        )

    def list_mounts(self) -> list[dict]:
        status, data = self.admin().json_request('GET', '/api/admin/mounts')
        if status != 200:
            raise VerifyError(f'列出挂载点失败（{status}）：{data}')
        return data['data']['mounts']

    def find_mount(self, mount_path: str) -> dict | None:
        return next((m for m in self.list_mounts() if m['mountPath'] == mount_path), None)

    def create_mount(self, body: dict) -> tuple[int, dict]:
        return self.admin().json_request('POST', '/api/admin/mounts', body, headers=self.h(self.admin()))

    def patch_mount(self, mount_id: str, body: dict) -> tuple[int, dict]:
        return self.admin().json_request('PATCH', f'/api/admin/mounts/{mount_id}', body, headers=self.h(self.admin()))

    def delete_mount(self, mount_id: str) -> tuple[int, dict]:
        return self.admin().json_request('DELETE', f'/api/admin/mounts/{mount_id}', headers=self.h(self.admin()))

    def ensure_mount(self, body: dict) -> dict:
        """按 mountPath 幂等：存在则 PATCH 到目标状态（poolMembers/rolePermissions 全量替换）。"""
        existing = self.find_mount(body['mountPath'])
        if existing is None:
            status, data = self.create_mount(body)
            if status != 201:
                raise VerifyError(f"创建挂载点 {body['mountPath']} 失败（{status}）：{data}")
            existing = self.find_mount(body['mountPath'])
            if existing is None:
                raise VerifyError(f"挂载点 {body['mountPath']} 创建后不可见")
            return existing
        patch = {k: v for k, v in body.items() if k not in ('mountPath',)}
        status, data = self.patch_mount(existing['id'], patch)
        if status != 200:
            raise VerifyError(f"更新挂载点 {body['mountPath']} 失败（{status}）：{data}")
        fresh = self.find_mount(body['mountPath'])
        if fresh is None:
            raise VerifyError(f"挂载点 {body['mountPath']} 更新后不可见")
        return fresh

    def set_settings(self, **fields) -> dict:
        status, data = self.admin().json_request('PATCH', '/api/admin/settings', fields, headers=self.h(self.admin()))
        if status != 200:
            raise VerifyError(f'更新系统设置失败（{status}）：{data}')
        return data.get('data') or {}

    def try_settings(self, **fields) -> tuple[int, dict]:
        """不抛异常的设置更新（负向用例用）"""
        return self.admin().json_request('PATCH', '/api/admin/settings', fields, headers=self.h(self.admin()))

    def get_settings(self) -> dict:
        status, data = self.admin().json_request('GET', '/api/admin/settings')
        if status != 200:
            raise VerifyError(f'读取系统设置失败（{status}）：{data}')
        return data['data']

    def admin_put_user_raw(self, user_id: str, body: dict) -> tuple[int, dict]:
        return self.admin().json_request('PUT', f'/api/admin/users/{user_id}', body, headers=self.h(self.admin()))

    def admin_rule(self, body: dict) -> tuple[int, dict]:
        return self.admin().json_request('POST', '/api/admin/rules', body, headers=self.h(self.admin()))

    # ---------------------------------------------------------------- 文件

    def list_files(self, s: Session, path: str = '/', **query) -> dict:
        qs = '&'.join(f'{k}={v}' for k, v in query.items())
        url = f'/api/files?path={path}' + (f'&{qs}' if qs else '')
        status, data = s.json_request('GET', url)
        if status != 200:
            raise VerifyError(f'列出 {path} 失败（{status}）：{data}')
        return data['data']

    def items(self, s: Session, path: str = '/') -> list[dict]:
        return self.list_files(s, path).get('items') or []

    def find_item(self, s: Session, path: str, name: str) -> dict | None:
        return next((i for i in self.items(s, path) if i['name'] == name), None)

    def file_id(self, s: Session, path: str, name: str) -> str:
        item = self.find_item(s, path, name)
        if item is None:
            raise VerifyError(f'{path}/{name} 不存在（或当前主体不可见）')
        return item['id']

    def tree(self, s: Session, path: str = '/') -> dict:
        status, data = s.json_request('GET', f'/api/files/tree?path={path}')
        if status != 200:
            raise VerifyError(f'读取文件树失败（{status}）：{data}')
        return data['data']

    def mkdir(self, s: Session, path: str, name: str) -> tuple[int, dict]:
        return s.json_request('POST', '/api/files/folder', {'path': path, 'name': name}, headers=self.h(s))

    def upload(self, s: Session, path: str, filename: str, content: bytes, mime: str | None = None) -> dict:
        """单文件上传（≤100 MiB）：自动适配预签名直传 / Worker 代理两种模式。"""
        if len(content) > MULTIPART_THRESHOLD:
            raise VerifyError('upload() 只处理 ≤100 MiB；大文件用 upload_large()')
        mime = mime or guess_mime(filename)
        headers = self.h(s)
        status, data = s.json_request(
            'POST',
            '/api/files/upload-session',
            {'path': path, 'fileName': filename, 'fileSize': len(content), 'mimeType': mime},
            headers=headers,
        )
        if status != 200:
            raise VerifyError(f'创建上传会话失败（{status}）：{data}')
        sess = data['data']
        if sess.get('alreadyCompleted'):
            return {'alreadyCompleted': True, **sess}
        etag = ''
        if sess.get('uploadUrl'):
            st, resp_headers = s.presigned_put(sess['uploadUrl'], content, mime)
            if st not in (200, 201):
                raise VerifyError(f'预签名直传失败（{st}）')
            etag = resp_headers.get('ETag') or resp_headers.get('Etag') or ''
        else:
            st, raw, _ = s.request(
                'PUT', f"/api/files/upload/raw/{sess['sessionId']}", body=content,
                headers={'Content-Type': mime, **headers},
            )
            if st not in (200, 201):
                raise VerifyError(f'Worker 代理上传失败（{st}）：{raw[:200]!r}')
            etag = (json.loads(raw).get('data') or {}).get('etag') or ''
        st, done = s.json_request(
            'POST', '/api/files/upload-complete', {'sessionId': sess['sessionId'], 'etag': etag}, headers=headers
        )
        if st != 200:
            raise VerifyError(f'完成上传失败（{st}）：{done}')
        return done['data']

    def upload_local(self, s: Session, path: str, local_path: pathlib.Path, *, filename: str | None = None, mime: str | None = None) -> dict:
        """从本地文件上传：≤100 MiB 走单对象，>100 MiB 走 8 MiB 分片（与应用阈值一致）。"""
        size = local_path.stat().st_size
        name = filename or local_path.name
        mime = mime or guess_mime(name)
        if size <= MULTIPART_THRESHOLD:
            return self.upload(s, path, name, local_path.read_bytes(), mime)
        return self.upload_multipart(s, path, name, local_path, mime)

    def upload_multipart(self, s: Session, path: str, filename: str, local_path: pathlib.Path, mime: str | None = None) -> dict:
        """分片上传：按会话下发的模式自动选择通道。

        · 服务端下发完整预签名分片 URL（S3 provider）→ 逐片直传对象存储，最后带上 parts 完成；
        · 未下发（R2 绑定等 Worker 代理 provider）→ 逐片 PUT Worker 分片端点，完成时无需 parts。

        两条通道都是生产路径（08 套件分别做过对照），这里只做派发，避免调用方关心提供商能力。
        """
        size = local_path.stat().st_size
        mime = mime or guess_mime(filename)
        headers = self.h(s)
        status, data = s.json_request(
            'POST',
            '/api/files/upload-session',
            {'path': path, 'fileName': filename, 'fileSize': size, 'mimeType': mime},
            headers=headers,
        )
        if status != 200:
            raise VerifyError(f'创建分片上传会话失败（{status}）：{data}')
        sess = data['data']
        total = sess.get('totalParts') or 0
        parts = sess.get('parts') or []
        if not total:
            raise VerifyError(f'分片会话缺少 totalParts：{sess}')
        if parts and len(parts) == total:
            completed: list[dict] = []
            with local_path.open('rb') as fh:
                for part in parts:
                    chunk = fh.read(PART_SIZE)
                    st, resp_headers = s.presigned_put(part['url'], chunk, mime, timeout=900)
                    if st not in (200, 201):
                        raise VerifyError(f"分片 {part['partNumber']} 直传失败（{st}）")
                    etag = resp_headers.get('ETag') or resp_headers.get('Etag') or ''
                    completed.append({'partNumber': part['partNumber'], 'etag': etag})
            st, done = s.json_request(
                'POST', '/api/files/upload-complete',
                {'sessionId': sess['sessionId'], 'parts': completed}, headers=headers,
            )
        else:
            with local_path.open('rb') as fh:
                for part_number in range(1, total + 1):
                    fh.seek((part_number - 1) * PART_SIZE)
                    chunk = fh.read(PART_SIZE)
                    st, raw, _ = s.request(
                        'PUT', f"/api/files/upload/multipart/{sess['sessionId']}/part/{part_number}",
                        body=chunk, headers={'Content-Type': 'application/octet-stream', **headers},
                    )
                    if st != 200:
                        raise VerifyError(f'分片 {part_number} 上传失败（{st}）：{raw[:200]!r}')
            st, done = s.json_request('POST', '/api/files/upload-complete',
                                      {'sessionId': sess['sessionId']}, headers=headers)
        if st != 200:
            raise VerifyError(f'分片完成失败（{st}）：{done}')
        return done['data']

    def parts_of(self, s: Session, session_id: str) -> dict:
        status, data = s.json_request('GET', f'/api/files/upload/multipart/{session_id}/parts')
        if status != 200:
            raise VerifyError(f'读取分片清单失败（{status}）：{data}')
        return data['data']

    def upload_multipart_worker(self, s: Session, path: str, filename: str, local_path: pathlib.Path,
                                mime: str | None = None, parts_to_upload: list[int] | None = None) -> dict:
        """Worker 代理分片上传（提供商不支持预签名分片时，如 R2 绑定）：

        会话 → 逐片 PUT /api/files/upload/multipart/:id/part/:n → 完成。
        `parts_to_upload` 只上传指定分片，用于验证断点续传契约。
        """
        size = local_path.stat().st_size
        mime = mime or guess_mime(filename)
        headers = self.h(s)
        status, data = s.json_request(
            'POST', '/api/files/upload-session',
            {'path': path, 'fileName': filename, 'fileSize': size, 'mimeType': mime}, headers=headers,
        )
        if status != 200:
            raise VerifyError(f'创建分片上传会话失败（{status}）：{data}')
        sess = data['data']
        if sess.get('uploadMode') != 'worker' or not sess.get('totalParts'):
            raise VerifyError(f'期望 Worker 分片会话，实际 {sess.get("uploadMode")} totalParts={sess.get("totalParts")}')
        total = sess['totalParts']
        wanted = parts_to_upload or list(range(1, total + 1))
        with local_path.open('rb') as fh:
            for part_number in wanted:
                fh.seek((part_number - 1) * PART_SIZE)
                chunk = fh.read(PART_SIZE)
                st, raw, _ = s.request(
                    'PUT', f"/api/files/upload/multipart/{sess['sessionId']}/part/{part_number}",
                    body=chunk, headers={'Content-Type': 'application/octet-stream', **headers},
                )
                if st != 200:
                    raise VerifyError(f'分片 {part_number} 上传失败（{st}）：{raw[:200]!r}')
        st, done = s.json_request('POST', '/api/files/upload-complete', {'sessionId': sess['sessionId']}, headers=headers)
        if st != 200:
            raise VerifyError(f'分片完成失败（{st}）：{done}')
        return done['data']

    def update_file(self, s: Session, file_id: str, **fields) -> tuple[int, dict]:
        return s.json_request('PUT', f'/api/files/{file_id}', fields, headers=self.h(s))

    def delete_file(self, s: Session, file_id: str) -> tuple[int, dict]:
        return s.json_request('DELETE', f'/api/files/{file_id}', headers=self.h(s))

    def batch(self, s: Session, action: str, file_ids: list[str], **extra) -> tuple[int, dict]:
        return s.json_request(
            'POST', '/api/files/batch', {'action': action, 'fileIds': file_ids, **extra}, headers=self.h(s)
        )

    def move(self, s: Session, file_id: str, target_path: str, new_name: str | None = None) -> tuple[int, dict]:
        body = {'targetPath': target_path}
        if new_name:
            body['newName'] = new_name
        return s.json_request('POST', f'/api/files/{file_id}/move', body, headers=self.h(s))

    def file_detail(self, s: Session, file_id: str) -> tuple[int, dict]:
        return s.json_request('GET', f'/api/files/{file_id}')

    def purge_dir(self, s: Session, path: str, *, keep: set[str] | None = None) -> int:
        """递归清空目录（删除其中每个条目；目录删除级联后代）。返回删除成功的条目数。"""
        keep = keep or set()
        removed = 0
        for item in self.items(s, path):
            if item['name'] in keep:
                continue
            status, _ = self.delete_file(s, item['id'])
            if status == 200:
                removed += 1
        return removed

    def download_url(self, s: Session, file_id: str) -> tuple[int, dict]:
        return s.json_request('GET', f'/api/files/{file_id}/download')

    def verify_password(self, s: Session, file_id: str, password: str) -> tuple[int, dict]:
        return s.json_request('POST', f'/api/files/{file_id}/verify-password', {'password': password}, headers=self.h(s))

    def copy_links(self, s: Session, file_id: str, *, signed: bool = False, expires_in: int | None = None) -> tuple[int, dict]:
        qs = f'?signed={"true" if signed else "false"}'
        if expires_in:
            qs += f'&expiresIn={expires_in}'
        return s.json_request('GET', f'/api/files/{file_id}/copy-links{qs}')

    # ---------------------------------------------------------------- 分享 / 网关

    def create_share(self, s: Session, file_ids: list[str], **opts) -> tuple[int, dict]:
        return s.json_request('POST', '/api/shares', {'fileIds': file_ids, **opts}, headers=self.h(s))

    def list_shares(self, s: Session, **query) -> dict:
        qs = '&'.join(f'{k}={v}' for k, v in query.items())
        status, data = s.json_request('GET', f'/api/shares{f"?{qs}" if qs else ""}')
        if status != 200:
            raise VerifyError(f'列出分享失败（{status}）：{data}')
        return data['data']

    def share_detail(self, s: Session, share_id: str, password: str | None = None) -> tuple[int, dict]:
        qs = f'?password={password}' if password else ''
        return s.json_request('GET', f'/api/shares/{share_id}{qs}')

    def share_verify(self, s: Session, share_id: str, password: str) -> tuple[int, dict]:
        return s.json_request('POST', f'/api/shares/{share_id}/verify', {'password': password})

    def share_verify_file(self, s: Session, share_id: str, item_id: str, password: str) -> tuple[int, dict]:
        return s.json_request('POST', f'/api/shares/{share_id}/verify-file', {'itemId': item_id, 'password': password})

    def share_list_dir(self, s: Session, share_id: str, root: str, sub: str = '/') -> tuple[int, dict]:
        return s.json_request('GET', f'/api/shares/{share_id}/list?root={root}&sub={sub}')

    def share_download(self, s: Session, share_id: str, item_id: str | None = None) -> tuple[int, dict]:
        qs = f'?itemId={item_id}' if item_id else ''
        return s.json_request('GET', f'/api/shares/{share_id}/download{qs}')

    def share_preview(self, s: Session, share_id: str, item_id: str | None = None) -> tuple[int, bytes, dict[str, str]]:
        qs = f'?itemId={item_id}' if item_id else ''
        return s.get_bytes(f'/api/shares/{share_id}/preview{qs}')

    def revoke_share(self, s: Session, share_id: str) -> tuple[int, dict]:
        return s.json_request('DELETE', f'/api/shares/{share_id}', headers=self.h(s))

    def gateway_fetch(self, s: Session, url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes, dict[str, str]]:
        return s.get_bytes(url, headers=headers)

    # ---------------------------------------------------------------- 公开面 / 用户规则 / 密钥

    def public_settings(self, s: Session | None = None) -> dict:
        s = s or self.new_session()
        status, data = s.json_request('GET', '/api/public/settings')
        if status != 200:
            raise VerifyError(f'读取公开设置失败（{status}）：{data}')
        return data

    def public_fs(self, s: Session, path: str = '/') -> tuple[int, dict]:
        return s.json_request('GET', f'/api/public/fs?path={path}')

    def gallery(self, s: Session, **query) -> tuple[int, dict]:
        qs = '&'.join(f'{k}={v}' for k, v in query.items())
        return s.json_request('GET', f'/api/gallery{f"?{qs}" if qs else ""}')

    def any_browse(self, path: str = '/') -> tuple[int, bytes, dict[str, str]]:
        """匿名直链访问（path-serve 面）"""
        return self.new_session().get_bytes(f'/{path.lstrip("/")}')

    def user_rule(self, s: Session, body: dict) -> tuple[int, dict]:
        return s.json_request('POST', '/api/users/rules', body, headers=self.h(s))

    def list_user_rules(self, s: Session) -> list[dict]:
        status, data = s.json_request('GET', '/api/users/rules')
        if status != 200:
            raise VerifyError(f'列出用户规则失败（{status}）：{data}')
        return data['data']['rules']

    def delete_user_rule(self, s: Session, rule_id: str) -> tuple[int, dict]:
        return s.json_request('DELETE', f'/api/users/rules/{rule_id}', headers=self.h(s))

    def create_key(self, s: Session, name: str, permissions: list[str], protocols: list[str], **opts) -> dict:
        status, data = s.json_request(
            'POST',
            '/api/keys',
            {'name': name, 'permissions': permissions, 'protocols': protocols, **opts},
            headers=self.h(s),
        )
        if status != 201:
            raise VerifyError(f'创建 API 密钥失败（{status}）：{data}')
        payload = data['data']
        # 【契约不一致】POST /api/keys 返回的 key.id 实际是 keyId（pk_…），而 DELETE /api/keys/:id
        # 需要数据库行 id —— 因此这里回查列表补上真实行 id，供撤销使用。
        row = next((k for k in self.list_keys(s) if k['keyId'] == payload['key']['keyId']), None)
        payload['rowId'] = (row or {}).get('id')
        return payload

    def list_keys(self, s: Session) -> list[dict]:
        status, data = s.json_request('GET', '/api/keys')
        if status != 200:
            raise VerifyError(f'列出 API 密钥失败（{status}）：{data}')
        return data['data']['keys']

    def delete_key(self, s: Session, key_ref: str) -> tuple[int, dict]:
        """key_ref 可为数据库行 id 或 pk_ keyId（后者先解析为行 id）"""
        target = key_ref
        if key_ref.startswith('pk_'):
            row = next((k for k in self.list_keys(s) if k['keyId'] == key_ref), None)
            if row is None:
                return 404, {'error': {'code': 'NOT_FOUND', 'message': '密钥不存在'}}
            target = row['id']
        return s.json_request('DELETE', f'/api/keys/{target}', headers=self.h(s))

    def purge_keys(self, s: Session) -> int:
        rows = [k for k in self.list_keys(s) if k['name'].startswith('lab-') or k['name'].startswith('probe-')]
        for row in rows:
            self.delete_key(s, row['id'])
        return len(rows)

    # ---------------------------------------------------------------- 管理端观察面

    def dashboard(self) -> dict:
        status, data = self.admin().json_request('GET', '/api/admin/dashboard')
        if status != 200:
            raise VerifyError(f'读取仪表盘失败（{status}）：{data}')
        return data['data']

    def admin_mount_tree(self) -> dict:
        status, data = self.admin().json_request('GET', '/api/admin/mount-tree')
        if status != 200:
            raise VerifyError(f'读取挂载点树失败（{status}）：{data}')
        return data['data']

    def admin_files(self, **query) -> dict:
        qs = '&'.join(f'{k}={v}' for k, v in query.items())
        status, data = self.admin().json_request('GET', f'/api/admin/files{f"?{qs}" if qs else ""}')
        if status != 200:
            raise VerifyError(f'读取全部文件失败（{status}）：{data}')
        return data['data']

    def admin_logs(self, **query) -> dict:
        qs = '&'.join(f'{k}={v}' for k, v in query.items())
        status, data = self.admin().json_request('GET', f'/api/admin/logs{f"?{qs}" if qs else ""}')
        if status != 200:
            raise VerifyError(f'读取日志失败（{status}）：{data}')
        return data['data']

    def admin_shares(self, **query) -> dict:
        qs = '&'.join(f'{k}={v}' for k, v in query.items())
        status, data = self.admin().json_request('GET', f'/api/admin/shares{f"?{qs}" if qs else ""}')
        if status != 200:
            raise VerifyError(f'读取分享管理失败（{status}）：{data}')
        return data['data']

    def ban_file(self, file_id: str, banned: bool) -> tuple[int, dict]:
        return self.admin().json_request(
            'PUT', f'/api/admin/files/{file_id}/ban', {'banned': banned}, headers=self.h(self.admin())
        )

    def review_file(self, file_id: str, **fields) -> tuple[int, dict]:
        return self.admin().json_request(
            'PATCH', f'/api/admin/files/{file_id}/review', fields, headers=self.h(self.admin())
        )

    def list_roles(self) -> list[dict]:
        status, data = self.admin().json_request('GET', '/api/admin/roles')
        if status != 200:
            raise VerifyError(f'列出角色失败（{status}）：{data}')
        return data['data']['roles']

    def set_role_defaults(self, role: str, body: dict) -> tuple[int, dict]:
        return self.admin().json_request(
            'PUT', f'/api/admin/roles/{role}/defaults', body, headers=self.h(self.admin())
        )

    # ---------------------------------------------------------------- 组合断言工具

    def mount_of(self, s: Session, path: str) -> str | None:
        """从列表响应读出路径所属挂载点 id（游标：/ 与 /public 分别是不同挂载）"""
        status, data = s.json_request('GET', f'/api/files?path={path}')
        if status != 200:
            return None
        mount = data['data'].get('mount') or {}
        return mount.get('id')

    def provider_name_map(self) -> dict[str, str]:
        return {p['id']: p['name'] for p in self.list_providers()}

    def file_provider(self, mount_id: str, file_path: str, name: str) -> str | None:
        row = self.db.one(
            'SELECT provider_id FROM file_metadata WHERE mount_id=? AND path=? AND name=?', (mount_id, file_path, name)
        )
        return (row or {}).get('provider_id')

    def file_row(self, mount_id: str, file_path: str, name: str) -> dict | None:
        return self.db.one(
            'SELECT id, provider_id, physical_key, object_key, blob_hash, size, visibility, '
            'owner_id, path, name, type FROM file_metadata WHERE mount_id=? AND path=? AND name=?',
            (mount_id, file_path, name),
        )

    def physical_key_of(self, mount_id: str, file_path: str, name: str) -> str | None:
        row = self.file_row(mount_id, file_path, name)
        if row is None:
            return None
        return row.get('physical_key') or row.get('object_key')
