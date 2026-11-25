import * as React from "react";
import ReactDOM from "react-dom/client";

/* 入口。#/pattern-player 是打到 LED 墙上的第二个窗口（commands/player.rs 打开），
   只渲染图案，不能带外壳（任何界面元素都会被投到墙上）；其余一律是主外壳 src/app。 */
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (window.location.hash.startsWith("#/pattern-player")) {
  void import("./windows/PatternPlayer").then(({ PatternPlayer }) => root.render(React.createElement(PatternPlayer)));
} else {
  void import("./app").then(({ App }) => root.render(React.createElement(App)));
}
