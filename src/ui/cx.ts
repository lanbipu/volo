/** 拼 className：忽略 false / null / undefined / 空串。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
