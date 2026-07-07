// Despill：① g 超 R/B 混合上限部分按强度压回 ② 亮度中性回填防边缘发暗
// ③ 半透明带（a<0.9）色度向 1/4 分辨率模糊核心色靠拢、保 luma。premultiplied 输出。
// HLSL 移植：Params 即 cbuffer；smoothstep/max/mix 一一对应；coreTex 为低分辨率纹理双线性采样。
struct Params {
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var matteTex: texture_2d<f32>;
@group(0) @binding(3) var coreTex: texture_2d<f32>;  // 模糊核心前景（premult, 1/4 分辨率）
@group(0) @binding(4) var<uniform> P: Params;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let a = textureSampleLevel(matteTex, samp, uv, 0.0).r;
  // ① spill 抑制：g 超过 R/B 混合上限的部分按强度压回
  let lim = mix(c.r, c.b, P.despillBalance);
  let spill = max(c.g - lim, 0.0) * P.despillStrength;
  c.g -= spill;
  c += vec3f(spill * P.lumaRestore);            // ② 亮度补偿（中性回填，防边缘发暗）
  // ③ 边缘色度借色：半透明带（a<0.9）色度向模糊核心色靠拢，保 luma
  if (a < 0.9) {
    let core = textureSampleLevel(coreTex, samp, uv, 0.0);
    if (core.a > 1e-3) {
      let coreC = core.rgb / core.a;
      let l = luma(c);
      let borrowed = coreC * (l / max(luma(coreC), 1e-4));
      c = mix(borrowed, c, smoothstep(0.0, 0.9, a));
    }
  }
  return vec4f(c * a, a);                        // premultiplied 输出
}
