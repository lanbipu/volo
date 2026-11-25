/* Chroma Keyer — WebGPU probe & device bootstrap.
   算法宿主层：WKWebView WebGPU（Windows WebView2 原生支持）。
   probe 失败即整卡降级提示（WebGL2 兜底属计划外修订，YAGNI）。 */

export interface GpuProbeOk {
  ok: true;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  adapterInfo: { vendor: string; architecture: string; description: string };
}
export interface GpuProbeFail { ok: false; reason: string; }
export type GpuProbeResult = GpuProbeOk | GpuProbeFail;

export async function probeWebGpu(canvas: HTMLCanvasElement): Promise<GpuProbeResult> {
  if (!("gpu" in navigator)) return { ok: false, reason: "navigator.gpu 不存在（WKWebView 未启用 WebGPU）" };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, reason: "requestAdapter() 返回 null" };
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) return { ok: false, reason: "canvas.getContext('webgpu') 返回 null" };
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const info = adapter.info ?? ({} as GPUAdapterInfo);
  return { ok: true, device, context, format,
    adapterInfo: { vendor: info.vendor ?? "?", architecture: info.architecture ?? "?", description: info.description ?? "?" } };
}
