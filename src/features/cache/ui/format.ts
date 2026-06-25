// Volo · Cache —— 通用格式化工具。

/** 字节数 → 自适应单位（B/KB/MB/GB/TB），≥1KB 保留一位小数。 */
export const fmtBytes = (n: number): string => {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
