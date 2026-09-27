#!/usr/bin/env bash
# Picumet 实验室：本地开发栈生命周期（备份 / 还原 / 重置 / 启停 / 状态）。
#
#   ./scripts/lab/env/stack.sh status          # 端口 + 容器 + D1 概览
#   ./scripts/lab/env/stack.sh backup          # 备份 .wrangler/state + .dev.vars + wrangler.toml + migrations
#   ./scripts/lab/env/stack.sh restore [ts]    # 从备份还原（缺省用 LATEST），会先停掉开发栈
#   ./scripts/lab/env/stack.sh reset --db      # 清空本地 D1/KV/R2 状态并重新执行迁移（不动 S3/SMTP 容器）
#   ./scripts/lab/env/stack.sh up              # 后台启动 workers(8787, --test-scheduled) 与 frontend(5173)
#                                              # 建议单独调用（`./stack.sh up;`）；若写入管道（`| tail`），
#                                              # 脚本已关闭继承 fd 但仍建议不要 piped，避免调用方等待 EOF
#   ./scripts/lab/env/stack.sh down            # 停止上述两个进程
#
# 备份目录：${PICUMET_BACKUP_DIR:-/home/excnies/picumet-backup}/<时间戳>，并维护 LATEST 软链。
# 日志与 PID：<repo>/.tmp/lab-logs/（.tmp/ 已被 .gitignore 忽略）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
WORKERS_DIR="$REPO_ROOT/workers"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKUP_ROOT="${PICUMET_BACKUP_DIR:-/home/excnies/picumet-backup}"
LOG_DIR="$REPO_ROOT/.tmp/lab-logs"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"
API_PID="$LOG_DIR/api.pid"
WEB_PID="$LOG_DIR/web.pid"

log() { printf '\033[36m[stack]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[stack] %s\033[0m\n' "$*" >&2; exit 1; }

cmd_backup() {
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local dest="$BACKUP_ROOT/$ts"
  mkdir -p "$dest"
  cp -a "$WORKERS_DIR/.dev.vars" "$dest/dev.vars"
  cp -a "$WORKERS_DIR/wrangler.toml" "$dest/wrangler.toml"
  cp -a "$WORKERS_DIR/migrations" "$dest/migrations"
  cp -a "$WORKERS_DIR/.wrangler/state" "$dest/wrangler-state"
  (cd "$REPO_ROOT" && git rev-parse HEAD > "$dest/HEAD.txt" 2>/dev/null || true)
  ln -sfn "$dest" "$BACKUP_ROOT/LATEST"
  log "已备份到 $dest（$(du -sh "$dest" | cut -f1)）"
}

cmd_restore() {
  local ts="${1:-}"
  local src
  if [[ -n "$ts" ]]; then src="$BACKUP_ROOT/$ts"; else src="$(readlink -f "$BACKUP_ROOT/LATEST")"; fi
  [[ -d "$src" ]] || die "备份不存在：$src"
  log "停止开发栈 …"; cmd_down || true
  [[ -d "$src/wrangler-state" ]] || die "备份缺少 wrangler-state"
  rm -rf "$WORKERS_DIR/.wrangler/state"
  cp -a "$src/wrangler-state" "$WORKERS_DIR/.wrangler/state"
  [[ -f "$src/dev.vars" ]] && cp -a "$src/dev.vars" "$WORKERS_DIR/.dev.vars"
  [[ -f "$src/wrangler.toml" ]] && cp -a "$src/wrangler.toml" "$WORKERS_DIR/wrangler.toml"
  log "已从 $src 还原（数据库/KV/R2 回到备份时状态）"
  log "提示：S3(A/B/C/D) 与 SMTP 容器的数据目录不在备份范围内（见 docs 报告「备份与还原」）"
}

cmd_reset() {
  [[ "${1:-}" == "--db" ]] || die "用法：stack.sh reset --db"
  log "停止开发栈 …"; cmd_down || true
  rm -rf "$WORKERS_DIR/.wrangler/state" "$WORKERS_DIR/.wrangler/tmp"
  (cd "$WORKERS_DIR" && bunx wrangler d1 migrations apply picumet-db --local >/dev/null)
  log "本地 D1/KV/R2 已重置并重新应用迁移"
}

cmd_up() {
  mkdir -p "$LOG_DIR"
  # 必须完全脱离调用者的会话与文件描述符：只重定向 stdout 不够——子进程仍可能持有调用方的
  # 管道句柄，使上游（CI / 自动化）一直等待。setsid + </dev/null + 三路重定向彻底切断。
  # 关闭 3..20 号继承 fd：仅重定向 0/1/2 时，调用方（CI、agent harness）传入的描述符仍会被
  # 子进程持有，导致调用方在管道上一直等待 EOF。这是「脚本起来了但调用方不返回」的唯一原因。
  (cd "$WORKERS_DIR" && setsid bun run dev -- --test-scheduled --port 8787 \
      </dev/null >"$API_LOG" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- 10>&- 11>&- 12>&- 13>&- 14>&- 15>&- 16>&- 17>&- 18>&- 19>&- 20>&- &
   echo $! >"$API_PID")
  (cd "$FRONTEND_DIR" && setsid bun run dev \
      </dev/null >"$WEB_LOG" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- 10>&- 11>&- 12>&- 13>&- 14>&- 15>&- 16>&- 17>&- 18>&- 19>&- 20>&- &
   echo $! >"$WEB_PID")
  for i in $(seq 1 90); do
    if (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null && (exec 4<>/dev/tcp/127.0.0.1/5173) 2>/dev/null; then
      exec 3>&-; exec 4>&-; log "API 8787 与前端 5173 就绪（日志 $LOG_DIR）"; return
    fi
    sleep 1
  done
  die "启动超时，见 $API_LOG / $WEB_LOG"
}

cmd_down() {
  for f in "$API_PID" "$WEB_PID"; do
    if [[ -f "$f" ]]; then kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; fi
  done
  pkill -f 'wrangler dev' 2>/dev/null || true
  pkill -f 'node_modules/.bin/vite' 2>/dev/null || true
  log "开发栈已停止"
}

cmd_status() {
  printf '== 端口 ==\n'
  for p in 8787 5173 9000 9002 9004 9006 1025; do
    if (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then exec 3>&-; echo "  $p 在监听"; else echo "  $p 未监听"; fi
  done
  printf '== 容器 ==\n'
  docker ps --filter name=picumet- --format '  {{.Names}}\t{{.Status}}' || true
  printf '== D1 ==\n'
  local d1
  d1="$(ls -S "$WORKERS_DIR"/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite 2>/dev/null | grep -v metadata | head -1 || true)"
  if [[ -n "$d1" ]]; then
    sqlite3 "$d1" "SELECT '  users=' || (SELECT COUNT(*) FROM users) || ' files=' || (SELECT COUNT(*) FROM file_metadata) || ' mounts=' || (SELECT COUNT(*) FROM mounts) || ' providers=' || (SELECT COUNT(*) FROM storage_providers) || ' shares=' || (SELECT COUNT(*) FROM shares);"
  else
    echo "  未找到本地 D1（先 stack.sh up 或 reset --db）"
  fi
  printf '== 备份 ==\n'
  ls -1 "$BACKUP_ROOT" 2>/dev/null | tail -3 | sed 's/^/  /' || echo "  （无）"
}

case "${1:-}" in
  status) cmd_status ;;
  backup) cmd_backup ;;
  restore) cmd_restore "${2:-}" ;;
  reset) cmd_reset "${2:-}" ;;
  up) cmd_up ;;
  down) cmd_down ;;
  *) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
