// Volo · 底部页签（水平居中，5 个：预演/校正/调色/现场/工具），1:1 移植自原型 shell.jsx PageTabs。
import { Icon } from "../features/cache/ui/Icon";
import { useShell } from "./store";
import { PAGES } from "./data";

export function PageTabs() {
  const { page, setPage } = useShell();
  return (
    <div className="pagetabs">
      {PAGES.map((p) => (
        <div
          key={p.id}
          className={"ptab" + (p.id === page ? " on" : "")}
          onClick={() => setPage(p.id)}
        >
          <span className="pico">
            <Icon name={p.icon} size={17} />
          </span>
          {p.label}
          {p.skeleton ? <span className="skl">WIP</span> : null}
        </div>
      ))}
      <div className="meta">
        <span className="sdot bg-notice" />
        <span>缓存健康分 72</span>
      </div>
    </div>
  );
}
