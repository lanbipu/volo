// Despill v2：Clean Plate premult un-mix + residual spill suppression；彻底移除低分辨率 core 借色。
// HLSL/Unreal 移植：小 alpha 不做 un-premultiply；alpha=0 必须显式清零，避免 plate 残差漏彩渣。
struct Params {
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var matteTex: texture_2d<f32>;
@group(0) @binding(3) var plateTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> P: Params;
fn cdiff(c: vec3f) -> f32 { return c.g - mix(c.r, c.b, P.balance); }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let a = textureSampleLevel(matteTex, samp, uv, 0.0).r;
  var background = P.keyColor;
  if (P.plateMode > 0.5) {
    let plate = textureSampleLevel(plateTex, samp, uv, 0.0).rgb;
    let dKey = cdiff(P.keyColor);
    let confidence = clamp((cdiff(plate) - 0.15 * dKey) / max(0.35 * dKey, 1e-4), 0.0, 1.0);
    background = mix(P.keyColor, plate, confidence);
  }
  let transmission = min(1.0 - a, src.g / max(background.g, 1e-4));
  var fgPre = max(src - transmission * background, vec3f(0.0));
  fgPre *= step(1e-4, a);                         // 必修 alpha=0 门
  let limit = mix(fgPre.r, fgPre.b, P.despillBalance);
  let spill = max(fgPre.g - limit, 0.0) * P.despillStrength;
  fgPre.g -= spill;
  fgPre += vec3f(spill * P.lumaRestore);
  return vec4f(max(fgPre, vec3f(0.0)), a);
}
