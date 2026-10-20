// flock_shaders.js: GLSL for the GPU murmuration (SPEC §4). Owned by the Flock builder.
//
// Sim passes are RawShaderMaterial / GLSL3 (full control over outputs, MRT for the neighbour lists). Bird rendering
// is ShaderMaterial (SPEC §4.6). Every read of a sim texture is a nearest texelFetch.
//
// References (see SPEC §10): Ballerini et al. 2008 (topological k = 7); Pearce et al. 2014 (marginal opacity);
// Cavagna et al. 2010 (scale-free correlations); Hemelrijk & Hildenbrandt 2011 (banking turns, StarDisplay);
// Procaccini et al. 2011 and Hemelrijk et al. 2015 (agitation waves); Carere et al. 2009 (predator patterns);
// Tobalske 1995 (flap / glide / bound); Ben-Gida et al. 2013 (13.3 Hz).

// The shared light chunk of SPEC §5.4, pasted verbatim for the stand-in (Sky's SKY_GLSL.light has the same text).
export const LIGHT_GLSL = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyUp; uniform vec3 uSkyDown;
uniform vec3 uHorizonColor; uniform vec3 uZenithColor; uniform float uExtinction; uniform float uAerialMax; uniform int uLook;
vec3 skyAmbient(vec3 n) { return mix(uSkyDown, uSkyUp, n.y * 0.5 + 0.5); }
vec3 skyAerial(vec3 col, vec3 wpos) {
  vec3 d = wpos - cameraPosition; float dist = length(d);
  float mu = d.y / max(dist, 1e-3);
  // in-scatter colour = the sky seen along this ray; below the horizon that is the (darker) hazed ground / sea, so a
  // near bird is never hazed toward a colour brighter than what lies behind it
  vec3 sky = mu >= 0.0 ? mix(uHorizonColor, uZenithColor, clamp(mu, 0.0, 1.0)) : uHorizonColor * mix(1.0, 0.35, clamp(-mu * 6.0, 0.0, 1.0));
  return mix(col, sky, min(uAerialMax, 1.0 - exp(-uExtinction * dist)));
}
`;

const HEAD = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
`;

// ---------------------------------------------------------------- common helpers (sim)
const COMMON = /* glsl */`
uniform ivec2 uSize;        // W, H of the bird textures
uniform int uN;             // live bird count (W*H)
ivec2 texOf(int id) { return ivec2(id % uSize.x, id / uSize.x); }
uint hashu(uint x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }
uint hash2u(uint a, uint b) { return hashu(a ^ hashu(b + 0x9e3779b9U)); }
float hash01(uint x) { return float(hashu(x) >> 8) / 16777216.0; }
float hash01b(uint a, uint b) { return float(hash2u(a, b) >> 8) / 16777216.0; }

// wind profile (SPEC §4.3 rule 9): below 10 m v10; 10–80 m log-interpolated; 80–1500 m lerp to v850
uniform vec3 uWind10, uWind80, uWind850; uniform float uWindDrift;
uniform vec4 uGustA[2];     // centre xyz, radius
uniform vec4 uGustB[2];     // velocity xyz, envelope 0..1
vec3 windProfile(float y) {
  y = max(y, 0.0);
  if (y < 10.0) return uWind10;
  if (y < 80.0) return mix(uWind10, uWind80, log(y / 10.0) / log(8.0));
  return mix(uWind80, uWind850, clamp((y - 80.0) / 1420.0, 0.0, 1.0));
}
vec3 windAt(vec3 p) {
  vec3 w = uWindDrift * windProfile(p.y);
  for (int i = 0; i < 2; i++) {
    float r = uGustA[i].w;
    if (uGustB[i].w <= 0.0 || r <= 0.0) continue;
    float d = length(p - uGustA[i].xyz);
    float k = 1.0 - smoothstep(0.35 * r, r, d);
    w += uGustB[i].xyz * (uGustB[i].w * k);
  }
  float m = length(w);
  return m > 12.0 ? w * (12.0 / m) : w;
}
// age since the last excitation, with tEx wrapping at 4096 s (−1e4 = never)
float exAge(float tEx, float tNow) {
  if (tEx < -1000.0) return 1e4;
  float a = tNow - tEx;
  if (a < -1.0) a += 4096.0;
  return a;
}
`;

// density / opacity atlas addressing (SPEC §4.2): nx × ny tiles, tilesX across
const ATLAS = /* glsl */`
uniform vec4 uDensOrigin;   // xyz = grid min corner (m), w = cell size (m)
uniform ivec4 uDensDim;     // nx, ny, nz, tilesX
ivec2 atlasTexel(ivec3 c) { return ivec2(c.x + (c.z % uDensDim.w) * uDensDim.x, c.y + (c.z / uDensDim.w) * uDensDim.y); }
bool inGrid(ivec3 c) { return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, uDensDim.xyz)); }
vec4 atlasFetch(sampler2D t, ivec3 c) { return inGrid(c) ? texelFetch(t, atlasTexel(c), 0) : vec4(0.0); }
vec4 atlasTrilinear(sampler2D t, vec3 p) {
  vec3 g = (p - uDensOrigin.xyz) / uDensOrigin.w - 0.5;
  vec3 fl = floor(g); vec3 f = g - fl; ivec3 c = ivec3(fl);
  vec4 a = mix(mix(atlasFetch(t, c), atlasFetch(t, c + ivec3(1, 0, 0)), f.x),
               mix(atlasFetch(t, c + ivec3(0, 1, 0)), atlasFetch(t, c + ivec3(1, 1, 0)), f.x), f.y);
  vec4 b = mix(mix(atlasFetch(t, c + ivec3(0, 0, 1)), atlasFetch(t, c + ivec3(1, 0, 1)), f.x),
               mix(atlasFetch(t, c + ivec3(0, 1, 1)), atlasFetch(t, c + ivec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
`;

