// Volo · Cache —— 左导航（集群总览 leaf + DDC 管理折叠子菜单），移植自 page_cache.jsx 的 left()。
import { Icon } from "../ui/Icon";
import { useCache } from "../state/store";
import { CACHE_MODULES, DDC_NAV, type CacheNav } from "../state/nav";

export function LeftNav() {
  const { nav, setNav, setDrawer } = useCache();

  const leaf = (m: (typeof CACHE_MODULES)[number]) => (
    <div
      key={m.id}
      className={"nav-i nav-mod" + (nav === m.id ? " on" : "")}
      onClick={() => setNav(m.id as CacheNav)}
    >
      <span className="nav-ico">
        <Icon name={m.icon} size={17} />
      </span>
      <span className="nav-lbl">{m.label}</span>
      <span className="nav-sub">{m.sub}</span>
    </div>
  );

  return (
    <>
      <div className="sect">
        <div className="sect-h">
          <span className="t">UECM · 缓存</span>
        </div>
        {CACHE_MODULES.map((m) => {
          if (m.id !== "ddc") return leaf(m);
          return (
            <div key="ddc">
              <div className="nav-i nav-mod nav-head">
                <span className="nav-ico">
                  <Icon name={m.icon} size={17} />
                </span>
                <span className="nav-lbl">{m.label}</span>
              </div>
              <div className="nav-children">
                {DDC_NAV.map((d) => (
                  <div
                    key={d.id}
                    className={"nav-i nav-child" + (nav === d.id ? " on" : "")}
                    onClick={() => setNav(d.id)}
                  >
                    <span className="nav-ico">
                      <Icon name={d.icon} size={15} />
                    </span>
                    <span className="nav-lbl">{d.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="sect" style={{ marginTop: "auto" }}>
        <div className="nav-i nav-mod" onClick={() => setDrawer({ kind: "creds" })}>
          <span className="nav-ico">
            <Icon name="key" size={17} />
          </span>
          <span className="nav-lbl">凭据管理</span>
          <span className="nav-sub">SecretStore</span>
        </div>
        <div className="pull-note">
          <Icon name="shield" size={13} />
          <span>pull 模式 · GPU / 项目 / INI 后台自动处理</span>
        </div>
      </div>
    </>
  );
}
