# Volo — Claude Design 设计系统（基于 React Spectrum）

> 在 Claude Design 建组织设计系统，视觉来源 = **Adobe React Spectrum**。✅ 已建（用户完成）。
> 历史：曾走自建冷蓝克制系统、复刻 DaVinci Resolve（均已弃）。现统一用 React Spectrum 视觉。

---

## A. 这个 design system 是什么

- **视觉来源**：Adobe React Spectrum 的设计语言（配色 / 间距 / 圆角 / 字体 / 组件外观）。
- **用途**：所有页在 Claude Design 里设计 / 迭代时继承这套 Spectrum 视觉，产出风格统一的设计稿。
- **闭环优势**：最终代码也用 `@react-spectrum/s2`，设计稿与实现栈一致，handoff 顺。

## B. 怎么用（逐页设计流程）

1. 在继承该 system 的项目里逐页设计 UI；外壳 + Cache / Calibrate 主画布先做实，其余 4 页占位。
2. **功能输入** = `WIREFRAMES.md`：把对应页内容（有哪些区 / 字段 / 按钮 / 交互）喂进去，让 Claude Design 用 Spectrum 视觉排版。
3. inline 微调 + chat 改结构，迭代到细节满意。
4. 设计稿确认 → handoff 给 Claude Code，用真 `@react-spectrum/s2` 组件实现（见 `UX-PLAN.md §9`）。

## C. 注意

- Claude Design 产出是"长得像 Spectrum"的设计稿，不一定是能跑的真 Spectrum 代码；handoff 时 Claude Code 照设计稿用真组件实现。
- `WIREFRAMES.md` 是**临时功能稿**，会在设计中大量调整；以迭代后的设计稿为准。
- 暗 / 亮双主题；中文 fallback 思源黑体（Spectrum 字体无 CJK）。

---

> External Inputs：Adobe React Spectrum 作为 Claude Design system 的视觉来源（用户已建）；中文 fallback 思源黑体。
