import { Heading, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

// Calibrate 占位页 —— 实质功能待 Claude Design 设计稿后实现。
export default function Calibrate() {
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
        校准
      </Heading>
      <Text>功能待 Claude Design 设计稿后实现</Text>
    </div>
  );
}
