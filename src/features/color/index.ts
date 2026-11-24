/* features/color 对外入口（frontend-structure.md §2/§3）：其他模块只能 import 这里。
   页面 UI 待 Runyard handoff 后落地；业务逻辑按 §8 P2 从旧壳抽到 ./model。 */
export { default } from "./ui/ColorPage";
