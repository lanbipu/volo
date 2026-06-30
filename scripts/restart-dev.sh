#!/bin/bash
# 重启 tauri dev —— 后台/detached 启动的 tauri dev 不会自动重编 src-tauri 改动，
# 改了 Rust 代码后跑这个脚本代替手动 kill + 重启（见 CLAUDE.md）。
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="$ROOT/volo-dev.log"
PID_FILE="$ROOT/volo-dev.pid"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
DEV_URL="http://127.0.0.1:1420/"
START_TIMEOUT="${VOLO_DEV_START_TIMEOUT:-120}"

stop_dev() {
  echo "停止现有 tauri dev 进程…"

  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi

  pkill -f "pnpm tauri dev" 2>/dev/null && sleep 1 || true
  pkill -f "tauri dev" 2>/dev/null && sleep 1 || true
  # 仅杀 dev 构建产物，不碰已安装的生产 Volo.app
  pkill -f "${TARGET_DIR}/debug/volo" 2>/dev/null || true

  PORT_PID=$(lsof -ti:1420 2>/dev/null || true)
  if [ -n "$PORT_PID" ]; then
    kill $PORT_PID 2>/dev/null || true
    sleep 1
  fi
}

wait_for_dev() {
  local pid=$1
  local elapsed=0

  while [ "$elapsed" -lt "$START_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "tauri dev 进程已退出（pid $pid）" >&2
      tail -20 "$LOG" >&2 || true
      return 1
    fi
    if curl -sf -o /dev/null "$DEV_URL" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "等待 dev 就绪超时（${START_TIMEOUT}s）" >&2
  tail -20 "$LOG" >&2 || true
  return 1
}

stop_dev

echo "重新启动 tauri dev（日志：$LOG）…"
nohup pnpm tauri dev > "$LOG" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$PID_FILE"
disown

if wait_for_dev "$DEV_PID"; then
  echo "已启动，pid $DEV_PID（$DEV_URL 就绪）"
else
  rm -f "$PID_FILE"
  exit 1
fi
