// ESLint：只管新结构（docs/architecture/frontend-structure.md §3 / §8 P0）。
// 旧壳 src/volo 冻结、逐页删除，不纳入检查；但禁止在其中新增文件（见 scripts/check-frontend-structure.mjs）。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const NEW_CODE = ["src/app/**", "src/ui/**", "src/features/**", "src/windows/**", "src/lib/**"];

/** 所有新代码共用的禁令 */
const baseRules = {
  // 不写 @ts-nocheck / @ts-ignore；确需时用 @ts-expect-error 并写原因
  "@typescript-eslint/ban-ts-comment": [
    "error",
    { "ts-nocheck": true, "ts-ignore": true, "ts-expect-error": "allow-with-description", minimumDescriptionLength: 6 },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  // 不往 window 上挂东西（旧壳的 window.VOLO_* 注册表模式）
  "no-restricted-syntax": [
    "error",
    {
      selector: "AssignmentExpression[left.type='MemberExpression'][left.object.name='window']",
      message: "不要往 window 上挂全局；用模块导出 / store。",
    },
    {
      selector: "AssignmentExpression > MemberExpression.left > :matches(TSAsExpression, TSNonNullExpression) Identifier[name=/^(window|globalThis)$/]",
      message: "不要往 window 上挂全局；用模块导出 / store。",
    },
    {
      selector: "AssignmentExpression[left.type='MemberExpression'][left.object.name='globalThis']",
      message: "不要往 globalThis 上挂全局；用模块导出 / store。",
    },
    {
      selector: "CallExpression[callee.object.name='Object'][callee.property.name='assign'][arguments.0.object.name='window']",
      message: "不要往 window.* 注册表上叠加；用模块导出 / store。",
    },
    {
      selector: "CallExpression[callee.object.name='Object'][callee.property.name='assign'][arguments.0.name='window']",
      message: "不要往 window 上挂全局；用模块导出 / store。",
    },
  ],
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "@tauri-apps/api/core", message: "invoke 只能在 api/ 里用；调用 @/api 的有类型函数。" },
        { name: "@tauri-apps/api/event", message: "listen 只能在 api/ 或 lib/events 里用。" },
      ],
      patterns: [
        { group: ["**/volo/**", "@/volo/**"], message: "新代码不得依赖旧壳 src/volo（api 走 @/api）。" },
        { group: ["@/features/*/*", "@/features/*/*/**"], message: "跨 feature 只能 import 对方的 index（@/features/<域>）。" },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "target/**", "sidecars/**", "src/volo/**", "src/stage/**", "src/main.tsx"] },
  {
    files: NEW_CODE.map((g) => `${g}/*.{ts,tsx}`),
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...baseRules,
    },
  },
  // ui/：纯展示层，不碰业务与后端
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: baseRules["no-restricted-imports"][1].paths,
          patterns: [
            ...baseRules["no-restricted-imports"][1].patterns,
            { group: ["@/api", "@/api/**", "@/features", "@/features/**", "@/app", "@/app/**"], message: "ui/ 只收 props，不依赖 api / features / app。" },
          ],
        },
      ],
    },
  },
  // lib/events.ts：Tauri 事件桥，唯一允许直接 listen 的地方（除 api/ 外）
  {
    files: ["src/lib/events.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: baseRules["no-restricted-imports"][1].paths.filter((p) => p.name !== "@tauri-apps/api/event"), patterns: baseRules["no-restricted-imports"][1].patterns },
      ],
    },
  },
);
