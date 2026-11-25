/* 待处理（设计：Inbox.dc.html）。条目从现状推出来，现状好了自动移到“已处理”。 */
import { useEffect, useRef, useState } from "react";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { Button, ChipFilter, Crumbs, Empty, Inspector, InspectorBody, InspectorHead, InspectorToggle, Props, Search, Sep, Skel, Spacer, Status, Table, TableBody, Toolbar, Workspace } from "@/ui";
import { fullAt } from "../model/tasks";
import { useTasks } from "../model/tasks";
import { useInbox, useInboxStore, type DoneIssue } from "../model/inbox";
import { DoneRow, IssueInspector, IssueRow, useOpenIssue } from "./issues";
import css from "./tasks.module.css";

type Filter = "all" | "stage" | "cluster" | "done";

export function InboxPage() {
  const tasks = useTasks();
  const inbox = useInbox(tasks.rows, !tasks.loading);
  const markRead = useInboxStore((s) => s.markRead);
  const [inspOpen, setInsp] = useInspector("inbox");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openIssue = useOpenIssue();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const s = q.trim().toLowerCase();
  const match = (t: string) => !s || t.toLowerCase().includes(s);
  const active = inbox.issues.filter((i) => (filter === "all" || i.scope === filter) && match(`${i.title} ${i.sub} ${i.object}`));
  const done = inbox.done.filter((d) => match(`${d.title} ${d.sub}`));
  const options = [
    { key: "all" as Filter, label: "全部", count: inbox.issues.length },
    { key: "stage" as Filter, label: "舞台", count: inbox.issues.filter((i) => i.scope === "stage").length },
    { key: "cluster" as Filter, label: "集群", count: inbox.issues.filter((i) => i.scope === "cluster").length },
    { key: "done" as Filter, label: "已处理" },
  ];

  const selected = filter === "done" ? null : (active.find((i) => i.id === sel) ?? active[0] ?? null);
  const selDone = filter === "done" ? (done.find((d) => d.id === sel) ?? done[0] ?? null) : null;

  const select = (id: string) => {
    setSel(id);
    markRead([id]);
  };

  const inspector = selected ? (
    <IssueInspector issue={selected} width={inspW} onClose={() => setInsp(false)} />
  ) : selDone ? (
    <DoneInspector item={selDone} width={inspW} onClose={() => setInsp(false)} />
  ) : (
    <aside className={`ry-inspector ${css.inspEmpty}`} aria-label="Inspector" style={{ width: inspW }}>
      <Empty icon="inspector" title="未选择条目">
        在列表中选择一条，这里会显示它挡住了什么、怎么处理。
      </Empty>
    </aside>
  );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="inbox" current="待处理" />
        <Spacer />
        <Button variant="ghost" icon="check" disabled={!inbox.unread} onClick={() => markRead(inbox.issues.map((i) => i.id))}>
          全部标为已读
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <Toolbar label="视图：筛选、搜索与显示">
        <ChipFilter label="按来源筛选" options={options} value={filter} onChange={setFilter} />
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} aria-label="筛选待处理：对象、机器、关键词" />
      </Toolbar>

      <Table label="待处理">
        <TableBody inbox>
          {inbox.loading &&
            [62, 48, 70].map((w, i) => (
              <div key={i} className="ry-row ry-row--inbox" aria-hidden="true">
                <span>
                  <Skel circle />
                </span>
                <span>
                  <Skel width={`${w}%`} />
                </span>
                <span>
                  <Skel width={40} end />
                </span>
              </div>
            ))}
          {!inbox.loading && filter !== "done" && active.length === 0 && (
            <Empty icon="success" title={inbox.issues.length ? "没有匹配的条目" : "没有要处理的事"}>
              {inbox.issues.length ? "换个关键词，或清除筛选。" : "巡检、标定和上屏发现的问题会出现在这里，处理好了自动移到“已处理”。"}
            </Empty>
          )}
          {filter !== "done" && active.map((i) => <IssueRow key={i.id} issue={i} unread={!inbox.read[i.id]} selected={i.id === selected?.id} onSelect={() => select(i.id)} onOpen={() => (markRead([i.id]), openIssue(i))} />)}
          {filter === "done" && done.length === 0 && (
            <Empty icon="inbox" title="还没有已处理的条目">
              问题消失或手动标为已处理后会记在这里（只在本机）。
            </Empty>
          )}
          {filter === "done" && done.map((d) => <DoneRow key={d.id} item={d} selected={d.id === selDone?.id} onSelect={() => setSel(d.id)} />)}
        </TableBody>
      </Table>
    </Workspace>
  );
}

function DoneInspector({ item, width, onClose }: { item: DoneIssue; width: number; onClose: () => void }) {
  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        meta={
          <>
            <span>{item.area}</span>
            <Status kind="success" label="已处理" pill />
          </>
        }
        title={item.title}
      />
      <InspectorBody>
        <Props
          items={[
            { label: "说明", value: item.sub },
            { label: "处理方式", value: item.auto ? "现状已恢复，自动移入" : "手动标为已处理" },
            { label: "处理于", value: <span className="ry-num">{fullAt(item.doneAt)}</span> },
          ]}
        />
      </InspectorBody>
    </Inspector>
  );
}
