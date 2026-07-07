import fullscreenWgsl from "./shaders/fullscreen.wgsl?raw";
import keyWgsl from "./shaders/key.wgsl?raw";
import compositeWgsl from "./shaders/composite.wgsl?raw";
import type { GpuProbeOk } from "./gpu";
import { DEFAULTS, packParams, type KeyerParams } from "./params";

interface Pass {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup | null;
  target: GPUTexture | null;
}

function cloneParams(p: KeyerParams): KeyerParams {
  return { ...p, keyColor: [p.keyColor[0], p.keyColor[1], p.keyColor[2]] };
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v | 0));
}

function srgbByteToLinear(v: number): number {
  return Math.pow(((v / 255) + 0.055) / 1.055, 2.4);
}

function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

export class KeyerEngine {
  private d: GPUDevice;
  private ctx: GPUCanvasContext;
  private fmt: GPUTextureFormat;
  private samp: GPUSampler;
  private srcTex: GPUTexture | null = null;
  private matteTex: GPUTexture | null = null;
  private plateTex: GPUTexture;
  private paramBuf: GPUBuffer;
  private params: KeyerParams = cloneParams(DEFAULTS);
  private w = 0;
  private h = 0;
  private keyPass: Pass | null = null;
  private compositePass: Pass | null = null;
  private frameMs = 0;
  private lastT = 0;

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
    this.paramBuf = this.d.createBuffer({
      label: "keyer params uniform",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.plateTex = this.d.createTexture({
      label: "keyer 1x1 plate placeholder",
      size: [1, 1],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.d.queue.writeTexture(
      { texture: this.plateTex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.setParams(DEFAULTS);
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
    if (w !== this.w || h !== this.h || !this.srcTex) {
      this.w = w;
      this.h = h;
      this.allocate();
    }
  }

  loadImage(src: ImageBitmap | HTMLVideoElement): void {
    const w = "videoWidth" in src ? src.videoWidth : src.width;
    const h = "videoHeight" in src ? src.videoHeight : src.height;
    if (w !== this.w || h !== this.h || !this.srcTex) {
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
    this.matteTex = this.makeTex("r16float");

    const keyPipeline = this.makePipeline("key", keyWgsl, "r16float");
    const compositePipeline = this.makePipeline("composite", compositeWgsl, this.fmt);
    const srcView = this.srcTex.createView();
    const matteView = this.matteTex.createView();

    this.keyPass = {
      pipeline: keyPipeline,
      target: this.matteTex,
      bindGroup: this.d.createBindGroup({
        layout: keyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samp },
          { binding: 1, resource: srcView },
          { binding: 2, resource: this.plateTex.createView() },
          { binding: 3, resource: { buffer: this.paramBuf } },
        ],
      }),
    };
    this.compositePass = {
      pipeline: compositePipeline,
      target: null,
      bindGroup: this.d.createBindGroup({
        layout: compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samp },
          { binding: 1, resource: srcView },
          { binding: 2, resource: matteView },
          { binding: 3, resource: srcView },
          { binding: 4, resource: { buffer: this.paramBuf } },
        ],
      }),
    };
    (this.ctx.canvas as HTMLCanvasElement).width = this.w;
    (this.ctx.canvas as HTMLCanvasElement).height = this.h;
  }

  setParams(p: KeyerParams): void {
    this.params = cloneParams(p);
    this.d.queue.writeBuffer(this.paramBuf, 0, packParams(this.params));
  }

  getParams(): KeyerParams {
    return cloneParams(this.params);
  }

  stats(): { fps: number; frameMs: number } {
    return { fps: this.frameMs > 0 ? 1000 / this.frameMs : 0, frameMs: this.frameMs };
  }

  renderOnce(): void {
    if (!this.keyPass || !this.compositePass || !this.matteTex) return;
    const now = performance.now();
    if (this.lastT > 0) {
      const dt = now - this.lastT;
      this.frameMs = this.frameMs === 0 ? dt : this.frameMs + 0.1 * (dt - this.frameMs); // EMA α=0.1
    }
    this.lastT = now;
    const enc = this.d.createCommandEncoder();
    const keyRp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.matteTex.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    keyRp.setPipeline(this.keyPass.pipeline);
    keyRp.setBindGroup(0, this.keyPass.bindGroup);
    keyRp.draw(3);
    keyRp.end();

    const compositeRp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    compositeRp.setPipeline(this.compositePass.pipeline);
    compositeRp.setBindGroup(0, this.compositePass.bindGroup);
    compositeRp.draw(3);
    compositeRp.end();
    this.d.queue.submit([enc.finish()]);
  }

  async readbackPixel(x: number, y: number): Promise<[number, number, number, number]> {
    if (!this.srcTex) return [0, 0, 0, 0];
    const ox = clampInt(x, 0, Math.max(0, this.w - 1));
    const oy = clampInt(y, 0, Math.max(0, this.h - 1));
    const buf = this.d.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.d.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.srcTex, origin: [ox, oy] },
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

  async readbackMatte(x: number, y: number): Promise<number> {
    if (!this.matteTex) return 0;
    const ox = clampInt(x, 0, Math.max(0, this.w - 1));
    const oy = clampInt(y, 0, Math.max(0, this.h - 1));
    const buf = this.d.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.d.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.matteTex, origin: [ox, oy] },
      { buffer: buf, bytesPerRow: 256 },
      [1, 1],
    );
    this.d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buf.getMappedRange());
    const half = bytes[0] | (bytes[1] << 8);
    const v = halfToFloat(half);
    buf.unmap();
    buf.destroy();
    return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  async sampleKeyColor(u: number, v: number): Promise<void> {
    if (!this.srcTex || this.w <= 0 || this.h <= 0) return;
    const regionW = Math.min(3, this.w);
    const regionH = Math.min(3, this.h);
    const cx = clampInt(Math.round(u * (this.w - 1)), 0, this.w - 1);
    const cy = clampInt(Math.round(v * (this.h - 1)), 0, this.h - 1);
    const ox = regionW === 3 ? clampInt(cx - 1, 0, this.w - 3) : 0;
    const oy = regionH === 3 ? clampInt(cy - 1, 0, this.h - 3) : 0;
    const bytesPerRow = 256;
    const buf = this.d.createBuffer({
      size: bytesPerRow * regionH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.d.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.srcTex, origin: [ox, oy] },
      { buffer: buf, bytesPerRow, rowsPerImage: regionH },
      [regionW, regionH],
    );
    this.d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buf.getMappedRange());
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let yy = 0; yy < regionH; yy++) {
      for (let xx = 0; xx < regionW; xx++) {
        const i = yy * bytesPerRow + xx * 4;
        r += srgbByteToLinear(bytes[i]);
        g += srgbByteToLinear(bytes[i + 1]);
        b += srgbByteToLinear(bytes[i + 2]);
        count++;
      }
    }
    buf.unmap();
    buf.destroy();
    const next = cloneParams(this.params);
    next.keyColor = [r / count, g / count, b / count];
    this.setParams(next);
  }
}
