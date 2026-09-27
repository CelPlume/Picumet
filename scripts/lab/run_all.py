#!/usr/bin/env python3
"""Picumet 实验室：一键运行全部用例并汇总。

    # 1) 起环境
    scripts/lab/env/s3/s3.sh up          # 四个 S3 兼容实例（A/B/C/D）
    scripts/lab/env/smtp/smtp.sh up      # 本地 SMTP 收件箱（邮件链路用例需要）
    cd workers && bun run dev -- --test-scheduled   # API（--test-scheduled 供回收/定时任务用例）
    cd frontend && bun run dev                      # 前端（UI 用例需要）

    # 2) 建拓扑 + 跑全部
    python3 scripts/lab/00_setup.py
    python3 scripts/lab/run_all.py                # 顺序执行 01..12
    python3 scripts/lab/run_all.py --only 01,03,05
    python3 scripts/lab/run_all.py --skip 08      # 跳过耗时的大文件分片实测

结果：每个模块把检查项写入 .tmp/lab-results/<name>.json；本脚本汇总为
.tmp/lab-results/_summary.json 并打印通过/失败矩阵（失败项即报告中的发现项）。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import REPO_ROOT, add_common_args, main_wrapper  # noqa: E402

LAB_DIR = pathlib.Path(__file__).resolve().parent
RESULTS_DIR = REPO_ROOT / '.tmp/lab-results'


def modules() -> list[pathlib.Path]:
    return sorted(p for p in LAB_DIR.glob('[0-9][0-9]_*.py') if p.name != '00_setup.py')


def run_one(module: pathlib.Path, args: argparse.Namespace) -> dict:
    cmd = [sys.executable, str(module), '--base-url', args.base_url, '--workers-dir', str(args.workers_dir)]
    if module.stem.startswith(('02', '08')) and args.skip_gc:
        cmd.append('--skip-gc')
    if module.stem.startswith('08') and args.skip_r2_multipart:
        cmd.append('--skip-r2-multipart')
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout)
    elapsed = round(time.time() - started, 1)
    tail = '\n'.join((proc.stdout or '').splitlines()[-40:])
    return {
        'module': module.stem,
        'exit': proc.returncode,
        'seconds': elapsed,
        'stdout_tail': tail,
        'stderr_tail': '\n'.join((proc.stderr or '').splitlines()[-12:]),
    }


def main(args: argparse.Namespace) -> None:
    selected = modules()
    if args.only:
        wanted = {x.strip() for x in args.only.split(',') if x.strip()}
        selected = [m for m in selected if m.stem[:2] in wanted]
    if args.skip:
        skipped = {x.strip() for x in args.skip.split(',') if x.strip()}
        selected = [m for m in selected if m.stem[:2] not in skipped]
    if not selected:
        raise SystemExit('没有选中任何用例模块')

    summary: list[dict] = []
    for module in selected:
        print(f'\n{"=" * 78}\n== {module.name}\n{"=" * 78}', flush=True)
        outcome = run_one(module, args)
        summary.append(outcome)
        print(outcome['stdout_tail'], flush=True)
        if outcome['exit'] != 0 and outcome['stderr_tail']:
            print(outcome['stderr_tail'], file=sys.stderr, flush=True)
        print(f"→ {outcome['module']}: exit={outcome['exit']} ({outcome['seconds']}s)", flush=True)

    # 汇总每个模块 JSON 里的检查项
    print(f'\n{"=" * 78}\n== 汇总\n{"=" * 78}')
    totals = {'checks': 0, 'failed': 0}
    table: list[dict] = []
    for outcome in summary:
        result_path = RESULTS_DIR / f"{outcome['module']}.json"
        entry = {'module': outcome['module'], 'exit': outcome['exit'], 'seconds': outcome['seconds']}
        if result_path.is_file():
            data = json.loads(result_path.read_text())
            entry.update({'checks': data.get('checks'), 'passed': data.get('passed'), 'failed': data.get('failed')})
            totals['checks'] += data.get('checks') or 0
            totals['failed'] += data.get('failed') or 0
            entry['failures'] = [
                r['label'] for r in data.get('results', []) if r['type'] == 'check' and not r['ok']
            ]
        table.append(entry)

    width = max(len(t['module']) for t in table)
    for entry in table:
        checks = entry.get('checks', '-')
        passed = entry.get('passed', '-')
        failed = entry.get('failed', '-')
        flag = 'PASS' if entry['exit'] == 0 else 'FAIL'
        print(f"  {entry['module']:<{width}}  {flag}  检查 {checks} 通过 {passed} 失败 {failed}  ({entry['seconds']}s)")
        for label in entry.get('failures', []):
            print(f"        · {label}")

    RESULT = RESULTS_DIR / '_summary.json'
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps({'totals': totals, 'modules': table}, ensure_ascii=False, indent=2))
    print(f"\n总检查项 {totals['checks']}，失败 {totals['failed']}；明细 {RESULT}")


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室一键运行'))
    parser.add_argument('--only', default='', help='只运行指定模块编号（逗号分隔，如 01,03）')
    parser.add_argument('--skip', default='', help='跳过指定模块编号（逗号分隔）')
    parser.add_argument('--skip-gc', action='store_true', help='把 --skip-gc 透传给 02/08')
    parser.add_argument('--skip-r2-multipart', action='store_true', help='跳过 08 的 R2 绑定分片实测')
    parser.add_argument('--timeout', type=float, default=3600, help='单个模块超时秒数')
    main_wrapper(lambda: main(parser.parse_args()))
