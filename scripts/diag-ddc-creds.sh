#!/bin/zsh
# DDC Mode B 凭据链路一键取证 — 在 Mac 上运行，SSH 到 lanPC（服务器）和 RazerPC（客户端）取证。
# 用途：定位「加入 DDC 后访问共享仍要求密钥」的根因（见 docs/changes/ 与 CLAUDE.md 拓扑节）。
# 依赖：~/.ssh/config 无 Razer alias —— Razer 走 sshpass + 密码文件（家庭实验室约定）。
set -u

LANPC="lanpc@192.168.10.20"
RAZER_SSH=(sshpass -f /Users/bip.lan/.ssh/.razer_pass ssh -o PubkeyAuthentication=no -o ConnectTimeout=8 lanbp@192.168.10.173)

section() { print -- "\n===== $1 ====="; }

reachable() { nc -z -w5 $1 22 >/dev/null 2>&1 }

# ---------- RazerPC（客户端侧：注入结果取证） ----------
if reachable 192.168.10.173; then
  section "RazerPC: whoami / 交互式用户"
  "${RAZER_SSH[@]}" 'whoami & query user' 2>&1

  section "RazerPC: UECM 计划任务（OnLogon 注入任务是否注册、上次运行结果）"
  "${RAZER_SSH[@]}" 'schtasks /query /fo LIST /v 2>nul | findstr /C:"TaskName" /C:"Last Run Time" /C:"Last Result" | findstr /C:"UECM" /C:"Last"' 2>&1 | grep -B1 -A2 -i UECM

  section "RazerPC: C:\\ProgramData\\UECM 配置/密文/状态文件"
  "${RAZER_SSH[@]}" 'dir /s /b C:\ProgramData\UECM 2>nul'

  section "RazerPC: worker 状态文件内容（modeb-*.json —— ok/write/netuse 错误码）"
  "${RAZER_SSH[@]}" 'for %f in (C:\ProgramData\UECM\status\*.json) do @(echo --- %f --- & type "%f")'

  section "RazerPC: 目标配置内容（CmdkeyTargets 是主机名还是 IP）"
  "${RAZER_SSH[@]}" 'for %f in (C:\ProgramData\UECM\modeb-targets-*.json) do @(echo --- %f --- & type "%f")'

  section "RazerPC: 当前用户 cmdkey /list（注意：SSH 是网络登录，只能看本用户持久化凭据）"
  "${RAZER_SSH[@]}" 'cmdkey /list'

  section "RazerPC: UE-SharedDataCachePath 环境变量（UI「已加入」的判定源）"
  "${RAZER_SSH[@]}" 'reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v UE-SharedDataCachePath 2>nul & echo --- & set UE-'

  section "RazerPC: EnableLinkedConnections（提权进程可见性）"
  "${RAZER_SSH[@]}" 'reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v EnableLinkedConnections 2>nul'
else
  print "RazerPC (192.168.10.173) UNREACHABLE — 跳过客户端取证"
fi

# ---------- lanPC（服务器侧：共享与账户取证） ----------
if reachable 192.168.10.20; then
  section "lanPC: SMB 共享列表"
  ssh -o ConnectTimeout=8 $LANPC 'net share'

  section "lanPC: ddc-svc 本地账户状态（是否存在/未禁用/密码策略）"
  ssh -o ConnectTimeout=8 $LANPC 'net user ddc-svc'

  section "lanPC: 共享 ACL（把 <ShareName> 换成 net share 输出里的 DDC 共享名后手动复查）"
  ssh -o ConnectTimeout=8 $LANPC 'net share | findstr /i ddc'
else
  print "lanPC (192.168.10.20) UNREACHABLE — 跳过服务器取证"
fi

print -- "\n===== 判读要点 ====="
cat <<'EOF'
1. status/modeb-*.json 不存在      → worker 从未运行：注入时无人登录且之后未重新登录，或任务注册失败。
2. status 里 code!=0 / netuse 报错 → 看具体错误：1326=密码错（密文文件与服务器账户不同步）；
                                     53/1231=网络路径问题；5=ACL 拒绝。
3. cmdkey /list 无 LANPC/IP 条目   → 交互式注入未生效（对应 1）或被清除。
4. CmdkeyTargets 与实际访问的 UNC 主机形式（主机名 vs IP）不一致 → 命中 db69895 同类问题。
5. UE-SharedDataCachePath 有值但上述任一失败 → 复现「UI 显示已加入但访问要密码」的假成功链路。
EOF
