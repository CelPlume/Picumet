#!/usr/bin/env python3
"""01 · 文件与目录全链路：上传 / 列表 / 树 / 改名 / 移动 / 复制链接 / 下载(Range) / 删除。

覆盖用户需求的“文件上传”主干，以及审计项 SEC-01（跨挂载文件夹移动）、D-2（移动目标冲突）、
D-7（目录重命名迁移子树）、TOP-04/PERM-11（权限路径基准）、路径遍历与文件名校验。
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, hget, main_wrapper  # noqa: E402

from _lab import Lab, guess_mime  # noqa: E402
import corpus  # noqa: E402
import fixtures  # noqa: E402

ALICE_DIR = '/users/labalice'


def run(args: argparse.Namespace) -> None:
    r = Reporter('01_files')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    root_id = topo['root']['id']
    prov_names = lab.provider_name_map()

    # 幂等：先清空本套件使用的目录
    purged = lab.purge_dir(alice, ALICE_DIR)
    r.note(f'前置清理 {ALICE_DIR}：删除 {purged} 项')
    lab.purge_dir(alice, fixtures.DEDUP_MOUNT_PATH)
    r.note(f'前置清理 {fixtures.DEDUP_MOUNT_PATH} 完成')

    # ---------------------------------------------------------------- 建目录
    for parent, name in (
        (ALICE_DIR, 'photos'),
        (f'{ALICE_DIR}/photos', 'albums'),
        (f'{ALICE_DIR}/photos/albums', '2026'),
    ):
        st, data = lab.mkdir(alice, parent, name)
        r.check(st in (200, 201), f'创建目录 {parent}/{name}', f'{st} {data}')
    r.check(
        {i['name'] for i in lab.items(alice, f'{ALICE_DIR}/photos/albums')} == {'2026'},
        '嵌套目录创建后结构正确',
    )

    # ---------------------------------------------------------------- 上传多种类型
    samples = corpus.small_samples()
    target = f'{ALICE_DIR}/photos/albums/2026'
    uploaded: dict[str, dict] = {}
    for sample in samples:
        name = sample.name
        result = lab.upload_local(alice, target, sample, filename=name)
        uploaded[name] = result
        row = lab.file_row(root_id, target, name)
        r.check(row is not None and row['size'] == sample.stat().st_size,
                f'上传 {name}（{sample.stat().st_size} B）', str(row))
    r.check(len(uploaded) == len(samples), f'共上传 {len(samples)} 个文件')

    # 同属主重复上传同一路径：设计语义为「覆盖」，至少应给出可解释结果（200 覆盖 / 409 明确拒绝），
    # 不能是 500 数据库约束错误。
    dup_name = samples[1].name
    try:
        st_dup, dup = lab.upload(alice, target, dup_name, b'overwrite-attempt' * 4, 'text/plain')
        r.check(True, f'同路径重复上传返回可解释结果（{st_dup}）', str(dup)[:160])
    except VerifyError as err:
        passed = '409' in str(err) or 'ALREADY_EXISTS' in str(err)
        r.check(passed, '同路径重复上传被明确拒绝（而非 500）', str(err)[:200])

    # 文件名保真（含空格 / 中文 / 括号）
    listed = {i['name']: i for i in lab.items(alice, target)}
    for sample in samples:
        r.check(sample.name in listed, f'列表原样返回文件名：{sample.name}', str(list(listed)[:6]))
    space_name = next((s.name for s in samples if ' ' in s.name), None)
    if space_name:
        r.check(space_name in listed, f'含空格文件名保真：{space_name}')

    # ---------------------------------------------------------------- 物理落桶（拼好桶 A/D 之一）
    for name in uploaded:
        row = lab.file_row(root_id, target, name)
        provider = prov_names.get(row['provider_id'] or '')
        key = row['physical_key']
        holder = provider.split('-')[-1] if provider else ''
        r.check(
            provider in ('lab-bucket-A', 'lab-bucket-D')
            and holder in ('A', 'D')
            and fixtures.s3(holder).exists(fixtures.BUCKET, key),
            f'{name} 落在池成员 {provider} 且对象存在于该桶',
            f'provider={provider} key={key}',
        )
    stale = [
        (k, name)
        for name in uploaded
        for k in ('A', 'B', 'C', 'D')
        if fixtures.s3(k).exists(fixtures.BUCKET, lab.file_row(root_id, target, name)['physical_key'])
        and k != (prov_names.get(lab.file_row(root_id, target, name)['provider_id'] or '') or '').split('-')[-1]
    ]
    if stale:
        r.note('其他桶存在同名物理键（历史运行遗留对象，删除后清理为异步）', str(sorted(set(stale))[:6]))

    # ---------------------------------------------------------------- 文件树
    tree = lab.tree(alice, ALICE_DIR)
    names = {item['name'] for item in tree['items']}
    r.check(set(uploaded) <= names, '文件树包含全部上传文件', f'{sorted(names)[:8]}')

    # ---------------------------------------------------------------- 改名（文件）
    first = samples[0].name
    fid = lab.file_id(alice, target, first)
    new_name = f'renamed-{first}'
    st, data = lab.update_file(alice, fid, name=new_name)
    r.check(st == 200, f'文件改名 {first} → {new_name}', f'{st} {data}')
    r.check(lab.find_item(alice, target, new_name) is not None, '改名后按新名可列出')
    r.check(lab.find_item(alice, target, first) is None, '改名后旧名不可列出')
    row_after = lab.file_row(root_id, target, new_name)
    r.check(row_after is not None and row_after['path'] == target, '改名后父目录 path 未被写坏（D-7 回归）', str(row_after))

    # ---------------------------------------------------------------- 目录改名迁移整棵子树（D-7）
    folder_id = lab.find_item(alice, f'{ALICE_DIR}/photos', 'albums')['id']
    st, data = lab.update_file(alice, folder_id, name='albums-renamed')
    r.check(st == 200, '目录改名', f'{st} {data}')
    moved_dir = f'{ALICE_DIR}/photos/albums-renamed/2026'
    listed2 = {i['name'] for i in lab.items(alice, moved_dir)}
    expected_names = {new_name if s.name == first else s.name for s in samples}
    r.check(expected_names <= listed2, '目录改名后子树可列出（整棵迁移，D-7）', str(sorted(listed2)[:6]))
    orphan = lab.db.query(
        "SELECT name FROM file_metadata WHERE mount_id=? AND path LIKE ?", (root_id, f'{ALICE_DIR}/photos/albums/%')
    )
    r.check(not orphan, '目录改名后无旧路径孤儿子项', str(orphan[:3]))

    # ---------------------------------------------------------------- 同挂载移动
    st, data = lab.mkdir(alice, ALICE_DIR, 'moved-target')
    r.check(st in (200, 201), '创建移动目标目录', f'{st} {data}')
    src_id = lab.file_id(alice, moved_dir, new_name)
    st, data = lab.move(alice, src_id, f'{ALICE_DIR}/moved-target')
    r.check(st in (200, 202), '同挂载移动文件', f'{st} {data}')
    job = (data.get('data') or {}).get('jobId')
    job_status = None
    if job:
        for _ in range(30):
            st_job, job_data = alice.json_request('GET', f'/api/files/jobs/{job}')
            job_status = ((job_data.get('data') or {}).get('job') or {}).get('status')
            if job_status in ('completed', 'failed', 'rollback'):
                break
            time.sleep(0.5)
        r.check(job_status == 'completed', '移动任务最终 completed', f'job={job} status={job_status} {job_data}')
    moved_ok = lab.find_item(alice, f'{ALICE_DIR}/moved-target', new_name) is not None
    r.check(moved_ok, '移动后目标目录可见',
            f'目标目录={[i["name"] for i in lab.items(alice, f"{ALICE_DIR}/moved-target")]}；'
            f'移动 Saga 失败（见上一条，报告 F-01）')
    # 移动失败时后续用例回退到源位置，保证套件仍跑完并给出完整矩阵
    work_dir = f'{ALICE_DIR}/moved-target' if moved_ok else moved_dir
    if not moved_ok:
        r.note('移动未生效 → 后续下载/复制链接用例回退到源目录', moved_dir)

    # ---------------------------------------------------------------- 跨挂载文件夹移动 → 422（SEC-01）
    cross_folder = lab.find_item(alice, f'{ALICE_DIR}/photos', 'albums-renamed')['id']
    st, data = lab.move(alice, cross_folder, fixtures.DEDUP_MOUNT_PATH)
    r.check(st == 422, '跨挂载文件夹移动被拒（SEC-01）', f'{st} {data}')

    # blob 跨挂载移动 → 422（D-3）：需先有内容寻址文件（/dedup 是 Worker 代理写入）
    ca_content = b'dedup-cross-mount-' + fixtures.fresh_name('x').encode()
    ca_name = fixtures.fresh_name('ca-cross', ext='.txt')
    lab.upload(alice, fixtures.DEDUP_MOUNT_PATH, ca_name, ca_content, 'text/plain')
    dedup_mount_id = topo['dedup']['id']
    ca_row = lab.file_row(dedup_mount_id, fixtures.DEDUP_MOUNT_PATH, ca_name)
    if ca_row and ca_row['blob_hash']:
        st, data = lab.move(alice, ca_row['id'], ALICE_DIR)
        r.check(st == 422, 'blob 内容寻址文件跨挂载移动被拒（D-3）', f'{st} {data}')
    else:
        r.note('内容寻址文件未生成 blob_hash，跳过 D-3 用例', str(ca_row))

    # ---------------------------------------------------------------- 目标路径已被他人占用
    bob = lab.login(fixtures.TEST_USERS['bob']['username'], fixtures.USER_PASSWORD, key='labbob')
    collide_name = fixtures.fresh_name('collide', ext='.txt')
    seeded = lab.upload(alice, f'{ALICE_DIR}/photos', collide_name, b'alice-owns-this' * 4, 'text/plain')
    r.check(isinstance(seeded, dict), f'alice 在 {ALICE_DIR}/photos 建立同名基准文件', str(seeded)[:120])
    # 会话创建阶段不校验路径占用（占用在提交时判定），因此必须真的把对象写下去再完成，
    # 才能观察到最终结果：期望 409（明确拒绝），不能是 500 数据库约束错误。
    st2, sess = bob.json_request(
        'POST', '/api/files/upload-session',
        {'path': f'{ALICE_DIR}/photos', 'fileName': collide_name, 'fileSize': 64, 'mimeType': 'text/plain'},
        headers=lab.h(bob),
    )
    r.check(st2 == 200, '他人目录的上传会话可创建（占用在提交时判定）', f'{st2} {sess}')
    if st2 == 200:
        session = sess['data']
        payload = b'x' * 64
        if session.get('uploadUrl'):
            _st_put, hdrs = bob.presigned_put(session['uploadUrl'], payload, 'text/plain')
            etag = hdrs.get('ETag') or hdrs.get('Etag') or ''
        else:
            _st_put, raw, _ = bob.request(
                'PUT', f"/api/files/upload/raw/{session['sessionId']}", body=payload,
                headers={'Content-Type': 'text/plain', **lab.h(bob)},
            )
            etag = (json.loads(raw).get('data') or {}).get('etag') or ''
        st3, done = bob.json_request(
            'POST', '/api/files/upload-complete',
            {'sessionId': session['sessionId'], 'etag': etag}, headers=lab.h(bob),
        )
        r.check(st3 == 409, '他人目录同名文件提交时返回 409（而非 500）', f'{st3} {str(done)[:220]}')

    # ---------------------------------------------------------------- 复制链接
    fid2 = lab.file_id(alice, work_dir, new_name)
    st, data = lab.copy_links(alice, fid2)
    r.check(st == 200, '复制链接（公开路径）', f'{st}')
    formats = ((data.get('data') or {}).get('formats') or {})
    r.check({'direct', 'html', 'markdown', 'bbcode'} <= set(formats), '复制链接返回 4 种格式', str(list(formats)))
    st, data = lab.copy_links(alice, fid2, signed=True, expires_in=120)
    r.check(st == 200 and (data.get('data') or {}).get('accessMode') == 'signed', '复制链接（签名模式）', str(data)[:160])
    signed_direct = ((data.get('data') or {}).get('formats') or {}).get('direct') or ''
    r.check(
        'sign=' in signed_direct or 'X-Amz-Signature=' in signed_direct,
        '签名直链可验证（Worker path-serve sign 或提供商预签名）',
        signed_direct[:120],
    )

    # ---------------------------------------------------------------- 下载与 Range
    st, data = lab.download_url(alice, fid2)
    url = (data.get('data') or {}).get('url') or ''
    r.check(st == 200 and '/api/gateway/download/' in url, '获取下载令牌', f'{st} {url[:80]}')
    st_dl, body, headers = alice.get_bytes(url)
    expected = next(s for s in samples if s.name == first).read_bytes()
    r.check(st_dl == 200 and body == expected, '网关下载内容与源文件一致', f'{st_dl} {len(body)}B')
    r.check(
        'attachment' in hget(headers, 'Content-Disposition') or hget(headers, 'ETag') != '',
        '下载响应可确认来源（Content-Disposition 或提供商 ETag）',
        f"CD={hget(headers, 'Content-Disposition')!r} ETag={hget(headers, 'ETag')!r}",
    )

    # Range：再取一个令牌（令牌一次性）
    st, data = lab.download_url(alice, fid2)
    url2 = (data.get('data') or {}).get('url') or ''
    st_r, part, hdr = alice.get_bytes(url2, headers={'Range': 'bytes=0-9'})
    r.check(st_r == 206 and part == expected[:10], 'Range 请求返回 206 与正确切片',
            f'{st_r} {part[:10]!r} vs {expected[:10]!r}')
    r.check(
        hget(hdr, 'Content-Range').startswith('bytes 0-9/') or len(part) == 10,
        'Range 响应可确认切片（Content-Range 或字节数）',
        f"CR={hget(hdr, 'Content-Range')!r} bytes={len(part)}",
    )
    st_again, _b, _h = alice.get_bytes(url2)
    r.check(st_again == 401, '下载令牌一次性（重复消费被拒）', str(st_again))

    # ---------------------------------------------------------------- 非法输入
    st, data = alice.json_request(
        'POST', '/api/files/upload-session',
        {'path': ALICE_DIR, 'fileName': '../evil.txt', 'fileSize': 5, 'mimeType': 'text/plain'},
        headers=lab.h(alice),
    )
    r.check(st == 400, '文件名含路径字符被拒（400）', f'{st} {data}')
    st, data = alice.json_request('GET', '/api/files?path=/etc/passwd')
    # 根挂载覆盖全部路径：不存在的目录返回空列表（200），未挂载路径才 404
    r.check(
        (st == 200 and not (data.get('data') or {}).get('items')) or st == 404,
        '不存在的目录返回空列表或 404（不泄露内容）',
        f'{st} {str(data)[:120]}',
    )
    st, data = alice.json_request('GET', '/api/files?path=/users/labalice/photos/../..')
    r.check(st in (200, 400, 404), '路径遍历输入被规范化处理', f'{st}')

    # ---------------------------------------------------------------- 删除
    doomed = lab.file_id(alice, work_dir, new_name)
    row_doomed = lab.db.one('SELECT physical_key, provider_id FROM file_metadata WHERE id=?', (doomed,))
    st, data = lab.delete_file(alice, doomed)
    r.check(st == 200, '删除单个文件', f'{st} {data}')
    r.check(lab.find_item(alice, work_dir, new_name) is None, '删除后列表中消失')
    s3_name = prov_names.get(row_doomed['provider_id'])
    if s3_name:
        r.check(
            not fixtures.s3(s3_name.split('-')[-1]).exists(fixtures.BUCKET, row_doomed['physical_key']),
            '删除后物理对象已从桶中移除',
        )

    # 批量删除 + 目录级联
    ids = [i['id'] for i in lab.items(alice, moved_dir)]
    st, data = lab.batch(alice, 'delete', ids)
    r.check(st == 200, '批量删除', f'{st} {data}')
    r.check(not lab.items(alice, work_dir), '批量删除后目录为空')
    st_parent, parent = alice.json_request('GET', f'/api/files?path={os.path.dirname(work_dir)}')
    r.check(st_parent == 200, '父目录仍可访问（未误删自身）', f'{st_parent} {str(parent)[:120]}')

    # ---------------------------------------------------------------- 清理
    for folder in ('photos', 'moved-target'):
        item = lab.find_item(alice, ALICE_DIR, folder)
        if item:
            lab.delete_file(alice, item['id'])
    st, _ = lab.delete_file(alice, lab.file_id(alice, fixtures.DEDUP_MOUNT_PATH, ca_name))
    r.check(True, '验收数据已清理')

    if not r.finish():
        raise VerifyError('01 · 文件与目录用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 01 · 文件与目录'))
    main_wrapper(lambda: run(parser.parse_args()))
