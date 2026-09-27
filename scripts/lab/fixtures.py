"""实验室拓扑夹具：A/B/C/D 桶、根挂载池、/public 挂载点、测试用户。

拓扑（对应用户需求）：
  A  根路径 `/` 主桶
  B  根路径副桶（standby=true，只作读回退：A 读取失败时向 B 请求）
  C  挂载到 `/public`，flat 模式，面向普通用户上传（不同角色权限）
  D  根路径拼好桶：与 A 同为可写池成员，由 poolStrategy 算法决定每个文件落 A 还是 D

幂等：`setup()` 可重复执行；已存在的 provider / mount / user 会被对齐到目标状态。
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import LocalDb, Reporter, S3, VerifyError  # noqa: E402

from _lab import Lab  # noqa: E402

import time  # noqa: E402
import uuid  # noqa: E402

BUCKET = 'picumet'
ACCESS_KEY = 'minioadmin'
SECRET_KEY = 'minioadmin'
REGION = 'us-east-1'

S3_ENDPOINTS = {
    'A': 'http://127.0.0.1:9000',
    'B': 'http://127.0.0.1:9002',
    'C': 'http://127.0.0.1:9004',
    'D': 'http://127.0.0.1:9006',
}
PROVIDER_NAMES = {k: f'lab-bucket-{k}' for k in S3_ENDPOINTS}

ROOT_PRIORITY = 100
PUBLIC_PRIORITY = 1000
PUBLIC_MOUNT_PATH = '/public'
# 内容寻址（§F）只在 Worker 代理写入路径生效：预签名直传/分片写的是虚拟路径键。
# 因此用一个 R2 绑定提供商挂载 /dedup，作为「服务端落盘」对照组。
BINDING_PROVIDER_NAME = 'lab-binding-r2'
DEDUP_MOUNT_PATH = '/dedup'
DEDUP_PRIORITY = 500

USER_PASSWORD = 'labpass123456'
# 权限判定链第 3 步（用户根路径边界）先于两级矩阵：defaultPath 之外的 private 内容一律 deny，
# 且**写入类永不豁免**（审计 PERM-01 修复后的隔离语义）。因此：
#   alice/bob  → defaultPath='/'     共享命名空间模式（seed 默认），可写 /public 等共享区，
#                                    角色区分由 /public 的挂载级矩阵表达
#   carol      → defaultPath='/public' 「公共上传者」配置：只能在 /public 内读写
#   isolated   → defaultPath='/users/labisolated' 隔离模式对照组（验证边界语义）
TEST_USERS = {
    # permissions 为「用户个别默认权限矩阵」：不含 share，则**非属主**对他人文件的分享被第 9 步拒绝
    # （属主回退在第 7 步，属主仍可分享/改名/删除自己的文件）——正好实现「其他人只能下载」。
    'alice': {'username': 'labalice', 'default_path': '/', 'permissions': ['read', 'write', 'update', 'delete', 'download']},
    'bob': {'username': 'labbob', 'default_path': '/', 'permissions': ['read', 'write', 'update', 'delete', 'download']},
    'carol': {'username': 'labcarol', 'default_path': PUBLIC_MOUNT_PATH, 'permissions': ['read', 'write', 'download']},
    'isolated': {'username': 'labisolated', 'default_path': '/users/labisolated', 'permissions': ['read', 'write', 'update', 'delete', 'download']},
}

# 长期保留的样本目录（用户要求：示例图片/视频/ISO 留在对象存储供后续开发测试使用）。
# 00_setup 的「清空根目录」与各套件的清理都必须跳过它们，否则每次重建拓扑都会把样本删掉。
PRESERVED_ROOT_DIRS = {'samples', 'bulk'}

# 每个桶一个直连客户端（应用 API 看不到「对象落在哪个桶」，容灾/拼好桶必须直连核对）
_S3_CACHE: dict[str, S3] = {}


def s3(name: str) -> S3:
    if name not in _S3_CACHE:
        _S3_CACHE[name] = S3(S3_ENDPOINTS[name], ACCESS_KEY, SECRET_KEY, REGION)
    return _S3_CACHE[name]


def all_buckets() -> dict[str, S3]:
    return {k: s3(k) for k in S3_ENDPOINTS}


def seed_provider_direct(
    lab: Lab,
    name: str,
    endpoint: str,
    *,
    bucket: str = BUCKET,
    access_key: str = ACCESS_KEY,
    secret_key: str = SECRET_KEY,
    region: str = REGION,
    path_prefix: str = '',
) -> dict:
    """在 DB 层写入存储提供商行。

    管理端创建路径会执行 `validateEndpoint`（SSRF 防护）：拒绝回环/私网/保留地址，且端口只允许
    80/443。本地实验室的 S3 实例跑在 127.0.0.1:9000–9006，因此**无法**经管理端配置——
    这正是防护生效的证据，由 `assert_endpoint_guard()` 单独做负向断言。
    实验室改为写入等价的数据行（读取侧 `services/storage/providers.ts` 仅在值为 `enc:` 前缀时
    解密，明文原样使用，故明文凭据可用，仅限本地）。
    """
    existing = lab.find_provider(name)
    if existing:
        return existing
    pid = str(uuid.uuid4())
    now = int(time.time() * 1000)
    sql = (
        'INSERT INTO storage_providers '
        '(id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, public_domain, path_prefix, created_at, updated_at, status) '
        f"VALUES ('{pid}', '{name}', 's3', '{endpoint}', '{region}', '{bucket}', '{access_key}', '{secret_key}', NULL, '{path_prefix}', {now}, {now}, 'active')"
    )
    LocalDb(lab.workers_dir).exec(sql)
    found = lab.find_provider(name)
    if found is None:
        raise VerifyError(f'直写 provider {name} 后不可见')
    return found


def assert_endpoint_guard(lab: Lab, reporter: Reporter) -> None:
    """负向断言：存储端点 SSRF 校验必须拒绝回环/私网/保留地址、非 80/443 端口、内嵌凭据。

    对应审计 SEC-02（更新路径复用校验）与 SEC-12（publicDomain 拒私网）。
    """
    cases: list[tuple[str, str]] = [
        ('http://127.0.0.1:9000', '回环 IPv4 + 非标端口'),
        ('http://localhost:9000', 'localhost 主机名'),
        ('http://10.0.0.5', '私网 10/8'),
        ('http://192.168.1.10', '私网 192.168/16'),
        ('http://172.20.0.9', '私网 172.16/12'),
        ('http://169.254.169.254', '链路本地/云元数据'),
        ('http://100.64.0.1', 'CGNAT 100.64/10'),
        ('https://example.com:8080', '合法主机但非 80/443 端口'),
        ('https://user:pass@example.com', 'URL 内嵌凭据'),
        ('http://[::1]:80', 'IPv6 回环'),
    ]
    for endpoint, label in cases:
        status, data = lab.admin().json_request(
            'POST',
            '/api/admin/storage/providers',
            {'name': f'guard-{uuid.uuid4().hex[:8]}', 'endpoint': endpoint, 'bucket': 'x', 'accessKeyId': 'k', 'secretAccessKey': 's'},
            headers=lab.h(lab.admin()),
        )
        reporter.check(status == 400, f'SSRF 校验拒绝：{label}（{endpoint}）', f'{status} {data}')


def _delete_all_at_root(lab: Lab) -> tuple[int, list[str]]:
    """清掉种子演示数据；挂载点目录行受保护（409），样本目录按约定跳过。"""
    admin = lab.admin()
    items = lab.items(admin, '/')
    deleted, skipped = 0, []
    for item in items:
        if item['name'] in PRESERVED_ROOT_DIRS:
            skipped.append(f"{item['name']}:preserved")
            continue
        status, data = lab.delete_file(admin, item['id'])
        if status == 200:
            deleted += 1
        else:
            skipped.append(f"{item['name']}:{status}:{(data.get('error') or {}).get('code')}")
    return deleted, skipped


def setup(lab: Lab, reporter: Reporter, *, pool_strategy: str = 'least_used') -> dict:
    """把本地栈配置成目标 A/B/C/D 拓扑（幂等）。"""
    lab.ensure_ready()
    # 注意：SettingsSchema 是 zod 对象，未识别字段会被静默丢弃（含 snake_case 写法）——
    # PATCH /api/admin/settings 只接受 camelCase 字段名，且不报「未知字段」错误（见报告 F-08）。
    lab.set_settings(
        allowRegistration=True,
        allowGuestAccess=True,
        requireEmailVerification=False,
        rateLimitEnabled=True,
    )

    settings = lab.get_settings()
    reporter.check(settings.get('allowGuestAccess') is True, '系统设置：开放游客访问已生效', str(settings.get('allowGuestAccess')))
    reporter.check(settings.get('allowRegistration') is True, '系统设置：开放注册已生效')

    # ---- 四个 provider（S3 协议指向四个独立实例；DB 层写入，见 seed_provider_direct 说明）----
    providers: dict[str, dict] = {}
    for key in ('A', 'B', 'C', 'D'):
        providers[key] = seed_provider_direct(lab, PROVIDER_NAMES[key], S3_ENDPOINTS[key])
    reporter.check(len(providers) == 4, '创建 A/B/C/D 四个存储提供商')
    assert_endpoint_guard(lab, reporter)
    for key, prov in providers.items():
        status, data = lab.test_provider(prov['id'])
        reporter.check(status == 200, f'提供商 {key} 连通性测试通过', f'{status} {data}')

    # ---- 清掉种子演示数据，并剔除种子 R2 提供商 ----
    deleted, skipped = _delete_all_at_root(lab)
    reporter.note(f'清理根目录种子数据：删除 {deleted} 项', f'跳过 {skipped}' if skipped else '')

    root = lab.find_mount('/')
    if root is None:
        raise VerifyError('根挂载点不存在（seed 未完成？）')

    # ---- 根挂载点：A（主）+ D（拼好桶，可写）+ B（standby 副桶）----
    root_patch = {
        'providerId': providers['A']['id'],
        'priority': ROOT_PRIORITY,
        'poolStrategy': pool_strategy,
        'uploadMode': 'free',
        'poolMembers': [
            {'providerId': providers['A']['id'], 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': providers['D']['id'], 'weight': 1, 'sortOrder': 1, 'standby': False},
            {'providerId': providers['B']['id'], 'weight': 1, 'sortOrder': 2, 'standby': True},
        ],
        'rolePermissions': [],
    }
    status, data = lab.patch_mount(root['id'], root_patch)
    reporter.check(status == 200, '根挂载点池配置为 [A(主), D(拼好), B(副/standby)]', f'{status} {data}')
    root = lab.find_mount('/') or root
    members = {m['providerId']: m for m in root.get('poolMembers') or []}
    reporter.check(len(members) == 3, '根挂载点池成员数为 3', str(root.get('poolMembers')))
    if len(members) == 3:
        reporter.check(
            members[providers['B']['id']]['standby'] is True,
            'B 标记为 standby（不参与写入放置）',
            str(members[providers['B']['id']]),
        )
        reporter.check(
            members[providers['A']['id']]['standby'] is False and members[providers['D']['id']]['standby'] is False,
            'A 与 D 均为可写成员（拼好桶）',
        )

    # ---- /public 挂载点：flat 模式 + 区分角色的权限矩阵 ----
    public_body = {
        'providerId': providers['C']['id'],
        'mountPath': PUBLIC_MOUNT_PATH,
        'name': '公共空间',
        'priority': PUBLIC_PRIORITY,
        'uploadMode': 'flat',
        'poolStrategy': 'least_used',
        'poolMembers': [{'providerId': providers['C']['id'], 'weight': 1, 'standby': False}],
        'rolePermissions': [
            {'role': 'user', 'permissions': ['read', 'write', 'download']},
            {'role': 'guest', 'permissions': ['read', 'download']},
        ],
    }
    public = lab.ensure_mount(public_body)
    reporter.check(public.get('uploadMode') == 'flat', '/public 挂载点为 flat 模式（不允许文件夹）', str(public.get('uploadMode')))
    rp = {entry['role']: entry['permissions'] for entry in public.get('rolePermissions') or []}
    reporter.check(
        rp.get('user') == ['read', 'write', 'download'],
        '/public 普通用户矩阵 = read/write/download（无 update/delete）',
        str(rp),
    )
    reporter.check(rp.get('guest') == ['read', 'download'], '/public 游客矩阵 = read/download', str(rp))

    # ---- R2 绑定提供商 + /dedup 挂载点（内容寻址/去重/引用回收的对照组）----
    # 绑定模式（endpoint/AK/SK 全空）经管理端 API 创建，走 ProviderSchema 的「同填同空」分支校验。
    binding = lab.find_provider(BINDING_PROVIDER_NAME)
    if binding is None:
        st, resp = lab.admin().json_request(
            'POST',
            '/api/admin/storage/providers',
            {'name': BINDING_PROVIDER_NAME, 'bucket': 'picumet-lab-binding', 'region': 'auto'},
            headers=lab.h(lab.admin()),
        )
        reporter.check(st == 201, '绑定模式提供商（无 endpoint）可由管理端创建', f'{st} {resp}')
        binding = lab.find_provider(BINDING_PROVIDER_NAME)
    if binding is None:
        raise VerifyError('绑定模式提供商创建失败')
    dedup = lab.ensure_mount(
        {
            'providerId': binding['id'],
            'mountPath': DEDUP_MOUNT_PATH,
            'name': '内容寻址对照组',
            'priority': DEDUP_PRIORITY,
            'uploadMode': 'free',
            'poolMembers': [{'providerId': binding['id'], 'weight': 1, 'standby': False}],
            # 测试用户在 defaultPath 之外，需要显式矩阵授权（PERM-01 生效后的正确姿势）
            'rolePermissions': [{'role': 'user', 'permissions': ['read', 'write', 'update', 'delete', 'download']}],
        }
    )
    reporter.check(dedup.get('providerType', '') == 'r2' or binding.get('type') == 'r2', '/dedup 挂载在 R2 绑定提供商上（走 Worker 代理写入）')

    # ---- 测试用户（隔离默认路径，检查权限区分度）----
    users: dict[str, dict] = {}
    for key, spec in TEST_USERS.items():
        users[key] = lab.ensure_user(
            spec['username'], USER_PASSWORD, default_path=spec['default_path'], permissions=spec.get('permissions')
        )
        reporter.check(users[key]['defaultPath'] == spec['default_path'], f"用户 {spec['username']} defaultPath={spec['default_path']}")
        if spec.get('permissions') is not None:
            reporter.check(
                users[key].get('permissions') == spec['permissions'],
                f"用户 {spec['username']} 个别权限矩阵={spec['permissions']}",
                str(users[key].get('permissions')),
            )

    # 「公共上传者」配置验证：defaultPath=/public 的用户只能在 /public 内写入
    carol = lab.login(TEST_USERS['carol']['username'], USER_PASSWORD, key='labcarol')
    outside = f'outside-{uuid.uuid4().hex[:6]}.txt'
    st_out, out_body = carol.json_request(
        'POST', '/api/files/upload-session',
        {'path': '/', 'fileName': outside, 'fileSize': 8, 'mimeType': 'text/plain'},
        headers=lab.h(carol),
    )
    reporter.check(st_out == 403, 'defaultPath=/public 的用户无法在 /public 之外写入（403）', f'{st_out} {out_body}')
    st_in, in_body = carol.json_request(
        'POST', '/api/files/upload-session',
        {'path': PUBLIC_MOUNT_PATH, 'fileName': outside, 'fileSize': 8, 'mimeType': 'text/plain'},
        headers=lab.h(carol),
    )
    reporter.check(st_in == 200, 'defaultPath=/public 的用户可在 /public 内写入', f'{st_in} {in_body}')
    if st_in == 200:
        carol.json_request(
            'DELETE', f"/api/files/upload/multipart/{in_body['data']['sessionId']}", headers=lab.h(carol)
        )

    # ---- 种子 R2 提供商已无引用时删除（保持拓扑纯粹）----
    seed_provider = next((p for p in lab.list_providers() if p['name'] == '本地存储'), None)
    if seed_provider:
        # 演示数据已删除，但用户配额/审计日志可能仍引用其对象；失败不阻塞
        st, resp = lab.delete_provider(seed_provider['id'])
        reporter.check(
            st in (200, 409),
            '种子 R2 提供商处理（删除或被引用保护）',
            f'{st} {(resp.get("error") or {}).get("code")}',
        )

    return {'providers': providers, 'root': root, 'public': public, 'dedup': dedup, 'binding': binding, 'users': users}


def topology(lab: Lab) -> dict:
    """读取当前拓扑（不做修改）；缺任何一项即硬失败，避免测试在错误拓扑上跑出假结论。"""
    providers: dict[str, dict] = {}
    for key, name in PROVIDER_NAMES.items():
        prov = lab.find_provider(name)
        if prov is None:
            raise VerifyError(f'缺少存储提供商 {name}（先运行 00_setup.py）')
        providers[key] = prov
    root = lab.find_mount('/')
    public = lab.find_mount(PUBLIC_MOUNT_PATH)
    if root is None or public is None:
        raise VerifyError('拓扑不完整：缺少 / 或 /public 挂载点（先运行 00_setup.py）')
    dedup = lab.find_mount(DEDUP_MOUNT_PATH)
    if dedup is None:
        raise VerifyError('拓扑不完整：缺少 /dedup 挂载点（先运行 00_setup.py）')
    binding = lab.find_provider(BINDING_PROVIDER_NAME)
    if binding is None:
        raise VerifyError('拓扑不完整：缺少 R2 绑定提供商（先运行 00_setup.py）')
    users = {}
    for key, spec in TEST_USERS.items():
        user = lab.find_user(spec['username'])
        if user is None:
            raise VerifyError(f"缺少测试用户 {spec['username']}（先运行 00_setup.py）")
        users[key] = user
    return {'providers': providers, 'root': root, 'public': public, 'dedup': dedup, 'binding': binding, 'users': users}


def login_users(lab: Lab) -> dict[str, object]:
    """登录三个测试用户，返回 {alice|bob|carol: Session}（缓存，避免重复登录触发限流）"""
    topo = topology(lab)
    out = {}
    for key, spec in TEST_USERS.items():
        out[key] = lab.login(spec['username'], USER_PASSWORD, key=spec['username'])
    return out


def snapshot_users(lab: Lab) -> list[dict]:
    """快照全部用户的个别配置。

    `PUT /api/admin/roles/:role/defaults` 按设计**立即覆盖该角色下全部用户**的
    default_path / capabilities / permissions —— 涉及角色默认的用例必须先快照再还原，
    否则会污染后续用例的拓扑（本轮实测踩过：carol 的 defaultPath 被改回 '/'）。
    """
    return lab.db.query('SELECT id, role, status, default_path, capabilities, permissions FROM users')


def restore_users(lab: Lab, snapshot: list[dict]) -> None:
    ids = {row['id'] for row in snapshot}
    for row in snapshot:
        lab.admin_put_user_raw(row['id'], {
            'role': row['role'],
            'status': row['status'] or 'active',
            'defaultPath': row['default_path'] or '/',
            'capabilities': json.loads(row['capabilities']) if row['capabilities'] else [],
            'permissions': json.loads(row['permissions']) if row['permissions'] else None,
        })
    # 期间新建的用户（如角色继承验证用例）一并清理，保持拓扑稳定
    for user in lab.list_users(limit=200):
        if user['id'] not in ids:
            lab.delete_user(user['id'])


def fresh_name(prefix: str, *, ext: str = '') -> str:
    import uuid

    return f'{prefix}-{uuid.uuid4().hex[:8]}{ext}'
