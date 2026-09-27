#!/usr/bin/env bash
# Picumet 实验室：本地 SMTP 收件箱生命周期脚本。
#
#   ./scripts/lab/env/smtp/smtp.sh install  # 构建 picumet-smtp-sink:local
#   ./scripts/lab/env/smtp/smtp.sh up       # 启动（宿主机 1025 端口）
#   ./scripts/lab/env/smtp/smtp.sh down     # 停止
#   ./scripts/lab/env/smtp/smtp.sh status   # 容器状态 + 已收邮件数
#   ./scripts/lab/env/smtp/smtp.sh reset    # 清空收件箱
#   ./scripts/lab/env/smtp/smtp.sh latest [n]  # 打印最近 n 封（默认 3）
#
# 环境变量：
#   PICUMET_SMTP_MAILBOX  收件箱目录（默认 /home/excnies/picumet-smtp/mailbox）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAILBOX_DIR="${PICUMET_SMTP_MAILBOX:-/home/excnies/picumet-smtp/mailbox}"
IMAGE="picumet-smtp-sink:local"

log() { printf '\033[36m[smtp]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[smtp] %s\033[0m\n' "$*" >&2; exit 1; }

cmd_install() {
  log "构建镜像 $IMAGE …"
  docker build -t "$IMAGE" "$HERE" >/dev/null
  log "镜像就绪：$(docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep "^$IMAGE")"
}

cmd_up() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || cmd_install
  mkdir -p "$MAILBOX_DIR"
  PICUMET_SMTP_MAILBOX="$MAILBOX_DIR" docker compose -f "$HERE/docker-compose.yml" up -d
  for _ in $(seq 1 40); do
    if (exec 3<>/dev/tcp/127.0.0.1/1025) 2>/dev/null; then exec 3>&-; log "SMTP 就绪：127.0.0.1:1025（收件箱 $MAILBOX_DIR）"; return; fi
    sleep 0.5
  done
  die 'SMTP 1025 未就绪'
}

cmd_down() { PICUMET_SMTP_MAILBOX="$MAILBOX_DIR" docker compose -f "$HERE/docker-compose.yml" down; }

cmd_status() {
  docker ps -a --filter name=picumet-smtp-sink --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}'
  local count=0
  [[ -f "$MAILBOX_DIR/mailbox.jsonl" ]] && count=$(wc -l < "$MAILBOX_DIR/mailbox.jsonl")
  printf '  已收邮件：%s 封（%s）\n' "$count" "$MAILBOX_DIR"
}

cmd_reset() { rm -rf "${MAILBOX_DIR:?}"/*; log "收件箱已清空：$MAILBOX_DIR"; }

cmd_latest() {
  local n="${1:-3}"
  [[ -f "$MAILBOX_DIR/mailbox.jsonl" ]] || die '收件箱为空'
  tail -n "$n" "$MAILBOX_DIR/mailbox.jsonl" | jq -r '"#\(.seq) \(.receivedAt) → \(.envelopeTo|join(",")) | \(.subject)"'
}

case "${1:-}" in
  install) cmd_install ;;
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  reset) cmd_reset ;;
  latest) cmd_latest "${2:-3}" ;;
  *) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
