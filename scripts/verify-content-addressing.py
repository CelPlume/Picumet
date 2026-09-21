#!/usr/bin/env python3
"""§F 内容哈希寻址本地验收：同内容只存一份物理对象、引用释放与回收队列、覆盖写。

用法（先启动本地开发栈 `cd workers && bun run dev -- --test-scheduled`）：

    python3 scripts/verify-content-addressing.py --base-url http://localhost:8787

断言链：
1. 同一内容上传到两个路径 → 两行共享同一 physical_key/blob_hash，blob_objects 只有一行，
   本地 R2 桶内 `picumet:blob/` 命名空间只有一个对象；
2. 两处都能读回同一内容（读路径按物理键定位）；
3. 删除其一 → 对象保留、回收队列为空；删除其二 → blob_objects 清空、blob_gc 入队、对象仍在（保护期）；
4. 触发一次 scheduled（需 `--test-scheduled`）→ 保护期后对象删除、队列清空；
5. 覆盖写 → 行指向新内容键，旧内容对象进入回收队列。

仅本地环境可用：D1 走 `wrangler d1 execute --local`，桶内对象探测读 miniflare 的 sqlite。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _picumet_e2e import (  # noqa: E402
    LocalDb, Session, VerifyError, add_common_args, create_api_key, csrf, expect, login, main_wrapper,
    multipart, require_server, section, trigger_scheduled,
)

BLOB_PREFIX = 'picumet:blob/'


def run(args: argparse.Namespace) -> None:
    session = Session(args.base_url)
    db = LocalDb(pathlib.Path(args.workers_dir))
    suffix = uuid.uuid4().hex[:8]
    dir_a, dir_b = f'/verify-ca-{suffix}/one.txt', f'/verify-ca-{suffix}/two.txt'
    dir_over = f'/verify-ca-{suffix}/overwrite.txt'
    content = f'content-addressing-verify-{suffix}'
    other = f'content-addressing-verify-other-{suffix}'
    key = ''

    # 清掉上次失败残留（幂等）
    db.query("DELETE FROM file_metadata WHERE path LIKE '/verify-ca-%'")

    section('前置检查')
    require_server(session)
    login(session, args.username, args.password)
    key = create_api_key(session, f'verify-ca-{suffix}', ['write', 'read', 'delete'])['fullToken']
    expect(True, f'开发服务器可达且已签发网关密钥（{args.base_url}）')

    def upload(path: str, payload: str) -> int:
        body, ctype = multipart({'path': path.rsplit('/', 1)[0]}, 'file', path.rsplit('/', 1)[1], payload.encode())
        status, raw, _ = session.request('POST', '/api/upload', body=body, headers={'Authorization': f'Bearer {key}', 'Content-Type': ctype})
        if status != 200:
            raise VerifyError(f'上传 {path} 失败（{status}）：{raw[:200]!r}')
        return status

    def read(path: str) -> tuple[int, str]:
        status, raw, _ = session.request('GET', f'/api/compat/file?path={path}', headers={'Authorization': f'Bearer {key}'})
        return status, raw.decode('utf-8', 'replace')

    def rows(path: str) -> list[dict]:
        return db.query(
            f"SELECT name, object_key, physical_key, blob_hash, size FROM file_metadata "
            f"WHERE path='{path.rsplit('/', 1)[0]}' AND type='file' ORDER BY name"
        )

    def delete(path: str) -> int:
        parent, name = path.rsplit('/', 1)
        row = db.query(f"SELECT id FROM file_metadata WHERE path='{parent}' AND name='{name}' AND type='file'")
        if not row:
            raise VerifyError(f'待删除文件行不存在：{path}')
        status, raw, _ = session.request('DELETE', f"/api/files/{row[0]['id']}", headers={'X-CSRF-Token': csrf(session)})
        if status != 200:
            raise VerifyError(f'删除 {path} 失败（{status}）：{raw[:200]!r}')
        return status

    section('① 同内容两处上传 → 单份物理对象')
    upload(dir_a, content)
    upload(dir_b, content)
    entries = rows(dir_a)
    expect(len(entries) == 2, f'两次上传落两行元数据（{len(entries)}）')
    expect({e['physical_key'] for e in entries} == {entries[0]['physical_key']}, f"两行共享物理键 {entries[0]['physical_key'][:32]}…")
    expect({e['blob_hash'] for e in entries} == {entries[0]['blob_hash']}, '两行共享内容哈希')
    hash_value = entries[0]['blob_hash']
    blob_rows = db.query(f"SELECT hash, object_key, size FROM blob_objects WHERE hash='{hash_value}'")
    expect(len(blob_rows) == 1, 'blob_objects 中该内容只有一行索引')

    bucket_keys = db.local_r2_keys(BLOB_PREFIX)
    if bucket_keys is None:
        print('  · 跳过桶内对象计数（非本地环境或未找到 miniflare R2 状态）')
    else:
        expect(bucket_keys.count(blob_rows[0]['object_key']) == 1, f'本地 R2 桶内该内容对象只有一份（{BLOB_PREFIX} 共 {len(bucket_keys)} 个）')

    section('② 读路径按物理键取对象')
    for path in (dir_a, dir_b):
        status, body = read(path)
        expect(status == 200 and body == content, f'{path} 读回内容一致')

    section('③ 引用释放与回收队列')
    delete(dir_a)
    expect(len(db.query(f"SELECT hash FROM blob_objects WHERE hash='{hash_value}'")) == 1, '删除其一：内容索引保留')
    expect(len(db.query(f"SELECT hash FROM blob_gc WHERE hash='{hash_value}'")) == 0, '删除其一：未入回收队列')
    delete(dir_b)
    expect(len(db.query(f"SELECT hash FROM blob_objects WHERE hash='{hash_value}'")) == 0, '删除其二：内容索引已清空')
    expect(len(db.query(f"SELECT hash FROM blob_gc WHERE hash='{hash_value}'")) == 1, '删除其二：对象已入回收队列')

    section('④ 保护期后回收')
    if args.skip_gc:
        print('  · 按 --skip-gc 跳过（队列保留，定时任务会在生产/迁移后自然处理）')
    else:
        print(f'  · 等待保护期 {args.grace_wait}s 后触发 scheduled')
        time.sleep(args.grace_wait)
        if not trigger_scheduled(session):
            raise VerifyError('触发 scheduled 失败：请用 `bun run dev -- --test-scheduled` 启动开发服务器')
        time.sleep(2)
        expect(len(db.query(f"SELECT hash FROM blob_gc WHERE hash='{hash_value}'")) == 0, '回收队列已清空')
        if bucket_keys is not None:
            expect(db.local_r2_keys(BLOB_PREFIX).count(blob_rows[0]['object_key']) == 0, '本地 R2 桶内对象已删除')

    section('⑤ 覆盖写释放旧内容')
    upload(dir_over, content)
    old_hash = db.query(f"SELECT blob_hash FROM file_metadata WHERE name='overwrite.txt'")[0]['blob_hash']
    upload(dir_over, other)
    new_row = db.query(f"SELECT physical_key, blob_hash FROM file_metadata WHERE name='overwrite.txt'")[0]
    expect(new_row['blob_hash'] != old_hash, '行已指向新内容哈希')
    status, body = read(dir_over)
    expect(status == 200 and body == other, '读回新内容')
    expect(len(db.query(f"SELECT hash FROM blob_gc WHERE hash='{old_hash}'")) == 1, '旧内容对象已入回收队列')
    delete(dir_over)

    section('⑥ 清理验收数据')
    db.exec(f"DELETE FROM file_metadata WHERE path LIKE '/verify-ca-{suffix}%'")
    db.exec(f"DELETE FROM api_keys WHERE name='verify-ca-{suffix}'")
    expect(len(db.query(f"SELECT id FROM file_metadata WHERE path LIKE '/verify-ca-{suffix}%'")) == 0, '验收目录行与密钥已清理')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='§F 内容哈希寻址本地验收'))
    parser.add_argument('--grace-wait', type=int, default=65, help='回收保护期等待秒数（默认 65，> 服务端 60s 保护期）')
    parser.add_argument('--skip-gc', action='store_true', help='跳过保护期等待与 scheduled 触发')
    main_wrapper(lambda: run(parser.parse_args()))
