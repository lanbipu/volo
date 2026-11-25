/* 待处理的一行 + Inspector（Inbox.dc.html；概览页 Main.dc.html 复用同一套）。 */
import { useRef, useState } from "react";
import { useNav } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import { useRunInspection } from "@/features/cache";
import { Activity, Button, Icon, IconButton, Inspector, InspectorBody, InspectorHead, Menu, MenuItem, Note, Props, Row, RowTwo, Status, ToolTabs } from "@/ui";
import { fullAt, shortAt } from "../model/tasks";
import { useInboxStore, type DoneIssue, type Issue } from "../model/inbox";

export function IssueRow({ issue, unread, selected, onSelect, onOpen }: { issue: Issue; unread: boolean; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  return (
    <Row inbox unread={unread} selected={selected} onSelect={onSelect} onOpen={onOpen}>
      <span role="gridcell" className="ry-avatar">
        <Icon name={issue.icon} size="sm" />
        <Status kind={issue.kind} label={issue.kindLabel} srOnly />
      </span>
      <RowTwo title={issue.title} sub={issue.sub} unread={unread} />
      <span role="gridcell" className="ry-row__end">
        {shortAt(issue.at)}
      </span>
    </Row>
  );
}

export function DoneRow({ item, selected, onSelect }: { item: DoneIssue; selected: boolean; onSelect: () => void }) {
  return (
    <Row inbox selected={selected} onSelect={onSelect}>
      <span role="gridcell" className="ry-avatar">
        <Icon name={item.icon} size="sm" />
        <Status kind="success" label="已处理" srOnly />
      </span>
      <RowTwo title={item.title} sub={item.sub} />
      <span role="gridcell" className="ry-row__end">
        {shortAt(item.doneAt)}
      </span>
    </Row>
  );
}

/** 跳到这一条对应的对象。 */
export function useOpenIssue() {
  const go = useNav((s) => s.go);
  const openObject = useNav((s) => s.openObject);
  return (i: Issue) => (i.target.tab ? openObject(i.target.page, i.target.tab) : go(i.target.page));
}

type Tab = "detail" | "activity";

/** variant = "overview"：概览页的简版（属性表在前，没有“更多”）。 */
export function IssueInspector({ issue, width, onClose, variant = "inbox" }: { issue: Issue; width: number; onClose: () => void; variant?: "inbox" | "overview" }) {
  const [tab, setTab] = useState<Tab>("detail");
  const open = useOpenIssue();
  const inspect = useRunInspection();
  const markDone = useInboxStore((s) => s.markDone);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);

  const primary =
    issue.action === "inspect" && issue.machineId != null ? (
      <Button
        variant="primary"
        icon={variant === "overview" ? "refresh" : undefined}
        busy={inspect.isPending}
        onClick={() =>
          inspect.mutate([issue.machineId as number], {
            onSuccess: (f) => toast(f.length ? `巡检部分完成：${f.join("；")}` : "巡检完成"),
            onError: (e) => toast(`巡检失败：${errText(e)}`),
          })
        }
      >
        重新巡检
      </Button>
    ) : null;
  const openBtn = (
    <Button icon="open" kbd="↵" onClick={() => open(issue)}>
      打开
    </Button>
  );

  const props = [
    { label: "对象", value: issue.object },
    { label: "挡住了", value: issue.blocks },
    { label: "来自", value: issue.from },
    { label: "发现于", value: issue.at != null ? <span className="ry-num">{fullAt(issue.at)}</span> : null },
    { label: "消失条件", value: issue.until },
  ];

  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={<ToolTabs label="Inspector 内容" value={tab} onChange={setTab} tabs={[{ key: "detail", label: "详情" }, { key: "activity", label: "活动" }]} />}
        meta={
          <>
            <span>{issue.area}</span>
            <Status kind={issue.kind} label={issue.kindLabel} pill />
          </>
        }
        title={issue.title}
        actions={
          variant === "overview" ? (
            <>
              {openBtn}
              {primary}
            </>
          ) : (
            <>
              {primary}
              {openBtn}
              <IconButton ref={moreRef} icon="more" label="更多操作：稍后提醒、标为已处理" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((o) => !o)} />
              {more && (
                <Menu anchor={moreRef} onClose={() => setMore(false)} label="更多操作" alignEnd>
                  <MenuItem disabled onSelect={() => undefined} meta="还没接入">
                    稍后提醒
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setMore(false);
                      markDone(issue);
                      toast("已标为已处理");
                    }}
                  >
                    标为已处理
                  </MenuItem>
                </Menu>
              )}
            </>
          )
        }
      />
      <InspectorBody>
        {tab === "detail" && (
          <>
            {variant === "inbox" && (
              <Note kind={issue.kind === "failed" ? "failed" : "attention"}>
                <div>
                  <p>{issue.note ?? issue.sub}</p>
                </div>
              </Note>
            )}
            <Props style={variant === "inbox" ? { marginTop: 20 } : undefined} items={variant === "overview" ? [...props.slice(0, 1), { label: "说明", value: issue.note ?? issue.sub }, ...props.slice(1)] : props} />
          </>
        )}
        {tab === "activity" &&
          (issue.at != null ? (
            <Activity items={[{ key: "found", icon: issue.kind === "failed" ? "failed" : "attention", text: `${issue.from ?? "检查"}发现这个问题`, time: shortAt(issue.at) }]} />
          ) : (
            <p className="ry-meta">还没有活动记录。</p>
          ))}
      </InspectorBody>
    </Inspector>
  );
}
