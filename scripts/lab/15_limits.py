#!/usr/bin/env python3
"""15 · 限速与限数验证：全局限流 / 下载限速 / 传输并发 / 认证限流（含「图床批量加载」场景）。

关键事实（源码）：三个限制中间件都是**生产专属**，非生产环境直接跳过——
  · `middleware/rate-limit.ts#rateLimitMiddleware`（「非生产环境跳过，避免误伤本地调试」）
  · `middleware/download-limit.ts#downloadRateLimitMiddleware`（`ENVIRONMENT !== 'production'` 直接 next）
  · `middleware/concurrency.ts#transferConcurrencyMiddleware`（同上）
故分两个阶段，**环境切换由调用方完成**（脚本内不做重启，避免编排不可靠）：

    # 阶段 1（dev，证明「本地不生效」+ 准备 prod 用例所需的设置与密钥）
    python3 scripts/lab/15_limits.py --prepare
    python3 scripts/lab/15_limits.py --phase dev

    # 阶段 2（prod，实测限制生效）
    sed -i 's/^ENVIRONMENT=.*/ENVIRONMENT=production/' workers/.dev.vars
    scripts/lab/env/stack.sh down && scripts/lab/env/stack.sh up
    python3 -u scripts/lab/15_limits.py --phase prod
    sed -i 's/^ENVIRONMENT=.*/ENVIRONMENT=development/' workers/.dev.vars
    scripts/lab/env/stack.sh down && scripts/lab/env/stack.sh up
    python3 scripts/lab/15_limits.py --restore

隔离手段：按请求设置 `CF-Connecting-IP` 模拟不同客户端，使每个限制器落在独立计数桶
（`utils/ip.ts` 的 SEC-03 修复即读取该头；本机没有 Cloudflare 覆盖该头，正好用于分桶）。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

WORKER = 'http://localhost:8787'
STATE = pathlib.Path('.tmp/lab-results/15_limits-state.json')
PUBLIC = fixtures.PUBLIC_MOUNT_PATH
PROD_LIMITS = {'rateLimitEnabled': True, 'rateLimitRequestsPerMinute': 5, 'rateLimitDownloadsPerMinute': 3, 'maxConcurrentTransfers': 1}
DEV_LIMITS = {'rateLimitEnabled': True, 'rateLimitRequestsPerMinute': 50, 'rateLimitDownloadsPerMinute': 120, 'maxConcurrentTransfers': 4}


def hit(url: str, *, method: str = 'GET', data: bytes | None = None, ip: str | None = None,
        headers: dict[str, str] | None = None, timeout: float = 60) -> tuple[int, str]:
    merged = dict(headers or {})
    if ip:
        merged['CF-Connecting-IP'] = ip
    req = urllib.request.Request(url, data=data, method=method, headers=merged)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(400).decode('utf-8', 'replace')
    except urllib.error.HTTPError as err:
        return err.code, err.read(400).decode('utf-8', 'replace')
    except Exception as err:  # noqa: BLE001
        return 0, f'{type(err).__name__}: {err}'


def error_code(body: str) -> str:
    try:
        return (json.loads(body).get('error') or {}).get('code', '')
    except Exception:  # noqa: BLE001
        return ''


def sequential(url: str, count: int, ip: str) -> tuple[int, list[tuple[int, str]]]:
    """顺序请求 count 次，返回（首个 429/403 的序号，[(状态码, 错误码)…]）；0 表示未受限。"""
    rows: list[tuple[int, str]] = []
    first = 0
    for i in range(1, count + 1):
        status, body = hit(url, ip=ip)
        rows.append((status, error_code(body)))
        if status == 429 and not first:
            first = i
    return first, rows


def concurrent(urls: list[str], ip: str, data: bytes | None = None, headers: dict[str, str] | None = None,
               method: str = 'GET', timeout: float = 180) -> list[int]:
    results = [0] * len(urls)

    def worker(index: int, target: str) -> None:
        results[index] = hit(target, method=method, data=data, ip=ip, headers=headers, timeout=timeout)[0]

    threads = [threading.Thread(target=worker, args=(i, u)) for i, u in enumerate(urls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=timeout)
    return results


def prepare(lab: Lab, r: Reporter) -> None:
    """dev 阶段准备：低限速设置、API Key（prod 无 Cookie 可用）、一个 public 可见性的直链样本。"""
    lab.set_settings(**PROD_LIMITS)
    r.check(lab.get_settings().get('rateLimitRequestsPerMinute') == 5, 'P0 已写入生产限速档设置（5/3/1）')

    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    lab.purge_keys(alice)
    key = lab.create_key(alice, f'lab-limits-{uid()[:5]}', ['read', 'write', 'delete'], ['api'], uploadPath='/')
    r.check(bool(key['key']['fullToken']), 'P0b 已签发 API Key（prod 阶段用 Bearer 走传输/并发面）')

    # 直链样本：设成 public 可见性 → 匿名可无 sign 直读（用于验证「直链不受限速」）
    target = next((i for i in lab.items(alice, '/samples/images') if i['type'] == 'file'), None)
    if target is None:
        raise VerifyError('/samples/images 为空：先运行 14_samples.py')
    lab.update_file(alice, target['id'], visibility='public')
    r.check(True, f'P0c 直链样本已设为 public：{target["name"]}')

    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({
        'token': key['key']['fullToken'],
        'keyId': key['key']['keyId'],
        'directPath': f'/samples/images/{target["name"]}',
        'bigName': f'dl-limit-{uid()[:6]}.bin',
    }, ensure_ascii=False, indent=2))


def phase_dev(lab: Lab, r: Reporter) -> None:
    first, rows = sequential(f'{WORKER}/api/gallery', 12, '10.9.0.1')
    r.check(first == 0, 'D1 development：全局限流不生效（设 5/min，12 次请求零 429）', str(rows[:6]))
    first_dl, rows_dl = sequential(f'{WORKER}/api/public/fs?path={PUBLIC}', 8, '10.9.0.2')
    r.check(first_dl == 0, 'D2 development：下载限速不生效（设 3/min，8 次请求零 429）', str(rows_dl[:6]))
    urls = [f'{WORKER}/api/public/settings' for _ in range(4)]
    codes = concurrent(urls, '10.9.0.3')
    r.check(all(c == 200 for c in codes), 'D3 development：传输并发限制不生效（设 1，4 并发均 200）', str(codes))


def phase_prod(lab: Lab, r: Reporter) -> None:
    state = json.loads(STATE.read_text())
    token = state['token']

    # L1 全局限流（仅挂 rateLimitMiddleware 的公开面）
    first, rows = sequential(f'{WORKER}/api/gallery', 10, '10.9.1.1')
    r.check(0 < first <= 7, f'L1 production：全局限流生效（设 5/min，第 {first} 次起 429）', str(rows))

    # L2 下载限速（独立 IP 桶，避免被全局限流先拦）
    first_dl, rows_dl = sequential(f'{WORKER}/api/public/fs?path={PUBLIC}', 6, '10.9.1.2')
    msg_dl = '下载次数已达上限' in json.dumps(rows_dl, ensure_ascii=False)
    r.check(
        0 < first_dl <= 5,
        f'L2 production：下载限速生效（设 3/min，第 {first_dl} 次起 429，独立桶）',
        str(rows_dl),
    )
    r.note('下载限速错误码序列（判断是否命中下载桶）', str(rows_dl[:6]) if msg_dl else '（全局限流先命中，见上）')

    # L3 传输并发限制（API Key + Bearer，不依赖 Cookie）
    body = b'x' * (6 * 1024 * 1024)
    boundary = '----limits'
    payload = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\npublic\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{state["bigName"]}"\r\n'
        f'Content-Type: application/octet-stream\r\n\r\n'
    ).encode() + body + f'\r\n--{boundary}--\r\n'.encode()
    headers = {'Content-Type': f'multipart/form-data; boundary={boundary}', 'Authorization': f'Bearer {token}'}
    codes = concurrent([f'{WORKER}/api/upload' for _ in range(4)], '10.9.1.3',
                       data=payload, headers=headers, method='POST')
    r.check(
        any(c == 429 for c in codes),
        'L3 production：传输并发限制生效（设 1，4 个并发上传出现 429）',
        str(codes),
    )

    # L4 直链（图床热链）：path-serve 未挂限速中间件 → 预期全部 200
    direct = f'{WORKER}{state["directPath"]}'
    codes_direct = concurrent([direct for _ in range(10)], '10.9.1.4')
    r.check(
        all(c == 200 for c in codes_direct),
        'L4 production：直链不受限速约束（10 次并发热链全部 200 → 图床场景无限速）',
        str(codes_direct),
    )

    # L5 认证端点限流（5 次/分钟/IP）
    login_payload = json.dumps({'username': 'labalice', 'password': 'wrong-pass'}).encode()
    login_codes: list[int] = []
    for _ in range(8):
        status, _body = hit(f'{WORKER}/api/auth/login', method='POST', data=login_payload,
                            ip='10.9.1.5', headers={'Content-Type': 'application/json'}, timeout=30)
        login_codes.append(status)
    r.check(429 in login_codes, 'L5 production：认证端点限流生效（8 次错误登录出现 429）', str(login_codes))


def run(args: argparse.Namespace) -> None:
    r = Reporter('15_limits')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password, session_timeout=30)

    if args.prepare:
        prepare(lab, r)
    elif args.restore:
        lab.set_settings(**DEV_LIMITS)
        state = json.loads(STATE.read_text()) if STATE.is_file() else {}
        if state.get('keyId'):
            lab.purge_keys(lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice'))
        r.check(lab.get_settings().get('rateLimitRequestsPerMinute') == 50, 'R1 已还原限速档设置（50/120/4）')
        r.check(True, 'R2 请确认已切回 ENVIRONMENT=development 并重启（见模块 docstring）')
    elif args.phase == 'dev':
        phase_dev(lab, r)
    else:
        phase_prod(lab, r)

    if not r.finish():
        raise VerifyError('15 · 限速与限数验证存在失败项')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 15 · 限速与限数验证'))
    parser.add_argument('--phase', default='dev', choices=['dev', 'prod'])
    parser.add_argument('--prepare', action='store_true', help='写入低限速档 + 签发 API Key + 备好直链样本')
    parser.add_argument('--restore', action='store_true', help='还原限速档设置并清理密钥')
    main_wrapper(lambda: run(parser.parse_args()))
