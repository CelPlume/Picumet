#!/usr/bin/env python3
"""00 · 拓扑搭建：A/B/C/D 桶 + 根挂载池 + /public 挂载点 + 测试用户（幂等）。

    python3 scripts/lab/00_setup.py [--base-url http://localhost:8787] [--pool-strategy hash]

前置：
  - 四个 S3 实例已启动：`scripts/lab/s3/s3.sh up`
  - Workers 开发栈已启动且完成迁移/种子：`cd workers && bun run dev -- --test-scheduled`
"""
from __future__ import annotations

import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab  # noqa: E402
import fixtures  # noqa: E402


def run(args: argparse.Namespace) -> None:
    reporter = Reporter('00_setup')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)

    # S3 实例可达性（早失败早暴露）
    for key, client in fixtures.all_buckets().items():
        ping = client.ping()
        reporter.check(ping.get('reachable') is True, f'S3 实例 {key} 可达（{fixtures.S3_ENDPOINTS[key]}）', str(ping))

    result = fixtures.setup(lab, reporter, pool_strategy=args.pool_strategy)

    print('\n拓扑摘要：')
    for key, prov in result['providers'].items():
        print(f"  {key}  provider={prov['id']}  endpoint={fixtures.S3_ENDPOINTS[key]}  bucket={fixtures.BUCKET}")
    print(f"  /      mount={result['root']['id']}  strategy={result['root'].get('poolStrategy')}")
    print(f"  /public mount={result['public']['id']}  uploadMode={result['public'].get('uploadMode')}")
    for key, user in result['users'].items():
        print(f"  user {key}: {user['username']} ({user['id']}) defaultPath={user['defaultPath']}")

    ok = reporter.finish()
    if not ok:
        raise VerifyError('拓扑搭建存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室拓扑搭建'))
    parser.add_argument(
        '--pool-strategy',
        default='least_used',
        choices=['least_used', 'round_robin', 'hash', 'free_weighted', 'ordered'],
        help='根挂载点写入放置策略（拼好桶 A/D 的分配算法）',
    )
    main_wrapper(lambda: run(parser.parse_args()))
