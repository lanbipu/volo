#!/bin/bash
# 重启 tauri dev —— 后台/detached 启动的 tauri dev 不会自动重编 src-tauri 改动，
# 改了 Rust 代码后跑这个脚本代替手动 kill + 重启（见 CLAUDE.md）。
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "停止现有 tauri dev 进程…"
pkill -f "tauri dev" 2>/dev/null && sleep 1 || true
pkill -x volo 2>/dev/null || true
PORT_PID=$(lsof -ti:1420 2>/dev/null || true)
[ -n "$PORT_PID" ] && kill $PORT_PID 2>/dev/null || true

LOG="$(pwd)/volo-dev.log"
echo "重新启动 tauri dev（日志：$LOG）…"
nohup pnpm tauri dev > "$LOG" 2>&1 &
disown
echo "已启动，pid $!"
