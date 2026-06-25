// Volo · Cache —— 共享集群数据（机器列表）。多个视图都要用机器，集中加载一次 + reload。
import { createContext, useContext, type ReactNode } from "react";
import { listMachines } from "../api/commands";
import { useAsync } from "./useAsync";
import type { Machine } from "../api/types";

interface MachinesCtx {
  machines: Machine[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  byId: (id: number | null | undefined) => Machine | undefined;
}

const Ctx = createContext<MachinesCtx | null>(null);

export function MachinesProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, reload } = useAsync<Machine[]>(() => listMachines(), []);
  const machines = data ?? [];
  const value: MachinesCtx = {
    machines,
    loading,
    error,
    reload,
    byId: (id) => (id == null ? undefined : machines.find((m) => m.id === id)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMachines(): MachinesCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMachines must be used within MachinesProvider");
  return v;
}
