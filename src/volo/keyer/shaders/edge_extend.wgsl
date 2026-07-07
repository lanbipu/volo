// 产出模糊的「核心前景色」：边缘像素用它借色度，对抗 4:2:2 色度糊与残余 spill。
// 1/4 分辨率、H/V 两轮可分离 9-tap 高斯（premultiplied 域，alpha 同步模糊）。
// HLSL 移植：dir 用 cbuffer 常量（xy=单像素 uv 步长）；权重数组 static const。
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var preTex: texture_2d<f32>;  // rgb=src*a, a=a（上一轮结果）
@group(0) @binding(2) var<uniform> dir: vec4f;       // xy = 单像素步长方向
const W = array<f32, 5>(0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var acc = textureSampleLevel(preTex, samp, uv, 0.0) * W[0];
  for (var i = 1; i < 5; i++) {
    let o = dir.xy * f32(i);
    acc += textureSampleLevel(preTex, samp, uv + o, 0.0) * W[i];
    acc += textureSampleLevel(preTex, samp, uv - o, 0.0) * W[i];
  }
  return acc;
}
