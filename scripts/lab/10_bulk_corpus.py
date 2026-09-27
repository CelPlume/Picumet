#!/usr/bin/env python3
"""10 · 真实语料批量上传：gastigado 素材库 + Archives/Video 中性缩略图 + 仓库文档/源码。

保留真实目录层级（逐段净化非法字符），校验元数据/物理对象/列表/树/管理端视图的一致性，
并统计落桶分布（拼好桶 A/D）。本轮上传的数据**保留**，作为 UI 验证与后续人工查看的样本。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab  # noqa: E402
import corpus  # noqa: E402
import fixtures  # noqa: E402

BULK_ROOT = '/bulk'
OWNER_DIR = '/users/labalice'


def run(args: argparse.Namespace) -> None:
    r = Reporter('10_bulk_corpus')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    root_id = topo['root']['id']
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    prov_names = lab.provider_name_map()

    if not args.keep:
        lab.purge_dir(alice, BULK_ROOT)
    lab.mkdir(alice, '/', 'bulk')

    groups = {
        'gastigado': (corpus.gastigado_plan(), corpus.GASTIGADO),
        'archives-video': (corpus.archive_plan(), corpus.ARCHIVES_VIDEO),
        'repo': (corpus.repo_plan(), corpus.REPO_ROOT),
    }
    stats: dict[str, dict] = {}
    for label, (files, base) in groups.items():
        started = time.time()
        uploaded = 0
        total_bytes = 0
        failures: list[str] = []
        for source in files:
            rel = source.relative_to(base)
            dirs = [corpus.sanitize_name(part) for part in rel.parent.parts if part not in ('', '.')]
            dest = '/'.join([BULK_ROOT, label, *dirs])
            if dest not in getattr(run, '_made', set()):
                parts = dest.strip('/').split('/')
                current = ''
                for seg in parts:
                    parent = current or '/'
                    current = f'{current}/{seg}'
                    if current not in getattr(run, '_made', set()):
                        st, _ = lab.mkdir(alice, parent, seg)
                        run._made = getattr(run, '_made', set()) | {current}
            try:
                lab.upload_local(alice, dest, source, filename=source.name)
                uploaded += 1
                total_bytes += source.stat().st_size
            except VerifyError as err:
                failures.append(f'{source.name}: {str(err)[:120]}')
        elapsed = time.time() - started
        stats[label] = {'files': len(files), 'uploaded': uploaded, 'bytes': total_bytes, 'seconds': round(elapsed, 1)}
        r.check(
            uploaded == len(files),
            f'B1 [{label}] 全部语料上传成功（{uploaded}/{len(files)}，{total_bytes / 1024 / 1024:.1f} MiB，{elapsed:.1f}s）',
            str(failures[:2]),
        )

    # ---------------------------------------------------------------- 一致性核对
    rows = lab.db.query(
        'SELECT name, path, size, provider_id, physical_key, blob_hash FROM file_metadata WHERE mount_id=? AND path LIKE ? AND type=?',
        (root_id, f'{BULK_ROOT}%', 'file'),
    )
    expected_files = sum(v['files'] for v in stats.values())
    r.check(len(rows) == expected_files, f'B2 元数据行数与语料数一致（{len(rows)}/{expected_files}）', str(len(rows)))
    expected_bytes = sum(v['bytes'] for v in stats.values())
    r.check(sum(row['size'] for row in rows) == expected_bytes, 'B3 元数据字节数与源文件一致',
            f"{sum(row['size'] for row in rows)} vs {expected_bytes}")

    by_bucket: dict[str, int] = {}
    by_bucket_bytes: dict[str, int] = {}
    missing: list[str] = []
    for row in rows:
        holder = (prov_names.get(row['provider_id'] or '') or '?').split('-')[-1]
        by_bucket[holder] = by_bucket.get(holder, 0) + 1
        by_bucket_bytes[holder] = by_bucket_bytes.get(holder, 0) + row['size']
        if holder in ('A', 'D') and not fixtures.s3(holder).exists(fixtures.BUCKET, row['physical_key']):
            missing.append(row['physical_key'])
    r.check(set(by_bucket) <= {'A', 'D'}, 'B4 全部语料落在可写成员 A/D（副桶 B 不参与写入）', str(by_bucket))
    r.check(not missing, 'B5 每个语料在记录桶中都有物理对象', str(missing[:3]))
    r.check(len(by_bucket) == 2, 'B6 拼好桶把语料分摊到两个桶', str(by_bucket))

    # 抽样逐目录列表核对（含深路径；深路径会命中 D1 LIKE 长度上限，见报告 F-04）
    dirs = sorted({row['path'] for row in rows})
    mismatched = []
    deep_failures = []
    for directory in dirs:
        expected = {row['name'] for row in rows if row['path'] == directory}
        if len(expected) > 40:
            expected = set(sorted(expected)[:40])  # 只抽查前 40 个名字，控制断言成本
        st_d, resp = alice.json_request('GET', f'/api/files?path={directory}')
        if st_d != 200:
            deep_failures.append((len(directory), directory, (resp.get('error') or {}).get('code')))
            continue
        actual = {i['name'] for i in (resp.get('data') or {}).get('items', [])}
        if not expected <= actual:
            mismatched.append((directory, sorted(expected - actual)[:2]))
    shallow = [name for name in dirs if not any(name == f[1] for f in deep_failures)]
    r.check(not mismatched, f'B7 逐目录列表与元数据一致（浅层 {len(dirs) - len(deep_failures)} 个目录）', str(mismatched[:3]))
    if deep_failures:
        shortest = min(deep_failures, key=lambda x: x[0])
        r.check(
            False,
            'B7b 深路径目录列表可用（D1 LIKE 模式长度上限，路径 ≥49 字符即 500）',
            f'{len(deep_failures)}/{len(dirs)} 个目录失败；最短失败路径 = {shortest[0]} 字符（{shortest[1]}）',
        )
    else:
        r.check(True, 'B7b 深路径目录列表可用')

    tree = lab.tree(alice, BULK_ROOT)
    tree_names = {item['name'] for item in tree['items']}
    r.check(len(tree_names) >= expected_files, 'B8 文件树覆盖全部语料', f'{len(tree_names)} >= {expected_files}')

    admin_files = lab.admin_files(limit=1)
    total_admin = ((admin_files.get('pagination') or {}).get('total')) or 0
    r.check(total_admin >= expected_files, 'B9 管理端「全部文件」可统计到语料', f'total={total_admin}')

    st_uls, usage = alice.json_request('GET', '/api/users/me/settings')
    used = ((usage.get('data') or {}).get('quota') or {}).get('usedStorage')
    r.check(used is not None and used >= expected_bytes, 'B10 用户配额用量已计入语料', f'{used} vs {expected_bytes}')

    r.note('落桶分布（文件数）', str(by_bucket))
    r.note('落桶分布（字节）', {k: f'{v / 1024 / 1024:.1f} MiB' for k, v in by_bucket_bytes.items()})
    for label, info in stats.items():
        r.note(f'[{label}] {info["uploaded"]} 文件 / {info["bytes"] / 1024 / 1024:.1f} MiB / {info["seconds"]}s')

    if not r.finish():
        raise VerifyError('10 · 批量语料上传存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 10 · 批量语料上传'))
    parser.add_argument('--keep', action='store_true', help='保留上一轮语料（默认先清空 /bulk）')
    main_wrapper(lambda: run(parser.parse_args()))
