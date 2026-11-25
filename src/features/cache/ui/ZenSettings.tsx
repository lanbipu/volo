/* Zen 服务器设置（设计：CacheZenSettings.dc.html）。对象页签，从缓存页“更多操作 › 服务器设置”打开。
   可改并“应用”的只有自动清理三项（zen_update_gc_settings：重写 zen_config.lua 并重启服务）。
   端口 / 数据目录 / 迁移 / 运行方式改动要走完整重新部署链路，这里只读；“自动清理”开关与“拍摄期间暂停清理”后端没有对应设置 → 禁用。 */
import { useRef, useState } from "react";
import { useNav, type ObjectTab } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import { Button, ConfirmDialog, Crumbs, Empty, Field, Fields, IconButton, Menu, MenuItem, Meta, Props, Spacer, SwitchRow, TextInput, Toolbar, ToolTabs } from "@/ui";
import { gb, useZenGc, useZenServer, useZenService, useZenUsage } from "../model/cache";
import css from "./cachePage.module.css";

export const ZEN_SETTINGS_TAB: ObjectTab = { id: "zen:settings", label: "Zen 服务器设置" };

const LIFECYCLE: Record<string, string> = {
  installed_service: "Windows 服务",
  service: "Windows 服务",
  user_logon: "随用户登录启动",
  logon: "随用户登录启动",
  manual: "手动启动",
};

type GcKey = "keep" | "full" | "light";
const toForm = (sec: number | null | undefined, unit: number) => (sec == null ? "" : String(Math.round(sec / unit)));

