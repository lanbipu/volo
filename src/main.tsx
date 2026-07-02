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

// The standalone Volo app has no Claude Design edit-mode host. The Tweaks panel
// announces `__edit_mode_available` once it has registered its message listener;
// reply with `__activate_edit_mode` to reveal it (platform / density / theme
// controls). Registering this listener before render makes activation race-free.
window.addEventListener("message", (e: MessageEvent) => {
  if (e && e.data && e.data.type === "__edit_mode_available") {
    window.postMessage({ type: "__activate_edit_mode" }, "*");
  }
});

// The panel's message listener stays mounted for the session, so re-posting
// `__activate_edit_mode` reveals it again after the user dismisses it (✕).
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
