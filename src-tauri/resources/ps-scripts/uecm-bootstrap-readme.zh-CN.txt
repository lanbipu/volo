========================================
 UECM SSH Bootstrap 一键部署工具
========================================

这是什么？
--------
让一台全新装好的 Windows 渲染节点，"一次双击" 就完成 UECM
（UE Cache Manager）远程接管所需的全部系统配置。跑完之后，
operator 主机就可以通过局域网用 SSH 远程管理这台机器的 UE
缓存、环境变量、INI 配置、SMB 共享等。

使用步骤
--------
0.（可选但强烈建议）想让 UECM 之后能远程接管这台机器，先用记事本
   打开 UECM-Bootstrap.cmd，找到顶部 UECM_LOCAL_ADMIN_PASSWORD=
   这一行，在等号后填一个强密码（账号名固定 uecm-svc）。
   不填 = 只开 SSH/SMB/WMI，不创建账号（之后没有可远程登录的账号）。
1. 把整个文件夹（U 盘 / 网盘 / 共享文件夹皆可）拷到目标机器。
   文件夹里必须同时有 enable-ssh.ps1、uecm.pub、PsExec64.exe。
2. 双击 UECM-Bootstrap.cmd。
3. 系统弹出 UAC 提示（"是否允许此应用对你的设备进行更改"），
   点击 "是"。
4. 看到窗口出现醒目的 "[ OK ] UECM bootstrap SUCCEEDED" 提示后即可关闭窗口。

整个过程通常 30 秒以内。

跑完之后机器会发生什么变化？
--------------------------
- 安装并启动 OpenSSH Server，设为开机自启，监听 22 端口
- Windows 防火墙放行 SSH 入站（TCP 22）
- 把随包的 uecm.pub 授权进节点的 administrators_authorized_keys
  （这就是 operator 通过 SSH 密钥登录用的那把"钥匙"）
- 文件共享服务（LanmanServer）启动 + 防火墙放行 TCP 445
- WMI 服务确认运行（用于 operator 远程查询 GPU / UE 版本）
- PowerShell 远程执行策略调为 RemoteSigned
- 启用 Windows 长路径支持（UE 工程必备）
- 电源计划切换为 "高性能"
- 把 PsExec64.exe 装到节点（UECM 用它以 SYSTEM 写 SMB 凭据）
- 若填了密码：创建（或重置）本地管理员账号 uecm-svc 并加入
  Administrators 组——SshExecutor 固定以 uecm-svc 登录

跑完之后不会改的：
- 不会装 OpenSSH 以外的软件
- 不会动你现有的用户账号 / 密码（只有你主动在 .cmd 里填了密码时，才会
  创建 / 重置 uecm-svc 这一个本地管理员账号，别的账号一概不碰）
- 不会重启系统
- 不会动 Defender / 反病毒 / EDR
- 不会改 RDP / 域账号 / 已有共享

operator 端首次连接前需要知道的（重要）
------------------------------------------
SSH 是密钥认证：随包的 uecm.pub 必须是 operator 这台机器 UECM
keystore 里的当前公钥（`uecm-cli ssh package-bootstrap` 打包时会自动
放入正确的公钥，不要手工替换）。节点授权了这把公钥后，operator 端的
UECM CLI（uecm-cli machine refresh / env / ini / zen / share 等）
就能以 uecm-svc 通过 SSH 私钥免密登录，无需 TrustedHosts、无需输入
密码。

连接用的账号固定是 uecm-svc：就是你在 .cmd 里填的那一组密码。把它在
UECM 里存成一个凭据别名（用于 SMB 共享等需要密码的场景），这台机器
的所有远程操作都用 SSH 密钥 + 这个账号。

故障排查
--------
[Q] 双击没反应 / UAC 直接关闭：
    右键点击 UECM-Bootstrap.cmd → "以管理员身份运行"。

[Q] 看到红色错误 "Administrator privileges are required"：
    当前 PowerShell 窗口不是管理员权限，按上一条重新走。

[Q] 提示 SSH_EXIT=9：
    enable-ssh.ps1 或 uecm.pub 没和 .cmd 放在同一个文件夹。确认整个
    包（含 enable-ssh.ps1 / uecm.pub / PsExec64.exe）完整拷过来了。

[Q] 跑完之后 operator 端 uecm-cli machine refresh 报
    "ssh probe ... Permission denied"：
    节点没授权当前 operator 的公钥（可能换过 keystore 公钥）。用本机
    最新的包重新双击 UECM-Bootstrap.cmd 重纳管（会重写 authorized_keys），
    或检查 uecm-svc 账号 / sshd 服务 / known_hosts。

[Q] 跑完之后 operator 端 uecm-cli machine refresh 还是
    "ssh offline" / 连不上：
    检查 operator 机和目标机是否在同一网段、防火墙是否放行了 TCP 22、
    OpenSSH Server（sshd）服务是否在运行。

[Q] 已经跑过一次，能再跑吗？
    可以。脚本是幂等的，重复跑不会产生副作用（会再次确保 SSH / 授权
    公钥 / 节点配置就位）。
