// Clean plate 估计 · 第一步：绿主导像素通过（premult by 有效性），前景像素置 0。
// HLSL 移植：Params 即 cbuffer（同 key.wgsl 布局）；step→step，无分支差异。
struct Params {
  keyColor: vec3f, balance: f32,
  blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32,
  wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let d = c.g - mix(c.r, c.b, P.balance);
  let valid = step(0.5 * (P.keyColor.g - mix(P.keyColor.r, P.keyColor.b, P.balance)), d);
  return vec4f(c * valid, valid);
}
