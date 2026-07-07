import fullscreenWgsl from "./shaders/fullscreen.wgsl?raw";
import blitWgsl from "./shaders/blit.wgsl?raw";
import type { GpuProbeOk } from "./gpu";

interface Pass {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup | null;
  target: GPUTexture | null;
}

export class KeyerEngine {
  private d: GPUDevice;
  private ctx: GPUCanvasContext;
  private fmt: GPUTextureFormat;
  private samp: GPUSampler;
  private srcTex: GPUTexture | null = null;
  private w = 0;
  private h = 0;
  private blit: Pass | null = null;

  constructor(gpu: GpuProbeOk) {
    this.d = gpu.device;
    this.ctx = gpu.context;
    this.fmt = gpu.format;
    this.samp = this.d.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  makePipeline(label: string, fragWgsl: string, targetFmt: GPUTextureFormat): GPURenderPipeline {
    return this.d.createRenderPipeline({
      label,
      layout: "auto",
      vertex: { module: this.d.createShaderModule({ code: fullscreenWgsl }), entryPoint: "vs" },
      fragment: {
        module: this.d.createShaderModule({ code: fragWgsl }),
        entryPoint: "fs",
        targets: [{ format: targetFmt }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  makeTex(fmt: GPUTextureFormat, scale = 1): GPUTexture {
    return this.d.createTexture({
      size: [Math.max(1, (this.w * scale) | 0), Math.max(1, (this.h * scale) | 0)],
      format: fmt,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }

  resize(w: number, h: number): void {
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.allocate();
    }
  }

  loadImage(src: ImageBitmap | HTMLVideoElement): void {
    const w = "videoWidth" in src ? src.videoWidth : src.width;
    const h = "videoHeight" in src ? src.videoHeight : src.height;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.allocate();
    }
    this.d.queue.copyExternalImageToTexture({ source: src }, { texture: this.srcTex! }, [w, h]);
  }

  private allocate(): void {
    this.srcTex = this.d.createTexture({
      size: [this.w, this.h],
      format: "rgba8unorm-srgb",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const p = this.makePipeline("blit", blitWgsl, this.fmt);
    this.blit = {
      pipeline: p,
      target: null,
      bindGroup: this.d.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samp },
          { binding: 1, resource: this.srcTex.createView() },
        ],
      }),
    };
    (this.ctx.canvas as HTMLCanvasElement).width = this.w;
    (this.ctx.canvas as HTMLCanvasElement).height = this.h;
  }

  renderOnce(): void {
    if (!this.blit) return;
    const enc = this.d.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    rp.setPipeline(this.blit.pipeline);
    rp.setBindGroup(0, this.blit.bindGroup);
    rp.draw(3);
    rp.end();
    this.d.queue.submit([enc.finish()]);
  }

  async readbackPixel(x: number, y: number): Promise<[number, number, number, number]> {
    const buf = this.d.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.d.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.srcTex!, origin: [x, y] },
      { buffer: buf, bytesPerRow: 256 },
      [1, 1],
    );
    this.d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buf.getMappedRange().slice(0, 4));
    buf.unmap();
    buf.destroy();
    return [px[0], px[1], px[2], px[3]];
  }
}
