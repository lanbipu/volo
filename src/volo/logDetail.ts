/* Volo — console log 明细格式化：把 runCmd/runStreamingCmd 已经拿到的真实调度元信息
   （domain/action/target/channel/note/耗时/后端返回值或错误）拼成对齐的 key: value 块，
   给 LogPanel 的行内展开 / 复制使用。不是 mock 的假数据——全部来自真实调用现场。 */

/** 把 [key, value] 列表格式化成对齐的多行 "  key : value" 文本；value 为 null/undefined/'' 的行跳过。 */
export function fmtDetail(fields: Array<[string, unknown]>): string {
  const rows = fields.filter(([, v]) => v !== null && v !== undefined && v !== "") as Array<[string, unknown]>;
  if (!rows.length) return "";
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)} : ${typeof v === "string" ? v : safeJson(v)}`).join("\n");
}

/** JSON.stringify 一个后端返回值/事件 payload，超长截断（detail 是拿去复制排查的，不需要无限长）。 */
export function safeJson(v: unknown, maxLen = 4000): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2);
  } catch {
    s = String(v);
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + `\n  …(截断，完整长度 ${s.length} 字符)`;
  return s;
}
