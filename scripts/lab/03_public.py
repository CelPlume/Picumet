#!/usr/bin/env python3
"""03 · /public 公共空间：flat 平铺、多用户上传、文件名映射、可见性与「他人只能下载」。

对应需求：C 桶挂载 /public 面向普通用户上传；flat 无法创建文件夹；不同用户上传后文件名正确显示；
只有首次上传真正落盘、删净后回收（内容寻址部分见 02）；用户把文件设为可给他人看后，他人只能下载。

本套件同时记录 4 个实测缺陷（见报告 F-03 / F-09 / F-10 / F-11），失败项即为发现项。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

PUBLIC = fixtures.PUBLIC_MOUNT_PATH


def _put_session(session, sess_data: dict, payload: bytes, s, mime: str = 'text/plain'):
    """按会话模式直传对象，返回 (etag, put_status)"""
    if sess_data.get('uploadUrl'):
        st, hdrs = s.presigned_put(sess_data['uploadUrl'], payload, mime)
        return (hdrs.get('ETag') or hdrs.get('Etag') or ''), st
    st, raw, _ = s.request(
        'PUT', f"/api/files/upload/raw/{sess_data['sessionId']}", body=payload,
        headers={'Content-Type': mime, **lab_h(s)},
    )
    return ((json.loads(raw or b'{}').get('data') or {}).get('etag') or ''), st


def lab_h(s):
    return _LAB.h(s)


_LAB: Lab | None = None


def run(args: argparse.Namespace) -> None:
    global _LAB
    r = Reporter('03_public')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    _LAB = lab
    topo = fixtures.topology(lab)
    public_mount = topo['public']['id']
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    bob = lab.login(fixtures.TEST_USERS['bob']['username'], fixtures.USER_PASSWORD, key='labbob')
    carol = lab.login(fixtures.TEST_USERS['carol']['username'], fixtures.USER_PASSWORD, key='labcarol')
    anon = lab.new_session()

    lab.purge_dir(alice, PUBLIC)

    # ================================================================ 1. flat 模式
    st, data = lab.mkdir(alice, PUBLIC, f'folder-{uid()[:6]}')
    r.check(st == 403, 'F1 flat 挂载点显式新建文件夹被拒（403）', f'{st} {data}')

    nested = f'nested-{uid()[:6]}'
    st_nested, nested_body = alice.json_request(
        'POST', '/api/files/upload-session',
        {'path': f'{PUBLIC}/{nested}', 'fileName': 'deep.txt', 'fileSize': 16, 'mimeType': 'text/plain'},
        headers=lab.h(alice),
    )
    if st_nested == 200:
        etag, _ = _put_session(None, nested_body['data'], b'deep-payload-123', alice)
        st_nc, nc = alice.json_request(
            'POST', '/api/files/upload-complete',
            {'sessionId': nested_body['data']['sessionId'], 'etag': etag}, headers=lab.h(alice),
        )
        row = lab.db.one('SELECT id, path, name FROM file_metadata WHERE mount_id=? AND name=?', (public_mount, 'deep.txt'))
        listed = {i['name'] for i in lab.items(alice, PUBLIC)}
        r.check(
            st_nc != 200,
            'F2 flat 模式下嵌套路径上传被拒（预签名路径跳过祖先目录校验）',
            f'complete={st_nc} → 落库行 {row}；该行无法在列表中出现（列表={sorted(listed)[:4]}）',
        )
        if row:
            alice.json_request('DELETE', f"/api/files/{row['id']}", headers=lab.h(alice))
    else:
        r.check(st_nested in (403, 400), 'F2 flat 挂载点嵌套路径上传被拒', f'{st_nested} {nested_body}')

    # ================================================================ 2. 多用户上传（各自文件名）
    mine: dict[str, tuple[object, dict[str, str]]] = {}
    for label, session, count in (('alice', alice, 3), ('bob', bob, 2), ('carol', carol, 2)):
        files = {}
        for i in range(count):
            name = f'{label}-{uid()[:6]}-{i}.txt'
            content = f'{label}-content-{i}'
            lab.upload(session, PUBLIC, name, content.encode(), 'text/plain')
            files[name] = content
        mine[label] = (session, files)
    for label, (session, files) in mine.items():
        own = {i['name'] for i in lab.items(session, PUBLIC)}
        r.check(set(files) <= own, f'F3 {label} 能看到自己上传的全部文件（文件名原样）', str(sorted(own)[:6]))
    for name, content in mine['alice'][1].items():
        row = lab.file_row(public_mount, PUBLIC, name)
        r.check(row is not None and row['size'] == len(content), f'F4 {name} 元数据（size/路径）正确', str(row))
    holders = {
        name: fixtures.s3('C').exists(fixtures.BUCKET, lab.file_row(public_mount, PUBLIC, name)['physical_key'])
        for name in mine['alice'][1]
    }
    r.check(all(holders.values()), 'F5 /public 文件物理对象全部落在 C 桶', str(holders))

    # 默认 private：他人不可见（§4.4a）——即「需用户主动设置才可给他人看」
    bob_sees = {i['name'] for i in lab.items(bob, PUBLIC)}
    r.check(
        not (set(mine['alice'][1]) & bob_sees),
        'F6 默认 private 的他人文件不出现在列表中（需属主主动开放）',
        str(sorted(bob_sees)[:6]),
    )

    # ================================================================ 3. 设为 users 后可读可下载，但不可改/删/移
    shared_name = next(iter(mine['alice'][1]))
    shared_content = mine['alice'][1][shared_name]
    shared_id = lab.file_id(alice, PUBLIC, shared_name)
    st, _ = lab.update_file(alice, shared_id, visibility='users')
    r.check(st == 200, f'F7 alice 将 {shared_name} 设为 users 可见', f'{st}')
    bob_sees2 = {i['name'] for i in lab.items(bob, PUBLIC)}
    r.check(shared_name in bob_sees2, 'F8 users 可见文件出现在他人列表', str(sorted(bob_sees2)[:6]))
    _st, dl = bob.json_request('GET', f'/api/files/{shared_id}/download')
    url = (dl.get('data') or {}).get('url') or ''
    st_dl, body, _h = bob.get_bytes(url)
    r.check(st_dl == 200 and body == shared_content.encode(), 'F9 他人可下载 users 可见文件且内容一致', f'{st_dl} {body[:20]!r}')

    r.check(lab.update_file(bob, shared_id, name='stolen.txt')[0] == 403, 'F10 他人不能改名（403）')
    r.check(bob.json_request('DELETE', f'/api/files/{shared_id}', headers=lab.h(bob))[0] == 403, 'F11 他人不能删除（403）')
    r.check(lab.update_file(bob, shared_id, visibility='private')[0] == 403, 'F12 他人不能改可见性（403）')
    r.check(lab.move(bob, shared_id, '/users/labbob')[0] == 403, 'F13 他人不能移动（403）')
    st_sh, sh = lab.create_share(bob, [shared_id])
    r.check(
        st_sh == 403,
        'F14 他人不能分享属主文件（403）',
        f'实际 {st_sh} —— share 不在权限矩阵词表内，第 9 步在 defaultPath 内对 share 一律放行（见报告 F-09）',
    )
    if st_sh == 201:
        lab.revoke_share(bob, sh['data']['share']['id'])
    r.check(lab.update_file(alice, shared_id, visibility='users')[0] == 200, 'F15 属主对自己文件仍有完整权限')

    # ================================================================ 4. 游客匿名访问
    st_anon, anon_body = lab.public_fs(anon, PUBLIC)
    r.check(st_anon == 200, 'F16 游客可匿名浏览 /public（guest 矩阵 read + allow_guest_access）', f'{st_anon} {str(anon_body)[:140]}')
    if st_anon == 200:
        guest_names = {i['name'] for i in anon_body['data']['items']}
        r.check(
            shared_name not in guest_names,
            'F17 游客列表不含 users 可见性文件（只含 public）',
            str(sorted(guest_names)[:6]),
        )

    # ================================================================ 5. public 可见性 + 审核队列（无 can_publish 用户）
    # 专用用户：can_publish 为空 → 设为 public 需走审核队列（不改动共享测试用户的配置）
    nopub = lab.ensure_user(f'labnopub{uid()[:3]}', fixtures.USER_PASSWORD,
                            default_path=PUBLIC, capabilities=[], permissions=['read', 'write', 'download'])
    nopub_session = lab.login(nopub['username'], fixtures.USER_PASSWORD)
    pub_name = f'nopub-public-{uid()[:6]}.txt'
    lab.upload(nopub_session, PUBLIC, pub_name, b'nopub-public-content', 'text/plain')
    pub_id = lab.file_id(nopub_session, PUBLIC, pub_name)
    st, data = lab.update_file(nopub_session, pub_id, visibility='public')
    review = lab.db.one('SELECT review_status, visibility FROM file_metadata WHERE id=?', (pub_id,))
    r.check(
        st == 200 and review is not None and review['review_status'] == 'pending',
        'F18 无 can_publish 用户设为 public 时进入待审（pending）',
        f'{st} {review}',
    )
    st_g, g = lab.gallery(anon)
    pre_ids = {i['id'] for i in (g.get('data') or {}).get('items', [])} if st_g == 200 else set()
    r.check(pub_id not in pre_ids, 'F19 待审文件不出现在 gallery', f'{st_g}')
    st_rev, rev = lab.review_file(pub_id, status='approved', visibility='public')
    r.check(st_rev == 200, 'F20 管理员审核通过', f'{st_rev} {str(rev)[:120]}')
    st_g2, g2 = lab.gallery(anon)
    post_ids = {i['id'] for i in (g2.get('data') or {}).get('items', [])} if st_g2 == 200 else set()
    r.check(pub_id in post_ids, 'F21 过审文件进入 gallery', f'{st_g2}')
    _st, gd = anon.json_request('GET', f'/api/gallery/{pub_id}/download')
    gurl = (gd.get('data') or {}).get('url') or ''
    st_gdl, gbody, _g = anon.get_bytes(gurl)
    r.check(st_gdl == 200 and gbody == b'nopub-public-content', 'F22 游客经 gallery 下载公开文件', f'{st_gdl}')
    r.check(lab.update_file(bob, pub_id, name='nope.txt')[0] == 403, 'F23 公开文件他人仍不能改名（403）')
    # 清理专用用户
    lab.delete_user(nopub['id'])
    carol = lab.login(fixtures.TEST_USERS['carol']['username'], fixtures.USER_PASSWORD)

    # ================================================================ 6. carol（defaultPath=/public）边界
    carol_own = {i['name'] for i in lab.items(carol, PUBLIC)}
    r.check(pub_name in carol_own, 'F24 carol（defaultPath=/public）正常列出自己的文件')
    st_out, out = carol.json_request(
        'POST', '/api/files/upload-session',
        {'path': '/', 'fileName': f'out-{uid()[:6]}.txt', 'fileSize': 4, 'mimeType': 'text/plain'},
        headers=lab.h(carol),
    )
    r.check(st_out == 403, 'F25 carol 不能在 /public 之外写入（403）', f'{st_out} {out}')
    r.check(lab.update_file(carol, shared_id, name='carol-rename.txt')[0] == 403, 'F26 carol 不能改名 alice 的文件（403）')

    # ================================================================ 7. 跨用户同名：预签名写入的属主校验缺口
    victim = f'victim-{uid()[:6]}.txt'
    victim_content = b'alice-original-content'
    lab.upload(alice, PUBLIC, victim, victim_content, 'text/plain')
    victim_id = lab.file_id(alice, PUBLIC, victim)
    lab.update_file(alice, victim_id, visibility='users')

    st_s, sess = bob.json_request(
        'POST', '/api/files/upload-session',
        {'path': PUBLIC, 'fileName': victim, 'fileSize': len(victim_content), 'mimeType': 'text/plain'},
        headers=lab.h(bob),
    )
    r.check(st_s == 200, 'F27 他人已占用文件名可创建上传会话', f'{st_s}')
    if st_s == 200:
        intruder = b'bob-overwrote-this!!' + b'x' * (len(victim_content) - len(b'bob-overwrote-this!!'))
        etag, put_st = _put_session(None, sess['data'], intruder, bob)
        r.check(put_st in (200, 201), 'F28 预签名 PUT 对他人路径成功（对象键=路径键）', f'{put_st}')
        st_c, done = bob.json_request(
            'POST', '/api/files/upload-complete',
            {'sessionId': sess['data']['sessionId'], 'etag': etag}, headers=lab.h(bob),
        )
        r.check(
            st_c == 409,
            'F29 他人已占用路径在提交时被拒（409）',
            f'实际 {st_c} {str(done)[:200]}',
        )
        _st, dl2 = alice.json_request('GET', f'/api/files/{victim_id}/download')
        url2 = (dl2.get('data') or {}).get('url') or ''
        _st_dl2, body2, _h2 = alice.get_bytes(url2)
        r.check(
            body2 == victim_content,
            'F30 属主对象内容未被他人预签名写入污染',
            f'实际得到 {body2!r}（属主行仍指向被覆盖后的对象）——见报告 F-10',
        )

    # ================================================================ 8. 匿名可读范围（guest 矩阵 vs 文件可见性）
    priv_name = f'anon-priv-{uid()[:6]}.txt'
    priv_users = f'anon-users-{uid()[:6]}.txt'
    lab.upload(alice, PUBLIC, priv_name, b'private-content-xyz', 'text/plain')
    lab.upload(alice, PUBLIC, priv_users, b'users-content-xyz', 'text/plain')
    lab.update_file(alice, lab.file_id(alice, PUBLIC, priv_users), visibility='users')
    st_l, lb = lab.public_fs(anon, PUBLIC)
    names_anon = {i['name'] for i in lb['data']['items']} if st_l == 200 else set()
    r.check(
        priv_name not in names_anon and priv_users not in names_anon,
        'F31 匿名列表不含 private / users 可见性文件',
        f'实际列表含 {sorted(names_anon & {priv_name, priv_users})}——公开目录浏览未按可见性过滤（见报告 F-11）',
    )
    # 直链必须落在 Worker 源站（APP_BASE_URL 指向前端，开发态不代理直链命名空间）
    st_p, raw_p, _h_p = anon.get_bytes(f'http://localhost:8787{PUBLIC}/{priv_name}')
    r.check(
        st_p in (401, 403, 404),
        'F32 匿名直链无法读取 private 文件',
        f'实际 {st_p} {raw_p[:40]!r}——mount 级 guest 矩阵（read/download）在可见性判定之前生效（见报告 F-11）',
    )
    st_u, raw_u, _h_u = anon.get_bytes(f'http://localhost:8787{PUBLIC}/{priv_users}')
    r.check(
        st_u in (401, 403, 404),
        'F33 匿名直链无法读取 users 可见性文件',
        f'实际 {st_u} {raw_u[:40]!r}',
    )

    # ================================================================ 清理
    lab.purge_dir(alice, PUBLIC)
    r.note('验收数据已清理（alice 视角清空 /public）')

    if not r.finish():
        raise VerifyError('03 · /public 公共空间用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 03 · /public 公共空间'))
    main_wrapper(lambda: run(parser.parse_args()))
