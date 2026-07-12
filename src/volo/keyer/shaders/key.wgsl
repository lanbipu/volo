// Key v2：Vlahos 色差 + Clean-Plate-First 逐像素归一，输出 r=linear-clipped soft、g=raw alpha。
// HLSL/Unreal 移植：rg16f 对应 PF_G16R16F；Params 即 cbuffer；plate 可疑处回退 keyColor。
struct Params {
  keyColor: vec3f, balance: f32,
  blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32,
  wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;   // 降噪后前景（线性）
@group(0) @binding(2) var plateTex: texture_2d<f32>; // clean plate / 估计屏幕模型
@group(0) @binding(3) var<uniform> P: Params;

fn cdiff(c: vec3f, balance: f32) -> f32 {   // 色差：绿主导度
  return c.g - mix(c.r, c.b, balance);
}

@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let dS = cdiff(src, P.balance);
  let dKey = cdiff(P.keyColor, P.balance);
  var dRef = dKey;
  if (P.plateMode > 0.5) {
    let dPlate = cdiff(textureSampleLevel(plateTex, samp, uv, 0.0).rgb, P.balance);
    let confidence = clamp((dPlate - 0.15 * dKey) / max(0.35 * dKey, 1e-4), 0.0, 1.0);
    dRef = mix(dKey, dPlate, confidence);
  }
  let raw = 1.0 - clamp(dS / max(dRef, 1e-4), 0.0, 1.0);
  var soft = clamp((raw - P.blackClip) / max(P.whiteClip - P.blackClip, 1e-4), 0.0, 1.0);
  soft = pow(soft, P.softness);                  // softness 仅作 gamma，不再改变 clip 线性度
  return vec4f(soft, raw, 0.0, 1.0);
}
