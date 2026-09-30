#!/usr/bin/env python3
"""16 · 大文件全链路实测：真实 ISO 经 S3 预签名分片或 R2 绑定 Worker 代理分片。

与 `08_large_multipart.py` 的差异：08 是契约回归（会话创建/阈值/续传），本脚本对
**任意本地大文件**做端到端实测（全部分片直传/代理上传 → 合并 → 元数据 → 网关下载
SHA-256 对比 → 清理），用于验证动态分片放大（`MAX_MULTIPART_PARTS`）后的大文件可用性。

用法：
  python3 scripts/lab/16_big_iso.py --file /mnt/d/res/ISO/Win11_23H2_Chinese_Simplified_x64v2.iso
  python3 scripts/lab/16_big_iso.py --file <a> --file <b> --mount dedup   # R2 绑定路径
  python3 scripts/lab/16_big_iso.py --file <a> --keep                     # 保留上传结果

依赖：`00_setup.py` 已建好拓扑；上传主体默认 labalice（可用 --username/--password 指定其他账号，配额需容纳目标文件）。
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _lab import Lab  # noqa: E402
import fixtures  # noqa: E402

BIG_DIR = '/users/labalice/bigfiles'


def sha256_file(path: pathlib.Path, chunk: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as fh:
        for block in iter(lambda: fh.read(chunk), b''):
            digest.update(block)
    return digest.hexdigest()


def run(args: argparse.Namespace) -> None:
    lab = Lab(args.base_url, args.workers_dir)  # admin 会话：topology() 需要管理员列 provider
    uploader = lab.login(args.username, args.password, key='uploader')
    topo = fixtures.topology(lab)
    mount_id = (topo['dedup'] if args.mount == 'dedup' else topo['root'])['id']
    target_dir = DEDUP_DIR if args.mount == 'dedup' else BIG_DIR
    if args.mount != 'dedup':
        lab.mkdir(uploader, '/users/labalice', 'bigfiles')
    headers = lab.h(uploader)
    failures: list[str] = []

    for raw in args.file:
        iso = pathlib.Path(raw).resolve()
        size = iso.stat().st_size
        total = -(-size // (8 * 1024 * 1024))  # 占位；以会话返回为准
        src_hash = sha256_file(iso)
        print(f'\n=== {iso.name}  {size / 2**30:.2f} GiB  sha256={src_hash[:16]}…  mount={args.mount}  user={args.username}')

        t0 = time.time()
        st, data = uploader.json_request(
            'POST', '/api/files/upload-session',
            {'path': target_dir, 'fileName': iso.name, 'fileSize': size, 'mimeType': 'application/octet-stream'},
            headers=headers,
        )
        if st != 200:
            failures.append(f'{iso.name}: session {st} {str(data)[:200]}')
            print(f'  FAIL session {st} {str(data)[:200]}')
            continue
        sess = data['data']
        total = sess.get('totalParts') or 0
        part_size = (size + total - 1) // total if total else size  # 与前端 ceil(size/totalParts) 推导一致
        print(f"  session ok in {time.time() - t0:.1f}s  mode={sess.get('uploadMode')} totalParts={total} partSize={part_size / 2**20:.0f} MiB")

        # 逐片上传（预签名直传或 Worker 代理），失败重试 3 次
        etags: dict[int, str] = {}
        t1 = time.time()
        with iso.open('rb') as fh:
            for n in range(1, total + 1):
                fh.seek((n - 1) * part_size)
                chunk = fh.read(part_size)
                etag = None
                for attempt in range(3):
                    try:
                        if sess.get('uploadMode') == 'presigned':
                            url = sess['parts'][n - 1]['url']
                            status, etag = requests_put(url, chunk)
                            if status in (200, 201):
                                break
                            print(f'  part {n} -> {status} (attempt {attempt + 1})')
                        else:
                            st_p, raw_body, _ = uploader.request(
                                'PUT', f'/api/files/upload/multipart/{sess["sessionId"]}/part/{n}', body=chunk,
                                headers={'Content-Type': 'application/octet-stream', **headers},
                            )
                            if st_p == 200:
                                etag = json.loads(raw_body)['data']['etag']
                                break
                            print(f'  part {n} -> {st_p} (attempt {attempt + 1}) {raw_body[:80]!r}')
                    except Exception as exc:  # noqa: BLE001
                        print(f'  part {n} error (attempt {attempt + 1}): {exc!r}')
                    time.sleep(2 * (attempt + 1))
                if etag:
                    etags[n] = etag
        dt = time.time() - t1
        print(f'  parts {len(etags)}/{total} in {dt:.1f}s ({size / 2**20 / dt:.0f} MiB/s)')
        if len(etags) != total:
            failures.append(f'{iso.name}: parts {len(etags)}/{total}')
            continue

        t2 = time.time()
        payload: dict = {'sessionId': sess['sessionId']}
        if sess.get('uploadMode') == 'presigned':
            payload['parts'] = [{'partNumber': n, 'etag': e} for n, e in sorted(etags.items())]
        for attempt in range(3):
            try:
                st_c, done = uploader.json_request('POST', '/api/files/upload-complete', payload, headers=headers)
                break
            except Exception as exc:  # noqa: BLE001
                print(f'  complete attempt {attempt + 1} connection issue: {exc!r}')
                st_c, done = None, None
                time.sleep(3)
        if st_c != 200:
            failures.append(f'{iso.name}: complete {st_c} {str(done)[:200]}')
            print(f'  FAIL complete {st_c} {str(done)[:200]}')
            continue
        print(f'  complete ok in {time.time() - t2:.1f}s')

        row = lab.file_row(mount_id, target_dir, iso.name)
        if not row or row.get('size') != size:
            failures.append(f'{iso.name}: metadata mismatch {row}')
            print(f'  FAIL metadata {row}')
            continue
        print(f"  metadata ok  physical={str(row.get('physical_key'))[:48]}…")

        st_d, dl = uploader.json_request('GET', f"/api/files/{row['id']}/download")
        if st_d != 200:
            failures.append(f'{iso.name}: download token {st_d}')
            print(f'  FAIL download token {st_d}')
            continue
        url = dl['data']['url']
        t3 = time.time()
        digest = hashlib.sha256()
        n_bytes = 0
        import requests  # noqa: PLC0415
        with requests.get(url, stream=True, timeout=3600) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_content(8 * 1024 * 1024):
                digest.update(chunk)
                n_bytes += len(chunk)
        ok_hash = digest.hexdigest() == src_hash and n_bytes == size
        print(f'  download {n_bytes / 2**20:.0f} MiB in {time.time() - t3:.1f}s ({n_bytes / 2**20 / (time.time() - t3):.0f} MiB/s)  sha256 {"MATCH" if ok_hash else "MISMATCH"}')
        if not ok_hash:
            failures.append(f'{iso.name}: hash/size mismatch')

        if not args.keep:
            lab.delete_file(uploader, row['id'])

    print('\n--- done' if not failures else f'\n--- FAILURES: {len(failures)}')
    for f in failures:
        print('  -', f)
    sys.exit(1 if failures else 0)


LAST_ETAG: list[str] = []


def requests_put(url: str, chunk: bytes) -> tuple[int, str]:
    """预签名直传一次，返回 (status, etag)。"""
    import requests  # noqa: PLC0415

    r = requests.put(url, data=chunk, timeout=600)
    return r.status_code, r.headers.get('ETag', '').strip('"')


def main() -> None:
    parser = argparse.ArgumentParser(description='Picumet 实验室 16 · 大文件全链路实测')
    parser.add_argument('--file', action='append', required=True, help='本地大文件路径（可重复）')
    parser.add_argument('--mount', choices=['root', 'dedup'], default='root', help='root=S3 预签名分片；dedup=R2 绑定 Worker 代理')
    parser.add_argument('--keep', action='store_true', help='保留上传结果（默认校验后删除）')
    parser.add_argument('--username', default=fixtures.TEST_USERS['alice']['username'], help='上传主体（配额需容纳目标文件）')
    parser.add_argument('--password', default=fixtures.USER_PASSWORD)
    parser.add_argument('--base-url', default='http://127.0.0.1:8787')
    parser.add_argument('--workers-dir', default=str(pathlib.Path(__file__).resolve().parent.parent.parent / 'workers'))
    args = parser.parse_args()
    run(args)


if __name__ == '__main__':
    main()
