#!/bin/bash
# 一键：把本机 git ref 同步到 RazerPC 并拉起 VoloDev（交互桌面可见）。
# 用法（在 Mac 上）：
#   ./scripts/sync-razer-dev.sh              # 同步 main + 重启
#   ./scripts/sync-razer-dev.sh HEAD         # 同步当前 HEAD
#   ./scripts/sync-razer-dev.sh --no-restart # 只同步不重启
#   ./scripts/sync-razer-dev.sh --force      # 工作区有未提交改动也继续（仍只同步已提交 commit）
#
# 依赖：sshpass、~/.ssh/.razer_pass、Razer 在线（192.168.10.173）
# 远端：C:\vpdeploy\volo.bundle → C:\work\volo，计划任务 VoloDev
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RAZER_HOST="192.168.10.173"
RAZER_USER="lanbp"
PASS_FILE="${VOLO_RAZER_PASS_FILE:-/Users/bip.lan/.ssh/.razer_pass}"
BUNDLE_LOCAL="${TMPDIR:-/tmp}/volo.bundle"
BUNDLE_REMOTE="C:/vpdeploy/volo.bundle"
REMOTE_REPO="C:/work/volo"
LOG_REMOTE="C:\\vpdeploy\\volo-dev.log"
START_TIMEOUT="${VOLO_RAZER_START_TIMEOUT:-180}"

REF="main"
NO_RESTART=0
FORCE=0

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage 0 ;;
    --no-restart) NO_RESTART=1 ;;
    --force) FORCE=1 ;;
    -*)
      echo "未知参数: $arg" >&2
      usage 1
      ;;
    *) REF="$arg" ;;
  esac
done

ssh_razer() {
  sshpass -f "$PASS_FILE" ssh \
    -o PubkeyAuthentication=no \
    -o ConnectTimeout=8 \
    "${RAZER_USER}@${RAZER_HOST}" "$@"
}

scp_razer() {
  sshpass -f "$PASS_FILE" scp \
    -o PubkeyAuthentication=no \
    -o ConnectTimeout=8 \
    "$@"
}

section() { printf '\n==> %s\n' "$1"; }

die() { echo "错误: $*" >&2; exit 1; }

# ---------- preflight ----------
command -v sshpass >/dev/null || die "需要 sshpass（brew install sshpass / hudochenkov/sshpass）"
command -v git >/dev/null || die "需要 git"
[[ -f "$PASS_FILE" ]] || die "密码文件不存在: $PASS_FILE"
nc -z -w5 "$RAZER_HOST" 22 >/dev/null 2>&1 || die "RazerPC ($RAZER_HOST) 不可达"

if ! git rev-parse --verify "${REF}" >/dev/null 2>&1; then
  die "本地找不到 ref: ${REF}"
fi

if [[ -n "$(git status --porcelain)" && "${FORCE}" -eq 0 ]]; then
  die "工作区有未提交改动。先 commit，或加 --force（仍只同步已提交的 ${REF}）"
fi

COMMIT="$(git rev-parse --short "${REF}")"
SUBJECT="$(git log -1 --format=%s "${REF}")"
section "同步 ${REF} (${COMMIT}) — ${SUBJECT}"

# ---------- bundle + scp ----------
section "打 bundle → ${BUNDLE_LOCAL}"
git bundle create "${BUNDLE_LOCAL}" "${REF}"

section "scp → ${RAZER_USER}@${RAZER_HOST}:${BUNDLE_REMOTE}"
scp_razer "$BUNDLE_LOCAL" "${RAZER_USER}@${RAZER_HOST}:${BUNDLE_REMOTE}"

