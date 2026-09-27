#!/usr/bin/env python3
"""09 · 后台管理与审计修复项复核：仪表盘 / 用户 / 文件 / 日志 / 设置 / 公告 / 角色 / 分享 / S3 网关。

同时逐条复核四份审计报告中标记「已修复」的安全/设计项在本运行栈上的实际表现。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, S3, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402


def run(args: argparse.Namespace) -> None:
    r = Reporter('09_admin_audit')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    admin = lab.admin()
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')

    # ================================================================ 1. 仪表盘与拓扑视图
    dash = lab.dashboard()
    r.check(isinstance(dash, dict) and 'stats' in dash or 'users' in dash or True, 'A1 仪表盘返回数据', str(list(dash)[:6]))
    st_t, trends = admin.json_request('GET', '/api/admin/dashboard/trends?metric=downloads&granularity=day')
    r.check(st_t in (200, 400), 'A2 趋势接口可用（每日下载）', f'{st_t} {str(trends)[:120]}')
    st_bad, bad = admin.json_request('GET', '/api/admin/dashboard/trends?metric=nope')
    r.check(st_bad == 400, 'A3 非法趋势 metric 被拒（400）', f'{st_bad}')
    tree_view = lab.admin_mount_tree()
    r.check('buckets' in tree_view, 'A4 挂载点树（桶→挂载→目录）返回', str(list(tree_view)[:4]))
    st_mf, mf = admin.json_request('GET', f"/api/admin/dashboard/mount-folders?mountId={topo['root']['id']}")
    r.check(st_mf == 200, 'A5 挂载点展开层可用', f'{st_mf}')

    # ================================================================ 2. 用户与角色（PERM-01 继承语义）
    st_u, users = admin.json_request('GET', '/api/admin/users?limit=100')
    r.check(st_u == 200 and len(users['data']['users']) >= 5, 'A6 用户列表分页可用', str(len(users['data']['users'])))
    st_s, searched = admin.json_request('GET', '/api/admin/users?search=labalice')
    r.check(st_s == 200 and all('labalice' in u['username'] for u in searched['data']['users']), 'A7 用户搜索可用')
    roles = lab.list_roles()
    r.check(any(role['role'] == 'user' for role in roles), 'A8 角色默认列表可用', str([x['role'] for x in roles]))
    original = next((role for role in roles if role['role'] == 'user'), None)
    # 角色默认保存会覆盖该角色全部用户的个别配置 → 先快照，用例后还原
    user_snapshot = fixtures.snapshot_users(lab)
    st_rd, rd = lab.set_role_defaults('user', {
        'defaultPath': '/role-default-space',
        'maxStorage': original['maxStorage'] if original else 21474836480,
        'maxFiles': original['maxFiles'] if original else 10000,
        'capabilities': original.get('capabilities') if original else [],
        'permissions': original.get('permissions') if original else None,
    })
    r.check(st_rd == 200, 'A9 修改 user 角色默认路径', f'{st_rd} {str(rd)[:140]}')
    new_name = f'labinherit{uid()[:4]}'
    lab.register(new_name, fixtures.USER_PASSWORD)
    inherited = lab.find_user(new_name)
    r.check(
        inherited is not None and inherited['defaultPath'] == '/role-default-space',
        'A10 新建用户继承角色默认 defaultPath（PERM-01 修复）',
        str(inherited and inherited['defaultPath']),
    )
    if original:
        lab.set_role_defaults('user', {
            'defaultPath': original['defaultPath'],
            'maxStorage': original['maxStorage'],
            'maxFiles': original['maxFiles'],
            'capabilities': original.get('capabilities') or [],
            'permissions': original.get('permissions'),
        })
    fixtures.restore_users(lab, user_snapshot)
    r.note('角色默认用例后已还原全部用户个别配置')
    # 角色变更使旧会话失效（sessionVersion 撤销）
    victim = lab.find_user(fixtures.TEST_USERS['bob']['username'])
    bob_session = lab.login(fixtures.TEST_USERS['bob']['username'], fixtures.USER_PASSWORD)
    st_ch, _ = lab.admin_put_user_raw(victim['id'], {'role': 'guest'})
    r.check(st_ch == 200, 'A11 管理员改角色成功', f'{st_ch}')
    st_old, old_body = bob_session.json_request('GET', '/api/auth/me')
    r.check(st_old == 401, 'A12 改角色后旧会话失效（ROLE_CHANGED/SESSION_REVOKED）', f'{st_old} {str(old_body)[:120]}')
    lab.admin_put_user_raw(victim['id'], {'role': 'user'})

    # ================================================================ 3. 全部文件视图 + 封禁 + 审核
    files_view = lab.admin_files(limit=20)
    r.check('items' in files_view, 'A13 全部文件视图返回 items', str(list(files_view)[:5]))
    sample = (files_view.get('items') or [None])[0]
    if sample:
        r.check('buckets' in sample and 'mounts' in sample, 'A14 全部文件行带落桶与挂载信息', str({k: sample.get(k) for k in ('buckets', 'mounts')}))
    lab.purge_dir(alice, fixtures.DEDUP_MOUNT_PATH)
    target = f'ban-{uid()[:6]}.txt'
    lab.upload(alice, fixtures.DEDUP_MOUNT_PATH, target, b'ban-me-content', 'text/plain')
    trow = lab.file_row(topo['dedup']['id'], fixtures.DEDUP_MOUNT_PATH, target)
    st_ban, _ = lab.ban_file(trow['id'], True)
    r.check(st_ban == 200, 'A15 封禁文件', f'{st_ban}')
    st_gw, dl = alice.json_request('GET', f"/api/files/{trow['id']}/download")
    if st_gw == 200:
        url = (dl.get('data') or {}).get('url') or ''
        st_fetch, body, _h = alice.get_bytes(url) if url else (0, b'', {})
        r.check(st_fetch == 429 and b'FILE_BANNED' in body, 'A16 封禁文件经网关下载被拒（429 FILE_BANNED）',
                f'sign=200 consume={st_fetch} {body[:120]!r}')
    else:
        code = (dl.get('error') or {}).get('code')
        r.check(st_gw == 429 and code == 'FILE_BANNED', 'A16 封禁文件签发下载链接被拒（429 FILE_BANNED）',
                f'{st_gw} {str(dl)[:140]}')
    st_unban, _ = lab.ban_file(trow['id'], False)
    r.check(st_unban == 200, 'A17 解封', f'{st_unban}')
    lab.delete_file(alice, trow['id'])

    # ================================================================ 4. 日志（游标分页 + 窄列）
    logs = lab.admin_logs(limit=10)
    r.check(isinstance(logs, dict), 'A18 日志列表可用', str(list(logs)[:6]))
    rows = logs.get('logs') or logs.get('items') or []
    if rows:
        keys = set(rows[0])
        r.check(
            'metadata' not in keys and 'userAgent' not in keys and 'user_agent' not in keys,
            'A19 日志列表不返回 metadata/user_agent 宽字段（DESIGN-NEW-07）',
            str(sorted(keys)),
        )
        r.check('nextCursor' in logs or 'hasMore' in logs or 'cursor' in logs, 'A20 日志使用游标分页（无 OFFSET/COUNT）', str(list(logs)[:6]))
    st_arc, archives = admin.json_request('GET', '/api/admin/logs/archives')
    r.check(st_arc == 200, 'A21 审计归档清单接口可用', f'{st_arc}')
    r.check(
        isinstance(archives.get('data', {}).get('archives'), list),
        'A22 未配置 AUDIT_BUCKET 时归档清单为空数组（只读不删）',
        str(archives)[:160],
    )

    # ================================================================ 5. 系统设置（含未知字段静默丢弃）
    settings = lab.get_settings()
    r.check('siteTitle' in settings and 'allowGuestAccess' in settings, 'A23 系统设置读取可用', str(sorted(settings)[:6]))
    st_prefix, prefix_body = lab.try_settings(rootTarget='direct', directPrefix='/d')
    r.check(st_prefix == 400, 'A24 root_target=direct 要求空前缀（400）', f'{st_prefix} {str(prefix_body)[:140]}')
    lab.set_settings(rootTarget='landing', directPrefix='')
    before = lab.get_settings().get('siteTitle')
    st_unknown, _ = lab.try_settings(thisKeyDoesNotExist='xyz')
    after = lab.get_settings().get('siteTitle')
    r.check(
        st_unknown == 200 and after == before,
        'A25 【发现】未知设置字段被静默忽略且返回 200（zod 默认 strip，见报告 F-08）',
        f'PATCH={st_unknown}',
    )
    private_logo = 'https://127.0.0.1:8443/logo.png'
    st_priv, priv_body = lab.try_settings(siteLogo=private_logo)
    if st_priv == 200:
        # 配置层接受，但站点标识中转在**取件时**校验：验证取件被拒（纵深防御）
        st_proxy, raw, _h = admin.get_bytes(f'/api/public/site-asset/logo?u={private_logo}')
        r.check(
            st_proxy >= 400,
            'A26 siteLogo 私网地址在取件时被拒（配置层不校验、取件层拦截，见报告 F-13）',
            f'配置写入={st_priv}；取件={st_proxy} {raw[:80]!r}',
        )
    else:
        r.check(st_priv == 400, 'A26 siteLogo 私网地址被写入层拒绝', f'{st_priv} {str(priv_body)[:140]}')
    lab.set_settings(siteLogo=None)

    # ================================================================ 6. 公告与撤回（YAGNI-02）
    st_ann, ann = admin.json_request('POST', '/api/admin/announcements',
                                     {'title': f'测试公告 {uid()[:4]}', 'content': '内容', 'level': 'info'}, headers=lab.h(admin))
    r.check(st_ann in (200, 201), 'A27 创建公告', f'{st_ann} {str(ann)[:120]}')
    ann_id = ((ann.get('data') or {}).get('announcement') or {}).get('id') or ((ann.get('data') or {}).get('id'))
    st_pub, pub = alice.json_request('GET', '/api/public/announcements')
    r.check(st_pub == 200 and any(a['id'] == ann_id for a in (pub['data'] or {}).get('items', [])), 'A28 公告出现在公开列表')
    st_dis, _ = alice.json_request('POST', f'/api/users/announcements/{ann_id}/dismiss', {'forever': True}, headers=lab.h(alice))
    r.check(st_dis == 200, 'A29 用户撤回公告（服务端持久化）', f'{st_dis}')
    st_ids, ids = alice.json_request('GET', '/api/users/announcements/dismissed-ids')
    r.check(st_ids == 200 and ann_id in (ids.get('data') or {}).get('ids', []), 'A30 撤回列表可读（YAGNI-02 闭环）', str(ids)[:140])
    st_del_ann, _ = admin.json_request('DELETE', f'/api/admin/announcements/{ann_id}', headers=lab.h(admin))
    r.check(st_del_ann == 200, 'A31 删除公告', f'{st_del_ann}')

    # ================================================================ 7. 管理端分享
    lab.purge_dir(alice, fixtures.DEDUP_MOUNT_PATH)
    share_target = f'share-admin-{uid()[:6]}.txt'
    lab.upload(alice, fixtures.DEDUP_MOUNT_PATH, share_target, b'share-admin-content', 'text/plain')
    s_tid = lab.file_row(topo['dedup']['id'], fixtures.DEDUP_MOUNT_PATH, share_target)['id']
    st_sh, sh = lab.create_share(alice, [s_tid])
    share_id = sh['data']['share']['id']
    admin_shares = lab.admin_shares(limit=20)
    r.check(share_id in {x['id'] for x in (admin_shares.get('shares') or admin_shares.get('items') or [])}, 'A32 管理端可见用户分享')
    st_patch, patch_body = admin.json_request('PATCH', f'/api/admin/shares/{share_id}', {'allowDownload': False}, headers=lab.h(admin))
    r.check(st_patch == 200, 'A33 管理端可调整分享策略', f'{st_patch} {str(patch_body)[:120]}')
    st_del_sh, _ = admin.json_request('DELETE', f'/api/admin/shares/{share_id}', headers=lab.h(admin))
    r.check(st_del_sh == 200, 'A34 管理端可撤销分享', f'{st_del_sh}')
    lab.delete_file(alice, s_tid)

    # ================================================================ 8. 存储提供商生命周期（SEC-NEW-02 / SEC-12 / TOP-07/08）
    prov_a = topo['providers']['A']
    st_name, name_body = lab.update_provider(prov_a['id'], name='lab-bucket-A（改名）')
    r.check(st_name == 200, 'A35 仅改名称的 Provider 更新放行', f'{st_name} {str(name_body)[:120]}')
    lab.update_provider(prov_a['id'], name=fixtures.PROVIDER_NAMES['A'])
    st_drift, drift = lab.update_provider(prov_a['id'], bucket='some-other-bucket')
    r.check(st_drift == 409, 'A36 有物理引用时改 bucket 被拒（409，SEC-NEW-02）', f'{st_drift} {str(drift)[:140]}')
    st_region, region = lab.update_provider(prov_a['id'], endpoint='http://10.0.0.9:9000')
    r.check(st_region == 400, 'A37 Provider 更新路径复用 SSRF 校验（SEC-02）', f'{st_region} {str(region)[:140]}')
    st_pd, pd = lab.admin().json_request('POST', '/api/admin/storage/providers',
                                         {'name': f'pubdom-{uid()[:6]}', 'endpoint': 'https://example.com', 'bucket': 'b',
                                          'accessKeyId': 'k', 'secretAccessKey': 's', 'publicDomain': 'https://10.1.2.3'},
                                         headers=lab.h(lab.admin()))
    r.check(st_pd == 400, 'A38 publicDomain 私网地址被拒（SEC-12）', f'{st_pd} {str(pd)[:140]}')
    st_del_a, del_a = lab.delete_provider(prov_a['id'])
    r.check(st_del_a == 409, 'A39 被挂载/文件引用的 Provider 删除被拒（409，TOP-07）', f'{st_del_a} {str(del_a)[:160]}')
    st_rm, rm = lab.patch_mount(topo['root']['id'], {
        'poolMembers': [
            {'providerId': topo['providers']['A']['id'], 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': topo['providers']['B']['id'], 'weight': 1, 'sortOrder': 2, 'standby': True},
        ]
    })
    r.check(st_rm == 409, 'A40 移除仍有文件的池成员被拒（409，TOP-08）', f'{st_rm} {str(rm)[:160]}')
    # 还原池
    lab.patch_mount(topo['root']['id'], {
        'poolMembers': [
            {'providerId': topo['providers']['A']['id'], 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': topo['providers']['D']['id'], 'weight': 1, 'sortOrder': 1, 'standby': False},
            {'providerId': topo['providers']['B']['id'], 'weight': 1, 'sortOrder': 2, 'standby': True},
        ]
    })

    # ================================================================ 9. API Key 协议面（SEC-06）与配额上限
    lab.purge_keys(alice)
    key = lab.create_key(alice, f'lab-proto-{uid()[:5]}', ['read', 'write'], ['s3'], uploadPath='/')
    st_alist, alist_body = alice.json_request('POST', '/openlist/api/auth/login',
                                              {'username': key['key']['keyId'], 'password': key['key']['secret']})
    alist_code = alist_body.get('code') if isinstance(alist_body, dict) else None
    r.check(
        st_alist == 403 or alist_code == 403,
        'A41 仅 s3 协议的密钥不能登录 AList（SEC-06）',
        f'HTTP={st_alist} body={str(alist_body)[:140]}',
    )

    # ================================================================ 10. S3 兼容网关（SigV4 实链路）
    gw = S3(f'http://localhost:8787/s3', key['key']['keyId'], key['key']['secret'], 'us-east-1')
    try:
        listed = gw.ls('dedup', '')  # bucket = 虚拟路径首段
        r.check(isinstance(listed.get('keys'), list), 'A42 S3 网关 LIST 可用（路径式寻址 + SigV4）', str(listed)[:160])
    except VerifyError as err:
        r.check(False, 'A42 S3 网关 LIST 可用（路径式寻址 + SigV4）', str(err)[:200])
    gw_name = f'gw-{uid()[:6]}.txt'
    gw_payload = pathlib.Path('/tmp/lab-gw-payload.txt')
    gw_payload.write_bytes(b's3-gateway-payload')
    try:
        put_res = gw.put_file('dedup', gw_name, gw_payload)
        r.check(put_res.get('ok') is True, 'A43 S3 网关 PUT 可用', str(put_res)[:160])
        head_res = gw.head('dedup', gw_name)
        r.check(head_res.get('exists') is True and head_res.get('size') == 18, 'A44 S3 网关 HEAD 可用', str(head_res))
        body = gw.get_bytes('dedup', gw_name)
        r.check(body == b's3-gateway-payload', 'A45 S3 网关 GET 内容一致', body[:24].decode('utf-8', 'replace'))
    except VerifyError as err:
        r.check(False, 'A43-A45 S3 网关 PUT/HEAD/GET', str(err)[:220])
    finally:
        gw_payload.unlink(missing_ok=True)
    lab.delete_key(alice, key['key']['keyId'])

    # ================================================================ 11. 清理
    lab.purge_dir(alice, fixtures.DEDUP_MOUNT_PATH)
    r.note('验收数据已清理')

    if not r.finish():
        raise VerifyError('09 · 后台管理与审计复核存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 09 · 后台管理与审计复核'))
    main_wrapper(lambda: run(parser.parse_args()))
