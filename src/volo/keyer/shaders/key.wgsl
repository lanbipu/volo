// 核心色差 key（Vlahos 系）+ plate 均衡化（IBK 系）。
// HLSL 移植：Params 即 cbuffer；plateMode==0 时 plateTex 绑白噪声占位不采样分支。
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
  // 均衡化参考：plate 模式用逐像素 plate 色差（打光不匀被除掉），否则用全局 keyColor
  var dRef = cdiff(P.keyColor, P.balance);
  if (P.plateMode > 0.5) { dRef = cdiff(textureSampleLevel(plateTex, samp, uv, 0.0).rgb, P.balance); }
  var a = 1.0 - clamp(dS / max(dRef, 1e-4), 0.0, 1.0);
  a = smoothstep(P.blackClip, P.whiteClip, a);   // 黑白位裁剪
  a = pow(a, P.softness);                        // 软度曲线
  return vec4f(a, 0.0, 0.0, 1.0);
}
