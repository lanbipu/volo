// 视图输出：0=结果 1=matte 2=源 3=wipe 4=plate 5=raw matte（clip 前）。
// fgTex = despill 后 premultiplied 前景（Task 6 起）。
struct Params { /* 同 key.wgsl，共用同一 uniform buffer */
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var matteTex: texture_2d<f32>;
@group(0) @binding(3) var fgTex: texture_2d<f32>;    // premultiplied（Task 6 起为 despill 后）
@group(0) @binding(4) var plateTex: texture_2d<f32>;
@group(0) @binding(5) var matteRaw: texture_2d<f32>;
@group(0) @binding(6) var<uniform> P: Params;

fn checker(uv: vec2f) -> vec3f {
  let g = floor(uv * vec2f(48.0, 27.0));
  let k = 0.22 + 0.10 * f32((i32(g.x) + i32(g.y)) % 2);
  return vec3f(k);
}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let a = textureSampleLevel(matteTex, samp, uv, 0.0).r;
  let fg = textureSampleLevel(fgTex, samp, uv, 0.0).rgb;
  var outc: vec3f;
  if (P.viewMode < 0.5)      { outc = fg + checker(uv) * (1.0 - a); }
  else if (P.viewMode < 1.5) { outc = vec3f(a); }
  else if (P.viewMode < 2.5) { outc = src; }
  else if (P.viewMode < 3.5) { outc = select(fg + checker(uv) * (1.0 - a), src, uv.x < P.wipe); }
  else if (P.viewMode < 4.5) { outc = textureSampleLevel(plateTex, samp, uv, 0.0).rgb; }
  else { outc = vec3f(textureSampleLevel(matteRaw, samp, uv, 0.0).g); }
  return vec4f(outc, 1.0);
}
