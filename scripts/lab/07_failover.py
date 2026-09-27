#!/usr/bin/env python3
"""07 · 容灾读回退（副桶 B）：主桶不可达时改向 B 请求；B 由外部同步通道镜像。

做法（对齐 docs/DEVELOPMENT 的 §G 验收思路）：
  1. 临时把根挂载池收敛为只有 A 可写，上传目标文件 → 确定落在 A；
  2. 恢复池 [A(主), D(拼好), B(standby)]，用**文件级通道**把 A 桶对象镜像到 B（模拟 rclone 等外部同步）；
  3. 停掉 A 实例（docker stop）→ 首次读取应在 8s 候选超时后由 B 返回 200 且内容一致；
  4. 第二次读取走 `serve:loc` 位置提示，显著更快；
  5. 恢复 A 实例。

需要 Docker 可用；`--skip-docker` 时只做元数据与静态断言。
"""
from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

S3_DIR = pathlib.Path('/home/excnies/picumet-s3/data')
DIR = '/users/labalice/failover-lab'
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def s3_sh(*args: str) -> tuple[int, str]:
    proc = subprocess.run(['bash', 'scripts/lab/env/s3/s3.sh', *args], cwd=str(REPO_ROOT),
                          capture_output=True, text=True, timeout=180)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def run(args: argparse.Namespace) -> None:
    r = Reporter('07_failover')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    root_id = topo['root']['id']
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    a_id, b_id, d_id = topo['providers']['A']['id'], topo['providers']['B']['id'], topo['providers']['D']['id']

    lab.purge_dir(alice, DIR)
    lab.mkdir(alice, '/users/labalice', 'failover-lab')

    # 1) 用 ordered + A 优先（sortOrder 0）确保新文件落在 A。
    #    注意不能把 D 从池里摘掉：D 上已有文件时移除成员按 TOP-08 会被 409 保护。
    st, body = lab.patch_mount(root_id, {
        'poolStrategy': 'ordered',
        'poolMembers': [
            {'providerId': a_id, 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': d_id, 'weight': 1, 'sortOrder': 1, 'standby': False},
            {'providerId': b_id, 'weight': 1, 'sortOrder': 2, 'standby': True},
        ],
    })
    r.check(st == 200, 'R1 切换 ordered 策略使新文件优先落在主桶 A', f'{st} {str(body)[:120]}')
    name = f'failover-{uid()}.bin'
    payload = (f'payload-for-failover-{uid()}'.encode()) * 64
    lab.upload(alice, DIR, name, payload, 'application/octet-stream')
    row = lab.file_row(root_id, DIR, name)
    r.check(row is not None and row['provider_id'] == a_id, 'R2 目标文件记录落桶为 A', str(row))
    key = row['physical_key']
    r.check(fixtures.s3('A').exists(fixtures.BUCKET, key), 'R3 对象存在于 A 桶')
    r.check(not fixtures.s3('B').exists(fixtures.BUCKET, key), 'R4 镜像前 B 桶没有该对象')

    # 2) 恢复池 + 文件级镜像 A → B
    st, _ = lab.patch_mount(root_id, {
        'poolStrategy': 'least_used',
        'poolMembers': [
            {'providerId': a_id, 'weight': 1, 'sortOrder': 0, 'standby': False},
            {'providerId': d_id, 'weight': 1, 'sortOrder': 1, 'standby': False},
            {'providerId': b_id, 'weight': 1, 'sortOrder': 2, 'standby': True},
        ],
    })
    r.check(st == 200, 'R5 池恢复为 [A 主, D 拼好, B 副/standby]', f'{st}')
    src = S3_DIR / 'a' / fixtures.BUCKET / key
    dst = S3_DIR / 'b' / fixtures.BUCKET / key
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        r.check(dst.is_file(), 'R6 外部同步通道把对象镜像到 B（文件级复制）')
    else:
        r.check(False, 'R6 外部同步通道把对象镜像到 B（文件级复制）', f'未找到 A 桶落地文件 {src}')
    r.check(fixtures.s3('B').exists(fixtures.BUCKET, key), 'R7 B 桶对象可见（S3 接口核对）')
    r.check(fixtures.s3('B').get_bytes(fixtures.BUCKET, key) == payload, 'R7b 镜像内容与源一致')

    # 3) 停 A → 读回退
    fid = row['id']
    if args.skip_docker:
        r.note('跳过 Docker 故障注入（--skip-docker）')
    else:
        code, out = s3_sh('stop-one', 'a')
        r.check(code == 0, 'R8 停止主桶实例 A', out[:160])
        try:
            time.sleep(1.5)
            t0 = time.time()
            st_dl, dl = alice.json_request('GET', f'/api/files/{fid}/download')
            url = (dl.get('data') or {}).get('url') or ''
            st_g, body, _h = alice.get_bytes(url, timeout=120)
            first = time.time() - t0
            r.check(st_g == 200 and body == payload, 'R9 主桶不可达时改向副桶 B 返回内容（容灾生效）',
                    f'{st_g} {len(body)}B {body[:24]!r}')
            t1 = time.time()
            st_dl2, dl2 = alice.json_request('GET', f'/api/files/{fid}/download')
            url2 = (dl2.get('data') or {}).get('url') or ''
            st_g2, body2, _h2 = alice.get_bytes(url2, timeout=120)
            second = time.time() - t1
            r.check(st_g2 == 200 and body2 == payload, 'R10 第二次读取仍成功', f'{st_g2}')
            r.check(second < first, 'R11 位置提示（serve:loc）使第二次读取更快', f'{second:.2f}s vs {first:.2f}s')
        finally:
            code, out = s3_sh('start-one', 'a')
            r.check(code == 0, 'R12 恢复主桶实例 A', out[:160])
            # 等待 A 重新就绪
            for _ in range(40):
                if fixtures.s3('A').ping().get('reachable'):
                    break
                time.sleep(0.5)
            st_dl3, dl3 = alice.json_request('GET', f'/api/files/{fid}/download')
            url3 = (dl3.get('data') or {}).get('url') or ''
            st_g3, body3, _h3 = alice.get_bytes(url3, timeout=60)
            r.check(st_g3 == 200 and body3 == payload, 'R13 恢复后仍可从主桶读取', f'{st_g3}')

    # 4) 副桶 B 从未被应用写入（判定标准：没有任何文件行把落桶记为 B）
    rows_on_b = lab.db.query('SELECT COUNT(*) AS c FROM file_metadata WHERE provider_id=?', (b_id,))
    r.check(
        (rows_on_b[0]['c'] if rows_on_b else 0) == 0,
        'R14 副桶 B 未被应用写入（无任何元数据行落在 B）',
        str(rows_on_b),
    )
    mirrored = [k for k in fixtures.s3('B').keys(fixtures.BUCKET) if k.startswith('users/')]
    r.note('B 桶内仅存在外部镜像通道写入的对象', str(sorted(mirrored)[:3]))

    lab.purge_dir(alice, DIR)
    if not r.finish():
        raise VerifyError('07 · 容灾用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 07 · 容灾读回退'))
    parser.add_argument('--skip-docker', action='store_true', help='跳过 Docker 故障注入')
    main_wrapper(lambda: run(parser.parse_args()))
