// Volo · Cache —— 浮层宿主（scrim + preview / 机器详情），移植自 page_cache.jsx drawer()。
import { useCache } from "./state/store";
import { PreviewPanel } from "./overlays/PreviewPanel";
import { MachineDetail } from "./overlays/MachineDetail";
import { ScriptPanel } from "./overlays/ScriptPanel";
import { CredsPanel } from "./overlays/CredsPanel";

export function CacheOverlay() {
  const { drawer, setDrawer } = useCache();
  if (!drawer) return null;
  return (
    <>
      <div className="scrim" onClick={() => setDrawer(null)} />
      {drawer.kind === "preview" ? (
        <PreviewPanel spec={drawer} />
      ) : drawer.kind === "machine" ? (
        <MachineDetail id={drawer.id} />
      ) : drawer.kind === "script" ? (
        <ScriptPanel id={drawer.id} />
      ) : drawer.kind === "creds" ? (
        <CredsPanel />
      ) : null}
    </>
  );
}
