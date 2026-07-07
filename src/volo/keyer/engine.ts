import fullscreenWgsl from "./shaders/fullscreen.wgsl?raw";
import keyWgsl from "./shaders/key.wgsl?raw";
import compositeWgsl from "./shaders/composite.wgsl?raw";
import plateMaskWgsl from "./shaders/plate_mask.wgsl?raw";
import plateFillWgsl from "./shaders/plate_fill.wgsl?raw";
import edgePreWgsl from "./shaders/edge_pre.wgsl?raw";
import denoiseTemporalWgsl from "./shaders/denoise_temporal.wgsl?raw";
import denoiseSpatialWgsl from "./shaders/denoise_spatial.wgsl?raw";
import mattePostWgsl from "./shaders/matte_post.wgsl?raw";
import edgeExtendWgsl from "./shaders/edge_extend.wgsl?raw";
import despillWgsl from "./shaders/despill.wgsl?raw";
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
  private plateTex: GPUTexture;                 // 1×1 占位（plateMode=0 时绑定）
  private plateFull: GPUTexture | null = null;  // 加载 / 估计出的全幅 plate
  private paramBuf: GPUBuffer;
  private params: KeyerParams = cloneParams(DEFAULTS);
  private w = 0;
  private h = 0;
  private keyPass: Pass | null = null;
  private compositePass: Pass | null = null;
  private edgeHPass: Pass | null = null;     // qTexA → qTexB
  private edgeVPass: Pass | null = null;     // qTexB → qTexA（= coreTex）
  private despillPass: Pass | null = null;   // → fgTex（全分辨率 premult）
  private fgTex: GPUTexture | null = null;
  private qTexA: GPUTexture | null = null;
  private qTexB: GPUTexture | null = null;
  private dirHBuf: GPUBuffer | null = null;
  private dirVBuf: GPUBuffer | null = null;
  private spatialPipeline: GPURenderPipeline | null = null;
  private spatialBinds: GPUBindGroup[] = []; // [p] 读 hist[p]
  private hist: GPUTexture[] = [];           // 时域历史 ping-pong
  private mHist: GPUTexture[] = [];          // matte 历史 ping-pong
  private temporalPipeline: GPURenderPipeline | null = null;
  private temporalBinds: GPUBindGroup[] = []; // [p] 读 hist[1-p]
  private mattePostPipeline: GPURenderPipeline | null = null;
  private mattePostBinds: GPUBindGroup[] = [];
  private parity = 0;
  private dn: GPUTexture | null = null;
  private matteRaw: GPUTexture | null = null;
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

  makePipelineMRT(label: string, fragWgsl: string, fmts: GPUTextureFormat[]): GPURenderPipeline {
    return this.d.createRenderPipeline({
      label,
      layout: "auto",
      vertex: { module: this.d.createShaderModule({ code: fullscreenWgsl }), entryPoint: "vs" },
      fragment: {
        module: this.d.createShaderModule({ code: fragWgsl }),
        entryPoint: "fs",
        targets: fmts.map((format) => ({ format })),
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
    this.matteRaw = this.makeTex("r16float");
    this.mHist = [this.makeTex("r16float"), this.makeTex("r16float")];
    this.hist = [this.makeTex("rgba16float"), this.makeTex("rgba16float")];
    this.dn = this.makeTex("rgba16float");
    this.parity = 0;

    const keyPipeline = this.makePipeline("key", keyWgsl, "r16float");
    const compositePipeline = this.makePipeline("composite", compositeWgsl, this.fmt);
    const srcView = this.dn.createView();   // 下游一律吃降噪后的 dn
    const matteView = this.matteTex.createView();

    this.temporalPipeline = this.makePipeline("denoise_temporal", denoiseTemporalWgsl, "rgba16float");
    this.temporalBinds = [0, 1].map((par) => this.d.createBindGroup({
      layout: this.temporalPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.samp },
        { binding: 1, resource: this.srcTex!.createView() },
        { binding: 2, resource: this.hist[1 - par].createView() },
        { binding: 3, resource: { buffer: this.paramBuf } },
      ],
    }));
    this.spatialPipeline = this.makePipeline("denoise_spatial", denoiseSpatialWgsl, "rgba16float");
    this.spatialBinds = [0, 1].map((par) => this.d.createBindGroup({
      layout: this.spatialPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.samp },
        { binding: 1, resource: this.hist[par].createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    }));
    this.mattePostPipeline = this.makePipelineMRT("matte_post", mattePostWgsl, ["r16float", "r16float"]);
    this.mattePostBinds = [0, 1].map((par) => this.d.createBindGroup({
      layout: this.mattePostPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.samp },
        { binding: 1, resource: this.matteRaw!.createView() },
        { binding: 2, resource: this.mHist[1 - par].createView() },
        { binding: 3, resource: this.dn!.createView() },
        { binding: 4, resource: { buffer: this.paramBuf } },
      ],
    }));

    this.keyPass = {
      pipeline: keyPipeline,
      target: this.matteRaw,
      bindGroup: this.makeKeyBind(keyPipeline, srcView),
    };
    // Despill 链：edge_pre(内联 premult, 1/4 H) → edge V(coreTex=qTexB) → despill(全分辨率 fgTex)
    this.fgTex = this.makeTex("rgba16float");
    this.qTexA = this.makeTex("rgba16float", 0.25);
    this.qTexB = this.makeTex("rgba16float", 0.25);
    const qw = Math.max(1, (this.w * 0.25) | 0);
    const qh = Math.max(1, (this.h * 0.25) | 0);
    const dirBuf = (x: number, y: number) => {
      const b = this.d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.d.queue.writeBuffer(b, 0, new Float32Array([x, y, 0, 0]));
      return b;
    };
    this.dirHBuf?.destroy(); this.dirVBuf?.destroy();
    this.dirHBuf = dirBuf(1 / qw, 0);
    this.dirVBuf = dirBuf(0, 1 / qh);

    const edgePrePipeline = this.makePipeline("edge_pre", edgePreWgsl, "rgba16float");
    this.edgeHPass = {
      pipeline: edgePrePipeline,
      target: this.qTexA,
      bindGroup: this.d.createBindGroup({
        layout: edgePrePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samp },
          { binding: 1, resource: srcView },
          { binding: 2, resource: matteView },
          { binding: 3, resource: { buffer: this.dirHBuf } },
        ],
      }),
    };
    const edgePipeline = this.makePipeline("edge_extend", edgeExtendWgsl, "rgba16float");
    this.edgeVPass = {
      pipeline: edgePipeline,
      target: this.qTexB,
      bindGroup: this.d.createBindGroup({
        layout: edgePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samp },
          { binding: 1, resource: this.qTexA.createView() },
          { binding: 2, resource: { buffer: this.dirVBuf } },
        ],
      }),
    };
    const despillPipeline = this.makePipeline("despill", despillWgsl, "rgba16float");
    this.despillPass = {
      pipeline: despillPipeline,
      target: this.fgTex,
      bindGroup: this.d.createBindGroup({
        layout: despillPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samp },
          { binding: 1, resource: srcView },
          { binding: 2, resource: matteView },
          { binding: 3, resource: this.qTexB!.createView() },
          { binding: 4, resource: { buffer: this.paramBuf } },
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
          { binding: 3, resource: this.fgTex.createView() },
          { binding: 4, resource: { buffer: this.paramBuf } },
        ],
      }),
    };
    (this.ctx.canvas as HTMLCanvasElement).width = this.w;
    (this.ctx.canvas as HTMLCanvasElement).height = this.h;
  }

  private makeKeyBind(pipeline: GPURenderPipeline, srcView: GPUTextureView): GPUBindGroup {
    return this.d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.samp },
        { binding: 1, resource: srcView },
        { binding: 2, resource: (this.plateFull ?? this.plateTex).createView() },
        { binding: 3, resource: { buffer: this.paramBuf } },
      ],
    });
  }

  private rebindPlate(): void {
    if (this.keyPass && this.dn) {
      this.keyPass.bindGroup = this.makeKeyBind(this.keyPass.pipeline, this.dn.createView());
    }
  }

  private setPlateMode(mode: number): void {
    const next = cloneParams(this.params);
    next.plateMode = mode;
    this.setParams(next);
  }

  loadPlate(src: ImageBitmap): void {
    const tex = this.d.createTexture({
      label: "keyer plate (loaded)",
      size: [src.width, src.height],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.d.queue.copyExternalImageToTexture({ source: src }, { texture: tex }, [src.width, src.height]);
    this.plateFull?.destroy();
    this.plateFull = tex;
    this.rebindPlate();
    this.setPlateMode(1);
    this.renderOnce();
  }

  clearPlate(): void {
    this.plateFull?.destroy();
    this.plateFull = null;
    this.rebindPlate();
    this.setPlateMode(0);
    this.renderOnce();
  }

  hasPlate(): boolean {
    return !!this.plateFull;
  }

  /* pull-push：mask → 6 级 down（premult 双线性均值）→ 6 级 up 补洞 → 全幅 plate */
  estimatePlate(): void {
    if (!this.srcTex || this.w <= 0 || this.h <= 0) return;
    const LEVELS = 6;
    const maskPipeline = this.makePipeline("plate_mask", plateMaskWgsl, "rgba16float");
    const fillPipeline = this.makePipeline("plate_fill", plateFillWgsl, "rgba16float");
    const levelTex = (level: number, label: string) =>
      this.d.createTexture({
        label,
        size: [Math.max(1, this.w >> level), Math.max(1, this.h >> level)],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    const pyr: GPUTexture[] = [];
    const fill: GPUTexture[] = [];
    for (let i = 0; i <= LEVELS; i++) {
      pyr.push(levelTex(i, "plate pyr " + i));
      fill.push(levelTex(i, "plate fill " + i));
    }
    const modeBuf = (x: number) => {
      const b = this.d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.d.queue.writeBuffer(b, 0, new Float32Array([x, 0, 0, 0]));
      return b;
    };
    const downMode = modeBuf(0);
    const upMode = modeBuf(1);
    const enc = this.d.createCommandEncoder();
    const runPass = (
      pipeline: GPURenderPipeline,
      target: GPUTexture,
      entries: GPUBindGroupEntry[],
    ) => {
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      rp.setPipeline(pipeline);
      rp.setBindGroup(0, this.d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      rp.draw(3);
      rp.end();
    };
    // mask → pyr[0]（吃降噪后 dn，与 key 同源）
    runPass(maskPipeline, pyr[0], [
      { binding: 0, resource: this.samp },
      { binding: 1, resource: (this.dn ?? this.srcTex).createView() },
      { binding: 2, resource: { buffer: this.paramBuf } },
    ]);
    // down: pyr[i-1] → pyr[i]
    for (let i = 1; i <= LEVELS; i++) {
      runPass(fillPipeline, pyr[i], [
        { binding: 0, resource: this.samp },
        { binding: 1, resource: pyr[i - 1].createView() },
        { binding: 2, resource: pyr[i - 1].createView() },
        { binding: 3, resource: { buffer: downMode } },
      ]);
    }
    // 最粗一级补洞：fine = coarse = pyr[LEVELS]
    runPass(fillPipeline, fill[LEVELS], [
      { binding: 0, resource: this.samp },
      { binding: 1, resource: pyr[LEVELS].createView() },
      { binding: 2, resource: pyr[LEVELS].createView() },
      { binding: 3, resource: { buffer: upMode } },
    ]);
    // up: fill[i+1] + pyr[i] → fill[i]
    for (let i = LEVELS - 1; i >= 0; i--) {
      runPass(fillPipeline, fill[i], [
        { binding: 0, resource: this.samp },
        { binding: 1, resource: fill[i + 1].createView() },
        { binding: 2, resource: pyr[i].createView() },
        { binding: 3, resource: { buffer: upMode } },
      ]);
    }
    this.d.queue.submit([enc.finish()]);
    for (let i = 0; i <= LEVELS; i++) {
      pyr[i].destroy();
      if (i > 0) fill[i].destroy();
    }
    downMode.destroy();
    upMode.destroy();
    this.plateFull?.destroy();
    this.plateFull = fill[0];
    this.rebindPlate();
    this.setPlateMode(1);
    this.renderOnce();
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
    const run = (p: Pass) => {
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: p.target!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      rp.setPipeline(p.pipeline);
      rp.setBindGroup(0, p.bindGroup);
      rp.draw(3);
      rp.end();
    };
    const runMRT = (pipeline: GPURenderPipeline, bind: GPUBindGroup, targets: GPUTexture[]) => {
      const rp = enc.beginRenderPass({
        colorAttachments: targets.map((t) => ({
          view: t.createView(), loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        })),
      });
      rp.setPipeline(pipeline);
      rp.setBindGroup(0, bind);
      rp.draw(3);
      rp.end();
    };
    const SKIP = (globalThis as unknown as { KEYER_SKIP?: { dn?: boolean; post?: boolean; edge?: boolean } }).KEYER_SKIP ?? {};
    const par = this.parity;
    this.parity = 1 - this.parity;
    if (!SKIP.dn && this.temporalPipeline && this.spatialPipeline) {
      runMRT(this.temporalPipeline, this.temporalBinds[par], [this.hist[par]]);
      runMRT(this.spatialPipeline, this.spatialBinds[par], [this.dn!]);
    }
    run(this.keyPass);
    if (!SKIP.post && this.mattePostPipeline) {
      runMRT(this.mattePostPipeline, this.mattePostBinds[par], [this.matteTex!, this.mHist[par]]);
    }
    if (!SKIP.edge && this.edgeHPass && this.edgeVPass && this.despillPass) {
      run(this.edgeHPass);
      run(this.edgeVPass);
      run(this.despillPass);
    }

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

  /* 全幅 matte 回读（基准测试用）：r16float → Float32Array(0..1) */
  async readbackMatteFull(): Promise<{ data: Float32Array; w: number; h: number } | null> {
    if (!this.matteTex || this.w <= 0 || this.h <= 0) return null;
    const row = Math.ceil((this.w * 2) / 256) * 256;
    const buf = this.d.createBuffer({ size: row * this.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.matteTex }, { buffer: buf, bytesPerRow: row }, [this.w, this.h]);
    this.d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const u16 = new Uint16Array(buf.getMappedRange());
    const out = new Float32Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      const r = (y * row) / 2;
      for (let x = 0; x < this.w; x++) {
        const v = halfToFloat(u16[r + x]);
        out[y * this.w + x] = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
      }
    }
    buf.unmap(); buf.destroy();
    return { data: out, w: this.w, h: this.h };
  }

  /* 导出 straight-alpha PNG：fgTex(premult 线性) + matte 回读 → un-premultiply → sRGB 编码 */
  async exportPng(): Promise<Blob | null> {
    if (!this.fgTex || !this.matteTex || this.w <= 0 || this.h <= 0) return null;
    const align = (n: number) => Math.ceil(n / 256) * 256;
    const fgRow = align(this.w * 8);   // rgba16float
    const mRow = align(this.w * 2);    // r16float
    const fgBuf = this.d.createBuffer({ size: fgRow * this.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const mBuf = this.d.createBuffer({ size: mRow * this.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.fgTex }, { buffer: fgBuf, bytesPerRow: fgRow }, [this.w, this.h]);
    enc.copyTextureToBuffer({ texture: this.matteTex }, { buffer: mBuf, bytesPerRow: mRow }, [this.w, this.h]);
    this.d.queue.submit([enc.finish()]);
    await Promise.all([fgBuf.mapAsync(GPUMapMode.READ), mBuf.mapAsync(GPUMapMode.READ)]);
    const fg16 = new Uint16Array(fgBuf.getMappedRange());
    const m16 = new Uint16Array(mBuf.getMappedRange());
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    const linToSrgb = (x: number) => {
      const v = Math.max(0, Math.min(1, x));
      return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
    };
    for (let y = 0; y < this.h; y++) {
      const fr = (y * fgRow) / 2;
      const mr = (y * mRow) / 2;
      for (let x = 0; x < this.w; x++) {
        const a = Math.max(0, Math.min(1, halfToFloat(m16[mr + x])));
        const inv = a > 1e-4 ? 1 / a : 0;
        const o = (y * this.w + x) * 4;
        out[o] = linToSrgb(halfToFloat(fg16[fr + x * 4]) * inv);
        out[o + 1] = linToSrgb(halfToFloat(fg16[fr + x * 4 + 1]) * inv);
        out[o + 2] = linToSrgb(halfToFloat(fg16[fr + x * 4 + 2]) * inv);
        out[o + 3] = Math.round(a * 255);
      }
    }
    fgBuf.unmap(); fgBuf.destroy();
    mBuf.unmap(); mBuf.destroy();
    const cnv = document.createElement("canvas");
    cnv.width = this.w; cnv.height = this.h;
    const c2d = cnv.getContext("2d")!;
    c2d.putImageData(new ImageData(out, this.w, this.h), 0, 0);
    return new Promise((resolve) => cnv.toBlob(resolve, "image/png"));
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
