#!/usr/bin/env python3
"""11 · 前端 UI 验证（浏览器）。

执行方式说明（重要）：
  浏览器由**宿主 Playwright 桥**驱动（交互式会话内的 `browser.*`），普通 python 进程拿不到该句柄，
  因此本文件分两段：
    · 运行段（本脚本）：读取桥产出的人工核对结果 `.tmp/lab-results/11_ui.json`，校验每项检查通过；
      若结果文件缺失，则打印核对清单并以非零码退出（提示需要先跑桥）。
    · 计划段（CHECKLIST）：桥执行时的动作与断言清单，逐项与结果文件一一对应，保证可复现。

桥执行步骤（agent/维护者）：
  1) 打开 http://localhost:5173/login，填写 admin/admin123456 提交 → 断言离开 /login 并落在 /files；
  2) 打开 /files → 断言渲染出挂载/目录列表（含 /bulk 语料目录）、可切换网格/列表视图；
  3) 打开 /files?path=/public → 断言平铺文件可见（flat 模式无子目录）；
  4) 打开 /admin/storage 与挂载页 → 断言显示 /public、/、/dedup 及池成员（A/D/B）；
  5) 打开 /admin/settings → 断言分组渲染；
  6) 用 API 建一个分享 → 打开 /share/<id> → 断言显示项目名；
  7) 截图写入 .tmp/lab-shots/ui-*.png；收集 console 错误（应为 0）。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import REPO_ROOT, Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

RESULTS = REPO_ROOT / '.tmp/lab-results/11_ui_bridge.json'

CHECKLIST = [
    ('U1', '登录后离开登录页并落在 /files'),
    ('U2', '文件页渲染出目录/文件列表（含根挂载点目录行）'),
    ('U3', '文件页显示批量语料目录 bulk'),
    ('U4', '网格/列表视图可切换'),
    ('U5', '管理端存储页显示 5 个存储提供商与挂载点/池成员'),
    ('U6', '管理端设置页渲染站点/安全/SMTP/公告分组'),
    ('U7', '分享页显示分享项目名与下载入口'),
    ('U8', '页面无 console 错误'),
]


def run(args: argparse.Namespace) -> None:
    r = Reporter('11_ui')
    if not RESULTS.is_file():
        print('未找到桥产出的 UI 核对结果：', RESULTS)
        print('\n核对清单（需通过宿主 Playwright 桥执行，见本文件头部说明）：')
        for code, label in CHECKLIST:
            print(f'  {code}  {label}')
        raise VerifyError('UI 结果文件缺失：请先通过浏览器桥执行核对并写入 .tmp/lab-results/11_ui.json')

    data = json.loads(RESULTS.read_text())
    checks = {entry['id']: entry for entry in data.get('checks', [])}
    for code, label in CHECKLIST:
        entry = checks.get(code)
        r.check(
            bool(entry and entry.get('ok')),
            f'{code} {label}',
            (entry or {}).get('detail', '结果缺失'),
        )
    r.note('截图目录', str(REPO_ROOT / '.tmp/lab-shots'))
    if not r.finish():
        raise VerifyError('11 · UI 验证存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 11 · UI 验证'))
    main_wrapper(lambda: run(parser.parse_args()))
