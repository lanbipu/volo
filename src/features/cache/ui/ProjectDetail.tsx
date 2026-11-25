/* 工程详情（设计：ProjectDetail.dc.html）。一行 = 这个工程在一台机器上的副本；Inspector = 预跑设置 / 属性。 */
import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getProjectThumbnail } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { getStageMembership } from "@/api/stageCommands";
import { useCurrentStage } from "@/features/stage";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Button,
  ConfirmDialog,
  Crumbs,
  Empty,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Menu,
  MenuItem,
  Meta,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  Toolbar,
  ToolTabs,
  Workspace,
  type StatusKind,
} from "@/ui";
import { useClusterUi } from "../model/clusterUi";
import { fmtFull } from "../model/machines";
import { copyPsoText, humanBytes, projectKeys, PROJECT_KIND, PROJECT_STATE_LABEL, useDeleteProject, useDiscover, useProjects, type CopyView, type ProjectView } from "../model/projects";
import { PsoSettingsForm } from "./PsoSettingsForm";
import css from "./cache.module.css";

const COLS = "16px 96px minmax(180px, 1fr) 150px 110px 110px 72px";

function copyKind(c: CopyView): [StatusKind, string] {
  if (c.offline) return ["offline", "离线"];
  if (c.pso?.status === "degraded") return ["attention", "已过期"];
  if (c.pso?.status === "ok") return ["success", "就绪"];
  return ["queued", "未预热"];
}

export function ProjectDetail({ id }: { id: number }) {
  const { views, loading } = useProjects();
  const v = views.find((x) => x.id === id) ?? null;
  const showList = useNav((s) => s.showList);
  const closeObject = useNav((s) => s.closeObject);
  const updateObject = useNav((s) => s.updateObject);
  const tabId = `project:${id}`;

  useEffect(() => {
    if (v) updateObject("projects", tabId, { label: v.name, status: v.state, statusLabel: PROJECT_STATE_LABEL[v.state] });
  }, [v, tabId, updateObject]);

  if (!v) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          <Crumbs icon="project" trail={[{ label: "工程", onClick: () => showList("projects") }]} current="—" />
        </Toolbar>
        {!loading && (
          <Empty icon="project" title="这个工程已不在 Volo 里" actions={<Button onClick={() => closeObject("projects", tabId)}>关闭页签</Button>}>
            它的记录可能已被移除。重新扫描工程可以找回。
          </Empty>
        )}
      </main>
    );
  }
  return <Detail v={v} />;
}

