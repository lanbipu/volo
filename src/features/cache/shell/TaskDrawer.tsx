// Volo · Cache —— 右侧常驻任务抽屉（进行中 / 历史 + 任务卡），移植自 page_cache.jsx inspector()/TaskCard。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { ChannelTag } from "../ui/status";
import { useCache, type Task } from "../state/store";
import { cancelUeJob } from "../api/commands";

const taskVis = (st: Task["state"]) =>
  st === "running" ? "accent" : st === "success" ? "positive" : st === "failed" ? "negative" : "neutral";

function TaskIcon({ t }: { t: Task }) {
  if (t.state === "running")
    return (
      <span className="spin">
        <Icon name="sync" size={13} />
      </span>
    );
  if (t.state === "success") return <Icon name="check" size={13} />;
  if (t.state === "failed") return <Icon name="x" size={13} />;
  return <Icon name="pause" size={13} />;
}

function TaskCard({ t }: { t: Task }) {
  const s = useCache();
  const [open, setOpen] = useState(false);
  const seeStream = () => {
    s.setLogSearch("#" + t.no);
    s.setLogFilter("all");
    s.setLogOpen(true);
  };
  return (
    <div className={"tcard tcard--" + t.state}>
      <div className="tcard-h">
        <span className={"tk-state s-" + taskVis(t.state)}>
          <TaskIcon t={t} />
        </span>
        <span className="tcard-title">
          {t.title}
          <span className="no">#{t.no}</span>
        </span>
        <span className="tcard-time">{t.started}</span>
      </div>
      <div className="tcard-meta">
        <ChannelTag ch={t.chan} mini />
        <span className="tk-target">{t.target}</span>
        <span className="sp" />
        <span className="tk-el">{t.elapsed}</span>
      </div>
      {t.state === "running" ? (
        <div className="tcard-bar">
          <div className="vmeter vmeter--accent">
            <div className="vmeter__fill" style={{ width: t.pct + "%" }} />
          </div>
          <span className="pct">{t.pct}%</span>
        </div>
      ) : (
        <div className="tcard-note">{t.note}</div>
      )}
      <div className="tcard-f">
        <button className="tk-btn" onClick={seeStream}>
          <Icon name="terminal" size={13} />
          看日志流
        </button>
        {t.state === "running" && t.jobId ? (
          <button
            className="tk-btn err"
            onClick={() => {
              cancelUeJob(t.jobId!).catch(() => {});
              s.cancelTask(t.id);
            }}
          >
            <Icon name="x" size={13} />
            取消
          </button>
        ) : null}
        {t.state === "failed" ? (
          <button className="tk-btn err" onClick={() => setOpen((v) => !v)}>
            <Icon name="alert" size={13} />
            看错误
          </button>
        ) : null}
      </div>
      {open && t.state === "failed" ? (
        <div className="tcard-err">
          <div className="er-line">
            <span className="k">exit</span>
            <span className="v">{t.exit}</span>
          </div>
          <div className="er-line">
            <span className="k">通道</span>
            <ChannelTag ch={t.chan} mini />
          </div>
          {t.stderr ? <div className="er-std">{t.stderr}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function TaskDrawer() {
  const s = useCache();
  const active = s.tasks.filter((t) => t.state === "running" || t.state === "queued");
  const history = s.tasks.filter((t) => t.state === "success" || t.state === "failed");
  const list = s.taskTab === "active" ? active : history;
  return (
    <div className="task-drawer">
      <div className="td-head">
        <div className="td-title">
          <Icon name="list" size={15} />
          任务抽屉
        </div>
        <div className="td-tabs">
          <button
            className={s.taskTab === "active" ? "on" : ""}
            onClick={() => s.setTaskTab("active")}
          >
            进行中<span className="n">{active.length}</span>
          </button>
          <button
            className={s.taskTab === "history" ? "on" : ""}
            onClick={() => s.setTaskTab("history")}
          >
            历史<span className="n">{history.length}</span>
          </button>
        </div>
      </div>
      <div className="td-body">
        {list.length === 0 ? (
          <div className="td-empty">
            <div className="ph">
              <Icon name={s.taskTab === "active" ? "sync" : "list"} size={26} />
            </div>
            <div>{s.taskTab === "active" ? "当前没有运行中的任务" : "暂无历史任务"}</div>
          </div>
        ) : (
          list.map((t) => <TaskCard key={t.id} t={t} />)
        )}
      </div>
    </div>
  );
}