// 3D simplex noise with analytic gradient (after Ashima Arts / Gustavson, MIT): returns (grad.xyz, value)
const NOISE = /* glsl */`
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec4 snoiseD(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m; vec4 m4 = m2 * m2;
  vec4 pdx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 t = m2 * m * pdx;
  vec3 grad = -8.0 * (t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3) + m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return 42.0 * vec4(grad, dot(m4, pdx));
}
`;

// ---------------------------------------------------------------- full-screen pass vertex shader
export const FS_VERT = /* glsl */`${HEAD}
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// copy a texture (init and debug copies of MRT attachments)
export const COPY_FRAG = /* glsl */`${HEAD}
uniform sampler2D tSrc;
out vec4 o;
void main() { o = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }
`;

// ---------------------------------------------------------------- spatial hash scatter (GL_POINTS, no blend)
const HASHFN = /* glsl */`
uniform float uHashCell; uniform int uHashN;   // cell size (m), hash texture side (power of two)
int cellSlot(ivec3 c) {
  uvec3 u = uvec3(c + 32768);
  uint h = hashu(u.x * 73856093U ^ u.y * 19349663U ^ u.z * 83492791U);
  return int(h & uint(uHashN * uHashN - 1));
}
ivec3 cellOf(vec3 p) { return ivec3(floor(p / uHashCell)); }
`;

export const HASH_VERT = /* glsl */`${HEAD}${COMMON}${HASHFN}
in vec3 position;   // x = bird id
uniform sampler2D tPos;
flat out float vId;
void main() {
  int id = int(position.x);
  vec3 p = texelFetch(tPos, texOf(id), 0).xyz;
  int s = cellSlot(cellOf(p));
  vec2 tc = (vec2(float(s % uHashN), float(s / uHashN)) + 0.5) / float(uHashN);
  gl_Position = vec4(tc * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vId = float(id);
}
`;
export const HASH_FRAG = /* glsl */`${HEAD}
flat in float vId;
out vec4 o;
void main() { o = vec4(vId + 1.0, 0.0, 0.0, 1.0); }
`;

// ---------------------------------------------------------------- density scatter (additive points into the atlas)
export const DENS_VERT = /* glsl */`${HEAD}${COMMON}${ATLAS}
in vec3 position;   // x = bird id
uniform sampler2D tPos, tVel;
out vec3 vV;
void main() {
  int id = int(position.x);
  vec3 p = texelFetch(tPos, texOf(id), 0).xyz;
  vV = texelFetch(tVel, texOf(id), 0).xyz;
  ivec3 c = ivec3(floor((p - uDensOrigin.xyz) / uDensOrigin.w));
  gl_PointSize = 1.0;
  if (!inGrid(c)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 asz = vec2(float(uDensDim.x * uDensDim.w), float(uDensDim.y * ((uDensDim.z + uDensDim.w - 1) / uDensDim.w)));
  vec2 tc = (vec2(atlasTexel(c)) + 0.5) / asz;
  gl_Position = vec4(tc * 2.0 - 1.0, 0.0, 1.0);
}
`;
export const DENS_FRAG = /* glsl */`${HEAD}
in vec3 vV;
out vec4 o;
void main() { o = vec4(vV, 1.0); }
`;

// ---------------------------------------------------------------- marginal opacity (Pearce et al. 2014)
// For each grid cell, 12 view directions (6 Fibonacci directions and their opposites): τ = σ ∫ρ ds over 6 growing
// steps (17.5 cells), O = 1 − exp(−τ) is the opacity a bird sees that way. w = Ō (mean of the 12), xyz = Σ d·O(d)
// points at the more opaque side. (A two-sided line opacity was tried: it regulates the flock to ~2× the size and
// it then reads as a faint haze at watcher distance; the one-sided view is what the bird itself sees.)
export const OPAC_FRAG = /* glsl */`${HEAD}${ATLAS}
uniform sampler2D tDens;
uniform vec3 uDirs[6];
uniform float uSigma;      // m² per bird
out vec4 o;
const float STEP[6] = float[6](1.0, 1.5, 2.0, 3.0, 4.0, 6.0);
float march(vec3 c0, vec3 d, float rhoK) {
  float s = 0.0, tau = 0.0;
  for (int i = 0; i < 6; i++) {
    float L = STEP[i];
    tau += atlasFetch(tDens, ivec3(floor(c0 + d * (s + 0.5 * L)))).a * rhoK * L;
    s += L;
  }
  return tau;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 tile = t / uDensDim.xy;
  ivec3 c = ivec3(t.x % uDensDim.x, t.y % uDensDim.y, tile.y * uDensDim.w + tile.x);
  if (c.z >= uDensDim.z) { o = vec4(0.0); return; }
  float cell = uDensOrigin.w;
  float rhoK = uSigma / (cell * cell);   // σ · (count / cell³) · (ds in cells · cell)
  float own = atlasFetch(tDens, c).a * rhoK * 0.5;
  vec3 sum = vec3(0.0); float mo = 0.0;
  vec3 c0 = vec3(c) + 0.5;
  for (int k = 0; k < 6; k++) {
    vec3 d = uDirs[k];
    float tf = march(c0, d, rhoK), tb = march(c0, -d, rhoK);
    float of = 1.0 - exp(-(tf + own)), ob = 1.0 - exp(-(tb + own));
    sum += d * (of - ob);
    mo += of + ob;
  }
  o = vec4(sum, mo / 12.0);
}
`;

// ---------------------------------------------------------------- neighbour refinement (MRT; nearest-neighbour descent)
export const NBR_FRAG = /* glsl */`${HEAD}${COMMON}${HASHFN}
uniform sampler2D tPos, tNbrA, tNbrB, tHash;
uniform int uFrame;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
float bd[8]; int bi[8];
int self; vec3 P;
void tryAdd(int c) {
  if (c < 0 || c >= uN || c == self) return;
  for (int k = 0; k < 8; k++) if (bi[k] == c) return;
  vec3 d = texelFetch(tPos, texOf(c), 0).xyz - P;
  float d2 = dot(d, d);
  if (d2 >= bd[7]) return;
  int k = 7;
  for (; k > 0; k--) {
    if (bd[k - 1] <= d2) break;
    bd[k] = bd[k - 1]; bi[k] = bi[k - 1];
  }
  bd[k] = d2; bi[k] = c;
}
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  self = tc.y * uSize.x + tc.x;
  P = texelFetch(tPos, tc, 0).xyz;
  for (int k = 0; k < 8; k++) { bd[k] = 1e30; bi[k] = -1; }
  vec4 A = texelFetch(tNbrA, tc, 0), B = texelFetch(tNbrB, tc, 0);
  int cur[8] = int[8](int(A.x), int(A.y), int(A.z), int(A.w), int(B.x), int(B.y), int(B.z), int(B.w));
  for (int k = 0; k < 8; k++) tryAdd(cur[k]);
  // neighbours of neighbours: slot (frame + k) % 8 of neighbour k (the SPEC minimum), plus slot (frame + k + 4) % 8,
  // which is the other half of the same fetch pair; two candidates per neighbour converge twice as fast while moving
  for (int k = 0; k < 8; k++) {
    int j = cur[k];
    if (j < 0 || j >= uN) continue;
    int s = (uFrame + k) % 4;
    tryAdd(int(texelFetch(tNbrA, texOf(j), 0)[s]));
    tryAdd(int(texelFetch(tNbrB, texOf(j), 0)[s]));
  }
  // hash occupants: own cell + 3 of the 26 neighbouring cells, picked per bird per frame
  ivec3 c = cellOf(P);
  tryAdd(int(texelFetch(tHash, ivec2(cellSlot(c) % uHashN, cellSlot(c) / uHashN), 0).r) - 1);
  for (int k = 0; k < 3; k++) {
    int o = int(hash2u(uint(self * 3 + k), uint(uFrame)) % 26U);
    o += o >= 13 ? 1 : 0;
    ivec3 cc = c + ivec3(o % 3 - 1, (o / 3) % 3 - 1, o / 9 - 1);
    int s = cellSlot(cc);
    tryAdd(int(texelFetch(tHash, ivec2(s % uHashN, s / uHashN), 0).r) - 1);
  }
  oA = vec4(float(bi[0]), float(bi[1]), float(bi[2]), float(bi[3]));
  oB = vec4(float(bi[4]), float(bi[5]), float(bi[6]), float(bi[7]));
}
`;

// ---------------------------------------------------------------- velocity (rules of SPEC §4.3, §4.4)
export const VEL_FRAG = /* glsl */`${HEAD}${COMMON}${ATLAS}${NOISE}
uniform sampler2D tPos, tVel, tState, tNbrA, tNbrB, tOpac;
uniform float uDt, uTime, uTimeMod;
uniform vec4 uP0;   // v0, vMin, vMax, speedNoise
uniform vec4 uP1;   // wAlign, wCohesion (× compaction), rSep, wSep
uniform vec4 uP2;   // wOpacity, opacityTarget, wLevel, wRoost
uniform vec4 uP3;   // roostRadius, altMin, altMax, altK
uniform vec4 uP4;   // maxLatG, agitatedLatG, rollRate, maxBank (rad)
uniform vec4 uP5;   // excitedDur, bankPulse (rad), speedBoost, fleeRadius
uniform vec4 uP6;   // curl (m/s²), 1/wavelength (1/m), octaves, wander (m/s²)
uniform vec4 uP7;   // centrality gain (StarDisplay edge cohesion), centroid pull (m/s² per 100 m beyond R0), R0 (m), flatten (1/s²)
uniform vec3 uCentroid;
uniform vec3 uNoiseOff;   // seed offset + wind advection + evolution (noise units)
uniform float uSeed;
uniform vec4 uPred;       // falcon xyz, w = 1 when active
uniform vec4 uPredVel;    // falcon velocity xyz
uniform vec4 uFlash;      // xyz = centre, w = impulse (m/s) this step, 0 = none
uniform float uFlashR;
uniform vec3 uWaveOrigin;
// large-scale steering (the flock's own wheeling, SPEC review fix): heading theta(tau) = base + Omega tau + sum A_i sin(w_i tau + p_i),
// evaluated at a delayed time tau = t - (position along a slowly rotating axis) / wave speed, so every turn starts at
// one side of the flock and sweeps across it (the turn waves and folds of a real murmuration)
uniform vec4 uSteerA;   // A1, A2, A3 (rad), Omega (rad/s)
uniform vec4 uSteerW;   // w1, w2, w3, wV (rad/s)
uniform vec4 uSteerP;   // p1, p2, p3, pV
uniform vec4 uSteerX;   // axis x, axis z, gain (1/s), wave speed (m/s)
uniform vec2 uSteerV;   // vertical speed amplitude (m/s), base heading (rad)
out vec4 o;
const float G = 9.81;
vec3 curlNoise(vec3 p, out float sc) {
  vec3 acc = vec3(0.0); float amp = 1.0, norm = 0.0, f = uP6.y;
  sc = 0.0;
  int oct = int(uP6.z + 0.5);
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    vec3 q = p * f + uNoiseOff + float(i) * vec3(17.3, 5.1, 9.7);
    vec4 a = snoiseD(q);
    vec4 b = snoiseD(q + vec3(31.416, 47.853, 12.679));
    acc += amp * cross(a.xyz, b.xyz);
    if (i == 0) sc = a.w;
    norm += amp * amp; amp *= 0.5; f *= 2.0;
  }
  // bitangent-noise curl: one octave of cross(∇a, ∇b) has RMS 6.41 (measured, 20k samples); the octaves are
  // independent, so dividing by 6.41·sqrt(Σ amp²) makes the RMS acceleration exactly 1 (× noise.curl)
  sc *= 2.55;   // the scalar channel has RMS 0.39 → about 1, clamped to ±1 by the caller
  return acc / (6.41 * sqrt(max(norm, 1e-6)));
}
vec3 rand3(uint id, uint k) {
  return vec3(hash01b(id * 3U + 0U, k), hash01b(id * 3U + 1U, k), hash01b(id * 3U + 2U, k)) * 2.0 - 1.0;
}
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int id = tc.y * uSize.x + tc.x;
  vec4 P4 = texelFetch(tPos, tc, 0), V4 = texelFetch(tVel, tc, 0), S4 = texelFetch(tState, tc, 0);
  vec3 p = P4.xyz;
  vec3 wind = windAt(p);
  vec3 vA = V4.xyz - wind;
  float spd = max(length(vA), 1e-3);
  vec3 f = vA / spd;
  float age = exAge(S4.w, uTimeMod);
  float exDur = uP5.x;
  bool excited = age >= 0.0 && age <= exDur;

  // --- topological neighbours (k = 7: slots 0–6)
  vec4 A = texelFetch(tNbrA, tc, 0), B = texelFetch(tNbrB, tc, 0);
  int nb[7] = int[7](int(A.x), int(A.y), int(A.z), int(A.w), int(B.x), int(B.y), int(B.z));
  vec3 sv = vec3(0.0), sp = vec3(0.0), sep = vec3(0.0), cdir = vec3(0.0); float n = 0.0;
  for (int k = 0; k < 7; k++) {
    int j = nb[k];
    if (j < 0 || j >= uN) continue;
    vec3 pj = texelFetch(tPos, texOf(j), 0).xyz;
    vec3 vj = texelFetch(tVel, texOf(j), 0).xyz - uWindDrift * windProfile(pj.y);
    sv += vj; sp += pj; n += 1.0;
    vec3 d = p - pj; float dl = length(d);
    // smooth separation kernel: zero force and zero slope at rSep (a 1/d kernel jumps by ~9 m/s² as a neighbour
    // crosses rSep, which set every bird rolling at its rate limit)
    if (dl < uP1.z && dl > 1e-4) { float q = 1.0 - dl / uP1.z; sep += d / dl * (q * q * 2.0 / max(dl, 0.25)); }
    if (dl > 1e-4) cdir -= d / dl;
  }
  vec3 F = vec3(0.0);
  if (n > 0.0) {
    F += uP1.x * (sv / n - vA);                                   // alignment
    // cohesion, stronger for edge birds (centrality: |mean unit vector to the neighbours|; Hemelrijk & Hildenbrandt 2011)
    float central = length(cdir) / n;
    vec3 coh = uP1.y * (1.0 + uP7.x * central * central) * (sp / n - p);   // capped at 4 m/s²
    float cl = length(coh); if (cl > 4.0) coh *= 4.0 / cl;
    F += coh;
    F += uP1.w * sep;                                             // separation
  }
  // --- scale-free curl noise (Cavagna et al. 2010) + speed channel
  float sc;
  // (vertical components damped: a real flock stays a thin, mostly horizontal sheet that tilts and folds)
  vec3 cn = curlNoise(p, sc); cn.y *= 0.35;
  F += uP6.x * cn;
  // --- marginal opacity (Pearce et al. 2014)
  vec4 op = atlasTrilinear(tOpac, p);
  float ol = length(op.xyz);
  // anisotropic (Ballerini et al. 2008: flocks are thinnest vertically and widest across the direction of travel):
  // the opacity regulation acts mostly sideways, a little along the heading and only weakly up and down
  if (ol > 1e-5) {
    // the target varies in space with the noise field's scalar channel: denser and sparser regions (dark patches)
    vec3 fo = uP2.x * (uP2.y * (1.0 + 0.45 * clamp(sc, -1.0, 1.0)) - op.w) * op.xyz / max(ol, 0.05);
    float along = dot(fo, f);
    fo -= f * along * 0.5;
    fo.y *= 0.3;
    F += fo;
  }
  // --- per-bird wander, smooth value noise at 0.7 Hz
  uint uid = uint(id);
  float tt = uTime * 0.7 + hash01b(uid, uint(uSeed)) * 64.0;
  float kf = floor(tt); float fr = tt - kf; fr = fr * fr * (3.0 - 2.0 * fr);
  F += uP6.w * mix(rand3(uid, uint(kf)), rand3(uid, uint(kf) + 1U), fr) * vec3(1.0, 0.35, 1.0);
  // flattening: a weak spring toward the flock's mean height
  F.y += uP7.w * (uCentroid.y - p.y);
  // --- weak pull toward the flock beyond R0 (keeps stragglers outside the opacity grid's reach in contact)
  if (uP7.y > 0.0) {
    vec3 dc = uCentroid - p; float dcl = length(dc);
    if (dcl > uP7.z) F += dc / dcl * uP7.y * (dcl - uP7.z) / 100.0;
  }
  // --- large-scale steering: the whole flock wheels, each part a little later than the last
  float vyWant = 0.0;
  if (uSteerX.z > 0.0) {
    float tau = uTime - clamp(dot(p.xz - uCentroid.xz, uSteerX.xy) / max(uSteerX.w, 1.0), -6.0, 6.0);
    float th = uSteerV.y + uSteerA.w * tau + dot(uSteerA.xyz, sin(uSteerW.xyz * tau + uSteerP.xyz));
    vec2 want = vec2(cos(th), sin(th));
    // the wheel is centred on the roost: beyond half the roost radius the heading bends back toward it
    float dr = length(p.xz);
    if (dr > 1.0) want = normalize(want - p.xz / dr * 1.6 * smoothstep(0.5 * uP3.x, 1.4 * uP3.x, dr));
    want *= uP0.x;
    vec3 fs = vec3(want.x - vA.x, 0.0, want.y - vA.z) * uSteerX.z;
    F += fs - f * dot(fs, f);             // steer by turning (lateral only), never by braking
    vyWant = uSteerV.x * sin(uSteerW.w * tau + uSteerP.w);
  }
  // --- level flight (toward the steering's gentle climb / descent)
  F.y -= uP2.z * (vA.y - vyWant);
  // --- roost (horizontal) and altitude springs; the roost spring has a tangential part, so a flock that strays
  // circles back over the roost instead of bouncing straight back
  float dh = length(p.xz);
  if (dh > uP3.x) {
    float e = (dh - uP3.x) / 100.0;
    vec2 rad = p.xz / dh;
    float side = dot(vec2(-rad.y, rad.x), vA.xz) >= 0.0 ? 1.0 : -1.0;
    F.xz -= rad * uP2.w * (e + 2.0 * e * e);
    F.xz += side * vec2(-rad.y, rad.x) * uP2.w * min(e, 1.0) * 0.6;
  }
  if (p.y < uP3.y) F.y += min(uP3.w * (uP3.y - p.y) * (uP3.y - p.y), 6.0);
  if (p.y > uP3.z) F.y -= min(uP3.w * (p.y - uP3.z) * (p.y - uP3.z), 6.0);
  // --- predator: flee from the falcon's path over the next 0.5 s
  if (uPred.w > 0.5) {
    vec3 a = uPred.xyz, b = uPred.xyz + uPredVel.xyz * 0.5;
    vec3 ab = b - a; float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    vec3 d = p - (a + ab * t); float dl = length(d);
    if (dl < uP5.w && dl > 1e-3) { float q = 1.0 - dl / uP5.w; F += d / dl * 25.0 * q * q; }
  }

  // --- speed: relax |v_air| toward the preferred speed (τ = 1 s)
  float vPref = uP0.x * (1.0 + uP0.w * clamp(sc, -1.0, 1.0)) + (excited ? uP5.z : 0.0);
  float aF = dot(F, f) + (vPref - spd);
  vec3 aL = F - dot(F, f) * f;
  float latMax = (excited ? uP4.y : uP4.x) * G;
  float al = length(aL); if (al > latMax) aL *= latMax / al;
  // --- banking turns (Hemelrijk & Hildenbrandt 2011): the bird turns by rolling
  vec3 right = cross(f, vec3(0.0, 1.0, 0.0));
  float rl = length(right);
  right = rl > 1e-3 ? right / rl : vec3(1.0, 0.0, 0.0);
  vec3 up = cross(right, f);
  float aR = dot(aL, right), aU = dot(aL, up);
  float target = atan(aR / G);
  if (excited) {
    float s = dot(uWaveOrigin - p, right) > 0.0 ? -1.0 : 1.0;   // roll away from the stimulus
    target += s * uP5.y * sin(3.14159265 * clamp(age / exDur, 0.0, 1.0));
  }
  target = clamp(target, -uP4.w, uP4.w);
  float roll = V4.w;
  // first-order lag (tau 0.15 s) under the roll-rate limit: the roll is the low-passed lateral demand
  roll += clamp((target - roll) * min(1.0, uDt / 0.15), -uP4.z * uDt, uP4.z * uDt);
  float aTurn = clamp(G * tan(roll), -latMax, latMax);
  vA += (f * aF + up * aU + right * aTurn) * uDt;
  // --- flash expansion: one radial impulse at the falcon's pass
  if (uFlash.w > 0.0) {
    vec3 d = p - uFlash.xyz; float dl = length(d);
    if (dl < uFlashR && dl > 1e-3) vA += d / dl * uFlash.w * (1.0 - dl / uFlashR);
  }
  float s2 = length(vA);
  vA *= clamp(s2, uP0.y, uP0.z + (excited ? uP5.z : 0.0)) / max(s2, 1e-3);
  o = vec4(vA + windAt(p), roll);
}
`;

// ---------------------------------------------------------------- state: flight bouts + excitable-cell waves
export const STATE_FRAG = /* glsl */`${HEAD}${COMMON}
uniform sampler2D tPos, tVel, tState, tNbrA, tNbrB;
uniform float uDt, uTime, uTimeMod;
uniform vec4 uW0;     // waveDelay, excitedDur, refractory, pProp
uniform vec4 uF0;     // flapHz, flapHzPerMs, glideShare, boundShare
uniform vec4 uF1;     // boutBeats min, max, pause min, max
uniform vec4 uPred;   // falcon xyz, w = 1 when it is a threat (stoop / strike / pullout)
uniform float uDetect;
uniform vec4 uExRayO; // ray origin xyz, w = 1 when active
uniform vec4 uExRayD; // ray dir xyz, w = t start along the ray
uniform int uSpont;   // bird id seeded spontaneously this step, −1 = none
out vec4 o;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int id = tc.y * uSize.x + tc.x;
  uint uid = uint(id);
  vec4 S = texelFetch(tState, tc, 0);
  vec3 p = texelFetch(tPos, tc, 0).xyz;
  vec3 vA = texelFetch(tVel, tc, 0).xyz - windAt(p);
  float spd = length(vA);
  float age = exAge(S.w, uTimeMod);
  float exDur = uW0.y;
  // --- excitable cell: excited [0, dur], refractory to dur + refractory, then resting
  if (age > exDur + uW0.z) {
    bool trig = false;
    vec4 A = texelFetch(tNbrA, tc, 0), B = texelFetch(tNbrB, tc, 0);
    int nb[7] = int[7](int(A.x), int(A.y), int(A.z), int(A.w), int(B.x), int(B.y), int(B.z));
    for (int k = 0; k < 7; k++) {
      int j = nb[k];
      if (j < 0 || j >= uN) continue;
      float tj = texelFetch(tState, texOf(j), 0).w;
      float aj = exAge(tj, uTimeMod);
      // one draw per (bird, neighbour wave) so the window length does not change the probability
      if (aj >= uW0.x && aj <= uW0.x + 0.12 && hash01b(uid, uint(tj * 1000.0) + uint(j)) < uW0.w) trig = true;
    }
    if (uPred.w > 0.5 && length(p - uPred.xyz) < uDetect) trig = true;
    if (uExRayO.w > 0.5) {
      vec3 d = p - uExRayO.xyz; float t = dot(d, uExRayD.xyz);
      if (t >= uExRayD.w && t <= uExRayD.w + 60.0 && length(d - t * uExRayD.xyz) < 6.0) trig = true;
    }
    if (id == uSpont) trig = true;
    if (trig) { S.w = uTimeMod; age = 0.0; }
  }
  bool excited = age >= 0.0 && age <= exDur;
  bool noPause = excited || age < exDur + 1.0 || vA.y > 2.0;
  // --- flight bouts (Tobalske 1995): flap 3–9 beats, then a glide or a bound pause
  float fHz = uF0.x + uF0.y * (spd - 12.5);
  uint k = uint(uTime * 60.0);
  float z = S.z;
  if (z > 0.0) {
    z -= uDt;
    if (z <= 0.0) {
      if (noPause) z = 0.05;
      else {
        float pd = uF1.z + (uF1.w - uF1.z) * pow(hash01b(uid, k + 7U), 2.0);
        float pb = clamp(uF0.w / (uF0.z + uF0.w) + (spd - 12.5) / 16.0, 0.05, 0.5);
        z = hash01b(uid, k + 13U) < pb ? -(10.0 + pd) : -pd;
      }
    }
  } else {
    bool bound = z <= -10.0;
    float rem = (bound ? -z - 10.0 : -z) - uDt;
    if (rem <= 0.0 || noPause) {
      float beats = uF1.x + (uF1.y - uF1.x) * sqrt(hash01b(uid, k + 29U));
      z = beats / max(fHz, 4.0);
    } else z = bound ? -(10.0 + rem) : -rem;
  }
  float gT = (z < 0.0 && z > -10.0) ? 1.0 : 0.0;
  float bT = z <= -10.0 ? 1.0 : 0.0;
  float sl = uDt / 0.08;
  S.x += clamp(gT - S.x, -sl, sl);
  S.y += clamp(bT - S.y, -sl, sl);
  S.z = z;
  o = S;
}
`;

// ---------------------------------------------------------------- position + flap phase
export const POS_FRAG = /* glsl */`${HEAD}${COMMON}
uniform sampler2D tPos, tVel, tState;
uniform float uDt, uTimeMod;
uniform vec4 uF0;     // flapHz, flapHzPerMs, -, -
uniform float uExDur;
out vec4 o;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(tPos, tc, 0), V = texelFetch(tVel, tc, 0), S = texelFetch(tState, tc, 0);
  float spd = length(V.xyz - windAt(P.xyz));
  float age = exAge(S.w, uTimeMod);
  float fHz = uF0.x + uF0.y * (spd - 12.5);
  if (age >= 0.0 && age <= uExDur) fHz *= 1.15;
  float adv = fHz * uDt;
  float ph = P.w;
  if (S.z < 0.0) {
    // a pause: run the stroke on to the pose phase (glide ≈ 0.28, extended; bound ≈ 0.91, folded), then hold
    float target = S.z <= -10.0 ? 0.91 : 0.28;
    float d = fract(target - ph + 1.0);
    ph = d <= adv ? target : fract(ph + adv);
  } else ph = fract(ph + adv);
  o = vec4(P.xyz + V.xyz * uDt, ph);
}
`;

// ---------------------------------------------------------------- LOD key: 4 birds per RGBA8 texel
export const LODKEY_FRAG = /* glsl */`${HEAD}${COMMON}
uniform sampler2D tPos;
uniform mat4 uView;
uniform vec4 uCam;     // tanHalfX, tanHalfY, near, far
uniform float uPxPerM; // render height / (2 tan(fov/2))
uniform float uSpanM;
out vec4 o;
float code(int id) {
  if (id >= uN) return 0.0;
  vec3 p = texelFetch(tPos, texOf(id), 0).xyz;
  vec3 v = (uView * vec4(p, 1.0)).xyz;
  float z = -v.z;
  if (z < uCam.z - 1.0 || z > uCam.w) return 0.0;
  if (abs(v.x) > z * uCam.x + 1.0 || abs(v.y) > z * uCam.y + 1.0) return 0.0;
  float span = uSpanM * uPxPerM / max(z, 0.05);
  return clamp(floor(32.0 * log2(span + 1.0) + 0.5), 1.0, 255.0) / 255.0;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int b = t.y * uSize.x + t.x * 4;
  o = vec4(code(b), code(b + 1), code(b + 2), code(b + 3));
}
`;

// ---------------------------------------------------------------- texSub: 256 sampled birds (row 0 pos, 1 vel, 2 state)
export const SUB_FRAG = /* glsl */`${HEAD}${COMMON}
uniform sampler2D tPos, tVel, tState;
uniform int uStride, uTarget;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int id = t.x == 255 && uTarget >= 0 ? uTarget : t.x * uStride;
  ivec2 c = texOf(min(id, uN - 1));
  o = t.y == 0 ? texelFetch(tPos, c, 0) : t.y == 1 ? texelFetch(tVel, c, 0) : texelFetch(tState, c, 0);
}
`;

// ---------------------------------------------------------------- bird rendering (ShaderMaterial, SPEC §4.6)
// Defines: LOD (0..3), FALCON (single bird from uniforms), PICK (id pass), SMOOTH_NRM, IRID, TRANSMIT, SELFSHADOW,
// AERIAL, MINPIXEL, NORMALMAP, LODVIZ, TEXTURED.
export const BIRD_VERT = /* glsl */`
precision highp sampler2D;
uniform sampler2D tPos, tVel, tState, tTrack;
uniform sampler2D tVatPos, tVatNrm;
uniform ivec2 uSize;
uniform int uTrackMode;          // 0 = all, 1 = tracked only
uniform float uPxPerM, uMinPx, uSpanM, uAlphaPow;
uniform float uLead;             // real time not yet simulated (s): drawn ahead by v·lead, so 75–165 Hz displays stay smooth
uniform vec2 uRes;               // render size (px), for the screen-space dilation of far birds
uniform float uDilate;           // px added on each side of a far (micro) bird
uniform vec3 uWind10, uWind80, uWind850; uniform float uWindDrift;
#ifdef FALCON
uniform vec3 uFPos, uFFwd; uniform float uFRoll, uFPhase, uFGlide, uFBound, uFScale, uFPitch;
#endif
#ifdef SELFSHADOW
uniform sampler2D tDens; uniform vec4 uDensOrigin; uniform ivec4 uDensDim; uniform float uSigma;
#endif
attribute float aVid;
#ifndef FALCON
attribute float aBird;
#endif
varying vec3 vWPos;
varying vec2 vUv;
varying float vWing;
varying float vAlpha;
varying float vShadow;
#ifdef SMOOTH_NRM
varying vec3 vNrm;
#endif
#ifdef PICK
flat varying float vPickId;
#endif
vec3 windProfile(float y) {
  y = max(y, 0.0);
  if (y < 10.0) return uWind10;
  if (y < 80.0) return mix(uWind10, uWind80, log(y / 10.0) / log(8.0));
  return mix(uWind80, uWind850, clamp((y - 80.0) / 1420.0, 0.0, 1.0));
}
uint hashu(uint x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }
void main() {
  int vid = int(aVid);
  vec3 P, f; float phase, gW, bW, roll, sc, pitchUp;
#ifdef FALCON
  P = uFPos; phase = uFPhase; gW = uFGlide; bW = uFBound; roll = uFRoll; sc = uFScale;
  f = normalize(uFFwd);
  pitchUp = uFPitch;
#else
  int id = int(aBird);
  ivec2 tc = ivec2(id % uSize.x, id / uSize.x);
  if (uTrackMode == 1 && texelFetch(tTrack, tc, 0).r < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 P4 = texelFetch(tPos, tc, 0), V4 = texelFetch(tVel, tc, 0), S4 = texelFetch(tState, tc, 0);
  P = P4.xyz + V4.xyz * uLead; phase = S4.z >= 0.0 ? fract(P4.w + 13.3 * uLead) : P4.w; gW = S4.x; bW = S4.y; roll = V4.w;
  sc = 1.0 + 0.04 * (float(hashu(uint(id)) >> 8) / 8388608.0 - 1.0);
  vec3 vA = V4.xyz - uWindDrift * windProfile(P.y);
  f = vA / max(length(vA), 1e-3);
  pitchUp = 0.0873 * gW;     // +5° nose-up in a glide
#endif
  // VAT pose: rows 0–31 the flap cycle, 32 glide, 33 bound
  float ph = phase * 32.0; float r0 = floor(ph); float fr = ph - r0;
  int i0 = int(r0) % 32, i1 = (i0 + 1) % 32;
  vec4 a = texelFetch(tVatPos, ivec2(vid, i0), 0), b = texelFetch(tVatPos, ivec2(vid, i1), 0);
  vec3 lp = mix(a.xyz, b.xyz, fr);
  lp = mix(lp, texelFetch(tVatPos, ivec2(vid, 32), 0).xyz, gW);
  lp = mix(lp, texelFetch(tVatPos, ivec2(vid, 33), 0).xyz, bW);
  vWing = a.w;
  // orientation: forward = air velocity, pitched up, rolled about forward (+ = right wing down)
  vec3 right = cross(f, vec3(0.0, 1.0, 0.0)); float rl = length(right);
  right = rl > 1e-3 ? right / rl : vec3(1.0, 0.0, 0.0);
  vec3 up = cross(right, f);
  float cp = cos(pitchUp), sp = sin(pitchUp);
  vec3 f2 = f * cp + up * sp; up = up * cp - f * sp; f = f2;
  float cr = cos(roll), sr = sin(roll);
  vec3 R = right * cr - up * sr; vec3 U = up * cr + right * sr;
  // model frame: +Z head, +Y back, +X left wing (= −right)
  float k = 1.0;
#if defined(MINPIXEL) || defined(PICK)
  {
    float z = max(length(P - cameraPosition), 0.05);
    float span = uSpanM * sc * uPxPerM / z;
    k = max(1.0, uMinPx / max(span, 1e-3));
  }
#endif
  vAlpha = pow(k, -uAlphaPow);
  vec3 wp = P + (sc * k) * (-lp.x * R + lp.y * U + lp.z * f);
#if defined(MINPIXEL) && !defined(PICK)
  // coverage follows the projected wing area: a bird banked face-on to the eye shows its whole wing (darker), one seen
  // edge-on only its body; this is what makes an agitation wave read as a dark band crossing the flock
  {
    vec3 vd = normalize(P - cameraPosition);
    vAlpha *= mix(0.4, 1.0, abs(dot(U, vd)));
  }
#endif
  vWPos = wp;
  vUv = uv;
#ifdef SMOOTH_NRM
  vec3 na = texelFetch(tVatNrm, ivec2(vid, i0), 0).xyz * 2.0 - 1.0, nb = texelFetch(tVatNrm, ivec2(vid, i1), 0).xyz * 2.0 - 1.0;
  vec3 ln = mix(na, nb, fr);
  ln = mix(ln, texelFetch(tVatNrm, ivec2(vid, 32), 0).xyz * 2.0 - 1.0, gW);
  ln = mix(ln, texelFetch(tVatNrm, ivec2(vid, 33), 0).xyz * 2.0 - 1.0, bW);
  vNrm = normalize(-ln.x * R + ln.y * U + ln.z * f);
#endif
  vShadow = 1.0;
#ifdef SELFSHADOW
  {
    float tau = 0.0;
    for (int i = 1; i <= 4; i++) {
      vec3 q = (P + vec3(0.0, float(i) * 2.5, 0.0) - uDensOrigin.xyz) / uDensOrigin.w;
      ivec3 c = ivec3(floor(q));
      if (all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, uDensDim.xyz)))
        tau += texelFetch(tDens, ivec2(c.x + (c.z % uDensDim.w) * uDensDim.x, c.y + (c.z / uDensDim.w) * uDensDim.y), 0).a;
    }
    vShadow = exp(-tau * uSigma * 2.5 / (uDensOrigin.w * uDensOrigin.w * uDensOrigin.w));
  }
