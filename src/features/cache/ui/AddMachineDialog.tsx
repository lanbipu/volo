/* 添加机器（设计：MachineAdd.dc.html）。三种方式：扫描网段 / 入网 U 盘 / 手动填写。
   扫描只回 IP 与端口可达性（没有主机名），主机名在加入后由“重新获取机器信息”读取。
   角色后端还没有可写字段 → 选择框禁用，固定显示“渲染节点”。 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addDiscoveredMachine, addMachine, packageSshBootstrap, pickDirectory, refreshMachine, scanNetwork } from "@/api/commands";
import { assignMachineToStage, ensureProjectStageId } from "@/api/stageCommands";
import type { ProbedHost } from "@/api/types";
import { useCurrentStage } from "@/features/stage";
import { errText, toast } from "@/lib/toast";
import { Button, Dialog, DialogBody, Field, Fields, Icon, Seg, Select, TextInput } from "@/ui";
import css from "./cache.module.css";

type Mode = "scan" | "usb" | "manual";

function guessNet(existing: string[]): string {
  const ip = existing.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  return ip ? `${ip.split(".").slice(0, 3).join(".")}.0/24` : "";
}

export function AddMachineDialog({ existing, onClose }: { existing: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { stage, recent } = useCurrentStage();
  const [mode, setMode] = useState<Mode>("scan");
  const [net, setNet] = useState(() => guessNet(existing));
  const [found, setFound] = useState<ProbedHost[] | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [ip, setIp] = useState("");
  const [usbDir, setUsbDir] = useState("");
  const [stagePath, setStagePath] = useState<string | null>(stage?.path ?? null);

  const scan = useMutation({
    mutationFn: (cidr: string) => scanNetwork(cidr.includes("/") ? cidr : `${cidr}/32`),
    onSuccess: (r) => {
      setFound(r.probed);
      setPick(r.probed.filter((h) => !existing.includes(h.ip) && h.winrm_open).map((h) => h.ip));
    },
    onError: (e) => toast(`扫描失败：${errText(e)}`),
  });
  const fresh = useMemo(() => (found ?? []).filter((h) => !existing.includes(h.ip)), [found, existing]);
  const notReady = fresh.find((h) => !h.winrm_open);

  const stageOptions = recent.map((r) => ({ value: r.abs_path, label: stage && r.abs_path === stage.path ? stage.name : r.display_name || r.abs_path.split(/[\\/]/).pop() || r.abs_path }));

  const add = useMutation({
    mutationFn: async () => {
      const ids: number[] = [];
      if (mode === "manual") ids.push(await addMachine(host.trim(), ip.trim()));
      else {
        const rs = await Promise.allSettled(pick.map((x) => addDiscoveredMachine(x, null)));
        rs.forEach((r) => r.status === "fulfilled" && ids.push(r.value));
        const bad = rs.filter((r) => r.status === "rejected").length;
        if (bad === rs.length) throw new Error("全部加入失败");
      }
      const stageId = stagePath ? await ensureProjectStageId(stagePath).catch(() => null) : null;
      if (stageId) await Promise.allSettled(ids.map((id) => assignMachineToStage(stageId, id)));
      void Promise.allSettled(ids.map((id) => refreshMachine(id))).then(() => qc.invalidateQueries({ queryKey: ["cache"] }));
      return ids.length;
    },
    onSuccess: (n) => {
      toast(`${n} 台已加入集群，正在读取机器信息`);
      onClose();
    },
    onError: (e) => toast(`加入失败：${errText(e)}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["cache"] }),
  });

  const usb = useMutation({
    mutationFn: () => packageSshBootstrap(usbDir),
    onSuccess: (r) => toast(`入网包已生成：${r.output_directory}`),
    onError: (e) => toast(`生成失败：${errText(e)}`),
  });

  const count = mode === "manual" ? (host.trim() && ip.trim() ? 1 : 0) : pick.length;
  const existingCount = (found ?? []).length - fresh.length;

  const actions = (
    <>
      {mode === "scan" && notReady && (
        <Button variant="ghost" className={css.push} onClick={() => setMode("usb")}>
          为 {notReady.ip} 制作入网 U 盘…
        </Button>
      )}
      <Button kbd="Esc" onClick={onClose}>
        取消
      </Button>
      {mode === "usb" ? (
        <Button variant="primary" busy={usb.isPending} disabled={!usbDir} onClick={() => usb.mutate()}>
          生成入网包
        </Button>
      ) : (
        <Button variant="primary" busy={add.isPending} disabled={!count} onClick={() => add.mutate()}>
          加入 {count} 台
        </Button>
      )}
    </>
  );

  return (
    <Dialog title="添加机器" width={560} onClose={onClose} actions={actions}>
      <DialogBody>入网是给一台机器装好远程管理用的密钥。装过之后，Volo 才能在它上面巡检、部署和上屏。</DialogBody>
      <Fields style={{ marginTop: 16 }}>
        <Seg
          block
          label="添加方式"
          value={mode}
          onChange={setMode}
          options={[
            { value: "scan", label: "扫描网段" },
            { value: "usb", label: "入网 U 盘" },
            { value: "manual", label: "手动填写" },
          ]}
        />

        {mode === "scan" && (
          <>
            <Field
              label="网段"
              htmlFor="net"
              hint={
                found == null
                  ? "输入网段（如 10.0.8.0/24）或单个地址，然后扫描。"
                  : `探到 ${found.length} 台，其中 ${existingCount} 台已经在集群里，下面是剩下的 ${fresh.length} 台。`
              }
            >
              <div className={css.netRow}>
                <TextInput id="net" mono value={net} onChange={setNet} boxStyle={{ flex: 1 }} onKeyDown={(e) => e.key === "Enter" && net.trim() && scan.mutate(net.trim())} />
                <Button icon="refresh" busy={scan.isPending} disabled={!net.trim()} onClick={() => scan.mutate(net.trim())}>
                  {found == null ? "扫描" : "重新扫描"}
                </Button>
              </div>
            </Field>
            {fresh.length > 0 && (
              <ul className={css.hostList}>
                {fresh.map((h) => {
                  const on = pick.includes(h.ip);
                  return (
                    <li key={h.ip} className={css.hostItem}>
                      <label className={`volo-check ${css.hostCheck}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          aria-label={`选择 ${h.ip}`}
                          onChange={() => setPick((p) => (on ? p.filter((x) => x !== h.ip) : [...p, h.ip]))}
                        />
                        <span className="volo-check__box">
                          <Icon name="check" />
                        </span>
                      </label>
                      <span className={`ry-mono ${css.hostIp}`}>{h.ip}</span>
                      <span className={css.hostText}>
                        <span className={css.hostName}>—</span>
                        <span className={`ry-meta ${css.hostNote}`}>
                          {h.winrm_open ? "已经装好远程管理，可以直接加入。" : "还没有装远程管理。先在它上面运行一次入网脚本，或插一次入网 U 盘。"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {mode === "usb" && (
          <Field label="入网包输出位置" htmlFor="usb-dir" hint="生成后把整个文件夹拷进 U 盘，插到新机器上运行一次。只能在 Windows 上生成。">
            <div className={css.netRow}>
              <TextInput id="usb-dir" mono value={usbDir} onChange={setUsbDir} boxStyle={{ flex: 1 }} placeholder="选择一个空文件夹" />
              <Button
                icon="folder"
                onClick={() =>
                  void pickDirectory().then(
                    (d) => d && setUsbDir(d),
                    (e) => toast(`选择失败：${errText(e)}`),
                  )
                }
              >
                选择…
              </Button>
            </div>
          </Field>
        )}

        {mode === "manual" && (
          <Fields row>
            <Field label="名称" htmlFor="m-host">
              <TextInput id="m-host" mono value={host} onChange={setHost} placeholder="render-05" />
            </Field>
            <Field label="地址" htmlFor="m-ip">
              <TextInput id="m-ip" mono value={ip} onChange={setIp} placeholder="10.0.8.25" />
            </Field>
          </Fields>
        )}

        {mode !== "usb" && (
          <Fields row>
            <Field label={<span id="f1l">加入到</span>}>
              <Select labelledBy="f1l" value={stagePath} options={stageOptions} onChange={setStagePath} placeholder="不加入 Stage" />
            </Field>
            <Field label={<span id="f2l">角色</span>}>
              <Select labelledBy="f2l" value="render" options={[{ value: "render", label: "渲染节点" }]} onChange={() => undefined} disabled />
            </Field>
          </Fields>
        )}
      </Fields>
    </Dialog>
  );
}
