#!/usr/bin/env bash
# Picumet 实验室：本地 S3 兼容存储集群（A/B/C/D）生命周期脚本。
#
#   ./scripts/lab/env/s3/s3.sh install   # 下载 VersityGW 二进制并构建 picumet-s3-gateway:local
#   ./scripts/lab/env/s3/s3.sh up        # 启动四个实例（9000/9002/9004/9006）并建好 bucket
#   ./scripts/lab/env/s3/s3.sh down      # 停止四个实例
#   ./scripts/lab/env/s3/s3.sh status    # 端口 + 桶内容概览
#   ./scripts/lab/env/s3/s3.sh reset     # 清空四个实例的数据目录（保留容器）
#   ./scripts/lab/env/s3/s3.sh mirror <src> <dst> <key>   # 文件级镜像一个对象（模拟外部同步通道）
#
# 环境变量：
#   PICUMET_S3_CACHE  构建缓存/二进制目录（默认 /home/excnies/picumet-s3）
#   PICUMET_S3_DATA   桶数据目录（默认 $PICUMET_S3_CACHE/data）
#   S3_AK / S3_SK     根凭证（默认 minioadmin / minioadmin）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
CACHE_DIR="${PICUMET_S3_CACHE:-/home/excnies/picumet-s3}"
DATA_DIR="${PICUMET_S3_DATA:-$CACHE_DIR/data}"
IMAGE="picumet-s3-gateway:local"
VGW_VERSION="v1.8.0"
BUCKET="picumet"
AK="${S3_AK:-minioadmin}"
SK="${S3_SK:-minioadmin}"

# 端口：a=9000 b=9002 c=9004 d=9006
declare -A PORT=( [a]=9000 [b]=9002 [c]=9004 [d]=9006 )

log() { printf '\033[36m[s3]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[s3] %s\033[0m\n' "$*" >&2; exit 1; }

download_vgw() {
  mkdir -p "$CACHE_DIR/context"
  if [[ -x "$CACHE_DIR/context/versitygw" ]]; then
    log "VersityGW 二进制已存在：$CACHE_DIR/context/versitygw"
    return
  fi
  local tarball="$CACHE_DIR/versitygw.tar.gz"
  log "下载 VersityGW $VGW_VERSION …"
  curl -fsSL --retry 3 -o "$tarball" \
    "https://github.com/versity/versitygw/releases/download/$VGW_VERSION/versitygw_${VGW_VERSION}_Linux_x86_64.tar.gz" \
    || die "下载失败（需要能访问 GitHub releases）"
  tar xzf "$tarball" -C "$CACHE_DIR"
  mv "$CACHE_DIR/versitygw_${VGW_VERSION}_Linux_x86_64/versitygw" "$CACHE_DIR/context/versitygw"
  rm -rf "$CACHE_DIR/versitygw_${VGW_VERSION}_Linux_x86_64" "$tarball"
  chmod +x "$CACHE_DIR/context/versitygw"
}

cmd_install() {
  download_vgw
  cp "$HERE/Dockerfile" "$CACHE_DIR/context/Dockerfile"
  log "构建镜像 $IMAGE …"
  docker build -t "$IMAGE" "$CACHE_DIR/context" >/dev/null
  log "镜像就绪：$(docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep "^$IMAGE")"
}

cmd_up() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || cmd_install
  mkdir -p "$DATA_DIR"/{a,b,c,d}
  for k in a b c d; do mkdir -p "$DATA_DIR/$k/$BUCKET"; done
  PICUMET_S3_DATA="$DATA_DIR" docker compose -f "$HERE/docker-compose.yml" up -d
  log "等待四个实例就绪 …"
  local ok=0
  for i in $(seq 1 40); do
    ok=0
    for k in a b c d; do
      if (exec 3<>"/dev/tcp/127.0.0.1/${PORT[$k]}") 2>/dev/null; then exec 3>&-; ok=$((ok + 1)); fi
    done
    [[ $ok -eq 4 ]] && break
    sleep 0.5
  done
  [[ $ok -eq 4 ]] || die "仅 $ok/4 个实例端口就绪"
  for k in a b c d; do
    log "  $k → http://127.0.0.1:${PORT[$k]}  数据目录 $DATA_DIR/$k"
  done
}

cmd_down() {
  PICUMET_S3_DATA="$DATA_DIR" docker compose -f "$HERE/docker-compose.yml" down
}

cmd_stop_one() {  # 用于容灾测试：只停一个实例
  local k="${1:-}"
  [[ -n "$k" ]] || die "用法：s3.sh stop-one <a|b|c|d>"
  docker stop "picumet-s3-$k" >/dev/null && log "已停止 picumet-s3-$k"
}

cmd_start_one() {
  local k="${1:-}"
  [[ -n "$k" ]] || die "用法：s3.sh start-one <a|b|c|d>"
  docker start "picumet-s3-$k" >/dev/null && log "已启动 picumet-s3-$k"
}

cmd_status() {
  docker ps -a --filter name=picumet-s3- --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}'
  for k in a b c d; do
    local dir="$DATA_DIR/$k/$BUCKET"
    if [[ -d "$dir" ]]; then
      printf '  %s/%s: %s 个文件, %s\n' "$k" "$BUCKET" "$(find "$dir" -type f 2>/dev/null | wc -l)" "$(du -sh "$dir" 2>/dev/null | cut -f1)"
    fi
  done
}

cmd_reset() {
  for k in a b c d; do
    rm -rf "${DATA_DIR:?}/$k"
    mkdir -p "$DATA_DIR/$k/$BUCKET"
  done
  log "四个实例的数据目录已清空"
}

# 文件级镜像：VersityGW posix 后端把对象存为 /data/<bucket>/<key>，
# 因此「外部同步通道」（真实部署里是 rclone/云复制）在本实验室用文件复制等价模拟。
cmd_mirror() {
  local src="${1:-}" dst="${2:-}" key="${3:-}"
  [[ -n "$src" && -n "$dst" && -n "$key" ]] || die "用法：s3.sh mirror <a|b|c|d> <a|b|c|d> <key>"
  local s="$DATA_DIR/$src/$BUCKET/$key" d="$DATA_DIR/$dst/$BUCKET/$key"
  [[ -f "$s" ]] || die "源对象不存在：$s"
  mkdir -p "$(dirname "$d")"
  cp -a "$s" "$d"
  # xattr 元数据随文件属性一起复制（cp -a 保留 xattr）
  log "镜像 $src/$key → $dst/$key"
}

case "${1:-}" in
  install) cmd_install ;;
  up) cmd_up ;;
  down) cmd_down ;;
  stop-one) cmd_stop_one "${2:-}" ;;
  start-one) cmd_start_one "${2:-}" ;;
  status) cmd_status ;;
  reset) cmd_reset ;;
  mirror) cmd_mirror "${2:-}" "${3:-}" "${4:-}" ;;
  *) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