#endif
#ifdef PICK
#ifdef FALCON
  vPickId = -2.0;
#else
  vPickId = float(id);
#endif
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
#if (defined(MINPIXEL) || defined(DILATE)) && !defined(PICK)
  // far birds (2–24 px): push every vertex uDilate px outward from the bird's centre in screen space, so wings under a
  // pixel wide stay a crisp dark dash (a camera's PSF does the same) instead of averaging to grey under MSAA
  if (uDilate > 0.0) {
    vec4 cP = projectionMatrix * viewMatrix * vec4(P, 1.0);
    if (cP.w > 0.0 && gl_Position.w > 0.0) {
      vec2 h = 0.5 * uRes;
      vec2 sP = cP.xy / cP.w * h, sW = gl_Position.xy / gl_Position.w * h;
      vec2 dd = sW - sP; float l = length(dd);
      if (l > 1e-3) gl_Position.xy = (sW + dd / l * uDilate) / h * gl_Position.w;
    }
  }
#endif
}
`;

export const BIRD_FRAG = /* glsl */`
precision highp float;
${LIGHT_GLSL}
uniform sampler2D tAlbedo, tMask, tNormal;
uniform vec3 uAlbBody, uAlbWing;
uniform vec3 uLodTint;
varying vec3 vWPos;
varying vec2 vUv;
varying float vWing;
varying float vAlpha;
varying float vShadow;
#ifdef SMOOTH_NRM
varying vec3 vNrm;
#endif
#ifdef PICK
flat varying float vPickId;
#endif
void main() {
#ifdef PICK
  float v = vPickId + 1.0;       // 0 = none, −1 → falcon code 0xFFFFFF
  if (vPickId < -1.5) { gl_FragColor = vec4(1.0); return; }
  float r = mod(v, 256.0), g = mod(floor(v / 256.0), 256.0), b = floor(v / 65536.0);
  gl_FragColor = vec4(r, g, b, 255.0) / 255.0;
  return;
#else
  vec3 V = normalize(cameraPosition - vWPos);
#ifdef SMOOTH_NRM
  vec3 n = normalize(vNrm);
  if (dot(n, V) < 0.0) n = -n;
#else
  vec3 n = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
  if (dot(n, V) < 0.0) n = -n;
#endif
#ifdef TEXTURED
  vec3 albedo = texture2D(tAlbedo, vUv).rgb;
  vec3 mask = texture2D(tMask, vUv).rgb;
#else
  vec3 albedo = mix(uAlbBody, uAlbWing, vWing);
  vec3 mask = vec3(1.0, 0.7, 0.0);
#endif
#ifdef NORMALMAP
  {
    vec3 dp1 = dFdx(vWPos), dp2 = dFdy(vWPos); vec2 du1 = dFdx(vUv), du2 = dFdy(vUv);
    vec3 dp2p = cross(dp2, n), dp1p = cross(n, dp1);
    vec3 T = dp2p * du1.x + dp1p * du2.x, B = dp2p * du1.y + dp1p * du2.y;
    float im = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
    vec3 tn = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
    n = normalize(mat3(T * im, B * im, n) * tn);
  }
#endif
  float ao = mask.r;
  vec3 amb = skyAmbient(n);
  vec3 col;
  if (uLook == 1) col = albedo * (amb * ao * vShadow + uSunColor * max(dot(n, uSunDir), 0.0));
  // signature and dusk are silhouette looks: soft ambient only (no side-lit birds on a sunny day), held dark
  else col = albedo * amb * ao * vShadow * (uLook == 2 ? 0.25 : 0.3);
#ifdef IRID
  {
    float nv = clamp(dot(n, V), 0.0, 1.0);
    float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    vec3 film = 0.5 + 0.5 * cos(6.2831853 * (1.6 * nv + vec3(0.0, 0.42, 0.18)));   // purple ↔ green
    col += mask.b * F * film * 0.15 * amb;
  }
#endif
#ifdef TRANSMIT
  col += 0.35 * albedo * uSkyUp * vWing * max(0.0, -n.y);   // sky light through the wing, seen from below
#endif
#ifdef AERIAL
  col = skyAerial(col, vWPos);
#endif
#ifdef LODVIZ
  col = uLodTint * 0.35 * uSkyUp;
#endif
#ifdef MINPIXEL
  gl_FragColor = vec4(col * vAlpha, vAlpha);
#else
  gl_FragColor = vec4(col, 1.0);
#endif
#endif
}
`;

// falcon GLB (SkinnedMesh) material: three's skinning chunks + the shared light chunk + aerial
export const FALCON_SKIN_VERT = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
varying vec3 vWPos; varying vec3 vNrm; varying vec2 vUv;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 w = modelMatrix * vec4(transformed, 1.0);
  vWPos = w.xyz;
  vNrm = normalize(mat3(modelMatrix) * objectNormal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
export const FALCON_SKIN_FRAG = /* glsl */`
${LIGHT_GLSL}
uniform sampler2D tAlbedo; uniform float uHasMap; uniform vec3 uAlb;
varying vec3 vWPos; varying vec3 vNrm; varying vec2 vUv;
void main() {
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 n = normalize(vNrm); if (dot(n, V) < 0.0) n = -n;
  vec3 albedo = uHasMap > 0.5 ? texture2D(tAlbedo, vUv).rgb : uAlb;
  // the scan's barring and moustache are low-contrast after the bake: expand the albedo contrast (linear)
  albedo = clamp(pow(albedo, vec3(1.35)) * 1.6, 0.0, 0.9);
  // hero-model ambient: a little of the sky's light reaches the underwing (bounce off the pale overcast and sea haze),
  // so the barred underparts and underwing read instead of a flat dark blade
  vec3 amb = mix(uSkyDown, uSkyUp, 0.7 + 0.3 * n.y);
  vec3 col = uLook == 1 ? albedo * (amb + uSunColor * max(dot(n, uSunDir), 0.0))
                        : albedo * (amb * 0.75 + uSunColor * max(dot(n, uSunDir), 0.0) * 0.3);
#ifdef AERIAL
  col = skyAerial(col, vWPos);
#endif
  gl_FragColor = vec4(col, 1.0);
}
`;
