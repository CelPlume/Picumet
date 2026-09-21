#!/usr/bin/env python3
"""多项目分享本地验收：一个分享包含多个文件/文件夹、按哈希+分享者文件名读取、文件夹内浏览与撤销失效。

用法（先启动本地开发栈 `cd workers && bun run dev`）：

    python3 scripts/verify-share-items.py --base-url http://localhost:8787

断言链：
1. 创建分享（2 个文件 + 1 个文件夹混合）→ 201，items 顺序与请求一致，share_items 落 3 行，shares.file_id = 首项；
2. 公开详情（不带登录态）→ items 3 项、名称取分享者文件行的 name，响应体不含 physical_key/object_key；
3. 文件夹浏览 → 分享内文件夹可列子项；`sub` 越界（`../`）被拒；
4. 下载令牌 → 令牌 payload 的 objectKey 等于该文件行的 physical_key（§F 内容哈希）、name 等于该行文件名；
   文件夹内后代文件可签发，分享范围外的文件被拒；
5. 撤销 → 公开详情返回 410 SHARE_REVOKED（说明「永久有效」只描述过期时间，与状态互不影响）。

仅本地环境可用：D1 走 `wrangler d1 execute --local`。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _picumet_e2e import (  # noqa: E402
    LocalDb, Session, VerifyError, add_common_args, create_api_key, csrf, expect, login, main_wrapper,
    multipart, require_server, section,
)


def run(args: argparse.Namespace) -> None:
    session = Session(args.base_url)
    db = LocalDb(pathlib.Path(args.workers_dir))
    suffix = uuid.uuid4().hex[:8]
    prefix = f'/verify-share-{suffix}'
    name_a, name_b, name_in_folder = f'a-{suffix}.txt', f'b-{suffix}.txt', f'inner-{suffix}.txt'
    folder_name = f'folder-{suffix}'
    content_a, content_b, content_inner = f'share-a-{suffix}', f'share-b-{suffix}', f'share-inner-{suffix}'
    key = ''
    share_id = ''

    # 清掉上次失败残留（幂等）
    db.query(f"DELETE FROM file_metadata WHERE path LIKE '/verify-share-%'")
    db.query("DELETE FROM api_keys WHERE name LIKE 'verify-share-%'")

    section('前置检查')
    require_server(session)
    login(session, args.username, args.password)
    key = create_api_key(session, f'verify-share-{suffix}', ['write', 'read', 'delete'])['fullToken']
    expect(True, f'开发服务器可达且已签发网关密钥（{args.base_url}）')

    def upload(path: str, payload: str) -> None:
        body, ctype = multipart({'path': path.rsplit('/', 1)[0]}, 'file', path.rsplit('/', 1)[1], payload.encode())
        status, raw, _ = session.request(
            'POST', '/api/upload', body=body,
            headers={'Authorization': f'Bearer {key}', 'Content-Type': ctype},
        )
        if status != 200:
            raise VerifyError(f'上传 {path} 失败（{status}）：{raw[:200]!r}')

    def create_folder(path: str, name: str) -> str:
        status, data = session.json_request('POST', '/api/files/folder', {'path': path, 'name': name}, headers={'X-CSRF-Token': csrf(session)})
        if status != 201:
            raise VerifyError(f'创建文件夹 {path}/{name} 失败（{status}）：{data}')
        return data['data']['file']['id']

    def file_row(name: str) -> dict:
        rows = db.query(f"SELECT id, name, physical_key, blob_hash FROM file_metadata WHERE name='{name}' AND type='file'")
        if not rows:
            raise VerifyError(f'文件行不存在：{name}')
        return rows[0]

    def raw_get(path: str) -> tuple[int, str]:
        status, raw, _ = session.request('GET', path)
        return status, raw.decode('utf-8', 'replace')

    section('① 创建多项目分享（2 文件 + 1 文件夹）')
    upload(f'{prefix}/{name_a}', content_a)
    upload(f'{prefix}/{name_b}', content_b)
    folder_id = create_folder(prefix, folder_name)
    upload(f'{prefix}/{folder_name}/{name_in_folder}', content_inner)
    row_a, row_b, row_inner = file_row(name_a), file_row(name_b), file_row(name_in_folder)

    status, data = session.json_request(
        'POST', '/api/shares',
        {'fileIds': [row_a['id'], folder_id, row_b['id']], 'allowDownload': True, 'allowPreview': True},
        headers={'X-CSRF-Token': csrf(session)},
    )
    if status != 201:
        raise VerifyError(f'创建分享失败（{status}）：{data}')
    share = data['data']['share']
    share_id = share['id']
    expect([i['id'] for i in share['items']] == [row_a['id'], folder_id, row_b['id']], '返回的 items 顺序与请求顺序一致')
    expect(len(share['items']) == 3, '分享包含 3 个项目')
    item_rows = db.query(f"SELECT file_id, sort_order FROM share_items WHERE share_id='{share_id}' ORDER BY sort_order")
    expect([r['file_id'] for r in item_rows] == [row_a['id'], folder_id, row_b['id']], 'share_items 落库 3 行且顺序一致')
    head = db.query(f"SELECT file_id FROM shares WHERE id='{share_id}'")
    expect(head[0]['file_id'] == row_a['id'], 'shares.file_id 记录首个项目（单文件兼容语义）')

    section('② 公开详情按分享者文件名展示、且不下发物理键')
    status, body = raw_get(f'/api/shares/{share_id}')
    expect(status == 200, f'公开详情可访问（{status}）')
    expect('physical_key' not in body and '"objectKey"' not in body, '响应体不含 physical_key / objectKey')
    status, detail = session.json_request('GET', f'/api/shares/{share_id}')
    items = detail['data']['share']['items']
    expect([i['name'] for i in items] == [name_a, folder_name, name_b], '项目名称取分享者文件行上的 name')
    expect(items[1]['type'] == 'folder', '文件夹项目按 folder 类型返回')
    expect(all(i.get('rootId') for i in items), '每个项目带 rootId')

    section('③ 分享内文件夹浏览与越界拦截')
    status, listing = session.json_request('GET', f'/api/shares/{share_id}/list?root={folder_id}&sub=/')
    expect(status == 200 and [i['name'] for i in listing['data']['items']] == [name_in_folder], '文件夹项目可列出其子项')
    status, escaped = session.json_request('GET', f'/api/shares/{share_id}/list?root={folder_id}&sub=/../{name_a}')
    expect(status >= 400, f'sub 越界请求被拒（{status}）')

    section('④ 下载令牌指向内容哈希与分享者文件名')
    status, dl = session.json_request('GET', f'/api/shares/{share_id}/download?itemId={row_a["id"]}')
    if status != 200:
        raise VerifyError(f'签发下载令牌失败（{status}）：{dl}')
    tokens = db.query(f"SELECT payload FROM download_tokens WHERE payload LIKE '%{share_id}%' ORDER BY created_at DESC LIMIT 1")
    if not tokens:
        raise VerifyError('download_tokens 未落库')
    import json
    payload = json.loads(tokens[0]['payload'])
    expect(payload['objectKey'] == row_a['physical_key'], '令牌 objectKey = 该行的 physical_key（§F 内容哈希）')
    expect(payload['name'] == name_a, '令牌 name = 分享者文件行上的文件名')

    status, dl_inner = session.json_request('GET', f'/api/shares/{share_id}/download?itemId={row_inner["id"]}')
    expect(status == 200, f'文件夹内后代文件可签发下载（{status}）')

    status, _ = session.json_request('GET', f'/api/shares/{share_id}/download?itemId=not-an-item')
    expect(status >= 400, f'分享范围外的 itemId 被拒（{status}）')

    status, raw, _ = session.request('GET', dl['data']['url'])
    expect(status == 200 and raw.decode('utf-8', 'replace') == content_a, '下载地址可取回原始内容')

    section('⑤ 撤销后公开详情返回 SHARE_REVOKED')
    session.json_request('DELETE', f'/api/shares/{share_id}', headers={'X-CSRF-Token': csrf(session)})
    status, revoked = session.json_request('GET', f'/api/shares/{share_id}')
    expect(status == 410 and revoked.get('error', {}).get('code') == 'SHARE_REVOKED', f'撤销后返回 410 SHARE_REVOKED（{status}）')
    expect(revoked.get('error', {}).get('message') == '分享已被撤销', '错误文案与前端分享页提示一致')

    section('⑥ 清理验收数据')
    db.exec(f"DELETE FROM file_metadata WHERE path LIKE '{prefix}%'")
    db.exec(f"DELETE FROM shares WHERE id='{share_id}'")
    db.exec(f"DELETE FROM api_keys WHERE name='verify-share-{suffix}'")
    expect(len(db.query(f"SELECT id FROM file_metadata WHERE path LIKE '{prefix}%'")) == 0, '验收行、分享与密钥已清理')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='多项目分享本地验收'))
    main_wrapper(lambda: run(parser.parse_args()))
