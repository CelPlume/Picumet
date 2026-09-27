#!/usr/bin/env python3
"""08 · 大文件与分片上传：ISO 语料 + 断点续传契约。

两组对照：
  A. S3 桶（预签名分片）—— 会话创建即调用 CreateMultipartUpload（XML 解析）→ 本轮实测在 Workers
     运行时失败（`DOMParser is not defined`，见报告 P0/F-01）。用真实 ISO 复现，失败是发现项。
  B. R2 绑定（Worker 代理分片）—— 不走 XML，逐片 PUT + 服务端合并；用 WePE ISO（226 MiB / 29 片）
     验证确实能完成，并检验分片清单/续传/重复完成幂等。

    python3 scripts/lab/08_large_multipart.py [--skip-r2-multipart]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, PART_SIZE, uid  # noqa: E402
import corpus  # noqa: E402
import fixtures  # noqa: E402

DEDUP_DIR = fixtures.DEDUP_MOUNT_PATH
BIG_DIR = '/users/labalice/bigfiles'


def sha256_file(path: pathlib.Path, chunk: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as fh:
        for block in iter(lambda: fh.read(chunk), b''):
            digest.update(block)
    return digest.hexdigest()


def run(args: argparse.Namespace) -> None:
    r = Reporter('08_large_multipart')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    lab.purge_dir(alice, '/users/labalice')
    lab.mkdir(alice, '/users/labalice', 'bigfiles')
    lab.purge_dir(alice, DEDUP_DIR)

    # ================================================================ A. S3 预签名分片（预期失败：P0）
    isos = corpus.iso_samples()
    r.note('ISO 语料', ', '.join(f'{p.name} ({p.stat().st_size / 1024 / 1024:.0f} MiB)' for p in isos))
    for iso in isos:
        size = iso.stat().st_size
        st, data = alice.json_request(
            'POST', '/api/files/upload-session',
            {'path': BIG_DIR, 'fileName': iso.name, 'fileSize': size, 'mimeType': 'application/octet-stream'},
            headers=lab.h(alice),
        )
        msg = str((data.get('error') or {}).get('message') or '')[:120]
        r.check(
            st == 200,
            f'L1 [{iso.name}] >100 MiB 上传会话创建成功',
            f'实际 {st} {msg} —— CreateMultipartUpload 的 XML 响应需要 DOMParser（见报告 F-01）',
        )
        if st == 200:
            sess = data['data']
            r.check(sess.get('uploadMode') == 'presigned' and sess.get('totalParts') == -(-size // PART_SIZE),
                    f'L2 [{iso.name}] 分片会话参数正确', str({k: sess.get(k) for k in ('uploadMode', 'totalParts')}))

    # 100 MiB 阈值边界：等于阈值走单对象，略超走分片
    boundary = 100 * 1024 * 1024
    st_eq, eq = alice.json_request('POST', '/api/files/upload-session',
                                   {'path': BIG_DIR, 'fileName': 'exact-100m.bin', 'fileSize': boundary,
                                    'mimeType': 'application/octet-stream'}, headers=lab.h(alice))
    if st_eq == 200:
        r.check(eq['data'].get('totalParts') is None, 'L3 恰好 100 MiB 走单对象（不分片）', str(eq['data'].get('totalParts')))
    else:
        r.check(False, 'L3 恰好 100 MiB 单对象会话创建成功', f'{st_eq} {str(eq)[:140]}')
    st_over, over = alice.json_request('POST', '/api/files/upload-session',
                                       {'path': BIG_DIR, 'fileName': 'over-100m.bin', 'fileSize': boundary + 1,
                                        'mimeType': 'application/octet-stream'}, headers=lab.h(alice))
    r.check(
        st_over != 200 and 'DOMParser' in str(over),
        'L4 略超 100 MiB 触发分片 → 命中同一 XML 解析缺陷',
        f'实际 {st_over} {str(over)[:160]}',
    )

    # ================================================================ B. R2 绑定 Worker 代理分片（正例对照）
    if args.skip_r2_multipart:
        r.note('跳过 R2 绑定分片上传（--skip-r2-multipart）')
    else:
        iso = isos[0]  # WePE64_V2.2.iso ≈226 MiB
        size = iso.stat().st_size
        headers = lab.h(alice)
        st_c, created = alice.json_request(
            'POST', '/api/files/upload-session',
            {'path': DEDUP_DIR, 'fileName': iso.name, 'fileSize': size, 'mimeType': 'application/octet-stream'},
            headers=headers,
        )
        r.check(st_c == 200, f'L5 [{iso.name}] R2 绑定分片会话创建成功', f'{st_c} {str(created)[:160]}')
        if st_c == 200:
            sess = created['data']
            total = sess.get('totalParts') or 0
            r.check(sess.get('uploadMode') == 'worker' and total == -(-size // PART_SIZE),
                    'L6 绑定模式下发 worker 分片模式与总片数', f"mode={sess.get('uploadMode')} totalParts={total}")
            sid = sess['sessionId']
            # 先只传 3 片，验证断点续传契约
            uploaded_etags = []
            with iso.open('rb') as fh:
                for part_number in range(1, 4):
                    fh.seek((part_number - 1) * PART_SIZE)
                    chunk = fh.read(PART_SIZE)
                    st_p, raw, _ = alice.request(
                        'PUT', f'/api/files/upload/multipart/{sid}/part/{part_number}', body=chunk,
                        headers={'Content-Type': 'application/octet-stream', **headers},
                    )
                    if st_p == 200:
                        uploaded_etags.append(json.loads(raw)['data']['etag'])
                    else:
                        r.check(False, f'L7 分片 {part_number} 上传失败', f'{st_p} {raw[:160]!r}')
            parts_state = lab.parts_of(alice, sid)
            r.check(parts_state.get('completedCount') == 3, 'L7 服务端记录已传 3 片', str(parts_state)[:200])
            r.check(parts_state.get('missingParts') == list(range(4, total + 1)), 'L8 返回缺口分片清单（续传契约）',
                    str(parts_state.get('missingParts'))[:120])
            st_early, early = alice.json_request('POST', '/api/files/upload-complete', {'sessionId': sid}, headers=headers)
            r.check(st_early == 422 and '分片不完整' in str(early), 'L9 缺片时完成被拒（422 分片不完整）',
                    f'{st_early} {str(early)[:160]}')
            # 补齐余下分片
            failures = []
            with iso.open('rb') as fh:
                for part_number in range(4, total + 1):
                    fh.seek((part_number - 1) * PART_SIZE)
                    chunk = fh.read(PART_SIZE)
                    st_p, raw, _ = alice.request(
                        'PUT', f'/api/files/upload/multipart/{sid}/part/{part_number}', body=chunk,
                        headers={'Content-Type': 'application/octet-stream', **headers},
                    )
                    if st_p != 200:
                        failures.append((part_number, st_p))
            r.check(not failures, 'L10 补齐全部分片', str(failures[:3]))
            t0 = time.time()
            st_done, done = alice.json_request('POST', '/api/files/upload-complete', {'sessionId': sid}, headers=headers)
            elapsed = time.time() - t0
            r.check(st_done == 200, f'L11 分片合并完成（{elapsed:.1f}s）', f'{st_done} {str(done)[:200]}')
            st_idem, idem = alice.json_request('POST', '/api/files/upload-complete', {'sessionId': sid}, headers=headers)
            r.check(
                st_idem == 200 and (idem.get('data') or {}).get('alreadyCompleted') is True,
                'L12 重复完成幂等（alreadyCompleted）',
                f'{st_idem} {str(idem)[:160]}',
            )
            row = lab.file_row(topo['dedup']['id'], DEDUP_DIR, iso.name)
            r.check(row is not None and row['size'] == size, 'L13 元数据大小与源文件一致', str(row))
            # 内容一致性（分片合并后的对象）
            _st, dl = alice.json_request('GET', f"/api/files/{row['id']}/download")
            url = (dl.get('data') or {}).get('url') or ''
            out = pathlib.Path('/tmp/lab-iso-download.bin')
            st_get, body, _h = alice.get_bytes(url, timeout=1800)
            if st_get == 200:
                out.write_bytes(body)
                r.check(sha256_file(out) == sha256_file(iso), 'L14 分片合并结果 SHA-256 与源 ISO 一致',
                        f'下载 {len(body)}B')
            else:
                r.check(False, 'L14 下载分片合并结果', f'{st_get}')
            r.check(
                not (row or {}).get('blob_hash'),
                'L15 【记录】分片路径不参与内容寻址（blob_hash 为空，DESIGN-NEW-03 已记录边界）',
                str((row or {}).get('blob_hash')),
            )
            lab.delete_file(alice, row['id'])
            out.unlink(missing_ok=True)

    # ================================================================ C. 清理
    lab.purge_dir(alice, '/users/labalice')
    lab.purge_dir(alice, DEDUP_DIR)
    r.note('验收数据已清理')

    if not r.finish():
        raise VerifyError('08 · 大文件/分片用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 08 · 大文件与分片'))
    parser.add_argument('--skip-r2-multipart', action='store_true', help='跳过 R2 绑定分片实测（较慢）')
    main_wrapper(lambda: run(parser.parse_args()))
