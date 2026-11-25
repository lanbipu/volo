/* 设置与凭据（设计：Settings.dc.html 通用 / SettingsCreds.dc.html 凭据）。
   能接的直接接（主题 / 密度 / 自动巡检 / 数据目录 / 本机凭据库）；后端还没有的项（默认路径、任务记录、凭据验证、通知）显示但不可用，并写明还没接入。 */
import { useState, type ReactNode } from "react";
import { revealPath } from "@/api/commands";
import { useShellStore } from "@/app/shellStore";
import { fmtFull, fmtTime } from "@/features/cache";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  ConfirmDialog,
  Crumbs,
  Dialog,
  Empty,
  Field,
  Fields,
  GroupRow,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Meta,
  Note,
  Props,
  Row,
  RowEnd,
  Seg,
  Select,
  Sep,
  Spacer,
  Status,
  SwitchRow,
  Table,
  TableBody,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
  type ActivityItem,
} from "@/ui";
import { GROUP_LABEL, useAppInfo, useCredRows, useDeleteCredential, useGeneralSettings, useSaveCredential, type CredGroup, type CredRow } from "../model/settings";
import css from "./settings.module.css";

type Tab = "general" | "creds" | "cli" | "about";

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  const [inspOpen, setInsp] = useInspector("settings.creds");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const creds = useCredRows();
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const selected = creds.rows.find((r) => r.key === sel) ?? creds.rows.find((r) => r.group === "share") ?? creds.rows[0] ?? null;
  const onCreds = tab === "creds";

  return (
    <Workspace
      inspector={onCreds && selected ? <CredInspector row={selected} width={inspW} onClose={() => setInsp(false)} /> : null}
      inspectorOpen={onCreds && inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="sliders" current="设置与凭据" />
        <Spacer />
        {onCreds && (
          <>
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              添加凭据
            </Button>
            <Sep />
            <InspectorToggle open={inspOpen} onChange={setInsp} />
          </>
        )}
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <ToolTabs
          label="设置内容"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "general", label: "通用" },
            { key: "creds", label: "凭据" },
            { key: "cli", label: "命令行" },
            { key: "about", label: "关于" },
          ]}
        />
        <Spacer />
        {onCreds ? (
          <>
            <Meta>Volo 不显示密码，只显示有没有、在哪、上次验证的结果</Meta>
            <IconButton icon="refresh" label={creds.fetchedAt ? `刷新 · 上次 ${new Date(creds.fetchedAt).toTimeString().slice(0, 8)}` : "刷新"} onClick={() => void creds.refetch()} />
          </>
        ) : (
          <Meta>改动立即保存</Meta>
        )}
      </Toolbar>
      {tab === "general" && <GeneralView />}
      {tab === "creds" && <CredTable rows={creds.rows} loading={creds.loading} selected={selected?.key ?? null} onSelect={setSel} />}
      {tab === "cli" && (
        <div className={css.scroll}>
          <Empty icon="terminal" title="命令行设置还没接入">
            voloctl 的安装和默认参数以后放在这里。
          </Empty>
        </div>
      )}
      {tab === "about" && <AboutView />}
      {adding && <AddCredDialog onClose={() => setAdding(false)} />}
    </Workspace>
  );
}

/* ------------------------------ 通用 ------------------------------ */

function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={css.section}>
      <div>
        <h2 className={css.sectionTitle}>{title}</h2>
        <p className={css.sectionDesc}>{desc}</p>
      </div>
      <Fields>{children}</Fields>
    </section>
  );
}

const NOT_YET = "还没接入";

