# Picumet 实验室本地 S3 兼容存储镜像（A/B/C/D 四实例共用）
#
# 背景：MinIO 在 2025 年撤下了 Docker Hub 镜像与 dl.min.io 二进制（实测 minio/minio 拉取被拒、
# dl.min.io 返回 410），因此改用同为 S3 协议的开源网关 VersityGW（Apache-2.0，静态二进制）。
# 对 Picumet 而言它就是一个 S3 endpoint：path-style 寻址、分片上传、ListParts、CopyObject、
# Range 读取、DeleteObjects 全部支持，足以承载多桶 / 容灾 / 拼好桶测试。
#
# 构建由 scripts/lab/s3/s3.sh install 驱动（会把二进制与 Dockerfile 一起放到构建上下文目录）。
FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY versitygw /usr/local/bin/versitygw
RUN chmod +x /usr/local/bin/versitygw

VOLUME ["/data"]
EXPOSE 7070

# 默认单账户模式：-a/-s 为根凭证，-q 静默请求日志避免无谓 IO
ENTRYPOINT ["/usr/local/bin/versitygw"]
CMD ["-a", "minioadmin", "-s", "minioadmin", "-p", ":7070", "-q", "posix", "/data"]
