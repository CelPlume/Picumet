#!/usr/bin/env python3
"""06 · 拼好桶 A/D：同一挂载 `/` 上按算法把文件分摊到两个可写桶，副桶 B 只读。

验证五种 poolStrategy 的实际落桶结果、standby 桶永不参与写入、以及物理对象与元数据一致。
每个策略跑一轮：切换策略 → 上传一批（含多目录）→ 校验落桶分布。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

BASE = '/users/labalice/composite'


def pool_members(topo: dict) -> list[dict]:
    return [
        {'providerId': topo['providers']['A']['id'], 'weight': 1, 'sortOrder': 0, 'standby': False},
        {'providerId': topo['providers']['D']['id'], 'weight': 1, 'sortOrder': 1, 'standby': False},
        {'providerId': topo['providers']['B']['id'], 'weight': 1, 'sortOrder': 2, 'standby': True},
    ]


def run(args: argparse.Namespace) -> None:
    r = Reporter('06_composite_pool')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    topo = fixtures.topology(lab)
    root_id = topo['root']['id']
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    names = {'A': 'lab-bucket-A', 'D': 'lab-bucket-D', 'B': 'lab-bucket-B'}
    prov_to_key = {v: k for k, v in names.items()}

    def placement(label: str) -> dict[str, str]:
        """读取本轮上传的落桶结果 {文件名: 桶名}"""
        rows = lab.db.query(
            'SELECT name, provider_id, physical_key, blob_hash FROM file_metadata WHERE mount_id=? AND path LIKE ? AND type=?',
            (root_id, f'{BASE}%', 'file'),
        )
        return {row['name']: prov_to_key.get(lab.provider_name_map().get(row['provider_id'], ''), '?') for row in rows}

    def reset() -> None:
        lab.purge_dir(alice, BASE)
        lab.mkdir(alice, '/users/labalice', 'composite')

    for strategy in ('round_robin', 'ordered', 'hash', 'least_used', 'free_weighted'):
        usage_before = {
            row['provider_id']: row['used']
            for row in lab.db.query(
                "SELECT provider_id, SUM(size) AS used FROM file_metadata WHERE mount_id=? AND type='file' GROUP BY provider_id",
                (root_id,),
            )
        }
        st, _ = lab.patch_mount(root_id, {'poolStrategy': strategy, 'poolMembers': pool_members(topo)})
        r.check(st == 200, f'C1 切换 poolStrategy={strategy}', f'{st}')
        reset()
        # 多目录 + 多文件，覆盖 hash 策略的「按父目录粘滞」与 ordered 的「按序填桶」
        dirs = [BASE]
        for i in range(2):
            name = f'dir{i}-{uid()[:5]}'
            lab.mkdir(alice, BASE, name)
            dirs.append(f'{BASE}/{name}')
        for index, directory in enumerate(dirs):
            for j in range(3):
                lab.upload(alice, directory, f'f{index}-{j}-{uid()[:5]}.bin', f'{strategy}-{index}-{j}'.encode(),
                           'application/octet-stream')
        placed = placement(strategy)
        buckets = set(placed.values())
        r.check(
            buckets <= {'A', 'D'},
            f'C2 [{strategy}] 全部文件落在可写成员 A/D（standby B 未参与写入）',
            f'实际 {sorted(buckets)} · {placed}',
        )
        r.check(len(placed) == len(dirs) * 3, f'C3 [{strategy}] 全部 {len(dirs) * 3} 个文件都有元数据行', str(len(placed)))
        # 物理对象与元数据一致
        bad = []
        for row in lab.db.query(
            'SELECT name, path, provider_id, physical_key FROM file_metadata WHERE mount_id=? AND path LIKE ? AND type=?',
            (root_id, f'{BASE}%', 'file'),
        ):
            holder = prov_to_key.get(lab.provider_name_map().get(row['provider_id'], ''), '?')
            if holder in ('A', 'D') and not fixtures.s3(holder).exists(fixtures.BUCKET, row['physical_key']):
                bad.append(row)
        r.check(not bad, f'C4 [{strategy}] 元数据 provider 与桶内物理对象一致', str(bad[:2]))

        if strategy == 'round_robin':
            sequence = [placed[name] for name in sorted(placed)]
            r.check(
                len(set(sequence)) == 2,
                'C5 [round_robin] 两个可写桶都被使用（轮转分摊）',
                str(sequence),
            )
        elif strategy == 'ordered':
            r.check(
                len(buckets) == 1,
                'C6 [ordered] 无容量上限时按 sortOrder 填满第一个桶后再换',
                f'实际使用 {sorted(buckets)}（sortOrder 0 = A）',
            )
        elif strategy == 'hash':
            sticky: dict[str, set[str]] = {}
            for row in lab.db.query(
                'SELECT name, path, provider_id FROM file_metadata WHERE mount_id=? AND path LIKE ? AND type=?',
                (root_id, f'{BASE}%', 'file'),
            ):
                holder = prov_to_key.get(lab.provider_name_map().get(row['provider_id'], ''), '?')
                sticky.setdefault(row['path'], set()).add(holder)
            r.check(
                all(len(v) == 1 for v in sticky.values()),
                'C7 [hash] 同一父目录的文件落在同一个桶（按目录粘滞）',
                str({k: sorted(v) for k, v in sticky.items()}),
            )
        elif strategy == 'least_used':
            # 语义：新文件落在「(已用+1)/weight」较小者；两桶用量接近时应两个都被使用
            low = min(
                (('A', topo['providers']['A']['id']), ('D', topo['providers']['D']['id'])),
                key=lambda item: (usage_before.get(item[1], 0) + 1) / 1,
            )[0]
            r.check(
                buckets == {low} or len(buckets) == 2,
                'C8 [least_used] 落在当时用量较低的桶（用量接近时两桶分摊）',
                f'用量前={ {k: v for k, v in usage_before.items()} } 实际={sorted(buckets)} 期望优先={low}',
            )

    # 副桶 B 从未被应用写入：以元数据维度判定（B 桶内对象可能来自 07 的外部镜像通道）
    rows_on_b = lab.db.one('SELECT COUNT(*) AS c FROM file_metadata WHERE provider_id=?', (topo['providers']['B']['id'],))
    r.check(
        (rows_on_b or {}).get('c', 0) == 0,
        'C9 副桶 B 未被应用写入（无元数据行落在 B）',
        str(rows_on_b),
    )

    # 锚点仍是 A（第一个非备用成员）
    root = lab.find_mount('/')
    r.check(root['providerId'] == topo['providers']['A']['id'], 'C10 挂载锚点派生为池内第一个非备用成员（A）',
            lab.provider_name_map().get(root['providerId'], '?'))

    # 只读回退：B 不被写入但可作为读候选（详见 07_failover）
    reset()
    lab.patch_mount(root_id, {'poolStrategy': 'round_robin', 'poolMembers': pool_members(topo)})
    r.note('拼好桶切换与分摊验证完成')

    lab.purge_dir(alice, BASE)
    if not r.finish():
        raise VerifyError('06 · 拼好桶用例存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 06 · 拼好桶 A/D'))
    main_wrapper(lambda: run(parser.parse_args()))
