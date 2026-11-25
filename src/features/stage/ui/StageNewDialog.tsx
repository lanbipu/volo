/* 新建 Stage（设计：StageNew.dc.html）。一个 Stage = 一个文件夹里的 project.yaml；类型创建后不能改。 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listMachines, pickDirectory } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { errText, toast } from "@/lib/toast";
import { Button, Check, Dialog, Field, Fields, TextInput } from "@/ui";
import { useCreateStage } from "../model/stage";
import css from "./StageSwitcher.module.css";

const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/^-+|-+$/g, "");

const parentOf = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");

export function StageNewDialog({ recentPath, onClose }: { recentPath: string | null; onClose: () => void }) {
  const machines = useQuery({ queryKey: ["cache", "machines"], queryFn: listMachines, enabled: isTauri() });
  const create = useCreateStage();
  const [name, setName] = useState("");
  const [type, setType] = useState<"led" | "ar">("led");
  /** null = 跟着名称走（最近一个 Stage 的上一级目录 + 名称）。 */
  const [dirOwn, setDirOwn] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const base = recentPath ? parentOf(recentPath) : null;
  const sep = recentPath?.includes("\\") ? "\\" : "/";
  const dir = dirOwn ?? (base && slug(name) ? `${base}${sep}${slug(name)}` : "");
  const list = machines.data ?? [];
  const isOffline = (status: string) => (status || "").toLowerCase().includes("offline");
  /* 默认勾上在线的机器。 */
  const checked = (id: number, status: string) => picked[id] ?? !isOffline(status);

  const nameErr = name.trim() ? null : "填一个名称";
  const dirErr = dir.trim() ? null : "选一个文件夹";

  const browse = async () => {
    try {
      const d = await pickDirectory();
      if (d) setDirOwn(d);
    } catch (e) {
      toast(`选择失败：${errText(e)}`);
    }
  };

  const submit = async () => {
    setTouched(true);
    if (nameErr || dirErr) return;
    setBusy(true);
    try {
      const ids = list.filter((m) => m.id != null && checked(m.id, m.status)).map((m) => m.id as number);
      const r = await create({ name: name.trim(), type, dir: dir.trim(), machineIds: ids });
      toast(r.failedMachines ? `已新建 ${name.trim()}，${r.failedMachines} 台机器没能登记，去“机器”里再加` : `已新建 ${name.trim()}`);
      onClose();
    } catch (e) {
      toast(`新建失败：${errText(e)}`);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="新建 Stage"
      width={480}
      onClose={onClose}
      actions={
        <>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={busy || (touched && !!(nameErr || dirErr))} onClick={submit}>
            创建
          </Button>
        </>
      }
    >
      <Fields style={{ marginTop: 16 }}>
        <Field label="名称" htmlFor="sn-stage-name" error={touched && nameErr ? nameErr : undefined}>
          <TextInput id="sn-stage-name" value={name} onChange={setName} placeholder="例如 Volume C" invalid={touched && !!nameErr} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <Field label="类型" hint="类型决定侧栏“舞台”里有哪些页，创建后不能改。">
          <div role="radiogroup" aria-label="类型" className={css.radios}>
            <Check radio top name="stage-type" checked={type === "led"} onChange={() => setType("led")}>
              <span>
                LED 舞台<small className={css.radioDesc}>有 LED 屏。步骤是屏幕 → 上屏 → 摄影机 → 重建。</small>
              </span>
            </Check>
            <Check radio top name="stage-type" checked={type === "ar"} onChange={() => setType("ar")}>
              <span>
                AR 舞台<small className={css.radioDesc}>没有 LED 屏，在实景上叠加。步骤是标记 → 摄影机 → 空间求解 → 验证。</small>
              </span>
            </Check>
          </div>
        </Field>
        <Field label="保存在" htmlFor="sn-stage-dir" error={touched && dirErr ? dirErr : undefined}>
          <div className={css.dirRow}>
            <TextInput id="sn-stage-dir" mono value={dir} onChange={setDirOwn} placeholder="选一个空文件夹" invalid={touched && !!dirErr} boxStyle={{ flex: 1 }} />
            <Button icon="project" onClick={browse}>
              浏览…
            </Button>
          </div>
        </Field>
        <Field label="用哪些机器" hint="一台机器可以同时属于几个 Stage。之后在“机器”里随时增减。">
          {list.length ? (
            <div className={css.machines}>
              {list.map((m) =>
                m.id == null ? null : (
                  <Check key={m.id} checked={checked(m.id, m.status)} onChange={(v) => setPicked((p) => ({ ...p, [m.id as number]: v }))}>
                    {isOffline(m.status) ? `${m.hostname} · 离线` : m.hostname}
                  </Check>
                ),
              )}
            </div>
          ) : (
            <p className="ry-meta">{machines.isLoading ? "正在读取机器…" : "集群里还没有机器，之后在“机器”里添加。"}</p>
          )}
        </Field>
      </Fields>
    </Dialog>
  );
}
