import * as React from "react";
import ReactDOM from "react-dom/client";

// Hash-routed secondary surfaces (live-capture plan):
//   #/pattern-player  — LED-facing pattern output window (opened by Rust,
//                       commands/player.rs; renders nothing but the pattern)
//   #/dev/capture     — capture developer console (non-product debug page)
// Both are self-contained and must NOT pull in the full shell (the player
// window especially: any chrome would be projected onto the wall).
const SHELL_KEY = "volo-shell";
const route = window.location.hash;
if (route.startsWith("#/pattern-player")) {
  void import("./volo/pages/patternPlayer").then(({ PatternPlayer }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      React.createElement(PatternPlayer),
    );
  });
} else if (route.startsWith("#/dev/capture")) {
  void import("./volo/pages/devCapture").then(({ DevCapture }) => {
    document.documentElement.setAttribute("data-theme", "dark");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      React.createElement(DevCapture),
    );
  });
} else if (wantsNextShell()) {
  // 新壳（src/app，LAN-20 新结构）。旧壳的模块与 CSS 都在 ./volo 的动态 chunk 里，这条分支不会加载它们。
  void import("./app").then(({ App }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(App));
  });
} else {
  void import("./volo").then(({ App }) => {
    bootShell(App);
  });
}

/* 新 / 旧壳开关（docs/architecture/frontend-structure.md §8 P1）。优先级：
   URL `?shell=next|legacy`（同时记住）> localStorage `volo-shell` > 构建变量 VITE_VOLO_SHELL=next（仅作默认值）。
   默认旧壳，直到新壳达到功能对等（P4）。原生 App 里用 ⌘/Ctrl+⌥/Alt+⇧+S 切换并重载。 */
function wantsNextShell(): boolean {
  const q = new URLSearchParams(window.location.search).get("shell");
  if (q === "next" || q === "legacy") {
    try { localStorage.setItem(SHELL_KEY, q); } catch { /* 无痕 / 禁用存储 */ }
    return q === "next";
  }
  let saved: string | null = null;
  try { saved = localStorage.getItem(SHELL_KEY); } catch { /* 无痕 / 禁用存储 */ }
  if (saved === "next" || saved === "legacy") return saved === "next";
  return import.meta.env.VITE_VOLO_SHELL === "next";
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === "KeyS") {
    e.preventDefault();
    try { localStorage.setItem(SHELL_KEY, wantsNextShell() ? "legacy" : "next"); } catch { return; }
    const url = new URL(window.location.href);
    url.searchParams.delete("shell");
    window.location.replace(url.toString());
  }
});

function bootShell(App: React.ComponentType) {

// The standalone Volo app has no Claude Design edit-mode host, and the Tweaks
// panel stays hidden until it receives `__activate_edit_mode`. It is no longer
// auto-activated on startup; the shortcut below reveals it on demand.
// Bound to Cmd/Ctrl+Shift+. — ignored while typing in a field.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  const typing =
    e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if (!typing && (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Period") {
    e.preventDefault();
    window.postMessage({ type: "__activate_edit_mode" }, "*");
  }
});

  // Render without StrictMode to match the Claude Design prototype's mount
  // (Volo.html: ReactDOM.createRoot(...).render(React.createElement(App))).
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    React.createElement(App),
  );
}
