#!/usr/bin/env python3
"""02 · 内容寻址（§F）：同内容只落一份物理对象、引用释放与回收队列、覆盖写入队。

两条写入入口在本轮实测中表现**不一致**，本套件同时钉住「设计意图」与「实际行为」：
  A. 文件上传会话入口（`POST /api/files/upload-session` + `PUT /upload/raw` + `POST /upload-complete`）
     —— Worker 代理时会写内容键，但**不登记 blob_objects 索引**，引用释放/回收随之失效。
  B. 兼容上传入口（`POST /api/upload`，API Key → `upsertFileObject` → write.ts）——索引、去重、GC 完整。
  C. S3 预签名直传——写虚拟路径键，`blob_hash` 为空，不参与内容寻址。

    python3 scripts/lab/02_content_addressing.py             # 含保护期等待（约 65s）
    python3 scripts/lab/02_content_addressing.py --skip-gc    # 跳过等待与定时任务
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import LocalDb, Reporter, VerifyError, add_common_args, main_wrapper, trigger_scheduled  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

DEDUP_DIR = fixtures.DEDUP_MOUNT_PATH
PUBLIC_DIR = fixtures.PUBLIC_MOUNT_PATH


def compat_multipart(filename: str, content: bytes, path: str | None = None) -> tuple[bytes, str]:
    """构造兼容上传（multipart/form-data）请求体；路径以 `path` 表单字段给出（契约如此）"""
    boundary = f'----picumetlab{uid()}'
    chunks: list[bytes] = []
    if path is not None:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n{path}\r\n'.encode()
        )
    chunks.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'
        ).encode()
        + content
        + b'\r\n'
    )
    chunks.append(f'--{boundary}--\r\n'.encode())
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


def object_key_holders(local_db: LocalDb, name: str) -> list[str]:
    return [k for k in (local_db.local_r2_keys('picumet:blob/') or []) if name in k]


def run(args: argparse.Namespace) -> None:
    r = Reporter('02_content_addressing')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    dedup_mount = topo['dedup']['id']
    public_mount = topo['public']['id']
    local_db = LocalDb(lab.workers_dir)

    lab.purge_dir(alice, DEDUP_DIR)
    lab.purge_dir(alice, PUBLIC_DIR)

    # ================================================================ A. 文件上传会话入口（R2 绑定 / Worker 代理）
    content = f'content-addressed-{uid()}'.encode()
    a1, a2 = f'sess-a-{uid()}.bin', f'sess-b-{uid()}.bin'
    lab.upload(alice, DEDUP_DIR, a1, content, 'application/octet-stream')
    lab.upload(alice, DEDUP_DIR, a2, content, 'application/octet-stream')
    row1 = lab.file_row(dedup_mount, DEDUP_DIR, a1)
    row2 = lab.file_row(dedup_mount, DEDUP_DIR, a2)
    r.check(bool(row1 and row1['blob_hash']), 'A1 会话路径写入内容键并记录 blob_hash', str(row1))
    r.check(
        row1['blob_hash'] == row2['blob_hash'] and row1['physical_key'] == row2['physical_key'],
        'A2 同内容两行共享 physical_key / blob_hash（内容键确定性）',
        f"{row1['physical_key']} vs {row2['physical_key']}",
    )
    keys = object_key_holders(local_db, row1['blob_hash'])
    r.check(len(keys) == 1, 'A3 桶内只有一份该内容对象（物理去重生效）', str(keys))
    index_rows = lab.db.query('SELECT hash, mount_id FROM blob_objects WHERE mount_id=? AND hash=?', (dedup_mount, row1['blob_hash']))
    r.check(
        len(index_rows) == 1,
        'A4 内容索引 blob_objects 已登记 (hash, mount)',
        f'实际 {len(index_rows)} 行 —— 会话路径未登记索引（见报告 F-02）',
    )
    logs = lab.db.query(
        "SELECT metadata FROM access_logs WHERE action='upload' AND path=? ORDER BY created_at DESC LIMIT 2", (DEDUP_DIR,)
    )
    deduped_flags = [('"deduped":true' in (row['metadata'] or '')) for row in logs]
    r.check(
        any(deduped_flags),
        'A5 第二次上传被识别为去重命中（access_logs.metadata.deduped=true）',
        f'实际 {deduped_flags}',
    )

    lab.delete_file(alice, row1['id'])
    r.check(bool(object_key_holders(local_db, row1['blob_hash'])), 'A6 删除第一处引用后物理对象保留')
    r.check(lab.db.query('SELECT hash FROM blob_gc WHERE hash=?', (row1['blob_hash'],)) == [], 'A7 仍有引用时回收队列为空')
    lab.delete_file(alice, row2['id'])
    gc_rows = lab.db.query('SELECT hash, mount_id, object_key FROM blob_gc WHERE hash=?', (row1['blob_hash'],))
    r.check(
        len(gc_rows) == 1,
        'A8 删净引用后进入回收队列 blob_gc',
        f'实际 blob_gc 行数 {len(gc_rows)} —— 未登记索引导致无引用可释放（见报告 F-02）',
    )

    # ================================================================ B. 兼容上传入口（write.ts 正例对照）
    lab.purge_keys(alice)
    key_info = lab.create_key(alice, f'lab-ca-{uid()}', ['read', 'write', 'delete'], ['api'], uploadPath='/')
    token = key_info['key']['fullToken']
    compat_content = f'compat-ca-{uid()}'.encode()
    compat_names = [f'compat-a-{uid()}.bin', f'compat-b-{uid()}.bin']
    for name in compat_names:
        body, ctype = compat_multipart(name, compat_content, path='dedup')  # uploadPath='/' → 落到 /dedup
        st, _raw, _hdrs = alice.request('POST', '/api/upload', body=body,
                                        headers={'Content-Type': ctype, 'Authorization': f'Bearer {token}'})
        r.check(st == 200, f'B1 兼容上传 {name} 成功', f'{st} {_raw[:160]!r}')
    cr1 = lab.file_row(dedup_mount, DEDUP_DIR, compat_names[0])
    cr2 = lab.file_row(dedup_mount, DEDUP_DIR, compat_names[1])
    r.check(
        bool(cr1 and cr2) and cr1['blob_hash'] == cr2['blob_hash'] and cr1['physical_key'] == cr2['physical_key'],
        'B2 兼容上传：同内容两行共享内容键与 blob_hash',
        f'{cr1} / {cr2}',
    )
    c_index = lab.db.query('SELECT hash, mount_id, provider_id FROM blob_objects WHERE mount_id=? AND hash=?', (dedup_mount, cr1['blob_hash']))
    r.check(len(c_index) == 1, 'B3 兼容上传登记内容索引 blob_objects（正例对照）', str(c_index))
    lab.delete_file(alice, cr1['id'])
    r.check(bool(object_key_holders(local_db, cr1['blob_hash'])), 'B4 删除其一后对象保留')
    lab.delete_file(alice, cr2['id'])
    c_gc = lab.db.query('SELECT hash, mount_id FROM blob_gc WHERE hash=?', (cr1['blob_hash'],))
    r.check(len(c_gc) == 1, 'B5 兼容上传删净后进入回收队列（正例对照）', str(c_gc))

    # ================================================================ C. 回收保护期 + 定时任务
    if args.skip_gc:
        r.note('跳过保护期等待与定时任务触发（--skip-gc）')
        leaked = object_key_holders(local_db, row1['blob_hash'])
        if leaked:
            r.note('会话路径遗留对象（无回收队列条目，本轮不删除）', str(leaked))
    else:
        time.sleep(args.grace_wait)
        r.note(f'等待 {args.grace_wait}s 保护期后触发 scheduled')
        ok = trigger_scheduled(alice)
        r.check(ok, 'C1 触发定时任务成功（需 --test-scheduled 启动）')
        if ok:
            time.sleep(2)
            remaining = lab.db.query('SELECT hash FROM blob_gc WHERE hash IN (?, ?)', (row1['blob_hash'], cr1['blob_hash']))
            r.check(
                not [x for x in remaining if x['hash'] == cr1['blob_hash']],
                'C2 兼容上传的对象保护期后从队列清空并物理删除（正例对照）',
                str(remaining),
            )
            r.check(
                not object_key_holders(local_db, cr1['blob_hash']),
                'C3 兼容上传物理对象已删除',
                str(object_key_holders(local_db, cr1['blob_hash'])),
            )
            leaked = object_key_holders(local_db, row1['blob_hash'])
            r.check(
                not leaked,
                'C4 会话路径对象在保护期后被回收',
                f'仍残留 {leaked} —— 会话路径未登记索引，孤儿对象无回收路径（见报告 F-02）',
            )
            # 清理本轮发现的泄漏对象，避免污染后续断言
            for key_name in leaked:
                try:
                    local_db.exec(f"DELETE FROM _mf_objects WHERE key='{key_name}'")
                except VerifyError:
                    pass

    # ================================================================ D. 跨挂载隔离（TOP-10，正例路径）
    second = lab.ensure_mount(
        {
            'providerId': topo['binding']['id'],
            'mountPath': '/dedup2',
            'name': '内容寻址对照组二',
            'priority': 600,
            'uploadMode': 'free',
            'poolMembers': [{'providerId': topo['binding']['id'], 'weight': 1, 'standby': False}],
            'rolePermissions': [{'role': 'user', 'permissions': ['read', 'write', 'update', 'delete', 'download']}],
        }
    )
    lab.purge_dir(alice, '/dedup2')
    shared = f'cross-mount-{uid()}'.encode()
    for mount_path in (DEDUP_DIR, '/dedup2'):
        body, ctype = compat_multipart(f'iso-{uid()}.bin', shared, path=mount_path.lstrip('/') or None)
        st, _raw, _hdrs = alice.request('POST', '/api/upload', body=body,
                                        headers={'Content-Type': ctype, 'Authorization': f'Bearer {token}'})
        r.check(st == 200, f'D1 兼容上传到 {mount_path} 成功', f'{st}')
    rows = lab.db.query('SELECT mount_id, provider_id, size FROM blob_objects WHERE size=?', (len(shared),))
    r.check(len(rows) == 2, 'D2 同内容在两挂载各写一份索引（(hash,mount) 隔离，TOP-10）', str(rows))
    lab.purge_dir(alice, '/dedup2')
    lab.delete_mount(second['id'])

    # ================================================================ E. S3 预签名：不参与内容寻址
    same = f'presigned-{uid()}'.encode()
    p1, p2 = f'presign-1-{uid()}.bin', f'presign-2-{uid()}.bin'
    lab.upload(alice, PUBLIC_DIR, p1, same, 'application/octet-stream')
    lab.upload(alice, PUBLIC_DIR, p2, same, 'application/octet-stream')
    pr1 = lab.file_row(public_mount, PUBLIC_DIR, p1)
    pr2 = lab.file_row(public_mount, PUBLIC_DIR, p2)
    r.check(
        pr1['physical_key'] != pr2['physical_key'] and not pr1['blob_hash'] and not pr2['blob_hash'],
        'E1 预签名直传同内容产生两份物理对象且无 blob_hash（不参与内容寻址）',
        f"keys=({pr1['physical_key']}, {pr2['physical_key']}) hashes=({pr1['blob_hash']}, {pr2['blob_hash']})",
    )
    for key_name in (pr1['physical_key'], pr2['physical_key']):
        r.check(fixtures.s3('C').exists(fixtures.BUCKET, key_name), f'E2 预签名对象存在于 C 桶：{key_name}')

    # ================================================================ 清理
    for name in (p1, p2):
        item = lab.find_item(alice, PUBLIC_DIR, name)
        if item:
            lab.delete_file(alice, item['id'])
    lab.purge_dir(alice, DEDUP_DIR)
    lab.delete_key(alice, key_info['key']['keyId'])
    r.note('验收数据已清理')

    if not r.finish():
        raise VerifyError('02 · 内容寻址用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 02 · 内容寻址'))
    parser.add_argument('--grace-wait', type=int, default=65, help='回收保护期等待秒数（默认 65，> 服务端 60s）')
    parser.add_argument('--skip-gc', action='store_true', help='跳过保护期等待与 scheduled 触发')
    main_wrapper(lambda: run(parser.parse_args()))
