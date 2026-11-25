// Matte v2：soft/core 双分支、可选 despot、固定 1px taps、motion-adaptive feather、TAA 邻域钳制。
// HLSL/Unreal 移植：rg16f matteRaw 的 r=soft/g=raw；9-tap 中值网络避免动态数组导致 Metal GPR 溢出。
struct Params {
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var matteRaw: texture_2d<f32>;
@group(0) @binding(2) var matteHist: texture_2d<f32>;
@group(0) @binding(3) var dnTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> P: Params;
fn mn2(a: ptr<function, f32>, b: ptr<function, f32>) {
  let lo = min(*a, *b); let hi = max(*a, *b); *a = lo; *b = hi;
}
fn hardClip(raw: f32) -> f32 {
  return clamp((raw - max(P.blackClip * 2.0, 0.03)) / max(0.72 - P.blackClip * 2.0, 1e-4), 0.0, 1.0);
}
struct FsOut { @location(0) m: vec4f, @location(1) hist: vec4f };
@fragment fn fs(@location(0) uv: vec2f) -> FsOut {
  let px = 1.0 / vec2f(textureDimensions(matteRaw));
  var v0 = textureSampleLevel(matteRaw, samp, uv + vec2f(-1.0, -1.0) * px, 0.0).r;
  var v1 = textureSampleLevel(matteRaw, samp, uv + vec2f( 0.0, -1.0) * px, 0.0).r;
  var v2 = textureSampleLevel(matteRaw, samp, uv + vec2f( 1.0, -1.0) * px, 0.0).r;
  var v3 = textureSampleLevel(matteRaw, samp, uv + vec2f(-1.0,  0.0) * px, 0.0).r;
  var v4 = textureSampleLevel(matteRaw, samp, uv, 0.0).r;
  var v5 = textureSampleLevel(matteRaw, samp, uv + vec2f( 1.0,  0.0) * px, 0.0).r;
  var v6 = textureSampleLevel(matteRaw, samp, uv + vec2f(-1.0,  1.0) * px, 0.0).r;
  var v7 = textureSampleLevel(matteRaw, samp, uv + vec2f( 0.0,  1.0) * px, 0.0).r;
  var v8 = textureSampleLevel(matteRaw, samp, uv + vec2f( 1.0,  1.0) * px, 0.0).r;
  let mn = min(min(min(min(v0, v1), min(v2, v3)), min(min(v4, v5), min(v6, v7))), v8);
  let mx = max(max(max(max(v0, v1), max(v2, v3)), max(max(v4, v5), max(v6, v7))), v8);
  let gaussian = (v0 + 2.0*v1 + v2 + 2.0*v3 + 4.0*v4 + 2.0*v5 + v6 + 2.0*v7 + v8) / 16.0;
  mn2(&v1, &v2); mn2(&v4, &v5); mn2(&v7, &v8);
  mn2(&v0, &v1); mn2(&v3, &v4); mn2(&v6, &v7);
  mn2(&v1, &v2); mn2(&v4, &v5); mn2(&v7, &v8);
  mn2(&v0, &v3); mn2(&v5, &v8); mn2(&v4, &v7);
  mn2(&v3, &v6); mn2(&v1, &v4); mn2(&v2, &v5);
  mn2(&v4, &v7); mn2(&v4, &v2); mn2(&v6, &v4); mn2(&v4, &v2);
  var soft = mix(textureSampleLevel(matteRaw, samp, uv, 0.0).r, v4, clamp(P._p0, 0.0, 1.0));
  let raw = textureSampleLevel(matteRaw, samp, uv, 0.0).g;
  let motion = textureSampleLevel(dnTex, samp, uv, 0.0).a;
  // 9-tap 十字+对角 raw min（对齐 ref min3(hardClip(raw))；hardClip 单调故 min 可提到内层）。
  let gL  = textureSampleLevel(matteRaw, samp, uv + vec2f(-1.0,  0.0) * px, 0.0).g;
  let gR  = textureSampleLevel(matteRaw, samp, uv + vec2f( 1.0,  0.0) * px, 0.0).g;
  let gU  = textureSampleLevel(matteRaw, samp, uv + vec2f( 0.0, -1.0) * px, 0.0).g;
  let gD  = textureSampleLevel(matteRaw, samp, uv + vec2f( 0.0,  1.0) * px, 0.0).g;
  let gUL = textureSampleLevel(matteRaw, samp, uv + vec2f(-1.0, -1.0) * px, 0.0).g;
  let gUR = textureSampleLevel(matteRaw, samp, uv + vec2f( 1.0, -1.0) * px, 0.0).g;
  let gDL = textureSampleLevel(matteRaw, samp, uv + vec2f(-1.0,  1.0) * px, 0.0).g;
  let gDR = textureSampleLevel(matteRaw, samp, uv + vec2f( 1.0,  1.0) * px, 0.0).g;
  let rawMin = min(min(min(min(raw, gL), min(gR, gU)), min(min(gD, gUL), min(gUR, gDL))), gDR);
  let core = hardClip(rawMin) * (1.0 - motion);
  var a = max(soft, core);
  a = select(a, mix(a, mn, clamp(P.shrink, 0.0, 3.0) / 3.0), P.shrink > 0.0);
  a = select(a, mix(a, mx, clamp(-P.shrink, 0.0, 3.0) / 3.0), P.shrink < 0.0);
  let feather = clamp(P.feather + motion * 0.75, 0.0, 1.5);
  a = mix(a, gaussian, feather * 0.5);
  let hist = textureSampleLevel(matteHist, samp, uv, 0.0).r;
  let histClamped = clamp(hist, mn, mx);
  a = mix(a, histClamped, P.matteStab * 0.65 * (1.0 - motion));
  var out: FsOut;
  out.m = vec4f(clamp(a, 0.0, 1.0), 0.0, 0.0, 1.0);
  out.hist = out.m;
  return out;
}