function Detail({ v }: { v: ProjectView }) {
  const showList = useNav((s) => s.showList);
  const go = useNav((s) => s.go);
  const closeObject = useNav((s) => s.closeObject);
  const focusPak = useClusterUi((s) => s.focusPak);
  const focusPso = useClusterUi((s) => s.focusPso);
  const [inspOpen, setInsp] = useInspector("projects:detail");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const { stage } = useCurrentStage();
  const member = useQuery({ queryKey: ["stage", "membership", stage?.stageId ?? ""], queryFn: () => getStageMembership(stage?.stageId as string), enabled: isTauri() && !!stage?.stageId });
  const discover = useDiscover();
  const remove = useDeleteProject();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState<"copies" | "activity">("copies");
  const [sel, setSel] = useState<number | null>(null);
  const sizes = useQueries({
    queries: v.copies.map((c) => ({
      queryKey: projectKeys.thumb(v.id, c.loc.machine_id),
      queryFn: () => getProjectThumbnail(v.id, c.loc.machine_id),
      enabled: isTauri() && !c.offline,
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });

  const rescan = () => {
    const ids = v.copies.filter((c) => !c.offline).map((c) => c.loc.machine_id);
    const roots = Array.from(new Set(v.copies.map((c) => c.loc.abs_path.replace(/[\\/][^\\/]+[\\/]?$/, "")).filter(Boolean)));
    discover.mutate({ machineIds: ids, roots }, { onSuccess: (r) => toast(`重新扫描完成 · ${r.found} 个位置`), onError: (e) => toast(`扫描失败：${errText(e)}`) });
  };
  const ordered = [...v.copies].sort((a, b) => {
    const rank = (c: CopyView) => (c.offline ? 3 : c.pso?.status === "degraded" ? 0 : c.pso?.status === "ok" ? 2 : 1);
    return rank(a) - rank(b) || a.host.localeCompare(b.host, "zh-CN", { numeric: true });
  });
  const selected = ordered.find((c) => c.loc.machine_id === sel) ?? ordered[0] ?? null;

  const inspector = (
    <ProjectInspector v={v} width={inspW} onClose={() => setInsp(false)} />
  );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="project" trail={[{ label: "工程", onClick: () => showList("projects") }]} current={v.name} />
        <Spacer />
        <Button icon="file" onClick={() => (focusPak(v.id), go("cache"))}>
          生成 PAK
        </Button>
        <Button icon="pso" onClick={() => (focusPso(v.id), go("pso"))}>
          预热 PSO
        </Button>
        <IconButton ref={moreRef} icon="more" label="更多操作：重新扫描这个工程、更换源机器、从 Volo 移除记录" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
        {moreOpen && (
          <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
            <MenuItem onSelect={() => (setMoreOpen(false), rescan())}>重新扫描这个工程</MenuItem>
            <MenuItem disabled onSelect={() => undefined}>
              更换源机器
            </MenuItem>
            <MenuItem danger onSelect={() => (setMoreOpen(false), setConfirm(true))}>
              从 Volo 移除记录
            </MenuItem>
          </Menu>
        )}
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <div className={`ry-detail ${css.detailTop}`}>
        <div className={`ry-detail__head ${css.detailHead}`}>
          <h1 className="ry-detail__title">{v.name}</h1>
          <div className="ry-detail__meta">
            <Status kind={PROJECT_KIND[v.state]} label={PROJECT_STATE_LABEL[v.state]} pill />
            {v.ue && <span>UE {v.ue}</span>}
            <span>{v.copies.length} 台机器上有它</span>
            {v.source && <span>源机器 {v.source.host}</span>}
            <span className="ry-mono">{v.uproject}.uproject</span>
            {stage && member.data?.project_ids.includes(v.id) && <span>Stage：{stage.name}</span>}
          </div>
        </div>
        <div className="ry-detail__tools">
          <ToolTabs label="工程内容" value={tab} onChange={setTab} tabs={[{ key: "copies", label: "各机器上的状况" }, { key: "activity", label: "活动" }]} />
          <Spacer />
          {tab === "copies" && <Meta>一行是这个工程在一台机器上的副本</Meta>}
        </div>
      </div>

      {tab === "copies" ? (
        <Table label={`${v.name} 在各机器上的状况`}>
          <TableBody>
            <HeadRow cols={COLS}>
              <span />
              <span>机器</span>
              <span>路径</span>
              <span>缓存指向</span>
              <span>PAK 预置包</span>
              <span>PSO 预热</span>
              <RowEnd>大小</RowEnd>
            </HeadRow>
            {ordered.map((c) => {
              const [kind, label] = copyKind(c);
              const size = sizes[v.copies.indexOf(c)]?.data?.size_bytes;
              const isSrc = c === v.source;
              return (
                <Row key={c.loc.machine_id} cols={COLS} selected={selected === c} onSelect={() => setSel(c.loc.machine_id)} onOpen={() => setInsp(true)}>
                  <Status kind={kind} label={label} srOnly />
                  <span className={`ry-row__id ${css.idPrimary}`}>{c.host}</span>
                  {isSrc ? (
                    <RowTitle>
                      <span className={`ry-mono ${css.pathInTitle}`}>{c.loc.abs_path}</span>
                    </RowTitle>
                  ) : (
                    <span className={`ry-mono ${css.sec}`}>{c.loc.abs_path}</span>
                  )}
                  <span className={css.sec}>—</span>
                  <span className={css.sec}>{c.offline ? "—" : c.pak ? (isSrc ? "有 · 在这台生成" : "有") : "没有"}</span>
                  <span className={css.sec}>{copyPsoText(c)}</span>
                  <RowEnd>{c.offline ? "—" : humanBytes(size)}</RowEnd>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <div className={css.pane}>
          <Empty icon="clock" title="还没有活动记录">
            这个工程的扫描、生成 PAK 与预热记录接入后会显示在这里。
          </Empty>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`从 Volo 移除 ${v.name} 的记录？`}
          body="只删除 Volo 里这个工程和它在各机器上的位置记录，磁盘上的工程文件、PAK 和缓存都不动。重新扫描就能找回。"
          props={[
            { label: "影响", value: <span className="ry-mono">{v.copies.map((c) => c.host).join(" · ") || "—"}</span> },
            { label: "可恢复", value: "是，重新扫描工程即可" },
          ]}
          command={`voloctl project delete ${v.id} --yes`}
          safeLabel="保留"
          dangerLabel="移除记录"
          dangerIcon="close"
          busy={remove.isPending}
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(v.id, {
              onSuccess: () => {
                setConfirm(false);
                closeObject("projects", `project:${v.id}`);
                toast(`已移除 ${v.name} 的记录`);
              },
              onError: (e) => toast(`移除失败：${errText(e)}`),
            })
          }
        />
      )}
    </Workspace>
  );
}

function ProjectInspector({ v, width, onClose }: { v: ProjectView; width: number; onClose: () => void }) {
  const [tab, setTab] = useState<"pso" | "props">("pso");
  const firstSeen = v.copies.map((c) => c.loc.discovered_at).filter((x): x is string => !!x).sort()[0] ?? null;
  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={<ToolTabs label="Inspector 内容" value={tab} onChange={setTab} tabs={[{ key: "pso", label: "预跑设置" }, { key: "props", label: "属性" }]} />}
        meta={
          tab === "pso" ? (
            <>
              <span>预热 PSO 时怎么跑</span>
              <span>改动立即保存</span>
            </>
          ) : (
            <span>工程</span>
          )
        }
        title={tab === "pso" ? `${v.name} 的预跑设置` : v.name}
      />
      <InspectorBody>
        {tab === "pso" ? (
          <PsoSettingsForm v={v} />
        ) : (
          <Props
            items={[
              { label: "名称", value: v.name },
              { label: "工程文件", value: <span className="ry-mono">{v.uproject}.uproject</span> },
              { label: "引擎", value: v.ue ? `UE ${v.ue}` : null },
              { label: "GUID", value: v.raw.uproject_guid ? <span className="ry-mono">{v.raw.uproject_guid}</span> : null },
              { label: "副本", value: `${v.copies.length} 台机器` },
              { label: "发现于", value: firstSeen ? <span className="ry-num">{fmtFull(firstSeen)}</span> : null },
            ]}
          />
        )}
      </InspectorBody>
    </Inspector>
  );
}
