/* 提示条（ry-toast）：一句话结果反馈，2.8 秒后消失。外壳渲染，任何层可调 toast()。 */
import { create } from "zustand";

interface ToastState {
  text: string;
  seq: number;
}

export const useToastStore = create<ToastState>(() => ({ text: "", seq: 0 }));

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, ms = 2800): void {
  const seq = useToastStore.getState().seq + 1;
  useToastStore.setState({ text, seq });
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (useToastStore.getState().seq === seq) useToastStore.setState({ text: "" });
  }, ms);
}

/** 把未知异常转成一句可读的话。 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
