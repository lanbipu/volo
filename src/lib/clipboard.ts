/* 复制到剪贴板 + 轻提示（“复制等效命令”等）。 */
import { toast } from "./toast";

export function copyText(text: string, done = "已复制") {
  navigator.clipboard.writeText(text).then(
    () => toast(done),
    () => toast("复制失败：系统剪贴板不可用"),
  );
}
