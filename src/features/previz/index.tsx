import { Heading, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

// Pre-viz 占位页 —— 实质功能待 Claude Design 设计稿后实现。
export default function Previz() {
  return (
    <div
      className={style({
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      })}
    >
      <Heading level={2} styles={style({ font: "heading-lg" })}>
        预演
      </Heading>
      <Text>功能待 Claude Design 设计稿后实现</Text>
    </div>
  );
}
