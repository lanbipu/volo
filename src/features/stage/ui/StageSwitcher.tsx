/* 侧栏顶部的 Stage 切换器（设计：Sidebar.dc.html 的 ry-sidebar__ws + StageMenu.dc.html）。 */
import { useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { loadProjectYaml } from "@/api/meshCommands";
import { revealPath } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { Icon, IconButton, Menu, MenuItem, MenuSep } from "@/ui";
import { errText, toast } from "@/lib/toast";
import css from "./StageSwitcher.module.css";
import { stageKeys, stageName, useCurrentStage, useOpenStageFolder, useStageSel } from "../model/stage";
import { StageNewDialog } from "./StageNewDialog";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export function StageSwitcher({ onSearch }: { onSearch: () => void }) {
  const { stage, recent } = useCurrentStage();
  const setPath = useStageSel((s) => s.setPath);
  const openFolder = useOpenStageFolder();
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const configs = useQueries({
    queries: recent.map((r) => ({ queryKey: stageKeys.config(r.abs_path), queryFn: () => loadProjectYaml(r.abs_path), enabled: isTauri() && menuOpen })),
  });

  const name = stage?.name ?? "未打开 Stage";
  const mark = (name.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="ry-sidebar__ws">
      <button
        ref={menuRef}
        type="button"
        aria-label="切换 Stage"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className={css.trigger}
      >
        <i className="ry-sidebar__mark" aria-hidden="true">
          {mark}
        </i>
        <b>{name}</b>
        <Icon name="chevron-down" size="sm" />
      </button>
      <span className="ry-toolbar__spacer" />
      <IconButton icon="search" label="搜索或跳转" onClick={onSearch} />
      {menuOpen && (
        <Menu anchor={menuRef} onClose={() => setMenuOpen(false)} label="切换 Stage" width={300}>
          <div className={`ry-meta ${css.menuLabel}`}>
            最近打开的 Stage
          </div>
          {recent.length === 0 && (
            <MenuItem disabled onSelect={() => {}}>
              还没有打开过 Stage
            </MenuItem>
          )}
          {recent.map((r, i) => {
            const cfg = configs[i]?.data;
            const type = cfg?.stage_type ?? "led";
            const empty = cfg && Object.keys(cfg.screens ?? {}).length === 0 && type !== "ar";
            const meta = type === "ar" ? "AR" : type === "hybrid" ? "LED + AR" : empty ? "LED · 空的" : "LED";
            return (
              <MenuItem
                key={r.abs_path}
                icon={type === "ar" ? "marker" : "screens"}
                meta={meta}
                checked={r.abs_path === stage?.path}
                onSelect={() => {
                  setPath(r.abs_path);
                  setMenuOpen(false);
                }}
              >
                {stageName(r, cfg)}
              </MenuItem>
            );
          })}
          <MenuSep subtle />
          <MenuItem
            icon="plus"
            onSelect={() => {
              setMenuOpen(false);
              setCreating(true);
            }}
          >
            新建 Stage…
          </MenuItem>
          <MenuItem
            icon="project"
            onSelect={() => {
              setMenuOpen(false);
              openFolder()
                .then((n) => n && toast(`已打开 ${n}`))
                .catch((e) => toast(`打开失败：${errText(e)}`));
            }}
          >
            打开文件夹里的 Stage…
          </MenuItem>
          {stage && (
            <>
              <MenuSep subtle />
              <MenuItem
                icon="sliders"
                onSelect={() => {
                  setMenuOpen(false);
                  toast("Stage 设置还没有设计稿：先在各页里改，名称和机器在“机器”里调整");
                }}
              >
                {stage.name} 的设置…
              </MenuItem>
              <MenuItem
                icon="open"
                onSelect={() => {
                  setMenuOpen(false);
                  revealPath(stage.path).catch((e) => toast(`打开失败：${errText(e)}`));
                }}
              >
                {IS_MAC ? "在访达中显示" : "在资源管理器中显示"}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {creating && <StageNewDialog recentPath={stage?.path ?? recent[0]?.abs_path ?? null} onClose={() => setCreating(false)} />}
    </div>
  );
}
