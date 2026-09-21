#!/usr/bin/env python3
"""§G 读路径容灾本地验收：文件落桶不可达时自动轮询同挂载点的其他桶（副桶）取回对象。

用法（先启动本地开发栈 `cd workers && bun run dev`）：

    python3 scripts/verify-storage-failover.py --base-url http://localhost:8787

做法：构造一个「坏主桶」（S3 端点指向不可达地址，连接会悬挂）作为文件记录落桶，再挂一个
真实的本地 R2 provider 作为池成员，并把对象真实放进 R2。断言链：
1. 首次读取：主桶尝试超时（服务端 8s 上限）后回退副桶 → 200 + 正确内容；
2. 命中提示生效：第二次读取显著更快（走 `serve:loc:<fileId>`，不再尝试坏主桶）；
3. 池成员（拼好桶）语义：同一挂载点的多个存储都是平级的可读目标。

结束后自动清理：文件行、挂载点、成员关系、坏 provider 与验收密钥。
仅本地环境可用（D1 走 `wrangler d1 execute --local`）。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _picumet_e2e import (  # noqa: E402
    LocalDb, Session, VerifyError, add_common_args, create_api_key, expect, login, main_wrapper,
    multipart, require_server, section,
)

BAD_PROVIDER_ID = 'prov-verify-bad-s3'
# 端口 9（discard）：本地没有服务监听，连接会被丢弃/悬挂 → 用来模拟"主桶不可达"
BAD_ENDPOINT = 'http://127.0.0.1:9'


def run(args: argparse.Namespace) -> None:
    session = Session(args.base_url)
    db = LocalDb(pathlib.Path(args.workers_dir))
    suffix = uuid.uuid4().hex[:8]
    mount_id = f'mount-verify-fo-{suffix}'
    mount_path = f'/verify-fo-{suffix}'
    file_id = f'file-verify-fo-{suffix}'
    file_name = 'fail.txt'
    content = f'failover-verify-{suffix}'

    def cleanup() -> None:
        db.query(f"DELETE FROM file_metadata WHERE id='{file_id}'")
        db.query(f"DELETE FROM mount_providers WHERE mount_id='{mount_id}'")
        db.query(f"DELETE FROM mounts WHERE id='{mount_id}'")
        db.query(f"DELETE FROM storage_providers WHERE id='{BAD_PROVIDER_ID}'")
        db.query(f"DELETE FROM api_keys WHERE name='verify-fo-{suffix}'")
        db.query(f"DELETE FROM file_metadata WHERE path LIKE '/verify-fo-src-{suffix}%'")

    cleanup()  # 清掉上次失败残留（幂等）
    try:
        section('前置检查')
        require_server(session)
        login(session, args.username, args.password)
        key = create_api_key(session, f'verify-fo-{suffix}', ['write', 'read'])['fullToken']
        expect(True, f'开发服务器可达且已签发网关密钥（{args.base_url}）')

        section('① 上传源文件拿到真实物理对象（落在 R2）')
        body, ctype = multipart({'path': f'/verify-fo-src-{suffix}'}, 'file', 'src.txt', content.encode())
        status, raw, _ = session.request(
            'POST', '/api/upload', body=body, headers={'Authorization': f'Bearer {key}', 'Content-Type': ctype}
        )
        if status != 200:
            raise VerifyError(f'上传源文件失败（{status}）：{raw[:200]!r}')
        src = db.query(f"SELECT id, physical_key, size, owner_id FROM file_metadata WHERE name='src.txt' AND path='/verify-fo-src-{suffix}'")
        if not src:
            raise VerifyError('源文件行未写入')
        physical_key, size, owner_id = src[0]['physical_key'], src[0]['size'], src[0]['owner_id']
        expect(bool(physical_key), f'源对象物理键 = {physical_key[:40]}…')

        section('② 构造「坏主桶 + 真实副桶」挂载')
        r2_provider = db.query("SELECT id FROM storage_providers WHERE name='本地存储'")
        if not r2_provider:
            raise VerifyError('未找到本地 R2 provider（先确保 seed 已运行）')
        r2_provider_id = r2_provider[0]['id']
        now = int(time.time() * 1000)
        db.query(
            "INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, path_prefix, created_at, updated_at, status) "
            f"VALUES ('{BAD_PROVIDER_ID}', '坏主桶-验收', 's3', '{BAD_ENDPOINT}', 'auto', 'nope', 'x', 'y', '', {now}, {now}, 'active')"
        )
        db.query(
            "INSERT INTO mounts (id, provider_id, mount_path, name, priority, created_at, updated_at, status, pool_strategy) "
            f"VALUES ('{mount_id}', '{BAD_PROVIDER_ID}', '{mount_path}', '容灾验收卷', 400, {now}, {now}, 'active', 'least_used')"
        )
        db.query(
            f"INSERT INTO mount_providers (mount_id, provider_id, weight, created_at) VALUES "
            f"('{mount_id}', '{BAD_PROVIDER_ID}', 1, {now}), ('{mount_id}', '{r2_provider_id}', 1, {now})"
        )
        db.query(
            "INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, provider_id, physical_key, blob_hash, created_at, updated_at) "
            f"VALUES ('{file_id}', '{mount_id}', '{mount_path}/{file_name}', '{mount_path}', '{file_name}', 'file', 'text/plain', {size}, '{owner_id}', '{BAD_PROVIDER_ID}', '{physical_key}', NULL, {now}, {now})"
        )
        expect(True, f'挂载 {mount_path}：成员 = [坏主桶, R2]；文件落桶记录为坏主桶')

        def read() -> tuple[int, str, float]:
            t0 = time.time()
            status, raw, _ = session.request(
                'GET', f'/api/compat/file?path={mount_path}/{file_name}', headers={'Authorization': f'Bearer {key}'}, timeout=120
            )
            return status, raw.decode('utf-8', 'replace'), time.time() - t0

        section('③ 首次读取：坏主桶超时 → 回退副桶')
        status, body_text, first = read()
        expect(status == 200, f'回退后返回 200（耗时 {first:.1f}s）')
        expect(body_text == content, '内容与源文件一致（由副桶 R2 提供）')

        section('④ 命中提示：第二次读取直取副桶')
        status, body_text, second = read()
        expect(status == 200 and body_text == content, '第二次读取同样返回 200 + 一致内容')
        expect(second < first / 2, f'第二次显著更快（{second:.2f}s vs {first:.2f}s）→ serve:loc 提示生效')
    finally:
        section('⑤ 清理验收数据')
        cleanup()
        print('  · 已删除验收文件行/挂载点/成员/坏 provider/密钥')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='§G 读路径容灾本地验收'))
    main_wrapper(lambda: run(parser.parse_args()))
