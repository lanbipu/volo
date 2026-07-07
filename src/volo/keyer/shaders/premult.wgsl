// 预乘：rgb = src×matte, a = matte（edge_extend / despill 借色的输入）。
// HLSL 移植：单纯逐像素乘，无坐标系差异。
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var matteTex: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let a = textureSampleLevel(matteTex, samp, uv, 0.0).r;
  return vec4f(c * a, a);
}
