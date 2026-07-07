// 空域降噪：YCoCg 域，Co/Cg 走 3×3 range-bilateral（σ=0.08×denoise），Y 与 a(motion) 直通。
// 色度噪声是 matte 噪的主凶，亮度细节（发丝）不动。
// HLSL 移植：textureDimensions→纹理尺寸 cbuffer 传入或 GetDimensions；循环可展开。
struct Params {
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: Params;
fn toYCoCg(c: vec3f) -> vec3f { return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), c.r - c.b, dot(c, vec3f(-0.25, 0.5, -0.25))); }
// 逆变换（Y=.25r+.5g+.25b, Co=r-b, Cg=-.25r+.5g-.25b）：r=Y+Co/2-Cg, g=Y+Cg, b=Y-Co/2-Cg
fn toRGB(y: vec3f) -> vec3f { return vec3f(y.x + y.y * 0.5 - y.z, y.x + y.z, y.x - y.y * 0.5 - y.z); }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(srcTex));
  let c0 = textureSampleLevel(srcTex, samp, uv, 0.0);
  let y0 = toYCoCg(c0.rgb);
  var acc = vec2f(0.0); var wsum = 0.0;
  let sigma = 0.08 * max(P.denoise, 1e-3);
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    let yi = toYCoCg(textureSampleLevel(srcTex, samp, uv + vec2f(f32(dx), f32(dy)) * px, 0.0).rgb);
    let d2 = dot(yi.yz - y0.yz, yi.yz - y0.yz);
    let w = 1.0 / (1.0 + d2 / (2.0 * sigma * sigma));   // exp 的有理近似（省超越函数）
    acc += yi.yz * w; wsum += w;
  }}
  let chroma = mix(y0.yz, acc / wsum, step(0.01, P.denoise));
  return vec4f(toRGB(vec3f(y0.x, chroma)), c0.a);
}
