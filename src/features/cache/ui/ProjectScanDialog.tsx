/* 扫描工程（设计：ProjectScan.dc.html）。范围：全部在线机器 / 选择机器；在若干目录里找 .uproject。
   “浏览…”在第一台在线机器上逐级列目录（list_remote_directories）。 */
import { useRef, useState } from "react";
import { listRemoteDirectories } from "@/api/commands";
import type { Machine } from "@/api/types";
import { errText, toast } from "@/lib/toast";
import { Button, Check, CommandLine, Dialog, DialogBody, Field, Fields, Icon, IconButton, Menu, MenuItem, Seg, TextInput } from "@/ui";
import { useDiscover } from "../model/projects";
import { useScanRoots } from "../model/scanRoots";
import css from "./cache.module.css";

const isOffline = (m: Machine) => (m.status || "").toLowerCase().includes("offline");

export function ProjectScanDialog({ machines, onClose }: { machines: Machine[]; onClose: () => void }) {
  const favorites = useScanRoots((s) => s.favorites);
  const toggleFav = useScanRoots((s) => s.toggle);
  const online = machines.filter((m) => !isOffline(m) && m.id != null);
  const offline = machines.filter(isOffline);
  const [scope, setScope] = useState<"all" | "pick">("all");
  const [picked, setPicked] = useState<number[]>(() => online.map((m) => m.id as number));
  const [roots, setRoots] = useState<string[]>(favorites);
  const [input, setInput] = useState("");
  const [dirs, setDirs] = useState<string[] | null>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  const discover = useDiscover();

  const targets = scope === "all" ? online.map((m) => m.id as number) : picked;
  const addRoot = (r: string) => {
    const v = r.trim();
    if (v && !roots.includes(v)) setRoots([...roots, v]);
    setInput("");
  };
  const browse = () => {
    const m = online[0];
    if (!m?.id) return toast("没有在线机器可以浏览目录");
    listRemoteDirectories(m.id, input.trim() || null).then(setDirs, (e) => toast(`列目录失败：${errText(e)}`));
  };
  const cmd = `voloctl project discover --machine-id ${targets[0] ?? "<机器>"} --roots ${roots.join(",") || "<目录>"}`;

  return (
    <Dialog
      title="扫描工程"
      width={500}
      onClose={onClose}
      actions={
        <>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            icon="search"
            busy={discover.isPending}
            disabled={!roots.length || !targets.length}
            onClick={() =>
              discover.mutate(
                { machineIds: targets, roots },
                {
                  onSuccess: (r) => {
                    toast(r.found ? `发现 ${r.found} 个工程位置${r.failed ? `（${r.failed} 台失败）` : ""}` : `扫描完成，没找到 .uproject${r.failed ? `（${r.failed} 台失败）` : ""}`);
                    onClose();
                  },
                  onError: (e) => toast(`扫描失败：${errText(e)}`),
                },
              )
            }
          >
            开始扫描
          </Button>
        </>
      }
    >
      <DialogBody>在机器上查找 .uproject。只读取，不改动磁盘上的任何文件。</DialogBody>
      <Fields style={{ marginTop: 16 }}>
        <Field label="范围" hint={offline.length ? `${offline.map((m) => m.hostname).join("、")} 离线，这次不会扫到。它上次的记录保留。` : undefined}>
          <Seg
            block
            label="范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: `全部在线机器 · ${online.length} 台` },
              { value: "pick", label: "选择机器…" },
            ]}
          />
        </Field>
        {scope === "pick" && (
          <div className={css.checkCol}>
            {online.map((m) => (
              <Check key={m.id} checked={picked.includes(m.id as number)} onChange={(on) => setPicked(on ? [...picked, m.id as number] : picked.filter((x) => x !== m.id))}>
                {m.hostname}
              </Check>
            ))}
          </div>
        )}
        <Field label="在这些目录里找" hint="每台机器都在这几个目录里找。某台机器上没有这个目录就跳过。">
          {roots.length > 0 && (
            <ul className={css.rootList}>
              {roots.map((r) => {
                const fav = favorites.includes(r);
                return (
                  <li key={r} className={css.rootItem}>
                    <Icon name="project" size="sm" />
                    <span className={`ry-mono ${css.rootPath}`}>{r}</span>
                    <IconButton size="sm" icon="star" label={fav ? "从常用中移除" : "设为常用"} pressed={fav} onClick={() => toggleFav(r)} />
                    <IconButton size="sm" icon="close" label="移除这个目录" onClick={() => setRoots(roots.filter((x) => x !== r))} />
                  </li>
                );
              })}
            </ul>
          )}
          <div className={`${css.netRow} ${roots.length ? css.mt6 : ""}`}>
            <TextInput mono value={input} onChange={setInput} boxStyle={{ flex: 1 }} placeholder="输入路径，或点右边逐级选择" aria-label="添加搜索目录" onKeyDown={(e) => e.key === "Enter" && addRoot(input)} />
            <Button ref={browseRef} icon="project" onClick={browse} aria-haspopup="menu" aria-expanded={dirs != null}>
              浏览…
            </Button>
            {dirs && (
              <Menu anchor={browseRef} onClose={() => setDirs(null)} label="选择目录" alignEnd width={260}>
                {input.trim() && (
                  <MenuItem icon="check" onSelect={() => (addRoot(input), setDirs(null))}>
                    添加 {input.trim()}
                  </MenuItem>
                )}
                {dirs.length === 0 && (
                  <MenuItem disabled onSelect={() => undefined}>
                    这一层没有子目录
                  </MenuItem>
                )}
                {dirs.map((d) => (
                  <MenuItem key={d} icon="folder" onSelect={() => (setInput(d), setDirs(null))}>
                    {d}
                  </MenuItem>
                ))}
              </Menu>
            )}
          </div>
        </Field>
      </Fields>
      <CommandLine command={cmd} />
    </Dialog>
  );
}
