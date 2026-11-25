/* 把机器指向 Zen（设计：ZenPoint.dc.html）。
   工程配置 = 逐台写该机器上选中工程的 DefaultEngine.ini [StorageServers] Shared；
   UE 用户 = zen_enable_global 写 UserEngine.ini。离线机器这次跳过。 */
import { useState } from "react";
import { errText, toast } from "@/lib/toast";
import { Button, Check, CommandLine, Dialog, DialogBody, Field, Fields, Tag } from "@/ui";
import { useZenPoint, type MachineRead, type PointScope, type ZenServer } from "../model/cache";
import type { ProjectView } from "../model/projects";
import css from "./cachePage.module.css";

export function ZenPointDialog({
  server,
  machines,
  projects,
  initialScope = "project",
  onClose,
}: {
  server: ZenServer;
  machines: MachineRead[];
  projects: ProjectView[];
  initialScope?: PointScope;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<PointScope>(initialScope);
  const online = machines.filter((m) => !m.offline);
  const offline = machines.filter((m) => m.offline);
  const ids = online.map((m) => m.id);
  const relevant = projects.filter((p) => p.copies.some((c) => ids.includes(c.loc.machine_id)));
  const [picked, setPicked] = useState<number[]>(() => relevant.map((p) => p.id));
  const point = useZenPoint();

  const targets = online.map((m) => ({
    machineId: m.id,
    host: m.host,
    locs: relevant
      .filter((p) => picked.includes(p.id))
      .flatMap((p) => p.copies.filter((c) => c.loc.machine_id === m.id).map((c) => ({ name: p.name, path: c.loc.abs_path }))),
  }));
  const files = scope === "user" ? targets.length : targets.reduce((a, t) => a + t.locs.length, 0);
  const ok = targets.length > 0 && files > 0;
  const machineArg = `--machines ${ids.join(",")} --upstream-endpoint-id ${server.endpointId}`;
  const command =
    scope === "user"
      ? `voloctl zen enable --global ${machineArg} --yes`
      : picked.length
        ? picked.map((p) => `voloctl zen enable --project-id ${p} ${machineArg} --yes`).join(" && ")
        : `voloctl zen enable --project-id <工程> ${machineArg} --yes`;

  const submit = () =>
    point.mutate(
      { server, scope, targets: scope === "user" ? targets : targets.filter((t) => t.locs.length) },
      {
        onSuccess: (r) => {
          toast(r.failed.length ? `已写入 ${r.ok} 台 · ${r.failed.join("、")} 失败` : `已指向 Zen · ${r.ok} 台，重启 UE 后生效`);
          onClose();
        },
        onError: (e) => toast(`写入失败：${errText(e)}`),
      },
    );

  return (
    <Dialog
      title={`把 ${online.length} 台机器指向 Zen`}
      width={500}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" className={css.push} onClick={() => toast(`试运行：会写 ${targets.length} 台机器上的 ${files} 份配置，不做改动`)}>
            先试运行
          </Button>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!ok || point.isPending} onClick={submit}>
            写入并指向
          </Button>
        </>
      }
    >
      <DialogBody>指向 {server.url}。写入之后，要重启这些机器上的 UE 才生效。</DialogBody>
      <Fields style={{ marginTop: 16 }}>
        <Field label="写到哪里">
          <div role="radiogroup" aria-label="写到哪里" className={css.radioCol}>
            <Check radio top name="zen-scope" checked={scope === "project"} onChange={() => setScope("project")}>
              工程配置<small className={css.radioDesc}>只对下面选中的工程生效。写每台机器上那个工程的 DefaultEngine.ini。</small>
            </Check>
            <Check radio top name="zen-scope" checked={scope === "user"} onChange={() => setScope("user")}>
              这台机器的 UE 用户<small className={css.radioDesc}>对 UE 运行用户打开的所有工程生效，不需要先扫描到工程。写 UserEngine.ini。</small>
            </Check>
          </div>
        </Field>
        {scope === "project" && (
          <Field label="哪些工程" hint={relevant.length ? "每台机器只写它自己有的工程。" : "这些机器上还没有扫描到工程。"}>
            <div className={css.checkCol}>
              {relevant.map((p) => (
                <Check key={p.id} checked={picked.includes(p.id)} onChange={(on) => setPicked((s) => (on ? [...s, p.id] : s.filter((x) => x !== p.id)))}>
                  {p.name}
                </Check>
              ))}
            </div>
          </Field>
        )}
        <Field label="机器" hint={offline.length ? `${offline.map((m) => m.host).join("、")} 离线，这次跳过。` : undefined}>
          <div className={css.tagRow}>
            {online.map((m) => (
              <Tag key={m.id}>{m.host}</Tag>
            ))}
          </div>
        </Field>
      </Fields>
      <CommandLine command={command} style={{ marginTop: 16 }} />
    </Dialog>
  );
}
