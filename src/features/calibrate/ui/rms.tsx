// Volo · Calibrate —— rmsBadge helper（按 RMS 值着色）。移植自 page_calibrate.jsx rmsBadge()。
import { Badge } from "./Badge";

export function rmsBadge(rms: number | null) {
  if (rms == null)
    return (
      <Badge variant="neutral" size="S">
        n/a
      </Badge>
    );
  const v = rms < 3 ? "positive" : rms < 8 ? "notice" : "negative";
  return (
    <Badge variant={v} size="S">
      {rms.toFixed(2) + " mm"}
    </Badge>
  );
}
