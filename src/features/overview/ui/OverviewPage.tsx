/* 概览（设计：Main.dc.html）：当前 Stage 的上场就绪 + 待处理。选中一条待处理 → Inspector。 */
import { useState } from "react";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import { fmtTime, useRunInspection } from "@/features/cache";
import { useCurrentStage } from "@/features/stage";
import { IssueInspector, IssueRow, useInbox, useInboxStore, useTasks } from "@/features/tasks";
import { Button, Crumbs, Empty, InspectorToggle, Meta, Sep, Spacer, Status, TableBody, Toolbar, Workspace } from "@/ui";
import { useReadiness, type ReadyStep } from "../model/readiness";
import css from "./overview.module.css";

const STAGE_TYPE: Record<string, string> = { led: "LED 舞台", ar: "AR 舞台", hybrid: "LED + AR 舞台" };

export function OverviewPage() {
  const { stage, loading } = useCurrentStage();
  const go = useNav((s) => s.go);
  const tasks = useTasks();
  const inbox = useInbox(tasks.rows, !tasks.loading);
  const markRead = useInboxStore((s) => s.markRead);
  const { steps, head, machines } = useReadiness(stage);
  const inspect = useRunInspection();
  const [inspOpen, setInsp] = useInspector("overview");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [sel, setSel] = useState<string | null>(null);

  const selected = inbox.issues.find((i) => i.id === sel) ?? inbox.issues[0] ?? null;
  const runAll = () => {
    const ids = machines.views.filter((v) => v.state !== "offline").map((v) => v.id);
    inspect.mutate(ids, {
      onSuccess: (fail) => toast(fail.length ? `巡检部分完成：${fail.join("；")}` : `巡检完成 · ${ids.length} 台`),
      onError: (e) => toast(`巡检失败：${errText(e)}`),
    });
  };

  return (
    <Workspace
      inspector={selected ? <IssueInspector issue={selected} variant="overview" width={inspW} onClose={() => setInsp(false)} /> : null}
      inspectorOpen={inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="overview" current="概览" />
        <Spacer />
        {machines.healthAt && <Meta>上次巡检 {fmtTime(machines.healthAt)}</Meta>}
        <Button icon="refresh" busy={inspect.isPending} disabled={!machines.views.some((v) => v.state !== "offline")} onClick={runAll}>
          立即巡检
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <div className={css.scroll}>
        {!stage && !loading ? (
          <Empty icon="stage" title="还没有打开 Stage">
            在左上角的 Stage 菜单里新建一个，或打开文件夹里已有的 Stage。上场就绪按它的屏幕、摄影机和机器来算。
          </Empty>
        ) : (
          <>
            <div className={`ry-detail__head ${css.head}`}>
              <h1 className="ry-detail__title">{stage?.name ?? "—"}</h1>
              <div className="ry-detail__meta">
                {stage?.config && <Status kind={head.kind} label={head.label} pill />}
                {stage && <span>{STAGE_TYPE[stage.type] ?? stage.type}</span>}
                {stage && <span className="ry-mono">{stage.path}</span>}
              </div>
            </div>

            <section aria-label="上场就绪" className={css.ready}>
              <h2 className={css.h2}>上场就绪 · 从左到右，前一步是后一步的前提</h2>
              <div className={css.steps}>
                {steps.map((s) => (
                  <StepCard key={s.key} s={s} onOpen={() => go(s.page)} />
                ))}
              </div>
            </section>
          </>
        )}

        <section aria-label="待处理" className={`ry-table ${css.inbox}`} role="grid">
          <h2 className={`${css.h2} ${css.inboxTitle}`}>待处理 · {inbox.issues.length}</h2>
          <TableBody inbox className={css.inboxBody}>
            {!inbox.loading && inbox.issues.length === 0 && <p className={`ry-meta ${css.none}`}>没有要处理的事。</p>}
            {inbox.issues.map((i) => (
              <IssueRow
                key={i.id}
                issue={i}
                unread={!inbox.read[i.id]}
                selected={i.id === selected?.id}
                onSelect={() => (setSel(i.id), markRead([i.id]))}
                onOpen={() => (setSel(i.id), markRead([i.id]), setInsp(true))}
              />
            ))}
          </TableBody>
        </section>
      </div>
    </Workspace>
  );
}

function StepCard({ s, onOpen }: { s: ReadyStep; onOpen: () => void }) {
  return (
    <button type="button" className={css.step} onClick={onOpen}>
      <Status kind={s.kind} label={s.label} />
      <span className={css.stepTitle}>{s.title}</span>
      <span className={css.stepDesc}>{s.desc}</span>
    </button>
  );
}

