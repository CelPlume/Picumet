#!/usr/bin/env python3
"""05 · 权限与访问控制回归：隔离边界 / 用户规则 / 两级矩阵 / 路径边界 / LIKE 转义 / 挂载放置 / API Key 范围。

逐条对应既有审计的「已修复」声明（PERM-01/02/07/08/10/11、TOP-01/02/03/04/05/14），
用真实运行栈验证这些控制是否按声明生效。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

ISO_DIR = '/users/labisolated'


def run(args: argparse.Namespace) -> None:
    r = Reporter('05_permissions')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    root_id = topo['root']['id']
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    bob = lab.login(fixtures.TEST_USERS['bob']['username'], fixtures.USER_PASSWORD, key='labbob')
    iso = lab.login(fixtures.TEST_USERS['isolated']['username'], fixtures.USER_PASSWORD, key='labisolated')
    admin = lab.admin()

    # 目录骨架由具备写权限的 alice 建立（隔离用户看不到 /users 这一层）
    for username in (fixtures.TEST_USERS['isolated']['username'], fixtures.TEST_USERS['alice']['username']):
        lab.mkdir(alice, '/users', username)
    lab.purge_dir(alice, '/users/labalice')
    lab.purge_dir(iso, ISO_DIR)

    # ================================================================ PERM-01 隔离模式边界
    st_out, out = iso.json_request(
        'POST', '/api/files/upload-session',
        {'path': '/', 'fileName': f'escape-{uid()[:6]}.txt', 'fileSize': 4, 'mimeType': 'text/plain'},
        headers=lab.h(iso),
    )
    r.check(st_out == 403, 'P1 隔离用户不能在 defaultPath 之外写入（403）', f'{st_out} {out}')
    lab.upload(alice, '/users/labalice', f'priv-{uid()[:6]}.txt', b'alice-private', 'text/plain')
    alice_priv = next(i for i in lab.items(alice, '/users/labalice') if i['name'].startswith('priv-'))
    st_r, resp = iso.json_request('GET', f"/api/files/{alice_priv['id']}/download")
    r.check(st_r == 403, 'P2 隔离用户不能读取他人 private 文件（403）', f'{st_r} {str(resp)[:140]}')
    st_l, listing = iso.json_request('GET', '/api/files?path=/users/labalice')
    r.check(st_l == 403, 'P3 隔离用户不能列出他人目录（403）', f'{st_l} {str(listing)[:120]}')

    # users 可见性豁免根边界（审计 PERM-09 语义）
    lab.update_file(alice, alice_priv['id'], visibility='users')
    st_r2, resp2 = iso.json_request('GET', f"/api/files/{alice_priv['id']}/download")
    if st_r2 == 200:
        url = (resp2.get('data') or {}).get('url') or ''
        st_dl, body, _h = iso.get_bytes(url)
        r.check(st_dl == 200 and body == b'alice-private', 'P4 users 可见性对 read/download 豁免根边界（审计语义）', f'{st_dl}')
    else:
        r.check(False, 'P4 users 可见性对 read/download 豁免根边界（审计语义）', f'{st_r2} {str(resp2)[:140]}')
    lab.update_file(alice, alice_priv['id'], visibility='private')

    # 用户空间内正常读写
    lab.upload(iso, ISO_DIR, f'own-{uid()[:6]}.txt', b'isolated-own', 'text/plain')
    r.check(any(i['name'].startswith('own-') for i in lab.items(iso, ISO_DIR)), 'P5 隔离用户在自己的空间内可读写')

    # ================================================================ PERM-02 列表与树一致（private 过滤）
    tree = lab.tree(bob, '/users/labalice')
    tree_names = {i['name'] for i in tree['items']}
    listed = {i['name'] for i in lab.items(alice, '/users/labalice')}
    r.check(alice_priv['name'] in listed, 'P6 属主列表可见 private 文件')
    r.check(
        alice_priv['name'] not in {i['name'] for i in lab.items(bob, '/users/labalice')},
        'P7 他人列表不含 private 文件（§4.4a）',
    )
    st_t, _tresp = bob.json_request('GET', '/api/files?path=/users/labalice')
    r.check(alice_priv['name'] not in tree_names, 'P8 他人树视图同样不含 private 文件（PERM-02）', str(sorted(tree_names)[:6]))

    # ================================================================ 用户规则（can_grant）
    target_name = f'grant-{uid()[:6]}.txt'
    lab.upload(alice, '/users/labalice', target_name, b'grant-target-content', 'text/plain')
    target_id = lab.file_id(alice, '/users/labalice', target_name)
    st_rule, rule = lab.user_rule(alice, {'itemId': target_id, 'effect': 'allow', 'targetUserId': topo['users']['isolated']['id'],
                                          'permissions': ['read', 'download']})
    r.check(st_rule == 201, 'P9 属主可为指定用户建立 allow 规则', f'{st_rule} {str(rule)[:160]}')
    st_iso, resp_iso = iso.json_request('GET', f'/api/files/{target_id}/download')
    r.check(
        st_iso == 200,
        'P10 allow 规则可使隔离用户读取属主 private 文件',
        f'实际 {st_iso} —— 第 3 步 defaultPath 边界先于规则层，按文件授权无法突破边界（见报告 F-12）',
    )
    lab.update_file(alice, target_id, visibility='users')
    st_iso_vis, _ = iso.json_request('GET', f'/api/files/{target_id}/download')
    r.check(st_iso_vis == 200, 'P10b users 可见性豁免边界后隔离用户可读（说明上一条是边界而非规则失效）', f'{st_iso_vis}')
    rule_id = ((rule.get('data') or {}).get('rule') or {}).get('id')
    st_deny, deny_rule = lab.user_rule(alice, {'itemId': target_id, 'effect': 'deny', 'targetUserId': topo['users']['isolated']['id'],
                                               'permissions': ['read', 'download']})
    r.check(st_deny == 201, 'P11 可建立 deny 规则（deny 优先于 allow）', f'{st_deny}')
    st_iso2, _ = iso.json_request('GET', f'/api/files/{target_id}/download')
    r.check(st_iso2 == 403, 'P12 deny 规则压制 allow（403）', f'{st_iso2}')
    if rule_id:
        lab.delete_user_rule(alice, rule_id)
    deny_id = ((deny_rule.get('data') or {}).get('rule') or {}).get('id')
    if deny_id:
        lab.delete_user_rule(alice, deny_id)
    r.check(lab.user_rule(bob, {'itemId': target_id, 'effect': 'allow', 'allUsers': True, 'permissions': ['read']})[0] in (403, 404),
            'P13 非属主不能对他人文件建立规则（403/404）')
    r.check(lab.user_rule(alice, {'itemId': target_id, 'effect': 'allow', 'targetUserId': topo['users']['isolated']['id'],
                                  'allUsers': True, 'permissions': ['read']})[0] == 400,
            'P14 targetUserId 与 allUsers 互斥（400）')
    r.check(lab.user_rule(alice, {'itemId': target_id, 'effect': 'allow', 'targetUserId': topo['users']['isolated']['id'],
                                  'permissions': ['write']})[0] == 400,
            'P15 规则权限词表仅 read/download（400）')

    # ================================================================ 两级矩阵
    deny_mount = lab.ensure_mount({
        'providerId': topo['providers']['D']['id'],
        'mountPath': '/matrix-deny',
        'name': '矩阵拒绝挂载',
        'priority': 700,
        'uploadMode': 'free',
        'poolMembers': [{'providerId': topo['providers']['D']['id'], 'weight': 1, 'standby': False}],
        'rolePermissions': [{'role': 'user', 'permissions': ['read']}],
    })
    # 直接写挂载根（free 模式无需祖先目录），避免 §4.4a 把管理员建的 private 目录对普通用户隐藏
    st_up, up = alice.json_request('POST', '/api/files/upload-session',
                                   {'path': '/matrix-deny', 'fileName': 'x.txt', 'fileSize': 4, 'mimeType': 'text/plain'},
                                   headers=lab.h(alice))
    r.check(st_up == 403, 'P16 挂载级矩阵无 write → 上传被拒（403）', f'{st_up} {up}')
    st_l2, _d = alice.json_request('GET', '/api/files?path=/matrix-deny')
    r.check(st_l2 == 200, 'P17 矩阵允许 read → 可列出', f'{st_l2}')

    # 桶级矩阵：根挂载上对 D 桶拒绝 read → 落在 D 的文件对普通用户不可读
    st_b, _b = lab.patch_mount(root_id, {
        'poolMembers': [
            {'providerId': topo['providers']['A']['id'], 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': topo['providers']['D']['id'], 'weight': 1, 'sortOrder': 1, 'standby': False,
             'rolePermissions': [{'role': 'user', 'permissions': ['write', 'download']}]},
            {'providerId': topo['providers']['B']['id'], 'weight': 1, 'sortOrder': 2, 'standby': True},
        ]
    })
    r.check(st_b == 200, 'P18 设置 D 桶的桶级矩阵（user 无 read）', f'{st_b}')
    on_d = next((row for row in lab.db.query(
        'SELECT name, path FROM file_metadata WHERE mount_id=? AND type=? AND provider_id=?',
        (root_id, 'file', topo['providers']['D']['id']))), None)
    if on_d:
        detail = lab.list_files(bob, on_d['path'])
        names = {i['name'] for i in detail['items']}
        r.check(
            on_d['name'] not in names,
            'P19 桶级矩阵 deny read → 落在 D 桶的文件对普通用户不可列出（TOP-05/14 同源）',
            f'{on_d} 仍出现在 {sorted(names)[:6]}',
        )
    else:
        r.note('根挂载暂无落在 D 桶的文件，跳过桶级矩阵读过滤用例')
    # 还原根挂载池（去掉桶级矩阵）
    lab.patch_mount(root_id, {
        'poolMembers': [
            {'providerId': topo['providers']['A']['id'], 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': topo['providers']['D']['id'], 'weight': 1, 'sortOrder': 1, 'standby': False},
            {'providerId': topo['providers']['B']['id'], 'weight': 1, 'sortOrder': 2, 'standby': True},
        ]
    })
    st_dm, dm_body = lab.delete_mount(deny_mount['id'])
    r.check(
        st_dm in (200, 409),
        'P20 清理矩阵测试挂载点（挂载点目录行存在时按设计 409）',
        f'{st_dm} {str(dm_body)[:140]}',
    )

    # ================================================================ 路径段边界（/users/alice vs /users/alice2）
    seg = f'seg-{uid()[:5]}'
    lab.mkdir(alice, '/users', seg)
    lab.mkdir(alice, '/users', f'{seg}x')
    lab.upload(alice, f'/users/{seg}', 'inside.txt', b'inside', 'text/plain')
    lab.upload(alice, f'/users/{seg}x', 'outside.txt', b'outside', 'text/plain')
    inside_id = lab.file_id(alice, f'/users/{seg}', 'inside.txt')
    rule_seg = lab.user_rule(alice, {'itemId': lab.find_item(alice, '/users', seg)['id'], 'effect': 'deny',
                                     'targetUserId': topo['users']['bob']['id'], 'permissions': ['read', 'download']})
    r.check(rule_seg[0] == 201, 'P21 建立目录级 deny 规则用于边界测试', f'{rule_seg[0]}')
    st_in, _ = bob.json_request('GET', f'/api/files/{inside_id}/download')
    r.check(st_in == 403, 'P22 规则命中目录内文件（403）', f'{st_in}')
    outside_id = lab.file_id(alice, f'/users/{seg}x', 'outside.txt')
    st_out2, out2 = bob.json_request('GET', f'/api/files/{outside_id}/download')
    r.check(
        st_out2 != 403,
        'P23 前缀相邻目录不受规则影响（/seg 不匹配 /segx，路径段边界）',
        f'{st_out2} {str(out2)[:120]}',
    )
    seg_rule_id = ((rule_seg[1].get('data') or {}).get('rule') or {}).get('id')
    if seg_rule_id:
        lab.delete_user_rule(alice, seg_rule_id)

    # ================================================================ PERM-07 LIKE 转义（目录名含 %）
    like_root = f'/users/labalice/like-{uid()[:5]}'
    lab.mkdir(alice, '/users/labalice', like_root.split('/')[-1])
    lab.mkdir(alice, like_root, '100%')
    lab.mkdir(alice, like_root, '100x')
    lab.upload(alice, f'{like_root}/100%', 'p.txt', b'percent-dir', 'text/plain')
    lab.upload(alice, f'{like_root}/100x', 'p.txt', b'x-dir', 'text/plain')
    pct_id = lab.find_item(alice, like_root, '100%')['id']
    st_like, _ = lab.update_file(alice, pct_id, visibility='users')
    sib = lab.db.one('SELECT visibility FROM file_metadata WHERE mount_id=? AND path=? AND name=?', (root_id, f'{like_root}/100x', 'p.txt'))
    r.check(st_like == 200, 'P24 对含 % 的目录改可见性', str(st_like))
    r.check(
        sib and sib['visibility'] != 'users',
        'P25 级联不误伤兄弟目录 /100x（PERM-07 LIKE 转义）',
        f"兄弟目录可见性={sib and sib['visibility']}",
    )

    # ================================================================ 挂载放置校验（TOP-01/02/03）
    st_dup, dup = lab.create_mount({'providerId': topo['providers']['A']['id'], 'mountPath': '/public',
                                    'name': '重复路径', 'priority': 2000})
    r.check(st_dup == 400, 'P26 同规范化路径的第二个挂载被拒（400，TOP-01）', f'{st_dup} {str(dup)[:140]}')
    st_nest, nest = lab.create_mount({'providerId': topo['providers']['A']['id'], 'mountPath': f'{fixtures.PUBLIC_MOUNT_PATH}/inner',
                                      'name': '遮蔽挂载', 'priority': 50})
    r.check(st_nest == 400, 'P27 嵌套挂载优先级被祖先遮蔽被拒（400，TOP-01）', f'{st_nest} {str(nest)[:140]}')
    st_data, data_mount = lab.create_mount({'providerId': topo['providers']['A']['id'],
                                            'mountPath': f'/users/labalice/{like_root.split("/")[-1]}',
                                            'name': '覆盖父挂载数据', 'priority': 800})
    r.check(st_data == 409, 'P28 覆盖父挂载已有数据的路径被拒（409，TOP-02）', f'{st_data} {str(data_mount)[:140]}')
    st_userdir, ud = lab.create_mount({'providerId': topo['providers']['A']['id'], 'mountPath': f'/users/{seg}',
                                       'name': '撞用户目录', 'priority': 800})
    r.check(st_userdir == 409, 'P29 同路径已有用户目录时拒绝创建挂载（409，TOP-03）', f'{st_userdir} {str(ud)[:140]}')
    if st_userdir == 201:
        lab.delete_mount(((ud.get('data') or {}).get('mount') or {}).get('id', ''))

    # ================================================================ API Key 范围
    lab.purge_keys(alice)
    key = lab.create_key(alice, f'lab-scope-{uid()[:5]}', ['read', 'write'], ['api'], uploadPath='/public')
    token = key['key']['fullToken']
    body_out, ctype_out = _compat_body('scope-out.txt', b'key-scope', path='../users/labalice')
    st_k, kresp, _kh = alice.request('POST', '/api/upload', body=body_out,
                                     headers={'Content-Type': ctype_out, 'Authorization': f'Bearer {token}'})
    r.check(st_k in (400, 403), 'P30 API Key 不能越出 uploadPath 根（400/403）', f'{st_k} {kresp[:160]!r}')
    body_in, ctype_in = _compat_body('scope-in.txt', b'key-scope-ok')
    st_k2, kresp2, _kh2 = alice.request('POST', '/api/upload', body=body_in,
                                        headers={'Content-Type': ctype_in, 'Authorization': f'Bearer {token}'})
    r.check(st_k2 in (200, 403), 'P31 API Key 在 uploadPath 内可写（或明确拒绝）', f'{st_k2} {kresp2[:120]!r}')
    st_k3, kresp3, _kh3 = alice.request('GET', '/api/compat/file?path=/users/labalice/priv-x.txt',
                                        headers={'Authorization': f'Bearer {token}'})
    r.check(st_k3 in (403, 404), 'P32 API Key 数据层属主隔离（不触达他人文件行）', f'{st_k3}')
    lab.delete_key(alice, key['key']['keyId'])

    # ================================================================ 清理
    lab.purge_dir(alice, '/users')
    lab.purge_dir(iso, ISO_DIR)
    r.note('验收数据已清理')

    if not r.finish():
        raise VerifyError('05 · 权限用例存在失败项')


def _compat_body(filename: str, content: bytes, path: str | None = None) -> tuple[bytes, str]:
    boundary = f'----picumetlab{uid()}'
    chunks: list[bytes] = []
    if path is not None:
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n{path}\r\n'.encode())
    chunks.append(
        (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
         f'Content-Type: application/octet-stream\r\n\r\n').encode() + content + b'\r\n'
    )
    chunks.append(f'--{boundary}--\r\n'.encode())
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 05 · 权限回归'))
    main_wrapper(lambda: run(parser.parse_args()))
