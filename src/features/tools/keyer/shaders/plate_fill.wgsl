// Clean plate 估计 · pull-push 补洞：down 轮 = 双线性一次采样（premult 即 alpha 加权均值）；
// up 轮 = 当级有效保留（un-premult），无效取更粗一级已补洞结果。
// HLSL 移植：mode 用 cbuffer 常量；两轮同一 shader 靠 mode.x 分支。
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var loTex: texture_2d<f32>;  // down 轮=上一级更高分辨率；up 轮=更粗一级已补洞
@group(0) @binding(2) var hiTex: texture_2d<f32>;  // 仅 up 轮读取：当级 down 结果（premult）
@group(0) @binding(3) var<uniform> mode: vec4f;    // x: 0=down 1=up
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (mode.x < 0.5) {
    // 双线性一次采样已等效 4-tap 均值（alpha 加权由预乘保证）
    return textureSampleLevel(loTex, samp, uv, 0.0);
  }
  let fine = textureSampleLevel(hiTex, samp, uv, 0.0);
  if (fine.a > 0.05) { return vec4f(fine.rgb / fine.a, 1.0); }
  let coarse = textureSampleLevel(loTex, samp, uv, 0.0);
  return vec4f(coarse.rgb, 1.0);
}
