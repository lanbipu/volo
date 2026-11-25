/* 预跑设置表单（设计：ProjectDetail.dc.html 的 Inspector「预跑设置」；PSO 页「预热设置」同一块）。
   改动立即保存（set_pso_project_settings）。nDisplay 配置与地图在源机器上发现。
   画质后端没有参数（固定 1920×1080 离屏）→ 选择框禁用，显示“与上屏一致”。 */
import { useCurrentStage } from "@/features/stage";
import { errText, toast } from "@/lib/toast";
import { Check, Field, Fields, FieldsTitle, Select, SwitchRow, TextInput } from "@/ui";
import type { PsoProjectSettings } from "@/api/types";
import { emptySettings, targetIds, useNdisplayAssets, useProjectMaps, usePsoPrefs, usePsoSettings, useSavePsoSettings } from "../model/pso";
import type { ProjectView } from "../model/projects";
import css from "./cache.module.css";

const FOLLOW = "__follow__";
const NO_MAP = "__none__";

export function PsoSettingsForm({ v }: { v: ProjectView }) {
  const q = usePsoSettings(v.id);
  const save = useSavePsoSettings(v.id);
  const { stage } = useCurrentStage();
  const cold = usePsoPrefs((s) => s.coldVerify[String(v.id)] ?? false);
  const setCold = usePsoPrefs((s) => s.setCold);
  const src = v.copies.find((c) => !c.offline) ?? v.source;
  const assets = useNdisplayAssets(src?.loc.machine_id ?? null, src?.loc.abs_path ?? null);
  const maps = useProjectMaps(src?.loc.machine_id ?? null, src?.loc.abs_path ?? null);

  const s: PsoProjectSettings = q.data ?? emptySettings(v.id);
  const ids = targetIds(q.data);
  const effectiveIds = q.data ? ids : v.copies.filter((c) => !c.offline).map((c) => c.loc.machine_id);
  const put = (patch: Partial<PsoProjectSettings>) => save.mutate({ ...s, ...patch }, { onError: (e) => toast(`保存失败：${errText(e)}`) });

  const assetList = assets.data ?? [];
  const cfgOptions = [...assetList, ...(s.dc_cfg_asset && !assetList.includes(s.dc_cfg_asset) ? [s.dc_cfg_asset] : [])].map((a) => ({ value: a, label: a }));
  const nodes = stage?.config?.output_topology?.nodes ?? [];
  const nodeOptions = [{ value: FOLLOW, label: "跟随上屏拓扑" }, ...nodes.map((n) => ({ value: n.node_id, label: `${n.node_id} · ${n.machine.hostname}` }))];
  const mapList = maps.data ?? [];
  const mapOptions = [{ value: NO_MAP, label: "不遍历 · 固定机位" }, ...mapList.map((m) => ({ value: m, label: m.split("/").pop() || m }))];

  return (
    <>
      <Fields>
        <FieldsTitle>按什么形态启动</FieldsTitle>
        <Field
          inline
          label={<span id="pso-cfg">配置</span>}
          hint={
            assets.isLoading
              ? "正在源机器上查找 nDisplay 配置…"
              : assets.error
                ? `查找失败：${errText(assets.error)}`
                : `在工程里找到 ${assetList.length} 份 nDisplay 配置。必须选正式拍摄用的那一份，否则预热出的缓存对不上。`
          }
        >
          <Select labelledBy="pso-cfg" mono value={s.dc_cfg_asset} options={cfgOptions} placeholder="选择 nDisplay 配置" onChange={(a) => put({ dc_cfg_source: "asset", dc_cfg_asset: a })} />
        </Field>
        <Field inline label={<span id="pso-node">节点</span>}>
          <Select labelledBy="pso-node" value={s.dc_node?.trim() ? s.dc_node : FOLLOW} options={nodeOptions} onChange={(n) => put({ dc_node: n === FOLLOW ? "" : n })} />
        </Field>
      </Fields>
      <div className={css.gap12} />
      <Fields>
        <FieldsTitle>在哪些机器上跑</FieldsTitle>
        {v.copies.map((c) => (
          <Check
            key={c.loc.machine_id}
            disabled={c.offline}
            checked={!c.offline && effectiveIds.includes(c.loc.machine_id)}
            onChange={(on) => {
              const next = on ? [...effectiveIds, c.loc.machine_id] : effectiveIds.filter((x) => x !== c.loc.machine_id);
              put({ target_machine_ids: JSON.stringify(Array.from(new Set(next))) });
            }}
          >
            {c.host}
            {c.offline ? " · 离线" : ""}
          </Check>
        ))}
      </Fields>
      <div className={css.gap12} />
      <Fields>
        <FieldsTitle>跑什么</FieldsTitle>
        <Field inline label={<span id="pso-map">地图</span>} hint="选了地图才会沿机位走一遍场景。不选就固定机位，只能靠最后的验证判断。">
          <Select labelledBy="pso-map" value={s.map_path?.trim() ? s.map_path : NO_MAP} options={mapOptions} onChange={(m) => put({ map_path: m === NO_MAP ? "" : m })} />
        </Field>
        <Field inline label="时长上限" htmlFor="pso-max">
          <TextInput
            id="pso-max"
            num
            unit="分钟"
            value={String(s.max_minutes)}
            onChange={(t) => {
              const n = Number(t.replace(/\D/g, ""));
              if (n >= 1 && n <= 240) put({ max_minutes: n });
            }}
          />
        </Field>
        <Field inline label={<span id="pso-q">画质</span>}>
          <Select labelledBy="pso-q" value="match" options={[{ value: "match", label: "与上屏一致" }]} onChange={() => undefined} disabled />
        </Field>
      </Fields>
      <div className={css.gap12} />
      <SwitchRow title="跑完再做一次冷启动验证" desc="先清空这台机器的显卡驱动缓存再跑一遍，从零证明不卡顿。耗时约翻倍。" checked={cold} onChange={(on) => setCold(v.id, on)} />
    </>
  );
}
