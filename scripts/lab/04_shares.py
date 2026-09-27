#!/usr/bin/env python3
"""04 · 分享全链路：密码 / 过期 / 次数与浏览上限 / 指定用户 / 多项目 / 文件级密码 / 网关一次性令牌 / 撤销。

对应审计 SEC-04（分享出口绕过文件级密码）与「分享」功能面的回归验证。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, hget, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

DIR = '/users/labalice/share-lab'


def run(args: argparse.Namespace) -> None:
    r = Reporter('04_shares')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    bob = lab.login(fixtures.TEST_USERS['bob']['username'], fixtures.USER_PASSWORD, key='labbob')
    carol = lab.login(fixtures.TEST_USERS['carol'], fixtures.USER_PASSWORD) if False else lab.login(
        fixtures.TEST_USERS['carol']['username'], fixtures.USER_PASSWORD, key='labcarol'
    )
    anon = lab.new_session()

    lab.purge_dir(alice, '/users/labalice')
    lab.mkdir(alice, '/users/labalice', 'share-lab')
    lab.mkdir(alice, DIR, 'album')
    contents = {}
    for name in ('a.txt', 'b.txt', '专辑 封面.png'):
        contents[name] = f'content-of-{name}-{uid()}'.encode()
        lab.upload(alice, DIR, name, contents[name], 'text/plain')
    lab.upload(alice, f'{DIR}/album', 'inner.txt', b'inner-content', 'text/plain')
    lab.upload(alice, DIR, 'outside.txt', b'outside-of-share', 'text/plain')
    a_id = lab.file_id(alice, DIR, 'a.txt')
    b_id = lab.file_id(alice, DIR, 'b.txt')
    folder_id = lab.find_item(alice, DIR, 'album')['id']

    # ---------------------------------------------------------------- 1. 基本分享 + 网关一次性令牌
    st, data = lab.create_share(alice, [a_id], title='单文件分享')
    r.check(st == 201, 'S1 创建单文件分享', f'{st} {str(data)[:140]}')
    share = data['data']['share']
    sid = share['id']
    r.check(share['url'].endswith(f'/share/{sid}'), 'S2 返回分享链接', share['url'])
    st, detail = lab.share_detail(anon, sid)
    items = (detail.get('data') or {}).get('share', {}).get('items', [])
    r.check(st == 200 and len(items) == 1 and items[0]['name'] == 'a.txt', 'S3 匿名可读分享详情与项目', f'{st} {items}')
    r.check('physical_key' not in str(detail) and 'object_key' not in str(detail), 'S4 分享详情不泄露物理键', str(detail)[:160])
    st, dl = lab.share_download(anon, sid, a_id)
    url = (dl.get('data') or {}).get('url') or ''
    st_g, body, hdrs = anon.get_bytes(url)
    r.check(st_g == 200 and body == contents['a.txt'], 'S5 网关下载内容一致', f'{st_g} {body[:20]!r}')
    disp = hget(hdrs, 'Content-Disposition')
    r.check('inline' in disp or 'attachment' in disp, 'S6 网关响应带 Content-Disposition', disp)
    st_g2, _b, _h = anon.get_bytes(url)
    r.check(st_g2 == 401, 'S7 下载令牌一次性（重复消费 401）', str(st_g2))

    # ---------------------------------------------------------------- 2. Range 下载
    st, dl = lab.share_download(anon, sid, a_id)
    url = (dl.get('data') or {}).get('url') or ''
    st_r, part, hdrs_r = anon.get_bytes(url, headers={'Range': 'bytes=0-9'})
    r.check(st_r == 206 and part == contents['a.txt'][:10], 'S8 网关支持 Range（206 + 正确切片）', f'{st_r} {part!r}')

    # ---------------------------------------------------------------- 3. 密码分享
    st, data = lab.create_share(alice, [a_id], password='share-secret')
    pw_sid = data['data']['share']['id']
    st, detail = lab.share_detail(anon, pw_sid)
    sh = (detail.get('data') or {}).get('share') or {}
    r.check(st == 200 and sh.get('requiresPassword') is True and not sh.get('items'), 'S9 密码分享未验证时不返回项目', f'{st} {str(sh)[:140]}')
    st, bad = lab.share_verify(anon, pw_sid, 'wrong-pass')
    r.check(st == 401, 'S10 分享密码错误被拒（401）', f'{st} {bad}')
    st, ok_body = lab.share_verify(anon, pw_sid, 'share-secret')
    r.check(st == 200, 'S11 分享密码正确通过', f'{st} {ok_body}')
    st, detail2 = lab.share_detail(anon, pw_sid)
    r.check(len(((detail2.get('data') or {}).get('share') or {}).get('items') or []) == 1, 'S12 验证后可读项目')
    st, dl = lab.share_download(anon, pw_sid, a_id)
    r.check(st == 200, 'S13 验证后可签发下载令牌', f'{st} {str(dl)[:120]}')

    # ---------------------------------------------------------------- 4. maxDownloads / maxViews
    st, data = lab.create_share(alice, [b_id], maxDownloads=1)
    lim_sid = data['data']['share']['id']
    st, dl = lab.share_download(anon, lim_sid, b_id)
    url = (dl.get('data') or {}).get('url') or ''
    st_g, _b, _h = anon.get_bytes(url)
    r.check(st_g == 200, 'S14 次数限制分享首次下载成功', str(st_g))
    # 限额在**消费**令牌时判定（签发阶段仍允许生成链接）
    st, more = lab.share_download(anon, lim_sid, b_id)
    more_url = (more.get('data') or {}).get('url') or ''
    st_consume, cons_body, _h = anon.get_bytes(more_url) if more_url else (0, b'', {})
    r.check(
        st_consume == 410 and b'SHARE_LIMIT_REACHED' in cons_body,
        'S15 超过 maxDownloads 后消费令牌被拒（410 SHARE_LIMIT_REACHED）',
        f'sign={st} consume={st_consume} {cons_body[:120]!r}',
    )
    st, data = lab.create_share(alice, [b_id], maxViews=1)
    view_sid = data['data']['share']['id']
    lab.share_detail(anon, view_sid)
    st, second = lab.share_detail(anon, view_sid)
    r.check(st == 410, 'S16 超过 maxViews 后被拒（410）', f'{st} {str(second)[:140]}')

    # ---------------------------------------------------------------- 5. requireLogin / allowedUsers
    st, data = lab.create_share(alice, [a_id], requireLogin=True)
    login_sid = data['data']['share']['id']
    st, body = lab.share_detail(anon, login_sid)
    r.check(st == 401, 'S17 requireLogin 分享拒绝匿名（401）', f'{st} {str(body)[:120]}')
    st, body = lab.share_detail(bob, login_sid)
    r.check(st == 200, 'S18 requireLogin 分享对登录用户放行', f'{st}')
    st, data = lab.create_share(alice, [a_id], allowedUsers=['labbob'])
    allow_sid = data['data']['share']['id']
    st, body = lab.share_detail(carol, allow_sid)
    r.check(st == 403, 'S19 不在 allowedUsers 的用户被拒（403）', f'{st} {str(body)[:140]}')
    st, body = lab.share_detail(bob, allow_sid)
    r.check(st == 200, 'S20 指定用户可访问（200）', f'{st}')
    st, body = lab.create_share(alice, [a_id], allowedUsers=['nobody-here'])
    r.check(st == 400, 'S21 未知用户名被拒（400）', f'{st} {str(body)[:120]}')

    # ---------------------------------------------------------------- 6. 过期
    st, data = lab.create_share(alice, [a_id], expiresAt=int(time.time() * 1000) - 1000)
    if st == 201:
        st_exp, exp_body = lab.share_detail(anon, data['data']['share']['id'])
        r.check(st_exp == 410, 'S22 过去时间戳的分享立即视为过期（410 SHARE_EXPIRED）', f'{st_exp} {str(exp_body)[:120]}')
    else:
        r.check(st == 400, 'S22 过去时间戳被拒（400）', f'{st}')
    st, data = lab.create_share(alice, [a_id], expiresIn=60, expiresAt=int(time.time() * 1000) + 60000)
    r.check(st == 400, 'S23 expiresIn 与 expiresAt 互斥（400）', f'{st}')

    # ---------------------------------------------------------------- 7. 多项目 + 文件夹浏览
    st, data = lab.create_share(alice, [a_id, folder_id, b_id], title='混合分享')
    multi = data['data']['share']
    mid = multi['id']
    r.check([i['name'] for i in multi['items']] == ['a.txt', 'album', 'b.txt'], 'S24 多项目顺序与请求一致',
            str([i['name'] for i in multi['items']]))
    r.check(len(lab.db.query('SELECT * FROM share_items WHERE share_id=?', (mid,))) == 3, 'S25 share_items 落 3 行')
    st, listing = lab.share_list_dir(anon, mid, root=folder_id, sub='/')
    names = [i['name'] for i in ((listing.get('data') or {}).get('items') or [])]
    r.check(st == 200 and 'inner.txt' in names, 'S26 分享内文件夹可浏览子项', f'{st} {names}')
    st, traversal = lab.share_list_dir(anon, mid, root=folder_id, sub='../../etc')
    r.check(st in (400, 403, 404), 'S27 分享内目录穿越被拒', f'{st} {str(traversal)[:120]}')
    inner_id = next((i['id'] for i in ((listing.get('data') or {}).get('items') or []) if i['name'] == 'inner.txt'), None)
    if inner_id:
        st, dl = lab.share_download(anon, mid, inner_id)
        r.check(st == 200, 'S28 文件夹内后代可签发令牌', f'{st}')
    # 分享范围外的文件不可签发（outside.txt 在同一目录但不属于本分享）
    outside_id = lab.file_id(alice, DIR, 'outside.txt')
    st, dl = lab.share_download(anon, mid, outside_id)
    r.check(st in (403, 404), 'S29 分享范围外文件不可签发令牌', f'{st} {str(dl)[:140]}')

    # ---------------------------------------------------------------- 8. 撤销
    st, _ = lab.revoke_share(alice, sid)
    r.check(st == 200, 'S30 撤销分享', f'{st}')
    st, body = lab.share_detail(anon, sid)
    r.check(st == 410 and (body.get('error') or {}).get('code') == 'SHARE_REVOKED', 'S31 撤销后公开详情 410 SHARE_REVOKED', f'{st} {str(body)[:140]}')
    st, dl = lab.share_download(anon, sid, a_id)
    r.check(st == 410, 'S32 撤销后不可签发令牌（410）', f'{st}')

    # ---------------------------------------------------------------- 9. 文件级密码（SEC-04）
    st, data = lab.create_share(alice, [b_id], password='outer-pass')
    f_sid = data['data']['share']['id']
    lab.update_file(alice, b_id, accessPassword='inner-pass')
    lab.share_verify(anon, f_sid, 'outer-pass')
    st, dl = lab.share_download(anon, f_sid, b_id)
    r.check(
        st != 200 or 'inner' not in str(dl),
        'S33 分享密码不等于文件密码：未验证文件密码时不得签发',
        f'{st} {str(dl)[:160]}',
    )
    st, prev, _hprev = lab.share_preview(anon, f_sid, b_id)
    r.check(st in (401, 403), 'S34 文件级密码未验证时预览被拒', f'{st} {prev[:60]!r}')
    st, vf = lab.share_verify_file(anon, f_sid, b_id, 'inner-pass')
    r.check(st == 200, 'S35 文件级密码验证通过', f'{st} {str(vf)[:140]}')
    st, dl2 = lab.share_download(anon, f_sid, b_id)
    r.check(st == 200, 'S36 文件级密码验证后可签发', f'{st} {str(dl2)[:120]}')
    st, prev2, _hprev2 = lab.share_preview(anon, f_sid, b_id)
    r.check(st == 200 and prev2 == contents['b.txt'], 'S37 验证后预览返回原文', f'{st} {prev2[:20]!r}')
    lab.update_file(alice, b_id, accessPassword=None)

    # ---------------------------------------------------------------- 10. 管理端
    admin_shares = lab.admin_shares(limit=50)
    r.check(isinstance(admin_shares, dict), 'S38 管理端可列出分享')
    ids = {s['id'] for s in (admin_shares.get('shares') or admin_shares.get('items') or [])}
    r.check(mid in ids, 'S39 管理端列表包含新建分享')
    st, admin_detail = lab.admin().json_request('GET', f'/api/admin/shares/{mid}')
    r.check(st == 200, 'S40 管理端可查看分享详情', f'{st}')

    # ---------------------------------------------------------------- 清理
    for share_id in (mid, pw_sid, lim_sid, view_sid, login_sid, allow_sid, f_sid):
        lab.revoke_share(alice, share_id)
    lab.purge_dir(alice, '/users/labalice')
    r.note('验收数据与分享已清理')

    if not r.finish():
        raise VerifyError('04 · 分享用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 04 · 分享'))
    main_wrapper(lambda: run(parser.parse_args()))
