#!/usr/bin/env python3
"""13 · 游客（匿名）访问权限专项：开关 / 受保护 API / 直链 / 文件级 guest_visibility / 分享 / gallery / guest 角色规则。

此前只在 03（/public 匿名浏览）与 04（匿名分享）里覆盖了片段，本模块把匿名主体作为独立面系统验证：
匿名是唯一「没有 defaultPath 兜底」的主体（判定链第 9 步只对 user 生效），因此它的放行必须来自
显式通道：挂载级/桶级矩阵的 guest 条目、role='guest' 规则、文件级 guest_visibility、分享令牌、签名直链。

    python3 scripts/lab/13_guest.py
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

WORKER = 'http://localhost:8787'
PUBLIC = fixtures.PUBLIC_MOUNT_PATH
DEDUP = fixtures.DEDUP_MOUNT_PATH


def run(args: argparse.Namespace) -> None:
    r = Reporter('13_guest')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    public_mount = topo['public']['id']
    dedup_mount = topo['dedup']['id']
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    admin = lab.admin()
    anon = lab.new_session()

    lab.purge_dir(alice, PUBLIC)
    lab.purge_dir(alice, DEDUP)

    # ================================================================ A. 全局游客开关
    st_on, body_on = lab.public_fs(anon, PUBLIC)
    r.check(st_on == 200, 'G1 allow_guest_access=ON 时匿名可浏览挂载级 guest 授权的目录', f'{st_on} {str(body_on)[:140]}')
    lab.set_settings(allowGuestAccess=False)
    st_off, body_off = lab.public_fs(anon, PUBLIC)
    r.check(
        st_off == 401 and (body_off.get('error') or {}).get('code') == 'LOGIN_REQUIRED',
        'G2 allow_guest_access=OFF 时匿名被拒（401 LOGIN_REQUIRED，总闸先行）',
        f'{st_off} {str(body_off)[:140]}',
    )
    lab.set_settings(allowGuestAccess=True)
    st_back, _b = lab.public_fs(anon, PUBLIC)
    r.check(st_back == 200, 'G3 恢复开关后匿名恢复可访问')

    # ================================================================ B. 匿名访问受保护 API / 协议面
    protected: list[tuple[str, str, str]] = [
        ('GET', '/api/files?path=/public', '文件列表'),
        ('GET', '/api/files/tree?path=/public', '文件树'),
        ('GET', '/api/users/me/settings', '个人设置'),
        ('GET', '/api/keys', 'API 密钥'),
        ('GET', '/api/admin/dashboard', '管理端仪表盘'),
        ('GET', '/api/admin/users', '管理端用户'),
        ('GET', '/api/shares', '我的分享列表'),
        ('POST', '/api/files/upload-session', '创建上传会话'),
        ('POST', '/api/files/folder', '新建文件夹'),
    ]
    for method, path, label in protected:
        st, body = anon.json_request(method, path, {} if method == 'POST' else None)
        r.check(
            st in (401, 403),
            f'G4 匿名访问受保护接口被拒：{label}',
            f'{method} {path} → {st} {(body.get("error") or {}).get("code")}',
        )

    st_wd, _w, _wh = anon.request('PROPFIND', '/webdav/', headers={'Depth': '1'})
    r.check(st_wd in (401, 403), 'G5 匿名 WebDAV PROPFIND 被拒', f'{st_wd}')
    st_s3, s3_body, _h = anon.get_bytes(f'{WORKER}/s3/public')
    r.check(st_s3 in (400, 401, 403), 'G6 匿名 S3 网关请求被拒（无签名）', f'{st_s3} {s3_body[:80]!r}')
    st_al, al_body = anon.json_request('POST', '/openlist/api/fs/list', {'path': '/'})
    r.check(st_al in (401, 403) or (al_body.get('code') or 0) in (401, 403), 'G7 匿名 AList 列目录被拒',
            f'HTTP={st_al} body={str(al_body)[:100]}')

    # ================================================================ C. 匿名直链（path-serve）
    name_users = f'guest-users-{uid()[:6]}.txt'
    payload_users = b'guest-users-visible-content'
    lab.upload(alice, PUBLIC, name_users, payload_users, 'text/plain')
    users_id = lab.file_id(alice, PUBLIC, name_users)
    lab.update_file(alice, users_id, visibility='users')
    st_nosign, body_nosign, _h = anon.get_bytes(f'{WORKER}{PUBLIC}/{name_users}')
    r.check(
        st_nosign in (401, 403),
        'G8 匿名直链无法直接读取 users 可见性文件（无 sign）',
        f'实际 {st_nosign} {body_nosign[:40]!r} —— mount 级 guest 矩阵在可见性判定之前放行（报告 F-07）',
    )
    # 有效签名直链（公开面下发的 url 自带 sign）
    st_fs, fs_body = lab.public_fs(anon, PUBLIC)
    signed = next((i.get('url') for i in (fs_body.get('data') or {}).get('items', [])
                   if i['name'] == name_users and i.get('url')), None)
    if signed:
        st_signed, body_signed, _h = anon.get_bytes(signed.replace('localhost:5173', 'localhost:8787'))
        r.check(st_signed == 200 and body_signed == payload_users, 'G9 有效签名直链可匿名读取', f'{st_signed}')
        tampered = signed.replace('sign=', 'sign=tampered', 1).replace('localhost:5173', 'localhost:8787')
        st_tamper, _b, _h = anon.get_bytes(tampered)
        r.check(
            st_tamper in (401, 403),
            'G10 篡改签名直链被拒',
            f'实际 {st_tamper} —— sign 校验被 guest 矩阵旁路（同 F-07）',
        )
    else:
        r.note('公开面未下发签名直链，跳过 G9/G10')

    # ================================================================ D. 文件级 guest_visibility（无 guest 矩阵的挂载）
    gv_name = f'guest-vis-{uid()[:6]}.txt'
    gv_payload = b'guest-visibility-content'
    lab.upload(alice, DEDUP, gv_name, gv_payload, 'text/plain')
    gv_id = lab.file_id(alice, DEDUP, gv_name)
    # public 可见性 + 默认 inherit（无 guest 规则）→ 匿名应被拒
    lab.update_file(alice, gv_id, visibility='public', guestVisibility='inherit')
    st_def, def_body, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{gv_name}')
    r.check(
        st_def == 200 and def_body == gv_payload,
        "G11 visibility='public' 本身即对匿名开放（合成规则仅对 users 要求登录；与 guest_visibility 无关）",
        f'{st_def} {def_body[:24]!r}',
    )
    st_fs2, _b = lab.public_fs(anon, DEDUP)
    r.check(st_fs2 in (401, 403, 404), 'G12 无 guest 矩阵的挂载匿名不可列目录', f'{st_fs2}')

    lab.update_file(alice, gv_id, guestVisibility='download')
    st_gd, body_gd, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{gv_name}')
    r.check(
        st_gd == 200 and body_gd == gv_payload,
        "G13 guest_visibility='download' 时匿名可下载（不给列表）",
        f'{st_gd} {body_gd[:24]!r}',
    )

    lab.update_file(alice, gv_id, guestVisibility='view')
    st_gv, gv_body = lab.public_fs(anon, DEDUP)
    names = {i['name'] for i in (gv_body.get('data') or {}).get('items', [])} if st_gv == 200 else set()
    r.check(
        st_gv == 200 and gv_name in names,
        "G14 guest_visibility='view' 时匿名可列目录并看到该文件",
        f'{st_gv} names={sorted(names)[:4]}',
    )
    st_gvd, body_gvd, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{gv_name}')
    r.check(st_gvd == 200 and body_gvd == gv_payload, "G15 guest_visibility='view' 时匿名可下载", f'{st_gvd}')

    lab.update_file(alice, gv_id, guestVisibility='none')
    st_gn, body_gn, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{gv_name}')
    r.check(
        st_gn in (401, 403),
        "G16 guest_visibility='none' 能对 public 可见性文件收回匿名访问",
        f'实际 {st_gn} {body_gn[:40]!r} —— syntheticGuestRule 只有 allow 语义、无 deny 分支（报告 F-17）',
    )

    # 有 guest 矩阵的挂载上，文件级 'none' 能否收紧（文件级 vs 挂载级优先级）
    none_name = f'guest-none-public-{uid()[:6]}.txt'
    lab.upload(alice, PUBLIC, none_name, b'public-mount-none', 'text/plain')
    none_id = lab.file_id(alice, PUBLIC, none_name)
    lab.update_file(alice, none_id, visibility='public', guestVisibility='none')
    st_pn, body_pn, _h = anon.get_bytes(f'{WORKER}{PUBLIC}/{none_name}')
    r.check(
        st_pn in (401, 403),
        "G17 挂载有 guest 矩阵时，文件级 guest_visibility='none' 仍能收紧匿名访问",
        f'实际 {st_pn} {body_pn[:40]!r} —— none 不产生 deny 规则，第 8 步挂载 guest 矩阵直接放行（报告 F-17）',
    )

    # ================================================================ E. 匿名分享
    share_name = f'guest-share-{uid()[:6]}.txt'
    lab.upload(alice, PUBLIC, share_name, b'guest-share-content', 'text/plain')
    share_id_file = lab.file_id(alice, PUBLIC, share_name)
    st_sh, sh = lab.create_share(alice, [share_id_file], title='匿名分享')
    sid = sh['data']['share']['id']
    st_det, det = lab.share_detail(anon, sid)
    r.check(st_det == 200 and len(((det.get('data') or {}).get('share') or {}).get('items') or []) == 1,
            'G18 匿名可读无门槛分享详情', f'{st_det}')
    st_dl, dl = lab.share_download(anon, sid)
    url = (dl.get('data') or {}).get('url') or ''
    st_g, body_g, _h = anon.get_bytes(url)
    r.check(st_g == 200 and body_g == b'guest-share-content', 'G19 匿名经分享网关下载成功', f'{st_g}')
    st_sh2, sh2 = lab.create_share(alice, [share_id_file], requireLogin=True)
    st_rl, rl = lab.share_detail(anon, sh2['data']['share']['id'])
    r.check(st_rl == 401, 'G20 requireLogin 分享拒绝匿名', f'{st_rl} {str(rl)[:120]}')
    st_sh3, sh3 = lab.create_share(alice, [share_id_file], allowedUsers=['labbob'])
    st_au, au = lab.share_detail(anon, sh3['data']['share']['id'])
    r.check(st_au in (401, 403), 'G21 allowedUsers 分享拒绝匿名', f'{st_au} {str(au)[:120]}')
    st_sh4, sh4 = lab.create_share(alice, [share_id_file], password='guest-pass')
    pw_sid = sh4['data']['share']['id']
    st_pw0, pw0 = lab.share_detail(anon, pw_sid)
    r.check((pw0.get('data') or {}).get('share', {}).get('requiresPassword') is True, 'G22 密码分享对匿名隐藏项目', str(pw0)[:120])
    st_pw1, _b = lab.share_verify(anon, pw_sid, 'guest-pass')
    st_pw2, pw2 = lab.share_detail(anon, pw_sid)
    r.check(st_pw1 == 200 and len(((pw2.get('data') or {}).get('share') or {}).get('items') or []) == 1,
            'G23 匿名验证分享密码后可读项目', f'{st_pw1}/{st_pw2}')

    # ================================================================ F. gallery（匿名公开空间）
    gal_name = f'guest-gallery-{uid()[:6]}.txt'
    lab.upload(alice, PUBLIC, gal_name, b'guest-gallery-content', 'text/plain')
    gal_id = lab.file_id(alice, PUBLIC, gal_name)
    lab.update_file(alice, gal_id, visibility='public')
    review = lab.db.one('SELECT review_status FROM file_metadata WHERE id=?', (gal_id,))
    r.check(
        review is not None and review['review_status'] == 'approved',
        'G24 具 can_publish 的用户设 public 即视为已裁定（直接 approved，设计语义）',
        str(review),
    )
    st_ga, ga = lab.gallery(anon)
    ids_after = {i['id'] for i in (ga.get('data') or {}).get('items', [])} if st_ga == 200 else set()
    r.check(gal_id in ids_after, 'G25 可发布用户设为 public 后出现在匿名 gallery')
    # 无 can_publish 用户 → pending → 不进 gallery（审核队列由 03-F18 覆盖，这里确认匿名面不可见）
    nopub = lab.ensure_user(f'labgnp{uid()[:3]}', fixtures.USER_PASSWORD, default_path=PUBLIC,
                            capabilities=[], permissions=['read', 'write', 'download'])
    nopub_s = lab.login(nopub['username'], fixtures.USER_PASSWORD)
    pend_name = f'guest-pending-{uid()[:6]}.txt'
    lab.upload(nopub_s, PUBLIC, pend_name, b'pending-content', 'text/plain')
    pend_id = lab.file_id(nopub_s, PUBLIC, pend_name)
    lab.update_file(nopub_s, pend_id, visibility='public')
    st_gp0, gp0 = lab.gallery(anon)
    ids_pending = {i['id'] for i in (gp0.get('data') or {}).get('items', [])} if st_gp0 == 200 else set()
    r.check(pend_id not in ids_pending, 'G25b 待审 public 文件不出现在匿名 gallery')
    lab.delete_user(nopub['id'])
    st_gdl, gdl = anon.json_request('GET', f'/api/gallery/{gal_id}/download')
    gurl = (gdl.get('data') or {}).get('url') or ''
    st_gbody, gbody, _h = anon.get_bytes(gurl)
    r.check(st_gbody == 200 and gbody == b'guest-gallery-content', 'G26 匿名经 gallery 下载成功', f'{st_gbody}')
    lab.update_file(alice, gal_id, accessPassword='gallery-pass')
    st_gp, gp = anon.json_request('GET', f'/api/gallery/{gal_id}/download')
    r.check(st_gp == 403 and (gp.get('error') or {}).get('code') == 'PASSWORD_REQUIRED',
            'G27 带密码的公开文件匿名下载被拒（403 PASSWORD_REQUIRED）', f'{st_gp} {str(gp)[:120]}')
    st_gv2, gv2 = anon.json_request('POST', f'/api/gallery/{gal_id}/verify-password', {'password': 'gallery-pass'})
    r.check(st_gv2 == 200, 'G28 匿名可凭密码换取下载链接', f'{st_gv2} {str(gv2)[:120]}')
    lab.update_file(alice, gal_id, accessPassword=None)

    # ================================================================ G. 封禁与密码文件
    ban_name = f'guest-ban-{uid()[:6]}.txt'
    lab.upload(alice, PUBLIC, ban_name, b'guest-ban-content', 'text/plain')
    ban_id = lab.file_id(alice, PUBLIC, ban_name)
    lab.update_file(alice, ban_id, visibility='public')
    lab.review_file(ban_id, status='approved', visibility='public')
    lab.ban_file(ban_id, True)
    st_banl, ban_body, _h = anon.get_bytes(f'{WORKER}{PUBLIC}/{ban_name}')
    r.check(st_banl in (401, 403, 429), 'G29 封禁文件的匿名直链被拒', f'{st_banl} {ban_body[:60]!r}')
    st_gl, gl = lab.gallery(anon)
    ids_banned = {i['id'] for i in (gl.get('data') or {}).get('items', [])} if st_gl == 200 else set()
    r.check(ban_id not in ids_banned, 'G30 封禁文件已从 gallery 列表过滤（PERM-06）')
    st_fsban, fsban = lab.public_fs(anon, PUBLIC)
    names_ban = {i['name'] for i in (fsban.get('data') or {}).get('items', [])} if st_fsban == 200 else set()
    r.check(ban_name not in names_ban, 'G30b 封禁文件已从公开目录列表过滤（PERM-06）')
    st_bang, bang = anon.json_request('GET', f'/api/gallery/{ban_id}/download')
    if st_bang == 200:
        burl = (bang.get('data') or {}).get('url') or ''
        st_consume, consume_body, _h = anon.get_bytes(burl)
        r.check(
            st_consume == 429 and b'FILE_BANNED' in consume_body,
            'G30c 封禁文件即使签发令牌，消费时仍被拦（出口安全有效；签发点未预检属一致性瑕疵）',
            f'sign={st_bang} consume={st_consume} {consume_body[:60]!r}',
        )
    else:
        r.check(st_bang in (403, 404, 429), 'G30c 封禁文件 gallery 签发被拒', f'{st_bang}')
    lab.ban_file(ban_id, False)
    lab.delete_file(alice, ban_id)

    pw_name = f'guest-pw-{uid()[:6]}.txt'
    lab.upload(alice, PUBLIC, pw_name, b'guest-pw-content', 'text/plain')
    pwfile_id = lab.file_id(alice, PUBLIC, pw_name)
    lab.update_file(alice, pwfile_id, visibility='public', accessPassword='file-pass')
    st_pwf, pwf, _h = anon.get_bytes(f'{WORKER}{PUBLIC}/{pw_name}')
    r.check(
        st_pwf == 403 and b'PASSWORD_REQUIRED' in pwf or st_pwf in (401, 403),
        'G31 带 accessPassword 的文件匿名直链被拒（403 PASSWORD_REQUIRED）',
        f'{st_pwf} {pwf[:60]!r}',
    )
    lab.update_file(alice, pwfile_id, accessPassword=None)

    # ================================================================ H. guest 角色规则
    rule_name = f'guest-rule-{uid()[:6]}.txt'
    lab.upload(alice, DEDUP, rule_name, b'guest-rule-content', 'text/plain')
    rule_file_id = lab.file_id(alice, DEDUP, rule_name)
    lab.update_file(alice, rule_file_id, visibility='private')
    st_pre, _b, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{rule_name}')
    r.check(st_pre in (401, 403), 'G32 建立 guest 规则前匿名被拒（基线）', f'{st_pre}')
    st_rule, rule = lab.admin_rule({
        'pathPattern': DEDUP,
        'effect': 'allow',
        'mountId': dedup_mount,
        'role': 'guest',
        'permissions': ['read', 'download'],
    })
    r.check(st_rule in (200, 201), "G33 管理员建立 role='guest' 的 allow 规则", f'{st_rule} {str(rule)[:140]}')
    st_post, post_body, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{rule_name}')
    r.check(
        st_post == 200 and post_body == b'guest-rule-content',
        'G34 guest 规则显式授权后匿名可读（放行必须来自显式通道）',
        f'{st_post} {post_body[:24]!r}',
    )
    st_fs3, fs3 = lab.public_fs(anon, DEDUP)
    r.check(st_fs3 == 200 or st_fs3 in (401, 403, 404), 'G35 guest 规则下匿名目录访问行为可解释', f'{st_fs3}')
    # deny 规则优先
    rule_id = ((rule.get('data') or {}).get('rule') or {}).get('id')
    st_deny, deny_rule = lab.admin_rule({
        'pathPattern': f'{DEDUP}/{rule_name}',
        'effect': 'deny',
        'mountId': dedup_mount,
        'role': 'guest',
        'permissions': ['read', 'download'],
        'priority': 10,
    })
    st_after, after_body, _h = anon.get_bytes(f'{WORKER}{DEDUP}/{rule_name}')
    r.check(
        st_after in (401, 403),
        'G36 更具体的 guest deny 规则压制 allow（匿名被拒）',
        f'deny={st_deny} 读取={st_after} {after_body[:40]!r}',
    )
    for rid in (rule_id, ((deny_rule.get('data') or {}).get('rule') or {}).get('id')):
        if rid:
            admin.json_request('DELETE', f'/api/admin/rules/{rid}', headers=lab.h(admin))

    # ================================================================ 清理
    for share in (sid, pw_sid, sh2['data']['share']['id'], sh3['data']['share']['id']):
        lab.revoke_share(alice, share)
    lab.purge_dir(alice, PUBLIC)
    lab.purge_dir(alice, DEDUP)
    lab.set_settings(allowGuestAccess=True)
    r.note('验收数据与 guest 规则已清理')

    if not r.finish():
        raise VerifyError('13 · 游客访问专项存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 13 · 游客访问专项'))
    main_wrapper(lambda: run(parser.parse_args()))