function GeneralView() {
  const theme = useShellStore((s) => s.theme);
  const follow = useShellStore((s) => s.followSystem);
  const density = useShellStore((s) => s.density);
  const setTheme = useShellStore((s) => s.setTheme);
  const setFollow = useShellStore((s) => s.setFollowSystem);
  const setDensity = useShellStore((s) => s.setDensity);
  const g = useGeneralSettings();
  const info = useAppInfo();
  const dataDir = info.data?.data_dir ?? null;
  const minutesBad = g.patrolTimed && !(Number(g.patrolMinutes) >= 1);

  return (
    <div className={css.scroll}>
      <div className={css.page}>
        <Section title="外观" desc="只影响这台电脑上的 Volo。">
          <Field label="主题">
            <Seg
              block
              label="主题"
              value={follow ? "system" : theme}
              onChange={(v) => (v === "system" ? setFollow(true) : setTheme(v))}
              options={[
                { value: "system", label: "跟随系统" },
                { value: "dark", label: "深色" },
                { value: "light", label: "浅色" },
              ]}
            />
          </Field>
          <Field label="密度" hint="紧凑时每行更矮，适合机器和任务很多的时候。">
            <Seg
              block
              label="密度"
              value={density}
              onChange={setDensity}
              options={[
                { value: "comfortable", label: "舒适" },
                { value: "compact", label: "紧凑" },
              ]}
            />
          </Field>
          <Field label="语言" hint="目前只有简体中文。">
            <Select value="zh-CN" disabled options={[{ value: "zh-CN", label: "简体中文" }]} onChange={() => undefined} />
          </Field>
        </Section>

        <Section title="巡检与提醒" desc="巡检会逐台检查 SSH、驱动、UE 版本和缓存指向。">
          <SwitchRow title="启动时自动巡检" checked={g.patrolOnStart} onChange={(v) => g.set({ patrolOnStart: v })} />
          <SwitchRow title="定时巡检" desc="Volo 开着的时候才会执行。" checked={g.patrolTimed} onChange={(v) => g.set({ patrolTimed: v })} />
          <Field label="间隔" htmlFor="settings-patrol-min" error={minutesBad ? "至少 1 分钟" : undefined}>
            <TextInput id="settings-patrol-min" num unit="分钟" value={g.patrolMinutes} invalid={minutesBad} disabled={!g.patrolTimed} onChange={(v) => g.set({ patrolMinutes: v.replace(/[^\d]/g, "") })} />
          </Field>
          <SwitchRow title="巡检发现问题时提醒" desc={`出现在“待处理”，并发系统通知。${NOT_YET}`} checked={false} disabled onChange={() => undefined} />
          <SwitchRow title="任务结束时发系统通知" desc={NOT_YET} checked={false} disabled onChange={() => undefined} />
        </Section>

        <Section title="路径" desc="新建 Stage 和读取素材时的默认位置。">
          <Field label="Stage 目录" htmlFor="settings-stage-dir" hint={`每个 Stage 是这里面的一个文件夹，里面有 project.yaml。默认目录${NOT_YET}，打开 Stage 时自己选位置。`}>
            <TextInput id="settings-stage-dir" mono value="" placeholder="—" disabled onChange={() => undefined} />
          </Field>
          <Field label="远端 UE 安装目录" htmlFor="settings-ue-dir" hint={`所有机器的默认值${NOT_YET}；现在按每台机器上检测到的 UE 版本走。`}>
            <TextInput id="settings-ue-dir" mono value="" placeholder="—" disabled onChange={() => undefined} />
          </Field>
        </Section>

        <Section title="数据" desc="任务记录和日志保存在本机。">
          <Props
            items={[
              { label: "任务记录", value: <span className="ry-num">—</span> },
              { label: "位置", value: dataDir ? <span className="ry-mono">{dataDir}</span> : null },
            ]}
          />
          <div className={css.actions}>
            <Button
              icon="folder"
              disabled={!dataDir}
              onClick={() =>
                dataDir &&
                revealPath(dataDir).catch((e) => {
                  toast(`没能打开：${errText(e)}`);
                })
              }
            >
              打开文件夹
            </Button>
            <Button variant="danger" disabled title={`任务记录清理${NOT_YET}`}>
              清除已结束的任务记录
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------ 关于 ------------------------------ */

function AboutView() {
  const info = useAppInfo();
  return (
    <div className={css.scroll}>
      <div className={css.page}>
        <Section title="Volo" desc="LanX 出品的虚拟制作桌面工具。">
          <Props
            items={[
              { label: "版本", value: info.data ? <span className="ry-num">{info.data.version}</span> : null },
              { label: "构建", value: info.data ? (info.data.debug ? "开发版（debug）" : "正式版（release）") : null },
              { label: "数据目录", value: info.data?.data_dir ? <span className="ry-mono">{info.data.data_dir}</span> : null },
            ]}
          />
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------ 凭据表 ------------------------------ */

const COLS = "16px 96px minmax(180px, 1fr) 176px 96px 96px";
const GROUPS: CredGroup[] = ["ssh", "share", "store"];

function CredTable({ rows, loading, selected, onSelect }: { rows: CredRow[]; loading: boolean; selected: string | null; onSelect: (k: string) => void }) {
  if (!loading && !rows.length) {
    return (
      <div className={css.scroll}>
        <Empty icon="key" title="还没有凭据">
          加了机器之后，这里会列出 Volo 登录每台机器、读写共享目录要用的凭据。
        </Empty>
      </div>
    );
  }
  return (
    <Table label="凭据">
      <TableBody>
        <HeadRow cols={COLS}>
          <span />
          <span>机器</span>
          <span>用途</span>
          <span>账户</span>
          <RowEnd>保存位置</RowEnd>
          <RowEnd>上次验证</RowEnd>
        </HeadRow>
        {GROUPS.map((g) => {
          const list = rows.filter((r) => r.group === g);
          if (!list.length) return null;
          return (
            <div key={g} role="rowgroup">
              <GroupRow label={GROUP_LABEL[g]} count={list.length} />
              {list.map((r) => (
                <Row key={r.key} cols={COLS} selected={r.key === selected} onSelect={() => onSelect(r.key)}>
                  <Status kind={r.state} label={r.stateLabel} srOnly />
                  <span className={`ry-row__id ${css.machine}`}>{r.machine}</span>
                  <span className="ry-row__title">
                    <span>{r.purpose}</span>
                  </span>
                  <span className={`ry-mono ${css.account}`}>{r.account ?? "—"}</span>
                  <RowEnd>{r.location ?? "—"}</RowEnd>
                  <RowEnd>{fmtTime(r.verifiedAt)}</RowEnd>
                </Row>
              ))}
            </div>
          );
        })}
      </TableBody>
    </Table>
  );
}

/* ------------------------------ 凭据 Inspector ------------------------------ */

function CredInspector({ row, width, onClose }: { row: CredRow; width: number; onClose: () => void }) {
  const [tab, setTab] = useState<"detail" | "activity">("detail");
  const [replace, setReplace] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const del = useDeleteCredential();
  const showList = useNav((s) => s.showList);
  const tabs = (
    <ToolTabs
      label="Inspector 内容"
      value={tab}
      onChange={setTab}
      tabs={[
        { key: "detail", label: "详情" },
        { key: "activity", label: "活动" },
      ]}
    />
  );
  const groupName = row.group === "ssh" ? "远程管理" : row.group === "share" ? "共享目录访问" : "本机凭据库";
  const meta = (
    <>
      <span>{groupName}</span>
      <Status pill kind={row.state} label={row.stateLabel} />
    </>
  );
  const title = row.group === "share" && row.share ? `${row.machine} → ${row.share.unc_path}` : row.group === "store" && row.cred ? row.cred.alias : row.machine;

  if (tab === "activity") {
    const items: ActivityItem[] = row.verifiedAt ? [{ key: "seen", icon: "clock", text: "最后一次连上这台机器", time: fmtTime(row.verifiedAt) }] : [];
    return (
      <Inspector width={width}>
        <InspectorHead tabs={tabs} onClose={onClose} meta={meta} title={title} />
        <InspectorBody>
          {items.length ? (
            <Activity style={{ gap: 10 }} items={items} />
          ) : (
            <Empty icon="clock" title="没有记录">
              凭据的验证和写入记录{NOT_YET}。
            </Empty>
          )}
        </InspectorBody>
      </Inspector>
    );
  }

  /* 共享目录：更换的是它用的那个别名；缺凭据时按别名新建 */
  const alias = row.cred?.alias ?? row.share?.credential_alias ?? null;
  const canReplace = row.group !== "ssh" && !!alias && row.share?.mode !== "open";
  const actions = (
    <>
      <Button icon="refresh" disabled title={`凭据验证${NOT_YET}`}>
        重新验证
      </Button>
      {canReplace && (
        <Button icon="key" onClick={() => setReplace(true)}>
          {row.cred ? "更换…" : "添加…"}
        </Button>
      )}
      {row.group === "store" && row.cred && <IconButton icon="close" label="从本机凭据库删除" onClick={() => setConfirmDel(true)} />}
    </>
  );

  const m = row.machineRaw;
  const items =
    row.group === "ssh"
      ? [
          { label: "机器", value: m ? `${m.hostname} · ${m.ip}` : row.machine },
          { label: "方式", value: "SSH 密钥登录（Bootstrap 时装好）" },
          { label: "保存位置", value: row.location },
          { label: "上次连上", value: <span className="ry-num">{fmtFull(row.verifiedAt)}</span> },
        ]
      : row.group === "share"
        ? [
            { label: "共享目录", value: <span className="ry-mono">{row.share?.unc_path}</span> },
            { label: "所在机器", value: row.machine },
            { label: "访问方式", value: row.share?.mode === "open" ? "来宾访问，不需要账户" : "指定账户" },
            { label: "账户", value: row.share?.mode === "open" ? null : row.account ? <span className="ry-mono">{row.account}</span> : null },
            { label: "凭据别名", value: alias ? <span className="ry-mono">{alias}</span> : null },
            { label: "保存位置", value: row.location },
            { label: "上次验证", value: null },
          ]
        : [
            { label: "别名", value: <span className="ry-mono">{row.cred?.alias}</span> },
            { label: "类型", value: row.cred?.kind === "share" ? "共享目录账户" : "WinRM（已停用）" },
            { label: "账户", value: <span className="ry-mono">{row.account}</span> },
            { label: "保存位置", value: row.location },
          ];

  return (
    <Inspector width={width}>
      <InspectorHead tabs={tabs} onClose={onClose} meta={meta} title={title} actions={actions} />
      <InspectorBody>
        {row.group === "share" && (
          <>
            <Note
              kind="attention"
              actions={
                <Button onClick={() => showList("cache")}>
                  去“缓存”查看指向
                </Button>
              }
            >
              {row.share?.mode === "open" ? <p>这个共享目录开了来宾访问，客户端读写不需要凭据。只有旧版缓存方式会用到它；机器改用 Zen 之后走 HTTP。</p> : <p>这是旧版缓存方式才需要的凭据。机器改用 Zen 之后走 HTTP，不需要它。</p>}
              {row.state === "attention" && <p>这个共享目录指定了账户「{alias ?? "—"}」，但本机凭据库里没有，客户端写入时会失败。</p>}
            </Note>
            <div className={css.spacer20} />
          </>
        )}
        {row.group === "ssh" && (
          <>
            <Note kind="default" actions={<Button onClick={() => showList("machines")}>去“机器”查看</Button>}>
              <p>SSH 用密钥登录，Volo 不保存这台机器的密码。连不上时在“机器”里巡检看原因。</p>
            </Note>
            <div className={css.spacer20} />
          </>
        )}
        <Props items={items} />
      </InspectorBody>
      {replace && alias && <AddCredDialog alias={alias} username={row.cred?.username ?? ""} onClose={() => setReplace(false)} />}
      {confirmDel && row.cred && (
        <ConfirmDialog
          title={`删除凭据「${row.cred.alias}」？`}
          body="只从本机凭据库删掉这一条。用到它的共享目录之后写入会失败，直到重新添加。"
          props={[
            { label: "别名", value: row.cred.alias },
            { label: "账户", value: row.cred.username },
          ]}
          safeLabel="取消"
          dangerLabel="删除"
          busy={del.isPending}
          onClose={() => setConfirmDel(false)}
          onConfirm={() =>
            del.mutate(row.cred!.alias, {
              onSuccess: () => {
                toast(`已删除「${row.cred!.alias}」`);
                setConfirmDel(false);
              },
              onError: (e) => toast(`没能删除：${errText(e)}`),
            })
          }
        />
      )}
    </Inspector>
  );
}

/* ------------------------------ 添加 / 更换 ------------------------------ */

function AddCredDialog({ alias: fixedAlias, username: initialUser = "", onClose }: { alias?: string; username?: string; onClose: () => void }) {
  const [alias, setAlias] = useState(fixedAlias ?? "");
  const [user, setUser] = useState(initialUser);
  const [pass, setPass] = useState("");
  const save = useSaveCredential();
  const ok = alias.trim() && user.trim() && pass;
  const submit = () => {
    if (!ok || save.isPending) return;
    save.mutate(
      { alias: alias.trim(), username: user.trim(), password: pass },
      {
        onSuccess: () => {
          toast(fixedAlias ? `已更换「${alias.trim()}」` : `已添加「${alias.trim()}」`);
          onClose();
        },
        onError: (e) => toast(`没能保存：${errText(e)}`),
      },
    );
  };
  return (
    <Dialog
      title={fixedAlias ? `更换凭据「${fixedAlias}」` : "添加凭据"}
      width={440}
      onClose={onClose}
      actions={
        <>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!ok || save.isPending} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <Fields>
        <Field label="别名" htmlFor="cred-alias" hint="共享目录按别名找凭据。">
          <TextInput id="cred-alias" mono value={alias} disabled={!!fixedAlias} onChange={setAlias} />
        </Field>
        <Field label="账户" htmlFor="cred-user" hint="例如 render-01\svc-volo-ddc">
          <TextInput id="cred-user" mono value={user} onChange={setUser} />
        </Field>
        <Field label="密码" htmlFor="cred-pass" hint="只存进本机凭据库，Volo 之后不再显示。">
          <TextInput id="cred-pass" type="password" value={pass} onChange={setPass} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
      </Fields>
    </Dialog>
  );
}
