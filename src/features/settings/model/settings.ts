/* 设置与凭据的数据层。
   通用：本机偏好（巡检间隔等）存 localStorage；主题 / 密度在外壳 shellStore。
   凭据：只读出“有没有、在哪”——机器的 SSH 状态、共享目录用的凭据、本机凭据库里的条目；不读密码，也不改注入逻辑。
   后端没有“上次验证”记录：SSH 用机器最后在线时间，共享凭据显示「—」。 */
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appInfo, deleteCredential, listCredentials, listMachines, listShares, saveCredential } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import type { CredentialRecord, Machine, ShareConfig } from "@/api/types";
import { persistOptions } from "@/lib/persist";

/* ------------------------------ 通用 ------------------------------ */

export interface GeneralSettings {
  patrolOnStart: boolean;
  patrolTimed: boolean;
  patrolMinutes: string;
}
interface GeneralStore extends GeneralSettings {
  set: (p: Partial<GeneralSettings>) => void;
}
export const useGeneralSettings = create<GeneralStore>()(
  persist(
    (set) => ({ patrolOnStart: false, patrolTimed: false, patrolMinutes: "15", set: (p) => set(p) }),
    persistOptions("settings.general", 1, (s: GeneralStore): GeneralSettings => ({ patrolOnStart: s.patrolOnStart, patrolTimed: s.patrolTimed, patrolMinutes: s.patrolMinutes })),
  ),
);

export function useAppInfo() {
  return useQuery({ queryKey: ["settings", "app-info"], queryFn: appInfo, enabled: isTauri(), staleTime: Infinity });
}

/* ------------------------------ 凭据 ------------------------------ */

export const credKeys = {
  machines: ["cache", "machines"] as const,
  shares: ["settings", "shares"] as const,
  creds: ["settings", "credentials"] as const,
};

export type CredGroup = "ssh" | "share" | "store";
export type CredState = "success" | "offline" | "queued" | "attention";

export interface CredRow {
  key: string;
  group: CredGroup;
  state: CredState;
  stateLabel: string;
  machine: string;
  purpose: string;
  account: string | null;
  location: string | null;
  verifiedAt: string | null;
  machineRaw?: Machine;
  share?: ShareConfig;
  cred?: CredentialRecord;
}

export const GROUP_LABEL: Record<CredGroup, string> = {
  ssh: "远程管理 · SSH",
  share: "共享目录访问 · 旧版缓存",
  store: "本机凭据库",
};

const machineState = (m: Machine): [CredState, string] => (m.status === "offline" ? ["offline", "离线"] : m.status === "online" ? ["success", "就绪"] : ["queued", "未连接过"]);

export function useCredRows() {
  const machinesQ = useQuery({ queryKey: credKeys.machines, queryFn: listMachines, enabled: isTauri() });
  const sharesQ = useQuery({ queryKey: credKeys.shares, queryFn: listShares, enabled: isTauri() });
  const credsQ = useQuery({ queryKey: credKeys.creds, queryFn: listCredentials, enabled: isTauri() });
  const rows = useMemo<CredRow[]>(() => {
    const machines = machinesQ.data ?? [];
    const creds = credsQ.data ?? [];
    const byId = new Map(machines.map((m) => [m.id, m]));
    const byAlias = new Map(creds.map((c) => [c.alias, c]));
    const out: CredRow[] = machines.map((m) => {
      const [state, stateLabel] = machineState(m);
      return {
        key: `ssh-${m.id}`,
        group: "ssh",
        state,
        stateLabel,
        machine: m.hostname,
        purpose: "Volo 登录这台机器执行命令",
        account: "SSH 密钥",
        location: "本机 SSH 密钥",
        verifiedAt: m.last_seen_at,
        machineRaw: m,
      };
    });
    for (const s of sharesQ.data ?? []) {
      const host = byId.get(s.host_machine_id)?.hostname ?? `#${s.host_machine_id}`;
      const c = s.credential_alias ? byAlias.get(s.credential_alias) : undefined;
      const open = s.mode === "open";
      const state: CredState = open ? "success" : c ? "success" : "attention";
      out.push({
        key: `share-${s.id}`,
        group: "share",
        state,
        stateLabel: open ? "不需要凭据" : c ? "就绪" : "缺凭据",
        machine: host,
        purpose: `读写 ${s.unc_path}`,
        account: open ? "来宾访问" : (c?.username ?? s.credential_alias ?? null),
        location: open ? null : c ? "本机凭据库，写入时注入客户端" : null,
        verifiedAt: null,
        share: s,
        cred: c,
      });
    }
    for (const c of creds) {
      out.push({
        key: `store-${c.alias}`,
        group: "store",
        state: c.kind === "winrm" ? "queued" : "success",
        stateLabel: c.kind === "winrm" ? "已停用" : "已保存",
        machine: "本机",
        purpose: c.kind === "share" ? `共享目录账户 · ${c.alias}` : `WinRM（已停用）· ${c.alias}`,
        account: c.username,
        location: "本机凭据库",
        verifiedAt: null,
        cred: c,
      });
    }
    return out;
  }, [machinesQ.data, sharesQ.data, credsQ.data]);
  const loading = machinesQ.isLoading || sharesQ.isLoading || credsQ.isLoading;
  const refetch = () => Promise.all([machinesQ.refetch(), sharesQ.refetch(), credsQ.refetch()]);
  return { rows, loading, refetch, fetchedAt: Math.max(machinesQ.dataUpdatedAt, sharesQ.dataUpdatedAt, credsQ.dataUpdatedAt) };
}

export function useSaveCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { alias: string; username: string; password: string }) => saveCredential(v.alias, "share", v.username, v.password),
    onSettled: () => void qc.invalidateQueries({ queryKey: credKeys.creds }),
  });
}

export function useDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alias: string) => deleteCredential(alias),
    onSettled: () => void qc.invalidateQueries({ queryKey: credKeys.creds }),
  });
}
