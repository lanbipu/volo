// Dynamic plate EMA：覆盖率门控冻结 + 画面变化自适应更新；候选/history 均为半分辨率 RGBA16F。
// HLSL/Unreal 移植：coverageTex 最粗级为 1x1；ping-pong 历史对应 persistent RDG external textures。
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var candidateTex: texture_2d<f32>;
@group(0) @binding(2) var historyTex: texture_2d<f32>;
@group(0) @binding(3) var coverageTex: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let candidate = textureSampleLevel(candidateTex, samp, uv, 0.0).rgb;
  let history = textureSampleLevel(historyTex, samp, uv, 0.0).rgb;
  let coverage = textureSampleLevel(coverageTex, samp, vec2f(0.5), 0.0).a;
  let relativeChange = distance(candidate, history) / (dot(abs(candidate), vec3f(0.3333)) + 0.05);
  // 逐像素渐变速率（对齐 ref）：运动像素立即跟随、稳定像素随变化量缓升 EMA。
  let movingRate = select(clamp(0.08 + relativeChange * 4.0, 0.08, 0.25), 1.0, relativeChange > 0.01);
  let rate = select(0.0, movingRate, coverage >= 0.08);
  return vec4f(mix(history, candidate, rate), 1.0);
}
