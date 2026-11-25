/* Keyer v2 objective metrics. Inputs use row-major Float32Array values in 0..1. */

function assertSameLength(a: Float32Array, b: Float32Array, label: string): void {
  if (a.length !== b.length) throw new Error(`${label}: size mismatch ${a.length} != ${b.length}`);
}

export function mad(a: Float32Array, gt: Float32Array): number {
  assertSameLength(a, gt, "mad");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - gt[i]);
  return sum / Math.max(1, a.length);
}

export function gradErr(a: Float32Array, gt: Float32Array, w: number, h: number): number {
  assertSameLength(a, gt, "gradErr");
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gxa = a[i + 1] - a[i - 1];
      const gya = a[i + w] - a[i - w];
      const gxg = gt[i + 1] - gt[i - 1];
      const gyg = gt[i + w] - gt[i - w];
      sum += Math.hypot(gxa - gxg, gya - gyg);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Alpha SAD restricted to a 3x3-dilated GT edge/fractional-alpha band. */
export function edgeBandSad(a: Float32Array, gt: Float32Array, w: number, h: number): number {
  assertSameLength(a, gt, "edgeBandSad");
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let lo = 1;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = gt[i + dy * w + dx];
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if ((gt[i] > 1 / 255 && gt[i] < 254 / 255) || hi - lo > 1 / 255) {
        sum += Math.abs(a[i] - gt[i]);
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Mean false alpha in pixels whose GT is fully background. */
export function backgroundResidue(a: Float32Array, gt: Float32Array): number {
  assertSameLength(a, gt, "backgroundResidue");
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (gt[i] <= 1 / 255) {
      sum += Math.max(0, a[i]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Mean missing alpha in pixels whose GT is fully opaque foreground. */
export function coreLeakage(a: Float32Array, gt: Float32Array): number {
  assertSameLength(a, gt, "coreLeakage");
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (gt[i] >= 254 / 255) {
      sum += Math.max(0, 1 - a[i]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Mean absolute premultiplied foreground RGB error in scene-linear light. */
export function foregroundError(fg: Float32Array, gtFg: Float32Array): number {
  assertSameLength(fg, gtFg, "foregroundError");
  let sum = 0;
  for (let i = 0; i < fg.length; i++) sum += Math.abs(fg[i] - gtFg[i]);
  return sum / Math.max(1, fg.length);
}

/** Error in frame-to-frame alpha change, so intentional subject motion is not counted as flicker. */
export function alphaFlicker(pred: Float32Array[], gt: Float32Array[]): number {
  if (pred.length < 2 || pred.length !== gt.length) return 0;
  let sum = 0;
  let count = 0;
  for (let frame = 1; frame < pred.length; frame++) {
    assertSameLength(pred[frame], pred[frame - 1], "alphaFlicker pred");
    assertSameLength(gt[frame], gt[frame - 1], "alphaFlicker gt");
    for (let i = 0; i < pred[frame].length; i++) {
      const dp = pred[frame][i] - pred[frame - 1][i];
      const dg = gt[frame][i] - gt[frame - 1][i];
      sum += Math.abs(dp - dg);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}