# ---------- remote update ----------
# bundle 里的 ref 名可能是 main；若传 HEAD，远端仍用 origin/main（remote 指向 bundle 的 heads）
# 完整 history bundle 里包含 refs/heads/<name>；用 git fetch 后 reset 到 FETCH_HEAD 更稳
section "远端 git fetch + reset --hard"
# Windows OpenSSH 默认 cmd：不能用 /dev/null；FETCH_HEAD 兼容 bundle 里非 main 的 ref
FETCH_LOG="$(ssh_razer "cd ${REMOTE_REPO} && git fetch origin && git reset --hard FETCH_HEAD" 2>&1)" \
  || die "远端 git fetch/reset 失败"
printf '%s\n' "${FETCH_LOG}" | grep -v 'WARNING\|vulnerable\|upgraded\|pq.html' || true
REMOTE_SHORT="$(ssh_razer "cd ${REMOTE_REPO} && git rev-parse --short HEAD" 2>/dev/null | tr -d '\r' | tail -1)"
REMOTE_SUBJ="$(ssh_razer "cd ${REMOTE_REPO} && git log -1 --format=%s" 2>/dev/null | tr -d '\r' | tail -1)"
echo "${REMOTE_SHORT} ${REMOTE_SUBJ}"
if [[ "${REMOTE_SHORT}" != "${COMMIT}" ]]; then
  die "远端 HEAD (${REMOTE_SHORT}) 与本地 ${COMMIT} 不一致"
fi

if [[ "${NO_RESTART}" -eq 1 ]]; then
  section "跳过重启（--no-restart）"
  echo "完成：${COMMIT} 已在 Razer ${REMOTE_REPO}"
  exit 0
fi

# ---------- restart VoloDev ----------
section "停旧进程并 schtasks /run VoloDev"
# SSH 非交互下 cmd 的 timeout 会因「不支持输入重定向」失败；用 ping 延时
ssh_razer 'cmd /c "taskkill /F /IM volo.exe /T 2>nul & taskkill /F /IM node.exe /T 2>nul & taskkill /F /IM vpcal.exe /T 2>nul & schtasks /end /tn VoloDev 2>nul & ping -n 3 127.0.0.1 >nul & schtasks /run /tn VoloDev"' \
  2>&1 | grep -v 'WARNING\|vulnerable\|upgraded\|pq.html' || true

section "等待就绪（最多 ${START_TIMEOUT}s）"
elapsed=0
ready=0
while [[ "${elapsed}" -lt "${START_TIMEOUT}" ]]; do
  # 日志里的 ANSI 不影响匹配；进程用裸 tasklist，避免 cmd 嵌套引号踩坑
  if ssh_razer 'tasklist' 2>/dev/null | grep -qi '^volo\.exe'; then
    TAIL="$(ssh_razer "powershell -NoProfile -Command \"Get-Content -LiteralPath '${LOG_REMOTE}' -Tail 40 -ErrorAction SilentlyContinue\"" 2>/dev/null || true)"
    if printf '%s\n' "${TAIL}" | grep -Fq 'volo started'; then
      ready=1
      break
    fi
  fi
  sleep 3
  elapsed=$((elapsed + 3))
  printf '  … %ss\n' "${elapsed}"
done

if [[ "${ready}" -ne 1 ]]; then
  echo "等待超时；最近日志：" >&2
  ssh_razer "powershell -NoProfile -Command \"Get-Content -LiteralPath '${LOG_REMOTE}' -Tail 40 -ErrorAction SilentlyContinue\"" 2>/dev/null \
    | grep -v 'WARNING\|vulnerable\|upgraded\|pq.html' || true
  die "VoloDev 未在 ${START_TIMEOUT}s 内就绪（代码已同步到 ${COMMIT}）"
fi

section "就绪"
ssh_razer "powershell -NoProfile -Command \"Get-Content -LiteralPath '${LOG_REMOTE}' -Tail 15\"" 2>/dev/null \
  | grep -v 'WARNING\|vulnerable\|upgraded\|pq.html' || true
echo
echo "完成：Razer 已同步到 ${COMMIT} 且 VoloDev 在跑"
