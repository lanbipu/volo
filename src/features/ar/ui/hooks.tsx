/* AR 页面共用的小件：/ 聚焦搜索、进行中计时、活动列表。 */
import { useEffect, useState, type RefObject } from "react";
import type { ActivityItem } from "@/ui";
import { dur, shortTime, type ArEvent } from "../model/ar";

/** 按 / 聚焦搜索框（输入框里不拦）。 */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/** 进行中的计时，每秒走一次。 */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{dur(now - since)}</>;
}

export function logItems(events: ArEvent[]): ActivityItem[] {
  return events.map((e) => ({
    key: e.key,
    icon: e.kind === "failed" ? "failed" : e.kind === "running" ? "spinner" : e.kind === "info" ? "clock" : "success",
    iconColor: e.kind === "failed" ? "var(--status-failed)" : e.kind === "success" ? "var(--status-success)" : undefined,
    text: e.text,
    time: shortTime(e.at),
  }));
}
