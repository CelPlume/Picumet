#!/usr/bin/env python3
"""14 · 样本播种（**非破坏性**）：把示例图片 / 视频 / ISO 镜像 / 中性缩略图留在对象存储，供后续开发测试。

与 00–13 的用例不同，本模块**不清理、不覆盖**：
  · 目标目录固定的样本集（`/samples/**`），已存在的同名文件跳过（幂等）；
  · `00_setup.py` 与各套件的清理都会跳过 `/samples` 与 `/bulk`（见 fixtures.PRESERVED_ROOT_DIRS）。

样本布局（用户要求保留）：
  /samples/images/*        图片（含中文 / 空格 / 括号文件名，落在根挂载 → 拼好桶 A/D）
  /samples/videos/*        视频（根挂载）
  /samples/thumbs/*        Archives/Video 的中性缩略图（仅封面图，不含露骨媒体本体）
  /samples/repo/*          仓库文档 / 源码（代码预览样本）
  /samples/isos/*          ISO/IMG 镜像 → 挂载在 R2 绑定提供商上（见下）

为什么 ISO 单独一个挂载：S3 provider 的分片上传需要 CreateMultipartUpload 的 XML 解析，实测在
workerd 下抛 `DOMParser is not defined`（报告 F-01），>100 MiB 无法经 S3 桶上传；R2 绑定走
Worker 代理分片（无 XML）可正常完成。故 `/samples/isos` 独立挂载到绑定提供商，样本得以真实入库。

    python3 scripts/lab/14_samples.py              # 全量播种（含 ISO，较慢）
    python3 scripts/lab/14_samples.py --skip-isos  # 只播图片/视频/缩略图/文档
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, guess_mime  # noqa: E402
import corpus  # noqa: E402
import fixtures  # noqa: E402

SAMPLES = '/samples'
ISO_MOUNT = '/samples/isos'
ISO_PRIORITY = 950
INVENTORY = pathlib.Path('.tmp/lab-results/14_samples.json')


def ensure_iso_mount(lab: Lab, topo: dict) -> dict:
    """ISO 子挂载：绑在 R2 绑定提供商上（S3 分片在 workerd 下不可用，见 F-01）。"""
    binding = topo['binding']
    return lab.ensure_mount({
        'providerId': binding['id'],
        'mountPath': ISO_MOUNT,
        'name': '样本镜像（R2 绑定）',
        'priority': ISO_PRIORITY,
        'uploadMode': 'free',
        'poolMembers': [{'providerId': binding['id'], 'weight': 1, 'standby': False}],
        'rolePermissions': [{'role': 'user', 'permissions': ['read', 'write', 'update', 'delete', 'download']}],
    })


def ensure_dir(lab: Lab, session, path: str) -> None:
    """逐级确保目录存在（幂等；已存在时接口返回 409，忽略）。"""
    parts = path.strip('/').split('/')
    current = ''
    for seg in parts:
        parent = current or '/'
        current = f'{current}/{seg}'
        lab.mkdir(session, parent, seg)


def seed_group(lab: Lab, r: Reporter, session, dest: str, files: list[pathlib.Path], label: str) -> dict:
    ensure_dir(lab, session, dest)
    existing = {i['name'] for i in lab.items(session, dest)}
    uploaded, skipped, failures, total_bytes = 0, 0, [], 0
    started = time.time()
    for source in files:
        if source.name in existing:
            skipped += 1
            continue
        try:
            lab.upload_local(session, dest, source, filename=source.name, mime=guess_mime(source.name))
            uploaded += 1
            total_bytes += source.stat().st_size
        except VerifyError as err:
            failures.append(f'{source.name}: {str(err)[:110]}')
    elapsed = round(time.time() - started, 1)
    r.check(
        not failures,
        f'S1 [{label}] 播种 {dest}：新增 {uploaded} / 跳过已存在 {skipped}'
        + (f'，{total_bytes / 1024 / 1024:.1f} MiB，{elapsed}s' if uploaded else ''),
        str(failures[:2]),
    )
    return {'dest': dest, 'uploaded': uploaded, 'skipped': skipped, 'bytes': total_bytes, 'seconds': elapsed, 'failures': failures}


def run(args: argparse.Namespace) -> None:
    r = Reporter('14_samples')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    root_id = topo['root']['id']

    # 样本区不加清理：只建立目录（/samples 本身若不存在则创建）
    ensure_dir(lab, alice, SAMPLES)
    r.check(lab.find_item(alice, '/', 'samples') is not None, 'S0 样本根目录 /samples 就绪')
    if not args.skip_isos:
        ensure_iso_mount(lab, topo)
        r.check(lab.find_mount(ISO_MOUNT) is not None, f'S0b 样本镜像挂载点 {ISO_MOUNT} 就绪（R2 绑定）')

    inventory: dict[str, object] = {'root': SAMPLES, 'groups': []}

    # ---- 图片 / 视频（根挂载 → 拼好桶 A/D，预签名直传） ----
    images = [p for p in corpus.gastigado_plan(max_files=600, max_file_bytes=12 * 1024 * 1024,
                                               max_total_bytes=200 * 1024 * 1024)
              if p.suffix.lower() in corpus.IMAGE_EXT][:14]
    inventory['groups'].append(seed_group(lab, r, alice, f'{SAMPLES}/images', images, '图片'))
    videos = corpus.gastigado_videos(limit=4)
    inventory['groups'].append(seed_group(lab, r, alice, f'{SAMPLES}/videos', videos, '视频'))
    thumbs = corpus.archive_plan(max_files=12, max_file_bytes=3 * 1024 * 1024, max_total_bytes=30 * 1024 * 1024)
    inventory['groups'].append(seed_group(lab, r, alice, f'{SAMPLES}/thumbs', thumbs, 'Archives 中性缩略图'))
    docs = corpus.repo_plan(max_files=8)
    inventory['groups'].append(seed_group(lab, r, alice, f'{SAMPLES}/repo', docs, '仓库文档/源码'))

    # ---- ISO 镜像（R2 绑定挂载，Worker 代理分片） ----
    if args.skip_isos:
        r.note('跳过 ISO 播种（--skip-isos）')
    else:
        isos = corpus.iso_samples()
        inventory['groups'].append(seed_group(lab, r, alice, ISO_MOUNT, isos, 'ISO 镜像'))
        iso_rows = lab.db.query(
            'SELECT name, size, provider_id, blob_hash FROM file_metadata WHERE path=? AND type=?', (ISO_MOUNT, 'file')
        )
        for src in isos:
            row = next((x for x in iso_rows if x['name'] == src.name), None)
            r.check(
                row is not None and row['size'] == src.stat().st_size,
                f'S2 ISO 样本 {src.name} 在库（{src.stat().st_size / 1024 / 1024:.0f} MiB）',
                str(row),
            )

    # ---- 落桶分布与物理对象核对（图片/视频/缩略图/文档在 A/D；ISO 在绑定桶） ----
    prov_names = lab.provider_name_map()
    rows = lab.db.query(
        "SELECT name, path, size, provider_id, physical_key FROM file_metadata WHERE path LIKE ? AND type='file'",
        (f'{SAMPLES}%',),
    )
    by_bucket: dict[str, int] = {}
    missing: list[str] = []
    for row in rows:
        holder = (prov_names.get(row['provider_id'] or '') or 'binding').split('-')[-1]
        by_bucket[holder] = by_bucket.get(holder, 0) + 1
        if holder in ('A', 'D') and not fixtures.s3(holder).exists(fixtures.BUCKET, row['physical_key']):
            missing.append(row['physical_key'])
    r.check(len(rows) > 0, f'S3 样本区共 {len(rows)} 个文件入库', str(by_bucket))
    r.check(not missing, 'S4 样本在记录桶中都有物理对象', str(missing[:3]))
    r.note('样本落桶分布', str(by_bucket))
    r.note('样本总字节', f"{sum(x['size'] for x in rows) / 1024 / 1024:.1f} MiB")

    inventory['files'] = len(rows)
    inventory['bytes'] = sum(x['size'] for x in rows)
    inventory['byBucket'] = by_bucket
    inventory['isos'] = [p.name for p in corpus.iso_samples()]
    INVENTORY.parent.mkdir(parents=True, exist_ok=True)
    INVENTORY.write_text(json.dumps(inventory, ensure_ascii=False, indent=2))

    r.note('样本清单已写入', str(INVENTORY))
    if not r.finish():
        raise VerifyError('14 · 样本播种存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 14 · 样本播种（保留）'))
    parser.add_argument('--skip-isos', action='store_true', help='跳过 ISO 镜像（体积大、耗时）')
    main_wrapper(lambda: run(parser.parse_args()))
