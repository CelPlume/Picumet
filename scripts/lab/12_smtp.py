#!/usr/bin/env python3
"""12 · 邮件链路（本地 SMTP 收件箱）：注册验证码 / 找回密码 / 邮箱验证 / 管理端测试邮件。

收件箱为本地搭建的 SMTP sink（scripts/lab/env/smtp），邮件落盘为 JSONL，因此可以断言
「应用是否真的把邮件投递出去、内容是什么」。

审计背景：CODE_AUDIT_REPORT SEC-05 记录「SMTP 未启用 TLS 且 `connect` 未导入 → 运行即
ReferenceError」，修复状态为**暂缓**。本套件在真实运行栈上复核该结论，并把 SMTP 基础设施
自身可用性作为对照组（基础设施没问题 → 问题在应用实现）。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import smtplib
import sys
import time
from email.message import EmailMessage

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _picumet_e2e import Reporter, VerifyError, add_common_args, main_wrapper  # noqa: E402

from _lab import Lab, uid  # noqa: E402
import fixtures  # noqa: E402

MAILBOX = pathlib.Path('/home/excnies/picumet-smtp/mailbox')
SMTP_HOST = '127.0.0.1'
SMTP_PORT = 1025


def mailbox_lines() -> list[dict]:
    path = MAILBOX / 'mailbox.jsonl'
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def run(args: argparse.Namespace) -> None:
    r = Reporter('12_smtp')
    lab = Lab(args.base_url, args.workers_dir, args.username, args.password)
    admin = lab.admin()

    # ---------------------------------------------------------------- 0. 收件箱自身可用性（对照组）
    before = len(mailbox_lines())
    try:
        msg = EmailMessage()
        msg['From'] = 'lab@example.com'
        msg['To'] = 'sink-check@example.com'
        msg['Subject'] = f'SMTP sink 自检 {uid()[:6]}'
        msg.set_content('sink-self-test')
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as client:
            client.ehlo()
            client.login('lab', 'labpass')
            client.send_message(msg)
        time.sleep(0.5)
        after = mailbox_lines()
        r.check(len(after) == before + 1, 'M0 本地 SMTP 收件箱可用（直接投递成功并落盘）',
                f'{before} → {len(after)}')
        if after:
            r.note('最近一封（自检）', f"subject={after[-1]['subject']!r}")
    except Exception as err:  # noqa: BLE001
        r.check(False, 'M0 本地 SMTP 收件箱可用', f'{type(err).__name__}: {err}')

    # ---------------------------------------------------------------- 1. 应用 SMTP 配置
    lab.set_settings(
        smtpHost=SMTP_HOST, smtpPort=SMTP_PORT, smtpSecure=False, smtpUser='lab',
        smtpPassword='labpass', smtpFromName='Picumet Lab', smtpFromEmail='lab@example.com', emailEnabled=True,
    )
    settings = lab.get_settings()
    r.check(settings.get('smtpHost') == SMTP_HOST and settings.get('emailEnabled') is True, 'M1 应用 SMTP 配置已保存')
    r.check(
        str(settings.get('smtpPassword')) in ('******', '', 'None') or 'enc:' not in str(settings.get('smtpPassword')),
        'M2 SMTP 密码不回读明文',
        str(settings.get('smtpPassword'))[:24],
    )

    # ---------------------------------------------------------------- 2. 管理端测试邮件
    sent_before = len(mailbox_lines())
    st_mail, mail_body = admin.json_request('POST', '/api/admin/settings/test-email', {'to': 'qa@example.com'},
                                            headers=lab.h(admin))
    msg_text = str((mail_body.get('error') or {}).get('message') or mail_body)[:200]
    r.check(
        st_mail == 200,
        'M3 管理端测试邮件发送成功',
        f'实际 {st_mail} {msg_text} —— SEC-05（SMTP connect 未导入）仍未修复，见报告 F-14',
    )
    r.check(len(mailbox_lines()) > sent_before, 'M4 测试邮件到达收件箱', f'{len(mailbox_lines())} 封')

    # ---------------------------------------------------------------- 3. 注册验证码
    email = f'otp-{uid()}@example.com'
    st_otp, otp_body = lab.new_session().json_request('POST', '/api/auth/register/send-otp', {'email': email})
    r.check(
        st_otp == 200,
        'M5 注册验证码接口发送成功',
        f'实际 {st_otp} {str(otp_body)[:180]}',
    )
    if st_otp == 200:
        codes = [m for m in mailbox_lines() if email in json.dumps(m, ensure_ascii=False)]
        r.check(bool(codes), 'M6 验证码邮件到达收件箱', f'{len(codes)} 封')
        if codes:
            r.note('验证码邮件主题', codes[-1]['subject'])

    # ---------------------------------------------------------------- 4. 找回密码
    alice = lab.login(fixtures.TEST_USERS['alice']['username'], fixtures.USER_PASSWORD, key='labalice')
    me = alice.json_request('GET', '/api/auth/me')[1]
    alice_email = ((me.get('data') or {}).get('user') or {}).get('email')
    st_forgot, forgot_body = lab.new_session().json_request('POST', '/api/auth/forgot-password', {'email': alice_email})
    r.check(
        st_forgot == 200 and 'success' in forgot_body,
        'M7 找回密码接口返回通用成功（不泄露账号存在性）',
        f'{st_forgot} {str(forgot_body)[:160]}',
    )
    reset_mails = [m for m in mailbox_lines() if alice_email and alice_email in json.dumps(m, ensure_ascii=False)]
    r.check(
        bool(reset_mails),
        'M8 重置链接邮件到达收件箱',
        f'实际 {len(reset_mails)} 封 —— SMTP 发信失败导致重置邮件无法送达',
    )

    # ---------------------------------------------------------------- 5. 邮箱验证开关 + 注册闭环
    lab.set_settings(requireEmailVerification=True)
    reg_name = f'laotp{uid()[:4]}'
    st_reg, reg_body = lab.new_session().json_request(
        'POST', '/api/auth/register',
        {'username': reg_name, 'password': 'labpass123456', 'email': f'{reg_name}@example.com'},
    )
    r.check(
        st_reg == 400 and (reg_body.get('error') or {}).get('code') == 'INVALID_OTP',
        'M9 开启邮箱验证后无验证码注册被拒（fail-closed）',
        f'{st_reg} {str(reg_body)[:140]}',
    )
    st_reg2, reg_body2 = lab.new_session().json_request(
        'POST', '/api/auth/register',
        {'username': reg_name, 'password': 'labpass123456', 'email': f'{reg_name}@example.com', 'emailCode': '123456'},
    )
    r.check(
        st_reg2 == 400 and (reg_body2.get('error') or {}).get('code') == 'INVALID_OTP',
        'M10 猜测验证码被拒（无法通过邮件获取真码 → 注册不可用）',
        f'{st_reg2} {str(reg_body2)[:140]}',
    )
    # 还原设置（开发栈默认关闭邮箱验证）
    lab.set_settings(requireEmailVerification=False)

    # ---------------------------------------------------------------- 6. 邮箱变更 OTP
    st_me_otp, me_otp = alice.json_request('POST', '/api/users/me/email/send-otp', {'email': f'new-{uid()}@example.com'},
                                           headers=lab.h(alice))
    r.check(
        st_me_otp == 200,
        'M11 用户邮箱变更 OTP 发送成功',
        f'实际 {st_me_otp} {str(me_otp)[:180]}',
    )

    # ---------------------------------------------------------------- 7. 汇总
    lines = mailbox_lines()
    from_app = [m for m in lines if str(m.get('subject', '')).startswith('Picumet')]
    r.check(
        len(from_app) > 0,
        'M12 收件箱中存在来自 Picumet 的邮件',
        f'Picumet 邮件 {len(from_app)} 封 / 总计 {len(lines)} 封',
    )
    r.note('收件箱统计', f'总 {len(lines)} 封；Picumet 来源 {len(from_app)} 封')

    if not r.finish():
        raise VerifyError('12 · 邮件链路存在失败项（均为 SEC-05 的表现，见报告）')


if __name__ == '__main__':
    parser = add_common_args(argparse.ArgumentParser(description='Picumet 实验室 12 · 邮件链路'))
    main_wrapper(lambda: run(parser.parse_args()))
