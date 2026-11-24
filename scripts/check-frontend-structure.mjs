#!/usr/bin/env node
// 前端结构守卫（docs/architecture/frontend-structure.md §8 P0），ESLint / stylelint 管不到的几条：
//   1. 旧壳 src/volo 冻结：不得新增文件（只允许删除 / 修改）。基线见 scripts/frontend/legacy-volo-files.txt。
//   2. 旧壳之外任何 TS/TSX 不得出现 @ts-nocheck。
//   3. features/ app/ windows/ 下的 CSS 必须是 *.module.css（页面样式要作用域隔离）。
//   4. 旧壳之外不得新增 CSS 层叠皮肤（全局 CSS 只允许 ui/ 下）。
// 用法：node scripts/check-frontend-structure.mjs      （退出码非 0 = 违规）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(rel(p));
  }
  return out;
}

const errors = [];
const all = walk(join(ROOT, "src"));

// 1
const baseline = new Set(
  readFileSync(join(ROOT, "scripts/frontend/legacy-volo-files.txt"), "utf8").split("\n").filter(Boolean),
);
for (const f of all.filter((f) => f.startsWith("src/volo/"))) {
  if (!baseline.has(f)) errors.push(`${f}: 旧壳 src/volo 已冻结，不得新增文件；新代码放 src/{app,ui,features,windows,lib}`);
}

// 2
for (const f of all.filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("src/volo/"))) {
  if (/@ts-nocheck/.test(readFileSync(join(ROOT, f), "utf8"))) errors.push(`${f}: 不得使用 @ts-nocheck`);
}

// 3 / 4
for (const f of all.filter((f) => f.endsWith(".css") && !f.startsWith("src/volo/"))) {
  if (/^src\/(features|app|windows)\//.test(f) && !f.endsWith(".module.css")) {
    errors.push(`${f}: 页面 / 外壳样式必须是 *.module.css`);
  } else if (!/^src\/(ui|features|app|windows)\//.test(f)) {
    errors.push(`${f}: 全局 CSS 只能放在 src/ui/（token + ry- 组件），不要再加皮肤层`);
  }
}

if (errors.length) {
  console.error(`前端结构检查失败（${errors.length}）：\n` + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("前端结构检查通过");
