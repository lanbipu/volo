#!/usr/bin/env node
// 由 src/ui/tokens.json（Runyard design system 的 tokens.json 拷贝）生成 src/ui/tokens.css。
// 输出与 DS artifact「06-css-variables.md」里的 CSS 逐字节一致（scripts/gen-tokens.test.mjs 校验）。
// 用法：node scripts/gen-tokens.mjs            写入 src/ui/tokens.css
//       node scripts/gen-tokens.mjs --check    只比对，不一致则退出码 1（CI / 提交前用）
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = `${ROOT}src/ui/tokens.json`;
const OUT = `${ROOT}src/ui/tokens.css`;

/** tokens.json 之外、DS 固定附带的部分（中文字体别名、字体切换、密度别名） */
const PREAMBLE = `/* Runyard tokens — generated from tokens.json */
/* Chinese on Windows / Linux: HarmonyOS Sans SC, one step lighter than the nominal weight.
   400–500 → Regular, 600–700 → Medium. macOS never reaches this family (PingFang SC comes first in the stack).
   When the font ships with the app, replace each local() with url() to the bundled file. */
@font-face { font-family: "Runyard CJK"; font-weight: 400 500; font-style: normal; src: local("HarmonyOS Sans SC"), local("HarmonyOS Sans SC Regular"), local("HarmonyOS_Sans_SC_Regular"), local("HarmonyOS_Sans_SC"); }
@font-face { font-family: "Runyard CJK"; font-weight: 600 700; font-style: normal; src: local("HarmonyOS Sans SC Medium"), local("HarmonyOS_Sans_SC_Medium"); }
`;

const POSTAMBLE = `/* font choice */
[data-ry-font="system"] { --font-sans: var(--font-sans-system); }
[data-ry-font="geist"] { --font-sans: var(--font-sans-geist); }
[data-ry-mono="jetbrains"] { --font-mono: var(--font-mono-jetbrains); }
[data-ry-mono="geist"] { --font-mono: var(--font-mono-geist); }
/* density aliases used by components */
:root, [data-ry-density="comfortable"] {
  --ry-row: var(--row-comfortable); --ry-control: var(--control-comfortable); --ry-nav: var(--nav-item-comfortable);
  --ry-bar: var(--bar-comfortable); --ry-pad: var(--space-6); --ry-gap: var(--space-3); --ry-log-lh: 22px; --ry-chip: 28px;
}
[data-ry-density="compact"] {
  --ry-row: var(--row-compact); --ry-control: var(--control-compact); --ry-nav: var(--nav-item-compact);
  --ry-bar: var(--bar-compact); --ry-pad: var(--space-4); --ry-gap: var(--space-2); --ry-log-lh: 18px; --ry-chip: 24px;
}
`;

/** 主题相关的族（值是 {themeId: value}） */
const THEMED = ["color", "shadow"];
/** 主题无关的族，按 DS 输出顺序 */
const STATIC = ["spacing", "radius", "density", "layout", "icon"];

export function generate(tokens) {
  const themes = tokens.color.themes.map((t) => t.id);
  const [first, ...rest] = themes;
  const themedVars = (id) =>
    THEMED.flatMap((fam) => (tokens[fam]?.tokens ?? []).map((t) => `  --${t.name}: ${t.value[id]};`));

  let css = PREAMBLE;
  css += `:root, [data-theme="${first}"] {\n${themedVars(first).join("\n")}\n}\n`;
  for (const id of rest) css += `[data-theme="${id}"] {\n${themedVars(id).join("\n")}\n}\n`;

  const statics = STATIC.flatMap((fam) => (tokens[fam]?.tokens ?? []).map((t) => `  --${t.name}: ${t.value};`));
  const fonts = Object.entries(tokens.type.families).map(([k, v]) => `  --font-${k}: ${v};`);
  css += `:root {\n${[...statics, ...fonts].join("\n")}\n}\n`;
  css += POSTAMBLE;
  return css;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const css = generate(JSON.parse(readFileSync(SRC, "utf8")));
  if (process.argv.includes("--check")) {
    let cur = "";
    try { cur = readFileSync(OUT, "utf8"); } catch { /* missing */ }
    if (cur !== css) {
      console.error("src/ui/tokens.css 与 tokens.json 不一致：运行 node scripts/gen-tokens.mjs");
      process.exit(1);
    }
    console.log("tokens.css 与 tokens.json 一致");
  } else {
    writeFileSync(OUT, css);
    console.log(`已生成 ${OUT}`);
  }
}
