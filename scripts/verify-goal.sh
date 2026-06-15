#!/usr/bin/env bash
# verify-goal.sh — Volo monorepo 移植成功标准的一键验证。
#
# 成功标准（全绿 = 移植达成）：
#   1. Rust workspace 可编译         cargo build --workspace
#   2. Rust workspace 测试 0 failed  cargo test --workspace
#   3. 前端可构建                    pnpm build (tsc && vite build)
#   4. voloctl uecm system version --json 含 schema_version
#   5. voloctl lmt  version        --json 含 schema_version
#   6. 三个 Python sidecar 落位      sidecars/{mesh-vba,vpcal,tracksim}/pyproject.toml
#   7. 六个前端 feature 占位页        src/features/<tab>/index.tsx
#
# 从 repo 根或任意目录运行皆可：脚本自行 cd 到所在目录的上一级（repo 根）。
# 每项输出 ✅ / ❌；末尾汇总，exit 码反映成败（0 = 全绿）。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

ok()   { echo "✅ $1"; PASS=$((PASS + 1)); }
bad()  { echo "❌ $1"; FAIL=$((FAIL + 1)); }

run_step() { # <label> <cmd...>
  local label="$1"; shift
  echo "── $label ──"
  if "$@" > /tmp/volo_goal_step.log 2>&1; then
    ok "$label"
  else
    bad "$label（见下方末尾日志）"
    tail -15 /tmp/volo_goal_step.log | sed 's/^/    | /'
  fi
}

echo "Volo 移植验证 @ $REPO_ROOT"
echo "============================================================"

# 1. cargo build --workspace
run_step "cargo build --workspace" cargo build --workspace

# 2. cargo test --workspace（确保 0 failed：任何 test 失败会令 cargo 返回非 0）
run_step "cargo test --workspace（0 failed）" cargo test --workspace

# 3. pnpm build（tsc && vite build）
run_step "pnpm build（tsc && vite build）" pnpm build

# 4 & 5. voloctl 两个 version 命令 —— 需 schema_version 字段
VOLOCTL="$REPO_ROOT/target/debug/voloctl"
echo "── voloctl uecm system version --json | grep schema_version ──"
if [ -x "$VOLOCTL" ] && "$VOLOCTL" uecm system version --json 2>/dev/null | grep -q schema_version; then
  ok "voloctl uecm system version --json 含 schema_version"
else
  bad "voloctl uecm system version --json 含 schema_version"
fi

echo "── voloctl lmt version --json | grep schema_version ──"
if [ -x "$VOLOCTL" ] && "$VOLOCTL" lmt version --json 2>/dev/null | grep -q schema_version; then
  ok "voloctl lmt version --json 含 schema_version"
else
  bad "voloctl lmt version --json 含 schema_version"
fi

# 6. 三个 sidecar 包存在（各有 pyproject.toml）
echo "── 三个 Python sidecar 落位 ──"
for sc in mesh-vba vpcal tracksim; do
  if [ -f "sidecars/$sc/pyproject.toml" ]; then
    ok "sidecars/$sc/pyproject.toml"
  else
    bad "sidecars/$sc/pyproject.toml（缺失）"
  fi
done

# 7. 六个 feature 占位存在（各有 index.tsx）
echo "── 六个前端 feature 占位页 ──"
for f in previz calibrate color cache live tools; do
  if [ -f "src/features/$f/index.tsx" ]; then
    ok "src/features/$f/index.tsx"
  else
    bad "src/features/$f/index.tsx（缺失）"
  fi
done

echo "============================================================"
echo "通过 $PASS 项，失败 $FAIL 项。"
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 GOAL 达成：Volo 移植全绿。"
  exit 0
else
  echo "⚠️  GOAL 未达成：尚有 $FAIL 项失败。"
  exit 1
fi
