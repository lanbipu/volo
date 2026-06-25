// Volo · Cache —— 底部可收起 NDJSON 控制台（搜索 / 暂停 / 通道），移植自 shell.jsx 的 LogPanel。
import { Icon } from "../ui/Icon";
import { CHANNEL } from "../ui/status";
import { useCache } from "../state/store";
import { startResize } from "./resize";

export function LogPanel() {
  const s = useCache();
  const allLogs = s.logs;
  const q = (s.logSearch || "").trim().toLowerCase();
  const strip = (html: string) => html.replace(/<[^>]+>/g, "");
  const counts = {
    all: allLogs.length,
    info: allLogs.filter((l) => l.lv === "info" || l.lv === "ok").length,
    warn: allLogs.filter((l) => l.lv === "warn").length,
    err: allLogs.filter((l) => l.lv === "err").length,
  };
  const byLevel = allLogs.filter((l) =>
    s.logFilter === "all"
      ? true
      : s.logFilter === "info"
        ? l.lv === "info" || l.lv === "ok"
        : s.logFilter === "warn"
          ? l.lv === "warn"
          : l.lv === "err",
  );
  const rows = q
    ? byLevel.filter(
        (l) =>
          strip(l.msg).toLowerCase().includes(q) ||
          (l.cat || "").includes(q) ||
          (l.ch || "").includes(q),
      )
    : byLevel;
  const tabs: Array<[typeof s.logFilter, string]> = [
    ["all", "全部"],
    ["info", "信息"],
    ["warn", "警告"],
    ["err", "错误"],
  ];
  const running = s.tasks.filter((t) => t.state === "running").length;

  return (
    <div className="logpanel">
      {s.logOpen ? (
        <div
          className="resizer resizer--row"
          title="拖动调整高度"
          onPointerDown={(e) => startResize(e, "y", -1, s.logH, s.setLogH, 90, 440)}
        />
      ) : null}
      <div
        className="log-head"
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest(".log-tab") || t.closest(".log-tools")) return;
          s.setLogOpen((v) => !v);
        }}
      >
        <span className="ttl">
          <Icon name="terminal" size={15} />
          控制台
          <span className="ndjson-tag">NDJSON</span>
        </span>
        <div className="log-tabs">
          {tabs.map(([id, lbl]) => (
            <div
              key={id}
              className={"log-tab" + (s.logFilter === id ? " on" : "")}
              onClick={() => {
                s.setLogFilter(id);
                s.setLogOpen(true);
              }}
            >
              {lbl}
              <span className="n">{counts[id]}</span>
            </div>
          ))}
        </div>
        <div className="right log-tools">
          <div className="log-search">
            <Icon name="search" size={13} />
            <input
              value={s.logSearch || ""}
              placeholder="搜索流…"
              onChange={(e) => {
                s.setLogSearch(e.target.value);
                s.setLogOpen(true);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <button
            className={"log-pause" + (s.logPaused ? " on" : "")}
            title={s.logPaused ? "已暂停 — 点击恢复" : "暂停自动滚动"}
            onClick={(e) => {
              e.stopPropagation();
              s.setLogPaused((v) => !v);
            }}
          >
            <Icon name={s.logPaused ? "play" : "pause"} size={13} />
            {s.logPaused ? "已暂停" : "实时"}
          </button>
          <span
            className="rec-dot"
            style={{
              width: 7,
              height: 7,
              background: running ? "var(--volo-600)" : "var(--positive-visual)",
              animationPlayState: s.logPaused ? "paused" : "running",
            }}
          />
          {running ? (
            <span style={{ fontSize: 11, color: "var(--volo-400)", fontWeight: 700 }}>
              {running} 运行中
            </span>
          ) : null}
          <button className="iconbtn" style={{ width: 22, height: 22 }}>
            <Icon
              name={s.logOpen ? "chevd" : "chevr"}
              size={15}
              style={{ transform: s.logOpen ? "rotate(180deg)" : "none" }}
            />
          </button>
        </div>
      </div>
      {s.logOpen ? (
        <div className={"log-body" + (s.logPaused ? " paused" : "")} style={{ height: s.logH }}>
          {rows.length === 0 ? (
            <div className="log-empty">{q ? `无匹配「${s.logSearch}」的流` : "暂无日志"}</div>
          ) : (
            rows.map((l, i) => (
              <div key={i} className="log-row">
                <span className="ts">{l.ts}</span>
                <span className={"lv " + l.lv}>{l.lv === "ok" ? "OK" : l.lv.toUpperCase()}</span>
                <span className={"ch" + (l.ch ? " ch-" + l.ch : "")}>
                  {l.ch ? CHANNEL[l.ch].short : "·"}
                </span>
                <span className="msg">{l.msg}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
