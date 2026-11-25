// edge_extend 水平轮（premult 内联版）：直接采样 dn×matte 预乘，省独立 premult pass。
// 1/4 分辨率 9-tap 高斯 H。HLSL 移植：同 edge_extend；两纹理各 9 tap。
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;   // dn（全分辨率，双线性降采样）
@group(0) @binding(2) var matteTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> dir: vec4f;       // xy = 单像素步长方向
const W = array<f32, 5>(0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
fn tapPre(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let a = textureSampleLevel(matteTex, samp, uv, 0.0).r;
  return vec4f(c * a, a);
}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var acc = tapPre(uv) * W[0];
  for (var i = 1; i < 5; i++) {
    let o = dir.xy * f32(i);
    acc += tapPre(uv + o) * W[i];
    acc += tapPre(uv - o) * W[i];
  }
  return acc;
}
