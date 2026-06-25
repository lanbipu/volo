// Volo · Cache —— preview→确认→执行 浮层（pattern 5.1），移植自 page_cache.jsx PreviewPanel。
// 破坏性操作统一走：将执行步骤 + 可选 diff + 影响范围（机器选择器 / 已知目标）+ 安全·回读 + 二次确认。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { ChannelTag } from "../ui/status";
import { useCache, type PreviewSpec } from "../state/store";
import { useMachines } from "../state/data";
import { MachineSelector, predict } from "./MachineSelector";

export function PreviewPanel({ spec }: { spec: PreviewSpec }) {
  const { setDrawer, runTask } = useCache();
  const { machines } = useMachines();
  const [scope, setScope] = useState<number[]>(spec.scope || []);
  const [confirmCk, setConfirmCk] = useState(false);

  const simple = spec.simpleScope || null;
  const rows = simple ? [] : predict(machines, scope, spec.destructive);
  const willApply = simple ? simple.length : rows.filter((r) => !r.skip).length;
  const willSkip = simple ? 0 : rows.filter((r) => r.skip).length;
  const count = simple ? simple.length : scope.length;
  const blocked = !!spec.destructive && !!spec.confirmInput && count > 1 && !confirmCk;
  const close = () => setDrawer(null);
  const confirm = () => {
    close();
    if (spec.task)
      // 把机器选择器最终勾选的范围传给任务（ctx.scope），分发/批量类据此发给真实目标，
      // 而非 openPreview 时算好的原始全集。simpleScope 模式不走选择器，不传 scope。
      runTask({
        ...spec.task,
        chan: spec.channel ?? spec.task.chan,
        scope: simple ? spec.task.scope : scope,
      });
    spec.onConfirm?.();
  };

  return (
    <div className={"drawer drawer--preview" + (spec.destructive ? " danger" : "")}>
      <div className="drawer-h">
        <span className={"di" + (spec.destructive ? "" : " info")}>
          <Icon name={spec.icon || "eye"} size={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2>{spec.title}</h2>
          <div className="sub">
            <span className="cli-pill">{spec.cli}</span>
            {spec.destructive ? (
              <span className="danger-note"> · 破坏性操作，需确认</span>
            ) : (
              <span> · 预览（dry-run）</span>
            )}
          </div>
        </div>
        <button className="iconbtn x" onClick={close}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="drawer-b">
        {/* ① 步骤 */}
        <div className="dblock">
          <div className="dblock-h">
            <span className="no">1</span>
            将执行的步骤
            <ChannelTag ch={spec.channel || "ssh"} mini />
          </div>
          <div className="steps-list">
            {(spec.steps || []).map((st, i) => (
              <div key={i} className="step-line">
                <span className="sn">{i + 1}</span>
                <span className="step-tx">{st}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 可选 diff */}
        {spec.diff ? (
          <div className="dblock">
            <div className="dblock-h">
              <span className="no">2</span>
              变更对比 (diff)
            </div>
            <div className="diff">
              {spec.ctx ? <div className="diff-ctx">{spec.ctx}</div> : null}
              {spec.diff.map((ln, i) => (
                <div key={i} className={"diff-line diff-" + ln[0]}>
                  <span className="sign">{ln[0] === "del" ? "−" : "+"}</span>
                  <span>{ln[1]}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* ② 影响范围 */}
        <div className="dblock">
          <div className="dblock-h">
            <span className="no">{spec.diff ? "3" : "2"}</span>
            {simple ? "目标设备" : "影响范围 · 机器选择器"}
            <span className="aff-sum">
              {simple ? `${simple.length} 台` : `${willApply} 应用 / ${willSkip} 跳过`}
            </span>
          </div>
          {simple ? (
            <div className="afflist">
              {simple.map((r, i) => (
                <div key={i} className="affrow">
                  <span className="ai s-positive">
                    <Icon name="check" size={15} />
                  </span>
                  <span className="host">{r.host}</span>
                  <span className="ip">{r.ip}</span>
                  <span className="msg s-positive">{r.msg || "就绪"}</span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <MachineSelector value={scope} onChange={setScope} />
              {rows.length ? (
                <div className="afflist">
                  {rows.map((r) => (
                    <div key={r.n.id} className={"affrow" + (r.skip ? " skip" : "")}>
                      <span className={"ai s-" + r.vis}>
                        {r.icon === "minus" ? <span>—</span> : <Icon name={r.icon} size={15} />}
                      </span>
                      <span className="host">{r.n.hostname}</span>
                      <span className="ip">{r.n.ip}</span>
                      <span className={"msg s-" + r.vis}>{r.msg}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* ③ 安全 / 回读 */}
        {spec.backup || spec.readback ? (
          <div className="dblock">
            <div className="dblock-h">
              <span className="no">{spec.diff ? "4" : "3"}</span>
              安全 / 回读
            </div>
            {spec.backup ? (
              <div className="backup">
                <Icon
                  name="folder"
                  size={16}
                  style={{ color: "var(--chrome-faint)", flex: "0 0 auto" }}
                />
                <div>
                  <div className="path">{spec.backup}</div>
                  <div style={{ fontSize: 11, color: "var(--chrome-faint)", marginTop: 3 }}>
                    应用前自动备份，可回滚
                  </div>
                </div>
              </div>
            ) : null}
            {spec.readback ? (
              <div className="readback">
                <div className="rb-h">
                  <Icon name="check" size={13} />
                  写入后回读确证
                </div>
                <div className="rb-row">
                  <span className="k">{spec.readback.key}</span>
                  <span className="exp">expected {spec.readback.expected}</span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {spec.destructive && spec.confirmInput && count > 1 ? (
          <label className="confirm-ck">
            <input
              type="checkbox"
              checked={confirmCk}
              onChange={(e) => setConfirmCk(e.target.checked)}
            />
            <span>
              我确认对 <b>{count}</b> 台机器执行此破坏性操作
            </span>
          </label>
        ) : null}
      </div>

      <div className="drawer-f">
        <Button variant="secondary" size="M" onPress={close}>
          取消
        </Button>
        <Button
          variant={spec.destructive ? "negative" : "accent"}
          size="M"
          isDisabled={blocked || willApply === 0}
          icon={<Icon name="check" size={15} />}
          onPress={confirm}
        >
          {spec.confirmLabel || "确认执行"}
        </Button>
      </div>
    </div>
  );
}
