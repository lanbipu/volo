import * as React from "react";
import ReactDOM from "react-dom/client";

/* 入口。#/pattern-player 是打到 LED 墙上的第二个窗口（commands/player.rs 打开），
   只渲染图案，不能带外壳（任何界面元素都会被投到墙上）；其余一律是主外壳 src/app。 */
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (window.location.hash.startsWith("#/pattern-player")) {
  void import("./windows/PatternPlayer").then(({ PatternPlayer }) => root.render(React.createElement(PatternPlayer)));
} else {
  /* 孤儿清扫：WebView 重载后，上一轮的 vpcal 任务已经没人持有句柄，却可能还独占着采集卡（DeckLink 单开）。
     渲染外壳之前统一取消一次，免得新会话打开设备失败。只在主窗口做：图案窗口不能动主窗口的任务。 */
  void import("./api/sidecarStream")
    .then(({ cancelSidecarTasksByProgram }) => cancelSidecarTasksByProgram("vpcal"))
    .catch(() => undefined)
    .then(() => import("./app"))
    .then(({ App }) => root.render(React.createElement(App)));
}