export function ZenSettings() {
  const { server, loading } = useZenServer();
  const showList = useNav((s) => s.showList);
  const ep = server?.endpoint ?? null;
  const usage = useZenUsage(server?.endpointId ?? null);
  const gc = useZenGc();
  const svc = useZenService();
  const [tab, setTab] = useState<"server" | "rules" | "activity">("server");
  const [edit, setEdit] = useState<Partial<Record<GcKey, string>>>({});
  const [ask, setAsk] = useState<"apply" | "stop" | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const orig: Record<GcKey, string> = {
    keep: toForm(ep?.cache_max_duration_seconds, 86400),
    full: toForm(ep?.gc_interval_seconds, 3600),
    light: toForm(ep?.gc_lightweight_interval_seconds, 60),
  };
  const form: Record<GcKey, string> = { ...orig, ...edit };
  const changed = (Object.keys(form) as GcKey[]).filter((k) => form[k] !== orig[k]);
  const nums = { keep: Number(form.keep), full: Number(form.full), light: Number(form.light) };
  const valid = Object.values(nums).every((n) => Number.isFinite(n) && n > 0);
  const set = (k: GcKey) => (t: string) => setEdit((e) => ({ ...e, [k]: t.replace(/\D/g, "") }));

  const crumbs = <Crumbs icon="cache" trail={[{ label: "缓存", onClick: () => showList("cache") }]} current="Zen 服务器设置" />;
  if (!server) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="cache" title="还没有 Zen 缓存服务器">
            部署 Zen 之后才能在这里调整它。
          </Empty>
        )}
      </main>
    );
  }

  const lifecycle = ep?.lifecycle_mode ?? null;
  const used = usage.data?.used ?? null;
  const total = usage.data?.total ?? null;
  const cmd = `voloctl zen gc-set --endpoint-id ${server.endpointId} --gc-interval-seconds ${nums.full * 3600} --gc-lightweight-interval-seconds ${nums.light * 60} --cache-max-duration-seconds ${nums.keep * 86400} --yes`;

  return (
    <main className="ry-main">
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button icon="stop" disabled={server.reachable !== true} onClick={() => setAsk("stop")}>
          停止服务
        </Button>
        <IconButton ref={moreRef} icon="more" label="更多操作：重新部署、卸载" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
        {moreOpen && (
          <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
            <MenuItem disabled onSelect={() => undefined}>
              重新部署
            </MenuItem>
            <MenuItem danger disabled onSelect={() => undefined}>
              卸载
            </MenuItem>
          </Menu>
        )}
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <ToolTabs
          label="Zen 服务器设置内容"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "server", label: "服务器" },
            { key: "rules", label: "访问规则" },
            { key: "activity", label: "活动" },
          ]}
        />
        <Spacer />
        <Meta>改动在“应用”之后才写到 {server.host}</Meta>
        <Button variant="primary" disabled={!changed.length || !valid || gc.isPending} onClick={() => setAsk("apply")}>
          {changed.length ? `应用 ${changed.length} 处改动` : "应用"}
        </Button>
      </Toolbar>

      {tab === "server" ? (
        <div className={css.settingsScroll}>
          <div className={css.settings}>
            <section aria-label="位置" className={css.section}>
              <div>
                <h2 className={css.sectionHead}>位置</h2>
                <p className={css.sectionDesc}>Zen 服务器只有一台。客户端都指向它。</p>
              </div>
              <Fields>
                <Props
                  items={[
                    { label: "机器", value: `${server.host} · ${server.ip}` },
                    { label: "地址", value: <span className="ry-mono">{server.url}</span> },
                    { label: "版本", value: server.version ? `Zen ${server.version}` : null },
                  ]}
                />
                <Field label="端口" htmlFor="zen-port" hint="改端口会断开所有客户端。改完要重新指向一次。">
                  <TextInput id="zen-port" mono num value={String(server.port)} onChange={() => undefined} disabled />
                </Field>
                <Field label="数据目录" htmlFor="zen-dir" hint={used != null ? `已用 ${gb(used)}${total != null ? ` / ${gb(total)}` : ""} GB。` : undefined}>
                  <TextInput id="zen-dir" mono value={ep?.data_dir ?? ""} onChange={() => undefined} disabled />
                </Field>
                <div className={css.btnRow}>
                  <Button icon="project" disabled>
                    迁移数据目录…
                  </Button>
                  <Button icon="machine" disabled>
                    搬到另一台机器…
                  </Button>
                </div>
              </Fields>
            </section>

            <section aria-label="运行方式" className={css.section}>
              <div>
                <h2 className={css.sectionHead}>运行方式</h2>
                <p className={css.sectionDesc}>决定没有人登录时 Zen 还在不在。</p>
              </div>
              <Fields>
                <Props
                  items={[
                    { label: "现在", value: lifecycle ? `${LIFECYCLE[lifecycle] ?? lifecycle}${ep?.service_account_username ? ` · 账户 ${ep.service_account_username}` : ""}` : null },
                    { label: "安装目录", value: ep?.install_dir ? <span className="ry-mono">{ep.install_dir}</span> : null },
                  ]}
                />
              </Fields>
            </section>

            <section aria-label="自动清理" className={css.section}>
              <div>
                <h2 className={css.sectionHead}>自动清理</h2>
                <p className={css.sectionDesc}>清掉很久没用到的缓存，腾出磁盘。</p>
              </div>
              <Fields>
                <SwitchRow title="自动清理" checked disabled onChange={() => undefined} />
                <Field label="保留多久" htmlFor="gc-keep" hint="太短的话，不常开的工程每次都要重新编译；太长会占更多磁盘。">
                  <TextInput id="gc-keep" num unit="天" value={form.keep} placeholder="—" onChange={set("keep")} />
                </Field>
                <Field label="完整清理间隔" htmlFor="gc-full">
                  <TextInput id="gc-full" num unit="小时" value={form.full} placeholder="—" onChange={set("full")} />
                </Field>
                <Field label="轻量清理间隔" htmlFor="gc-light">
                  <TextInput id="gc-light" num unit="分钟" value={form.light} placeholder="—" onChange={set("light")} />
                </Field>
                <SwitchRow title="拍摄期间暂停清理" desc="清理会占磁盘读写。暂停期间不清理，恢复后补做。" checked={false} disabled onChange={() => undefined} />
              </Fields>
            </section>
          </div>
        </div>
      ) : (
        <Empty icon={tab === "rules" ? "sliders" : "clock"} title={tab === "rules" ? "访问规则还没有接入" : "还没有活动记录"}>
          {tab === "rules" ? "URL 访问规则（urlacl）的管理接入后会显示在这里。" : "这台 Zen 服务器的部署与设置改动接入记录后会显示在这里。"}
        </Empty>
      )}

      {ask === "apply" && (
        <ConfirmDialog
          title={`把 ${changed.length} 处改动写到 ${server.host}？`}
          body="会重写 zen_config.lua 并重启 Zen 服务。重启的几秒里，客户端读不到共享缓存。"
          props={[
            { label: "影响", value: <span className="ry-mono">{server.host}</span> },
            { label: "可恢复", value: "是，改回原值再应用一次" },
          ]}
          command={cmd}
          safeLabel="先不改"
          dangerLabel="应用并重启"
          dangerIcon="refresh"
          busy={gc.isPending}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            gc.mutate(
              { endpointId: server.endpointId, full: nums.full * 3600, light: nums.light * 60, keep: nums.keep * 86400 },
              {
                onSuccess: () => {
                  setAsk(null);
                  setEdit({});
                  toast("已应用，Zen 服务已重启");
                },
                onError: (e) => toast(`应用失败：${errText(e)}`),
              },
            )
          }
        />
      )}
      {ask === "stop" && (
        <ConfirmDialog
          title={`停止 ${server.host} 上的 Zen 服务？`}
          body="停止后，所有指向它的机器读不到共享缓存，会退回本机缓存或从头编译，直到再次启动。"
          props={[{ label: "可恢复", value: "是，再启动服务即可" }]}
          command={`voloctl zen service stop --endpoint-id ${server.endpointId} --yes`}
          safeLabel="保持运行"
          dangerLabel="停止服务"
          dangerIcon="stop"
          busy={svc.isPending}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            svc.mutate({ endpointId: server.endpointId, stop: true }, { onSuccess: () => (setAsk(null), toast(`${server.host} 上的 Zen 已停止`)), onError: (e) => toast(`停止失败：${errText(e)}`) })
          }
        />
      )}
    </main>
  );
}
