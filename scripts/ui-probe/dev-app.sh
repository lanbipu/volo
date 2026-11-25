#!/bin/bash
# 运行时 UI 验证用：把开发版二进制套成 ~/Applications/Volo Dev.app 再启动，让 Computer Use 能认出它（按 bundle id 授权、后台操作）。
# `pnpm tauri dev` 起的是裸进程 target/debug/volo，不是 .app，Computer Use 查不到它。
# 外壳里的可执行文件是指向 target/debug/volo 的符号链接：重编后不用重做外壳；
# debug 构建（不带 custom-protocol）从 devUrl 加载页面，所以前端热更新照常生效。
#
# 用法：scripts/ui-probe/dev-app.sh [--build]
#   --build  先 cargo build（改了 src-tauri 时用），否则直接用现有二进制
# 环境：CARGO_TARGET_DIR 指向要用的 target/（worktree 里通常指主仓的 target/）。
# 日志：仓库根目录 volo-vite.log（前端）、volo-app.log（App）。
#
# Computer Use 实测（2026-11）：app_click / app_type / app_key 后台都能打进 WKWebView。注意：
#   - app_type 的 mode:"replace" 靠 cmd+a，后台 App 不认 → 先点到末尾，再逐个 backspace（count 参数不生效，要拆成多步）。
#   - 打字时 -- 会变破折号、引号变弯引号（系统「智能引号和破折号」，per-app defaults 和 disable_substitutions 都挡不住），
#     含 -- 的路径（如 Claude scratchpad）别手打，换个路径。
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN="$TARGET_DIR/debug/volo"
APP="$HOME/Applications/Volo Dev.app"
BUNDLE_ID="com.lanbipu.volo.dev"

# sidecar 默认按编译期的 workspace 找 venv；worktree 里有空的 target/ 会找错，这里显式指到真正的 venv。
sidecar_path() {
  local name=$1 d
  for d in "$ROOT" "$(dirname "$TARGET_DIR")"; do
    if [ -x "$d/sidecars/$name/.venv/bin/$name" ]; then
      echo "$d/sidecars/$name/.venv/bin/$name"
      return
    fi
  done
}

if [ "$1" = "--build" ]; then
  echo "cargo build…"
  CARGO_TARGET_DIR="$TARGET_DIR" cargo build --manifest-path src-tauri/Cargo.toml
fi
[ -x "$BIN" ] || { echo "找不到 $BIN，先加 --build" >&2; exit 1; }

# 1. 外壳（每次重写 Info.plist，sidecar 路径跟着当前仓库走）
mkdir -p "$APP/Contents/MacOS"
ln -sfn "$BIN" "$APP/Contents/MacOS/volo"
TRACKSIM="$(sidecar_path tracksim)"
VPCAL="$(sidecar_path vpcal)"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Volo Dev</string>
  <key>CFBundleDisplayName</key><string>Volo Dev</string>
  <key>CFBundleExecutable</key><string>volo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0-dev</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSEnvironment</key>
  <dict>
    <key>VOLO_TRACKSIM_SIDECAR_PATH</key><string>$TRACKSIM</string>
    <key>VOLO_VPCAL_SIDECAR_PATH</key><string>$VPCAL</string>
  </dict>
</dict>
</plist>
EOF
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

# 2. 关掉旧的开发版实例（tauri dev 会连带停掉它起的 vite，所以先关再查前端）
pkill -f "pnpm tauri dev" 2>/dev/null || true
pkill -f "tauri dev" 2>/dev/null || true
pkill -f "$BIN" 2>/dev/null && sleep 1 || true

# 3. 前端 dev server（已在跑就复用）
if ! curl -sf -o /dev/null http://127.0.0.1:1420/; then
  echo "启动 vite（日志 volo-vite.log）…"
  nohup pnpm dev > "$ROOT/volo-vite.log" 2>&1 &
  disown
  for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:1420/ && break; sleep 1; done
fi

# 4. 从外壳启动
open -n "$APP" --stdout "$ROOT/volo-app.log" --stderr "$ROOT/volo-app.log"
echo "已启动 Volo Dev（$BUNDLE_ID）"
