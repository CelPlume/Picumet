# Picumet 实验室本地 SMTP 收件箱（sink）
#
# 用途：让 Picumet 的邮件链路（注册验证码 / 找回密码 / 邮箱验证 / 管理端测试邮件）
# 有一个真实可连的 SMTP 端点，并把收到的报文落盘供 E2E 断言读取。
# 基础镜像 python:3.11-slim 为本地已有镜像（registry mirror 无法拉取外部镜像）。
FROM python:3.11-slim

WORKDIR /app
COPY smtp_sink.py /app/smtp_sink.py

VOLUME ["/mailbox"]
EXPOSE 1025

CMD ["python", "/app/smtp_sink.py", "--host", "0.0.0.0", "--port", "1025", "--out", "/mailbox"]
