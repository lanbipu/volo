import * as React from "react";
import ReactDOM from "react-dom/client";

// Hash-routed secondary surfaces (live-capture plan):
//   #/pattern-player  — LED-facing pattern output window (opened by Rust,
//                       commands/player.rs; renders nothing but the pattern)
//   #/dev/capture     — capture developer console (non-product debug page)
// Both are self-contained and must NOT pull in the full shell (the player
// window especially: any chrome would be projected onto the wall).
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
} else {
  void import("./volo").then(({ App }) => {
    bootShell(App);
  });
}

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
