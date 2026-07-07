/* MAD + Sobel 梯度误差。输入为同尺寸 Float32Array alpha（0..1）。 */
export function mad(a: Float32Array, gt: Float32Array): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - gt[i]);
  return s / a.length;
}
export function gradErr(a: Float32Array, gt: Float32Array, w: number, h: number): number {
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gxa = a[i + 1] - a[i - 1], gya = a[i + w] - a[i - w];
    const gxg = gt[i + 1] - gt[i - 1], gyg = gt[i + w] - gt[i - w];
    s += Math.hypot(gxa - gxg, gya - gyg); n++;
  }
  return n > 0 ? s / n : 0;
}
