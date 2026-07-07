// matte 后处理：3×3 中值 despot + 收缩/羽化（min/max/blur 插值近似）+ 运动自适应时域稳定。
// HLSL 移植：数组插入排序照搬；matteHist 为上一帧持久 RT；r16f target 只取 r 分量。
struct Params {
  keyColor: vec3f, balance: f32, blackClip: f32, whiteClip: f32, softness: f32, shrink: f32,
  feather: f32, despillStrength: f32, despillBalance: f32, lumaRestore: f32,
  denoise: f32, matteStab: f32, plateMode: f32, viewMode: f32, wipe: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var matteTex: texture_2d<f32>;
@group(0) @binding(2) var matteHist: texture_2d<f32>;
@group(0) @binding(3) var dnTex: texture_2d<f32>;   // a=motion
@group(0) @binding(4) var<uniform> P: Params;
fn mn2(a: ptr<function, f32>, b: ptr<function, f32>) {
  let lo = min(*a, *b); let hi = max(*a, *b); *a = lo; *b = hi;
}
struct FsOut { @location(0) m: vec4f, @location(1) hist: vec4f };
@fragment fn fs(@location(0) uv: vec2f) -> FsOut {
  let px = 1.0 / vec2f(textureDimensions(matteTex));
  let st = px * max(P.feather, 1.0);
  var v0 = textureSampleLevel(matteTex, samp, uv + vec2f(-1.0, -1.0) * st, 0.0).r;
  var v1 = textureSampleLevel(matteTex, samp, uv + vec2f( 0.0, -1.0) * st, 0.0).r;
  var v2 = textureSampleLevel(matteTex, samp, uv + vec2f( 1.0, -1.0) * st, 0.0).r;
  var v3 = textureSampleLevel(matteTex, samp, uv + vec2f(-1.0,  0.0) * st, 0.0).r;
  var v4 = textureSampleLevel(matteTex, samp, uv, 0.0).r;
  var v5 = textureSampleLevel(matteTex, samp, uv + vec2f( 1.0,  0.0) * st, 0.0).r;
  var v6 = textureSampleLevel(matteTex, samp, uv + vec2f(-1.0,  1.0) * st, 0.0).r;
  var v7 = textureSampleLevel(matteTex, samp, uv + vec2f( 0.0,  1.0) * st, 0.0).r;
  var v8 = textureSampleLevel(matteTex, samp, uv + vec2f( 1.0,  1.0) * st, 0.0).r;
  let mn = min(min(min(min(v0, v1), min(v2, v3)), min(min(v4, v5), min(v6, v7))), v8);
  let mx = max(max(max(max(v0, v1), max(v2, v3)), max(max(v4, v5), max(v6, v7))), v8);
  let blur = (v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8) / 9.0;
  // despot：3x3 中值（min/max 排序网络，无数组无循环——动态下标数组在 Metal 上寄存器溢出）
  mn2(&v1, &v2); mn2(&v4, &v5); mn2(&v7, &v8);
  mn2(&v0, &v1); mn2(&v3, &v4); mn2(&v6, &v7);
  mn2(&v1, &v2); mn2(&v4, &v5); mn2(&v7, &v8);
  mn2(&v0, &v3); mn2(&v5, &v8); mn2(&v4, &v7);
  mn2(&v3, &v6); mn2(&v1, &v4); mn2(&v2, &v5);
  mn2(&v4, &v7); mn2(&v4, &v2); mn2(&v6, &v4);
  mn2(&v4, &v2);
  var a = v4;
  a = select(a, mix(a, mn, clamp(P.shrink, 0.0, 3.0) / 3.0), P.shrink > 0.0);   // 收缩
  a = select(a, mix(a, mx, clamp(-P.shrink, 0.0, 3.0) / 3.0), P.shrink < 0.0);  // 扩张
  a = mix(a, blur, clamp(P.feather / 5.0, 0.0, 1.0) * 0.6);                     // 羽化
  let motion = textureSampleLevel(dnTex, samp, uv, 0.0).a;
  let hist = textureSampleLevel(matteHist, samp, uv, 0.0).r;
  a = mix(a, hist, P.matteStab * 0.85 * (1.0 - motion));                        // 时域稳定
  var o: FsOut;
  o.m = vec4f(a, 0.0, 0.0, 1.0);
  o.hist = o.m;   // MRT 直写历史，省一次全幅拷贝
  return o;
}
