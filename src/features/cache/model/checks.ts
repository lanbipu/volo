/* 巡检探测项的界面文案。探测项 key 的唯一真相源是后端 PROBE_REGISTRY
   （crates/cache-core/src/core/probe_keys.rs）；这里只给人话：
   label = 巡检列表里的一条断言（通过时读起来成立），fail = 行内一句话状况。 */
export const CHECK_TEXT: Record<string, { label: string; fail: string }> = {
  tcp_5985: { label: "远程管理通道可达", fail: "远程管理通道不通" },
  tcp_445: { label: "文件共享通道可达", fail: "文件共享通道不通" },
  tcp_135: { label: "远程调用通道可达", fail: "远程调用通道不通" },
  firewall_445: { label: "防火墙放行文件共享", fail: "防火墙挡住了文件共享" },
  local_account_token_filter: { label: "本地账户可远程管理", fail: "本地账户的远程权限没放开" },
  long_paths_enabled: { label: "系统已开启长路径", fail: "系统没开启长路径支持" },
  lanman_server: { label: "文件共享服务在运行", fail: "文件共享服务没在运行" },
  share_reachable: { label: "共享缓存目录可达", fail: "连不上共享缓存目录" },
  ntfs_perm: { label: "共享目录权限正确", fail: "共享缓存目录权限不对" },
  cred_user: { label: "共享访问账号可用", fail: "共享访问账号还没准备好" },
  cred_system: { label: "后台服务凭据可用", fail: "后台服务访问共享的凭据缺失" },
  env_vars: { label: "缓存路径已配置", fail: "缓存路径没配置" },
  env_local: { label: "本地缓存路径已设置", fail: "本地缓存路径没设置" },
  env_shared: { label: "已指向共享缓存", fail: "没有指向共享缓存" },
  system_write: { label: "缓存目录可写", fail: "缓存目录写不进去" },
  winmgmt: { label: "系统信息服务在运行", fail: "系统信息服务没在运行" },
  rs_service: { label: "RenderStream 服务就绪", fail: "RenderStream 服务没就绪" },
  ini_consistency: { label: "工程配置与集群一致", fail: "工程配置与集群不一致" },
  pso_precaching: { label: "PSO 预缓存已打开", fail: "工程配置关掉了 PSO 预缓存" },
  gpu_consistency: { label: "GPU 驱动与集群一致", fail: "GPU 驱动与集群不一致" },
  zen_reachable: { label: "Zen 缓存服务器可达", fail: "连不上 Zen 缓存服务器" },
  zen_version_consistent: { label: "Zen 版本与集群一致", fail: "Zen 版本与集群不一致" },
  zen_binary_intact: { label: "Zen 程序完整", fail: "Zen 程序文件不完整" },
  zen_cache_provider_ready: { label: "Zen 缓存已就绪", fail: "Zen 缓存还没就绪" },
};

export function checkLabel(key: string): string {
  return CHECK_TEXT[key]?.label ?? key;
}
