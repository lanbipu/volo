// 运动自适应时域 EMA：静区深度积分（降传感器噪声），动区立即放行（防拖影）。
// a 通道带出 motion 度量（matte_post 复用）。
// HLSL 移植：histTex 在 UE RDG 对应上一帧持久 RT（RegisterExternalTexture）；Params 即 cbuffer。
struct Params {
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var curTex: texture_2d<f32>;
@group(0) @binding(2) var histTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> P: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cur = textureSampleLevel(curTex, samp, uv, 0.0).rgb;
  let hist = textureSampleLevel(histTex, samp, uv, 0.0).rgb;
  let motion = smoothstep(0.015, 0.10, distance(cur, hist));
  let blend = max(1.0 - P.denoise * 0.9, motion);   // denoise=0 → 直通
  let outc = mix(hist, cur, blend);
  return vec4f(outc, motion);   // a 通道带出 motion（写入 hist[par]，下一帧作历史）
}
