// sky_shaders.js: GLSL for the real-weather sky (SPEC §5). Owner: Sky builder. ES module, no imports.
//
//  SKY_GLSL.light   the shared light chunk (§5.4), pasted verbatim by every lit material (flock, falcon, ground)
//  atmosphere       Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR):
//                   transmittance LUT 256×64, multi-scattering LUT 32×32 (fx sky.multiScatter), sky-view LUT 192×108
//  clouds           three decks on spherical shells (low stratocumulus, mid altocumulus, high cirrus), each a
//                   tileable 2-D field thresholded through an inverse-CDF LUT so its covered area equals the real
//                   cloud fraction; dual-lobe Henyey-Greenstein + Beer-powder single scattering, two-stream diffuse
//                   transmission, light taps toward the sun, silver lining, aerial fade to the horizon radiance
//  grade/present    the looks (§5.5: signature, physical (AgX), dusk, negative) and the canvas pass
//
// Units: the atmosphere works in km, the clouds in metres. Radiance is in "scaled sun" units: uSunIrr is the solar
// irradiance times an auto-exposure prescale chosen so the mean sky radiance Lref is about 1 (keeps RGBA16F healthy
// from noon to deep twilight). Every look is normalised by Lref, so the prescale never shows.

// ---------------------------------------------------------------------------------------------------------------
// §5.4 shared light chunk. EXACT text; flock pastes it too.
const LIGHT = `uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyUp; uniform vec3 uSkyDown;
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

// ---------------------------------------------------------------------------------------------------------------
const FSQ_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Atmosphere constants and lookups (km). Rayleigh, Mie and ozone values are SPEC §5.2 (Hillaire's Earth).
const ATMO = /* glsl */`
#ifndef PI
#define PI 3.141592653589793
#endif
const float RG = 6360.0;
const float RT = 6460.0;
const vec3 RAY_S = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float MIE_S = 3.996e-3;
const float MIE_A = 4.4e-3;
const vec3 OZO_A = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float VIEW_H = 0.01;                 // sky-view LUT eye height above the ground, km
const vec2 TRANS_SIZE = vec2(256.0, 64.0);
const vec2 MS_SIZE = vec2(32.0, 32.0);
const vec2 SV_SIZE = vec2(192.0, 108.0);
uniform float uMieScale;                  // clamp(20000 / visibility, 0.5, 8)
uniform sampler2D uTransLUT;
uniform sampler2D uMSLUT;
uniform sampler2D uSkyViewLUT;
uniform vec3 uSunIrr;                     // solar irradiance × prescale (rgb)

vec3 mediumDens(float h) {               // rayleigh, mie, ozone densities at altitude h km
  return vec3(exp(-h / 8.0), exp(-h / 1.2) * uMieScale, max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}
vec3 mediumExt(vec3 d) { return RAY_S * d.x + vec3(MIE_S + MIE_A) * d.y + OZO_A * d.z; }
vec3 mediumScat(vec3 d) { return RAY_S * d.x + vec3(MIE_S) * d.y; }

float raySphereFar(vec3 ro, vec3 rd, float r) {    // far root, or -1
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}
float raySphereNear(vec3 ro, vec3 rd, float r) {   // nearest positive root, or -1
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc), t0 = -b - s, t1 = -b + s;
  return t0 > 0.0 ? t0 : (t1 > 0.0 ? t1 : -1.0);
}
vec2 toSubUV(vec2 uv, vec2 size) { return (uv * (size - 1.0) + 0.5) / size; }
vec2 fromSubUV(vec2 uv, vec2 size) { return (uv * size - 0.5) / (size - 1.0); }

vec2 transUV(float r, float mu) {           // Bruneton/Hillaire parametrisation
  float H = sqrt(RT * RT - RG * RG);
  float rho = sqrt(max(0.0, r * r - RG * RG));
  float disc = r * r * (mu * mu - 1.0) + RT * RT;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dmin = RT - r, dmax = rho + H;
  return toSubUV(vec2((d - dmin) / max(dmax - dmin, 1e-6), rho / H), TRANS_SIZE);
}
vec3 transmittance(float r, float mu) { return textureLod(uTransLUT, transUV(clamp(r, RG + 1e-4, RT), mu), 0.0).rgb; }
float earthShadow(float r, float mu) {
  float muH = -sqrt(max(0.0, 1.0 - (RG * RG) / (r * r)));
  return smoothstep(muH - 0.0045, muH + 0.0045, mu);     // the sun's 0.27° radius softens the terminator
}
vec3 sunTrans(float r, float mu) { return transmittance(r, mu) * earthShadow(r, mu); }

float phaseRay(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float phaseMie(float c) {                    // Cornette-Shanks, g 0.8
  const float g = 0.8; float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float hgPhase(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }

vec3 msTerm(float r, float muS) {           // Ψms (Hillaire §5.5): multi-scattered luminance transfer
#if MULTI_SCATTER
  vec2 uv = toSubUV(vec2(clamp(muS * 0.5 + 0.5, 0.0, 1.0), clamp((r - RG) / (RT - RG), 0.0, 1.0)), MS_SIZE);
  return textureLod(uMSLUT, uv, 0.0).rgb;
#else
  // constant isotropic term (fx sky.multiScatter off), shaped by the sun's own transmittance so twilight still
  // fades smoothly; calibrated against the LUT (tests/sky/run.js, S8 notes)
  float h = clamp(r - RG, 0.0, 60.0);
  return vec3(0.0180, 0.0290, 0.0480) * exp(-h / 9.0) * smoothstep(-0.32, 0.12, muS) * (0.35 + 0.65 * transmittance(r, max(muS, 0.02)));
#endif
}

// sky-view LUT lookup: radiance (scaled) of the cloud-free atmosphere seen from the ground along rd
uniform vec3 uSunW;                       // world sun direction (+Y up)
vec3 skyView(vec3 rd) {
  float viewR = RG + VIEW_H;
  float vHorizon = sqrt(viewR * viewR - RG * RG);
  float beta = acos(vHorizon / viewR);
  float zha = PI - beta;
  float vz = acos(clamp(rd.y, -1.0, 1.0));
  float v;
  if (vz < zha) { float c = 1.0 - vz / zha; v = (1.0 - sqrt(max(c, 0.0))) * 0.5; }
  else { float c = (vz - zha) / beta; v = sqrt(clamp(c, 0.0, 1.0)) * 0.5 + 0.5; }
  vec2 a = rd.xz, s = uSunW.xz;
  float la = length(a), ls = length(s);
  float cosLV = (la > 1e-5 && ls > 1e-5) ? dot(a, s) / (la * ls) : 1.0;
  float u = sqrt(clamp(0.5 - 0.5 * cosLV, 0.0, 1.0));
  return textureLod(uSkyViewLUT, toSubUV(vec2(u, v), SV_SIZE), 0.0).rgb * uSunIrr;
}
`;

// ---------------------------------------------------------------------------------------------------------------
// LUT passes
const TRANS_FRAG = /* glsl */`
${ATMO}
varying vec2 vUv;
void main() {
  vec2 uv = fromSubUV(vUv, TRANS_SIZE);
  float H = sqrt(RT * RT - RG * RG);
  float rho = H * uv.y;
  float r = sqrt(rho * rho + RG * RG);
  float dmin = RT - r, dmax = rho + H;
  float d = dmin + uv.x * (dmax - dmin);
  float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0), rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  float tMax = raySphereFar(ro, rd, RT);
  const int N = 40;
  vec3 od = vec3(0.0);
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++) {
    vec3 P = ro + rd * (float(i) + 0.5) * dt;
    od += mediumExt(mediumDens(length(P) - RG)) * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

const MS_FRAG = /* glsl */`
#define MULTI_SCATTER 0
${ATMO}
varying vec2 vUv;
const float GROUND_ALBEDO = 0.12;
void main() {
  vec2 uv = fromSubUV(vUv, MS_SIZE);
  float muS = uv.x * 2.0 - 1.0;
  float r = RG + clamp(uv.y, 0.0, 1.0) * (RT - RG) + 1e-3;
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunD = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 Lsum = vec3(0.0), fsum = vec3(0.0);
  const int ND = 8, NS = 20;
  for (int i = 0; i < ND; i++) for (int j = 0; j < ND; j++) {
    float th = 2.0 * PI * (float(i) + 0.5) / float(ND);
    float ph = acos(1.0 - 2.0 * (float(j) + 0.5) / float(ND));
    vec3 rd = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
    float tG = raySphereNear(ro, rd, RG);
    float tT = raySphereFar(ro, rd, RT);
    float tMax = tG > 0.0 ? tG : tT;
    float dt = tMax / float(NS);
    vec3 thr = vec3(1.0), L = vec3(0.0), f = vec3(0.0);
    for (int k = 0; k < NS; k++) {
      vec3 P = ro + rd * (float(k) + 0.5) * dt;
      float pr = length(P);
      vec3 dn = mediumDens(pr - RG);
      vec3 sc = mediumScat(dn), ex = mediumExt(dn);
      vec3 sT = sunTrans(pr, dot(P / pr, sunD));
      vec3 S = sT * sc / (4.0 * PI);
      vec3 Ts = exp(-ex * dt);
      vec3 ex1 = max(ex, vec3(1e-7));
      L += thr * (S - S * Ts) / ex1;
      f += thr * (sc - sc * Ts) / ex1;
      thr *= Ts;
    }
    if (tG > 0.0) {
      vec3 P = ro + rd * tG; vec3 n = normalize(P);
      L += thr * sunTrans(length(P), dot(n, sunD)) * max(dot(n, sunD), 0.0) * GROUND_ALBEDO / PI;
    }
    Lsum += L; fsum += f;
  }
  Lsum /= float(ND * ND); fsum /= float(ND * ND);
  gl_FragColor = vec4(Lsum / max(vec3(1.0) - fsum, vec3(1e-3)), 1.0);
}
`;

const SKYVIEW_FRAG = /* glsl */`
${ATMO}
varying vec2 vUv;
uniform float uSunMu;
void main() {
  vec2 uv = fromSubUV(vUv, SV_SIZE);
  float viewR = RG + VIEW_H;
  float vHorizon = sqrt(viewR * viewR - RG * RG);
  float beta = acos(vHorizon / viewR);
  float zha = PI - beta;
  float vz;
  if (uv.y < 0.5) { float c = 1.0 - 2.0 * uv.y; vz = zha * (1.0 - c * c); }
  else { float c = uv.y * 2.0 - 1.0; vz = zha + beta * c * c; }
  float cosLV = 1.0 - 2.0 * uv.x * uv.x;
  float sinLV = sqrt(max(0.0, 1.0 - cosLV * cosLV));
  vec3 rd = vec3(sin(vz) * cosLV, cos(vz), sin(vz) * sinLV);
  vec3 sunD = vec3(sqrt(max(0.0, 1.0 - uSunMu * uSunMu)), uSunMu, 0.0);
  vec3 ro = vec3(0.0, viewR, 0.0);
  float tG = raySphereNear(ro, rd, RG);
  float tT = raySphereFar(ro, rd, RT);
  float tMax = tG > 0.0 ? tG : tT;
  float c = dot(rd, sunD);
  float pR = phaseRay(c), pM = phaseMie(c);
  const int N = 32;
  vec3 L = vec3(0.0), thr = vec3(1.0);
  float tPrev = 0.0;
  for (int i = 0; i < N; i++) {
    float tn = (float(i) + 0.3) / float(N);
    float t = tMax * tn * tn;
    float dt = t - tPrev; tPrev = t;
    vec3 P = ro + rd * t;
    float pr = length(P);
    vec3 dn = mediumDens(pr - RG);
    vec3 ex = mediumExt(dn);
    float muS = dot(P / pr, sunD);
    vec3 sT = sunTrans(pr, muS);
    vec3 scat = RAY_S * dn.x * pR + vec3(MIE_S) * dn.y * pM;
    vec3 S = sT * scat + msTerm(pr, muS) * mediumScat(dn);
    vec3 Ts = exp(-ex * dt);
    L += thr * (S - S * Ts) / max(ex, vec3(1e-7));
    thr *= Ts;
  }
  gl_FragColor = vec4(L, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------
// noise2D: 512² RGBA8, tileable, generated once.
//  R  low deck: Perlin-Worley (Schneider-style) with 1.5 km Worley clumps on a 12 km tile (8 cells)
//  G  mid deck: altocumulus cells, 300 m on a 4.8 km tile (16 cells) — also used as a warp field
//  B  cirrus: fibrous FBM (stretched 8 km × 0.6 km by the high-deck mapping)
//  A  detail: fine Worley-FBM erosion
const NOISE_LIB = /* glsl */`
uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return v;
}
vec2 rand2(vec2 c, int seed) {
  uvec2 h = pcg2d(uvec2(ivec2(c)) + uvec2(uint(seed) * 7919u + 17u, uint(seed) * 104729u + 3u));
  return vec2(h) * (1.0 / 4294967295.0);
}
vec3 rand3(vec3 c, int seed) {
  uvec2 a = pcg2d(uvec2(ivec2(c.xy)) + uvec2(uint(seed) * 7919u, uint(c.z) * 104729u + 11u));
  uvec2 b = pcg2d(a ^ uvec2(uint(c.z) * 2654435761u, uint(seed) * 40503u));
  return vec3(float(a.x), float(b.x), float(b.y)) * (1.0 / 4294967295.0);
}
float gnoise(vec2 p, float P, int seed) {            // periodic gradient noise, period P lattice cells
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = normalize(rand2(mod(i, P), seed) * 2.0 - 1.0 + 1e-4);
  vec2 g10 = normalize(rand2(mod(i + vec2(1, 0), P), seed) * 2.0 - 1.0 + 1e-4);
  vec2 g01 = normalize(rand2(mod(i + vec2(0, 1), P), seed) * 2.0 - 1.0 + 1e-4);
  vec2 g11 = normalize(rand2(mod(i + vec2(1, 1), P), seed) * 2.0 - 1.0 + 1e-4);
  float a = dot(g00, f), b = dot(g10, f - vec2(1, 0)), c = dot(g01, f - vec2(0, 1)), d = dot(g11, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.414;
}
float fbm(vec2 uv, float f0, int oct, int seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    float f = f0 * exp2(float(o));
    s += a * gnoise(uv * f, f, seed + o * 13); n += a; a *= 0.5;
  }
  return s / n;                                     // ~[-1, 1]
}
float worley(vec2 uv, float cells, int seed) {       // periodic F1, ~[0, 1]
  vec2 p = uv * cells, i = floor(p), f = fract(p);
  float md = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + rand2(mod(i + o, cells), seed) - f;
    md = min(md, dot(r, r));
  }
  return clamp(sqrt(md), 0.0, 1.0);
}
`;

const NOISE2D_FRAG = /* glsl */`
${NOISE_LIB}
varying vec2 vUv;
float remap(float v, float a, float b, float c, float d) { return c + (v - a) * (d - c) / (b - a); }
void main() {
  vec2 uv = vUv;
  // R: low stratocumulus
  float pf = fbm(uv, 4.0, 5, 11) * 0.5 + 0.5;
  float wf = (1.0 - worley(uv, 8.0, 21)) * 0.625 + (1.0 - worley(uv, 16.0, 22)) * 0.25 + (1.0 - worley(uv, 32.0, 23)) * 0.125;
  // FBM sets the low end (irregular gaps), Worley clumping only lifts the high end (cell vertices would otherwise
  // become a regular lattice of gaps in an overcast)
  float pw = clamp(remap(pf, wf - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  float R = clamp(mix(pf, pw, smoothstep(0.45, 0.75, pf)) * 0.85 + wf * 0.15 * smoothstep(0.35, 0.7, pf), 0.0, 1.0);
  // G: mid altocumulus (cells, gathered into patches by a broad FBM)
  // domain-warped cells of mixed size (no regular lattice), gathered into patches and soft rows by a broad FBM
  vec2 wp = vec2(fbm(uv, 4.0, 3, 91), fbm(uv + 0.37, 4.0, 3, 93)) * 0.045;
  float cell = (1.0 - worley(uv + wp, 16.0, 31)) * 0.55 + (1.0 - worley(uv * 1.0 + wp * 1.7, 24.0, 33)) * 0.45;
  float patchy = fbm(uv, 2.0, 5, 41) * 0.5 + 0.5;
  float G = clamp(pow(cell, 1.3) * 0.5 + patchy * 0.5, 0.0, 1.0);
  // B: cirrus fibres (ridged FBM)
  float c1 = fbm(uv, 4.0, 6, 51);
  float B = clamp(0.5 + 0.5 * c1 + 0.25 * (1.0 - abs(fbm(uv, 8.0, 4, 71))) - 0.12, 0.0, 1.0);
  // A: detail
  float A = clamp((1.0 - worley(uv, 32.0, 61)) * 0.3 + (fbm(uv, 16.0, 4, 81) * 0.5 + 0.5) * 0.7, 0.0, 1.0);
  gl_FragColor = vec4(R, G, B, A);
}
`;

// noise3D (fx sky.cloudRaymarch): 64³ RGBA8, one slice per draw. r = Worley-FBM erosion, g = FBM
const NOISE3D_FRAG = /* glsl */`
${NOISE_LIB}
varying vec2 vUv;
uniform float uSlice;    // 0..63
float worley3(vec3 p, float cells, int seed) {
  vec3 q = p * cells, i = floor(q), f = fract(q);
  float md = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + rand3(mod(i + o, cells), seed) - f;
    md = min(md, dot(r, r));
  }
  return clamp(sqrt(md), 0.0, 1.0);
}
float vnoise3(vec3 p, float P, int seed) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = rand3(mod(i, P), seed).x, n100 = rand3(mod(i + vec3(1,0,0), P), seed).x;
  float n010 = rand3(mod(i + vec3(0,1,0), P), seed).x, n110 = rand3(mod(i + vec3(1,1,0), P), seed).x;
  float n001 = rand3(mod(i + vec3(0,0,1), P), seed).x, n101 = rand3(mod(i + vec3(1,0,1), P), seed).x;
  float n011 = rand3(mod(i + vec3(0,1,1), P), seed).x, n111 = rand3(mod(i + vec3(1,1,1), P), seed).x;
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(vUv, (uSlice + 0.5) / 64.0);
  float w = (1.0 - worley3(p, 4.0, 5)) * 0.625 + (1.0 - worley3(p, 8.0, 6)) * 0.25 + (1.0 - worley3(p, 16.0, 7)) * 0.125;
  float v = vnoise3(p * 8.0, 8.0, 9) * 0.5 + vnoise3(p * 16.0, 16.0, 10) * 0.3 + vnoise3(p * 32.0, 32.0, 11) * 0.2;
  gl_FragColor = vec4(w, v, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Cloud decks (metres). Shared by the field pass (CDF), the coverage view, the prepass and the hemisphere pass.
const CLOUDS = /* glsl */`
uniform sampler2D uNoise2D;
uniform vec4 uDeckLow;      // base m, thickness m, threshold, tauMax
uniform vec4 uDeckMid;
uniform vec4 uDeckHigh;
uniform vec3 uSoft;         // edge softness per deck, field units
uniform vec4 uOffLM;        // low offset (m, wrapped to its tile) xy, mid offset zw
uniform vec2 uOffH;         // high offset in the cirrus frame (m, wrapped)
uniform vec4 uEvo;          // detail drift (uv, wrapped): low xy, mid zw
uniform vec2 uCirDir;       // unit xz along v300
uniform vec3 uCamM;         // camera position, m
uniform vec4 uCover;        // low, mid, high, total
uniform float uPixAng;      // pixel footprint angle (rad) for explicit mip selection
uniform vec2 uCirK;         // cirrus contrast (1 = physical, small in the signature look), extra blur factor
const float RE = 6360000.0;
const float TILE_L = 12000.0;
const float TILE_M = 4800.0;
const vec2 TILE_H = vec2(64000.0, 19200.0);

// explicit LOD from the footprint fp (m) of one pixel on the deck: no derivatives, so it is safe in loops/branches
vec4 nz(vec2 uv, float fp, float texelM) { return textureLod(uNoise2D, uv, log2(max(fp / texelM, 1.0))); }
float fieldLow(vec2 uv, float fp) {
  return nz(uv, fp, 23.44).r * 0.78 + nz(uv * 5.0 + uEvo.xy, fp, 4.69).a * 0.15 + nz(uv * 19.0 - uEvo.yx * 2.0, fp, 1.234).b * 0.07;
}
float fieldMid(vec2 uv, float fp) { return nz(uv, fp, 9.375).g * 0.74 + nz(uv * 3.0 + uEvo.zw, fp, 3.125).a * 0.26; }
// cirrus (tile 64 km along the wind × 19.2 km across; texel 37.5 m across): fibres along the wind, domain-warped twice
// (a broad across-wind meander and a finer along-wind shear) so streaks bend into hooks instead of ruled lines
float fieldHigh(vec2 uv, float fp) {
  float w = nz(uv * vec2(2.0, 1.0) + vec2(0.37, 0.11), fp, 18.75).g - 0.5;
  float h = nz(uv * vec2(1.0, 3.0) + vec2(0.71, 0.29), fp, 12.5).a - 0.5;
  return nz(uv + vec2(0.06 * h, 0.10 * w + 0.03 * h * h * sign(h)), fp, 37.5).b;
}
vec2 uvLow(vec2 xz) { return (xz - uOffLM.xy) / TILE_L; }
vec2 uvMid(vec2 xz) { return (xz - uOffLM.zw) / TILE_M; }
vec2 uvHigh(vec2 xz) { vec2 q = vec2(dot(xz, uCirDir), dot(xz, vec2(-uCirDir.y, uCirDir.x))); return (q - uOffH) / TILE_H; }

// A deck sample is (c, tau): the covered fraction c and the in-cloud vertical optical depth tau.
// At full resolution c is 0 outside the covered area (exact coverage) and its soft edge is real thinning of the cloud.
// When the field is pre-filtered (mip, footprint fp), c becomes the fraction of thick cloud in the footprint: the
// variance the filter removed (sigLost, measured per deck and footprint at init) widens the soft threshold, so a
// blurred field keeps its true mean coverage instead of vanishing (low cover) or filling in (high cover).
uniform vec3 uSigLost[15];   // per deck (r low, g mid, b high), footprint 2^k m, k = 0..14
const vec3 CELL = vec3(1500.0, 300.0, 600.0);   // typical cloud cell per deck (m), for clumpy transmittance
float sigLost(int deck, float fp) {
  float k = clamp(log2(max(fp, 1.0)), 0.0, 13.999);
  int i = int(floor(k)); float f = k - float(i);
  vec3 v = mix(uSigLost[i], uSigLost[i + 1], f);
  return deck == 0 ? v.x : (deck == 1 ? v.y : v.z);
}
// coreField: a coarse version of the field for the in-cloud thickness (gentle undulation, no cell pattern)
vec2 deckCT(float field, float coreField, vec4 deck, float soft, float sl) {
  float e = field - deck.z;
  float c = smoothstep(-2.2 * sl, soft + 2.2 * sl, e);
  float core = 0.5 + 0.5 * clamp((coreField - deck.z) / max(1.0 - deck.z, 0.25) * 1.6, 0.0, 1.0);
  float thin = mix(sqrt(c), 1.0, clamp(sl / max(soft, 1e-3), 0.0, 1.0));
  return vec2(c, deck.w * core * thin);
}
vec2 ctLowAt(vec2 xz, float fp) { vec2 uv = uvLow(xz); float f = fieldLow(uv, fp); return deckCT(f, nz(uv, max(fp, 400.0), 23.44).r, uDeckLow, uSoft.x, sigLost(0, fp)); }
vec2 ctMidAt(vec2 xz, float fp) { float f = fieldMid(uvMid(xz), fp); return deckCT(f, f, uDeckMid, uSoft.y, sigLost(1, fp)); }
vec2 ctHighAt(vec2 xz, float fp) {
  float f = fieldHigh(uvHigh(xz), fp);
  // a 37 km field that matches neither tile period: cirrus comes in bands and gaps, and the tile never repeats visibly
  float b = textureLod(uNoise2D, xz / 37000.0 + vec2(0.31, 0.67), log2(max(fp / 72.0, 1.0))).r;
  f += 0.30 * (b - 0.5);
  return deckCT(f, f, uDeckHigh, uSoft.z, sigLost(2, fp));
}
vec2 ctDeck(int which, vec2 xz, float fp) { return which == 0 ? ctLowAt(xz, fp) : (which == 1 ? ctMidAt(xz, fp) : ctHighAt(xz, fp)); }
// transmittance of a clumpy deck along a path: pf = path length / thickness, n = independent cells crossed
float clumpyT(vec2 ct, float pf, float n) {
  float hit = 1.0 - pow(1.0 - clamp(ct.x, 0.0, 1.0), n);
  return 1.0 - hit * (1.0 - exp(-ct.y * pf));
}
// mean vertical optical depth (light taps)
float tauLowAt(vec2 xz, float fp) { vec2 ct = ctLowAt(xz, fp); return ct.x * ct.y; }
float tauMidAt(vec2 xz, float fp) { vec2 ct = ctMidAt(xz, fp); return ct.x * ct.y; }

// distance along a ray (cosine mu to the vertical at the eye, eye height hc m) to the shell at height h; -1 if none
float shellHit(float hc, float mu, float h) {
  float r0 = RE + hc;
  float b = r0 * mu;
  float c = (hc - h) * (2.0 * RE + hc + h);
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  if (c < 0.0) return (-c) / (b + s);        // inside the shell
  if (b >= 0.0) return -1.0;                   // above it and looking up
  return c / (-b + s);
}

// Light leaving the underside of a deck toward the eye, for a pixel whose ray hits cloud with probability hit.
//  tau: in-cloud vertical optical depth; Tc: in-cloud transmittance along the view; tauSun: optical depth toward the
//  sun (light taps); muV: view cosine at the base; Esun: sun irradiance at the deck top (rgb); Lsky: sky radiance
//  above (isotropic). Tv returns the pixel's transmittance through the deck.
vec3 deckEmit(float tau, float Tc, float hit, float tauSun, float muV, float muS, float cosT, vec3 Esun, vec3 Lsky, float angK, out float Tv) {
  Tv = 1.0 - hit * (1.0 - Tc);
  float ms = max(muS, 0.0);
  float ph = mix(hgPhase(cosT, 0.6), hgPhase(cosT, -0.3), 0.3);
  float powder = 1.0 - exp(-2.0 * tau);
  vec3 L = Esun * ph * (1.0 - Tc) * exp(-tauSun) * (0.5 + 0.5 * powder);
#if SILVER
  L += Esun * hgPhase(cosT, 0.85) * 0.5 * (1.0 - Tc) * exp(-1.2 * tau - tauSun);   // silver lining at thin edges
#endif
  float Td = 1.0 / (1.0 + 0.1125 * tau);                     // two-stream diffuse transmission, g 0.85
  vec3 Ed = Esun * ms * max(Td - exp(-tau / max(ms, 0.05)), 0.0) + Lsky * PI * max(Td - exp(-1.66 * tau), 0.0);
  float ang = (1.0 + angK * clamp(muV, 0.0, 1.0)) / (1.0 + angK * 0.6667);   // CIE-like base radiance shape
  return hit * (L + Ed / PI * ang);
}
vec3 sunAt(float hM) { return uSunIrr * sunTrans(RG + hM * 1e-3, uSunW.y); }
`;

// The full sky function (atmosphere + decks + aerial fade). Used by the prepass and the hemisphere pass.
const SKYFULL = /* glsl */`
#ifndef ANG_K
#define ANG_K 1.25
#endif
float viewMuAt(vec3 rd, float t, float h) { return (dot(rd, uCamM) + RE * rd.y + t) / (RE + h); }

// A deck seen along the view ray through its slab [base, base + thickness] (2-D decks; fx sky.cloudRaymarch replaces
// the low deck with a true volume). Straight up it is the exact single-point field. Toward the horizon one sample at
// the slab middle is pre-filtered over part of the slant traverse with the coverage-preserving threshold, and the
// clumpy hit probability 1 - (1 - c)^n over the n cells the ray crosses closes the gaps (a real 500 m deck shows its
// sides there). One sample, so nothing ghosts or stripes. Returns (c, tau); P = slab mid point, t0 = entry
// distance, muV = view cosine at the base, pf = path length / thickness, n = cloud cells crossed.
vec2 slabCT(int which, vec3 rd, float hc, vec4 deck, out vec3 P, out float t0, out float muV, out float pf, out float n) {
  muV = 1.0; pf = 1.0; n = 1.0;
  t0 = shellHit(hc, rd.y, deck.x);
  P = uCamM + rd * max(t0, 0.0);
  if (t0 <= 0.0) return vec2(0.0);
  float t1 = shellHit(hc, rd.y, deck.x + deck.y);
  float len = t1 > t0 ? t1 - t0 : deck.y;
  P = uCamM + rd * (t0 + 0.5 * len);
  float hl = min(length(rd.xz) * len, 12000.0);
  muV = viewMuAt(rd, t0, deck.x);
  pf = min(len / deck.y, 40.0);
  float cell = which == 0 ? CELL.x : (which == 1 ? CELL.y : CELL.z);
  n = 1.0 + hl / cell;
  float fp = max(t0 * uPixAng / sqrt(max(muV, 0.02)), 0.18 * hl * smoothstep(0.6, 0.15, muV));
  if (which == 2) {
    // cirrus: the mip follows the footprint's LONG axis (1/muV at grazing angles; the fibres are thin across) and the
    // look's blur; beyond ~15 km or below muV 0.08 the streaks converge faster than any filter can hold, so they fade
    // to the deck's mean (no moiré at the horizon)
    fp = max(t0 * uPixAng / max(muV, 0.02), 0.25 * hl * smoothstep(0.6, 0.15, muV)) * uCirK.y;
    vec2 ct = ctDeck(2, P.xz, fp);
    float k = uCirK.x * smoothstep(0.06, 0.16, muV) * (1.0 - smoothstep(15000.0, 45000.0, t0));
    return vec2(mix(uCover.z, ct.x, k), ct.y);
  }
  return ctDeck(which, P.xz, fp);
}
// sun transmittance through a deck from a point at height h0 below it (clumpy, blurred)
float sunThrough(int which, vec2 xz, float h0, vec4 deck, vec2 sunXZ, float cotS, float sm) {
  // a low sun crosses deck.y·cot(alt) of the deck: its transmittance is the average over that traverse, not the
  // field at one point (which would print the upper deck's cells onto the lower one)
  vec2 ct = ctDeck(which, xz + sunXZ * min((deck.x + 0.5 * deck.y - h0) * cotS, 60000.0), max(600.0, 0.5 * min(deck.y * cotS, 30000.0)));
  float cell = which == 0 ? CELL.x : (which == 1 ? CELL.y : CELL.z);
  return clumpyT(ct, 1.0 / sm, 1.0 + min(deck.y * cotS, 12000.0) / cell);
}

// clear-sky radiance seen by a deck's top, averaged over the sky (zenith, and 25° up toward and away from the sun):
// the zenith alone is too dim and too blue-starved to balance a low, warm sun
vec3 skyDiffuse() {
  float l = length(uSunW.xz);
  vec2 s = l > 1e-4 ? uSunW.xz / l : vec2(1.0, 0.0);
  const float c = 0.9063, sn = 0.4226;
  return (skyView(vec3(0.0, 1.0, 0.0)) + skyView(vec3(s.x * c, sn, s.y * c)) + skyView(vec3(-s.x * c, sn, -s.y * c))) / 3.0;
}
// radiance toward the horizon at the azimuth of rd, under the expected (mean) decks
vec3 horizonRadiance(vec3 rd) {
  vec3 d = normalize(vec3(rd.x, 0.0, rd.z) + vec3(0.0, 0.0045, 0.0));
  vec3 L = skyView(d);
  vec3 Lz = skyDiffuse();
  float muS = uSunW.y, cosT = dot(d, uSunW), Tv;
  float sm = max(muS, 0.06);
  float tH = uDeckHigh.w * 0.8, tM = uDeckMid.w * 0.85, tL = uDeckLow.w * 0.86;
  float sH = 1.0 - uCover.z * (1.0 - exp(-tH / sm)), sM = 1.0 - uCover.y * (1.0 - exp(-tM / sm));
  // at the horizon a ray crosses ~12 km of each slab: hit probability 1 - (1 - cover)^n
  float hH = 1.0 - pow(1.0 - uCover.z, 1.0 + 12000.0 / CELL.z);
  float hM = 1.0 - pow(1.0 - uCover.y, 1.0 + 12000.0 / CELL.y);
  float hL = 1.0 - pow(1.0 - uCover.x, 1.0 + 12000.0 / CELL.x);
#if CIRRUS
  vec3 Eh = deckEmit(tH, exp(-tH * 20.0), hH, tH * 0.5 / sm, 0.05, muS, cosT, sunAt(uDeckHigh.x), Lz, ANG_K, Tv);
  L = L * Tv + Eh;
#endif
  vec3 Em = deckEmit(tM, exp(-tM * 20.0), hM, tM * 0.5 / sm, 0.05, muS, cosT, sunAt(uDeckMid.x) * sH, Lz, ANG_K, Tv);
  L = L * Tv + Em;
  vec3 El = deckEmit(tL, exp(-tL * 20.0), hL, tL * 0.5 / sm, 0.05, muS, cosT, sunAt(uDeckLow.x) * sH * sM, Lz * mix(1.0, 0.55, uCover.y), ANG_K, Tv);
  return L * Tv + El;
}

#if RAYMARCH
// Low deck as a true volume (fx sky.cloudRaymarch, high quality). The 2-D field says where cloud is (its base keeps
// the exact coverage) and how tall it grows: flat base, rounded top, thicker clouds reach higher (stratocumulus /
// cumulus). A 64³ Worley-FBM erodes the edges. 12 view steps (jittered), 3 light steps, 2-octave multiple scattering.
uniform highp sampler3D uNoise3D;
uniform float uJitter;
float lowAlt(vec3 p) { return p.y + dot(p.xz, p.xz) / (2.0 * RE); }   // altitude above the curved ground
uniform vec2 uLowB;   // volume: threshold of the low field at a 256 m footprint (exact coverage there), its range
float lowDensity(vec3 p, float h, float fp) {
  if (h <= 0.0 || h >= 1.0) return 0.0;
  // one smoothed field (256 m) sets both where the cloud is and how tall it grows, so nothing extrudes into towers;
  // the cauliflower detail comes from the 3-D erosion only. Dome-shaped tops (circular profile), flat base.
  float e = fieldLow(uvLow(p.xz), max(fp, 256.0)) - uLowB.x;
  float cov = smoothstep(-0.01, 0.06, e);
  if (cov <= 0.0) return 0.0;
  float s = clamp(e / uLowB.y, 0.0, 1.0);
  float topH = 0.18 + 0.82 * sqrt(s * (2.0 - s));
  float prof = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(topH * 0.55, topH, h)) * cov;
  if (prof <= 0.0) return 0.0;
  vec3 q = vec3((p.x - uOffLM.x) / 1500.0, h * uDeckLow.y / 380.0, (p.z - uOffLM.y) / 1500.0) + vec3(uEvo.x, 0.0, uEvo.y) * 3.0;
  float nE = textureLod(uNoise3D, q, 0.0).r * 0.65 + textureLod(uNoise3D, q * 3.1 + 0.37, 0.0).g * 0.35;
  float er = (1.0 - nE) * mix(0.75, 0.15, prof) * (0.45 + 0.55 * h);   // erode edges and tops, keep the base
  return clamp(prof - er, 0.0, 1.0);
}
bool marchLow(vec3 rd, float hc, float cosT, float muS, vec3 Esun, vec3 Lamb, out vec3 Lout, out float Tout, out float tHit) {
  Lout = vec3(0.0); Tout = 1.0; tHit = -1.0;
  float t0 = shellHit(hc, rd.y, uDeckLow.x);
  if (t0 <= 0.0) return false;
  float t1 = shellHit(hc, rd.y, uDeckLow.x + uDeckLow.y);
  float len = min(t1 > t0 ? t1 - t0 : uDeckLow.y, 16000.0);
  vec3 Pm = uCamM + rd * (t0 + 0.5 * len);
  if (ctLowAt(Pm.xz, max(0.5 * length(rd.xz) * len, 60.0)).x <= 0.0) return false;   // nothing anywhere on the traverse
  tHit = t0;
  float muV = viewMuAt(rd, t0, uDeckLow.x);
  float fp = t0 * uPixAng / sqrt(max(muV, 0.02));
  const int NV = 12;
  float dt = len / float(NV);
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uJitter);
  float sigMax = uDeckLow.w / uDeckLow.y * 1.4;                  // extinction per metre at full density
  float g1 = mix(hgPhase(cosT, 0.6), hgPhase(cosT, -0.3), 0.3);
  float g2 = mix(hgPhase(cosT, 0.3), hgPhase(cosT, -0.15), 0.3);
  float lsl = min(uDeckLow.y / max(muS, 0.08), 1800.0) / 3.0;  // light step along the sun
  for (int i = 0; i < NV; i++) {
    vec3 p = uCamM + rd * (t0 + (float(i) + j) * dt);
    float h = (lowAlt(p) - uDeckLow.x) / uDeckLow.y;
    float d = lowDensity(p, h, fp + float(i) * dt * uPixAng);
    if (d <= 0.002) continue;
    float od = 0.0;
    for (int k = 1; k <= 3; k++) {
      vec3 q = p + uSunW * lsl * float(k);
      od += lowDensity(q, (lowAlt(q) - uDeckLow.x) / uDeckLow.y, 80.0 + fp) * sigMax * lsl;
    }
    float powder = 1.0 - exp(-2.0 * d * sigMax * dt);
    // single + 2 octaves of multiple scattering, plus two-stream diffusion for the optically thick interior
    // (od·μs = vertical optical depth to the top; Td as in the 2-D decks), so an overcast base is lit grey, not blue
    float odV = od * max(muS, 0.05);
    float Td = 1.0 / (1.0 + 0.1125 * odV);
    vec3 S = Esun * (g1 * exp(-od) * mix(0.6, 1.0, powder) + 0.5 * g2 * exp(-0.25 * od) + 0.25 * 0.0796 * exp(-0.0625 * od)
                     + max(muS, 0.0) * Td / PI)
           + Lamb * mix(0.35, 1.0, h) * mix(1.0, Td, 0.5);
    float a = 1.0 - exp(-d * sigMax * dt);
    Lout += Tout * a * S;
    Tout *= 1.0 - a;
    if (Tout < 0.01) { Tout = 0.0; break; }   // opaque: no residual (a thick deck must hide the sun disc)
  }
  return true;
}
#endif

vec3 skyFull(vec3 rd, out float Tview) {
  Tview = 1.0;
  vec3 Lhor = horizonRadiance(rd);
  if (rd.y <= 0.0) return Lhor;
  vec3 Lclear = skyView(rd);
  vec3 L = Lclear;
  vec3 Lz = skyDiffuse();
  float hc = max(uCamM.y, 0.5);
  float muS = uSunW.y, cosT = dot(rd, uSunW);
  float sm = max(muS, 0.06);
  float lsx = length(uSunW.xz);
  vec2 sunXZ = lsx > 1e-4 ? uSunW.xz / lsx : vec2(0.0);
  float cotS = clamp(lsx / max(muS, 1e-3), 0.0, 60.0);
  float Tv, t0, muV, pf, n;
  vec3 P;
  // HIGH: cirrus (thin ice; strong forward scatter)
#if CIRRUS
  if (uCover.z > 0.0) {
    vec2 ct = slabCT(2, rd, hc, uDeckHigh, P, t0, muV, pf, n);
    if (ct.x > 0.0) {
      float hit = 1.0 - pow(1.0 - ct.x, n);
      vec3 E = deckEmit(ct.y, exp(-ct.y * pf), hit, ct.y * 0.5 / sm, muV, muS, cosT, sunAt(uDeckHigh.x), Lz, ANG_K, Tv);
      L = L * Tv + E; Tview *= Tv;
    }
  }
#endif
  // MID: altocumulus
  if (uCover.y > 0.0) {
    vec2 ct = slabCT(1, rd, hc, uDeckMid, P, t0, muV, pf, n);
    if (ct.x > 0.0) {
      float sT = 1.0;
#if CIRRUS
      sT = sunThrough(2, P.xz, uDeckMid.x, uDeckHigh, sunXZ, cotS, sm);
#endif
      float tS = ct.y * 0.5;
#if LIGHT_TAPS > 0
      float acc = 0.0;
      for (int k = 1; k <= LIGHT_TAPS; k++) acc += tauMidAt(P.xz + sunXZ * min(uDeckMid.y * 0.5 * cotS * float(k) / float(LIGHT_TAPS), 2500.0), 40.0);
      tS = 0.5 * (ct.y * 0.4 + 0.6 * acc / float(LIGHT_TAPS));
#endif
      float hit = 1.0 - pow(1.0 - ct.x, n);
      vec3 E = deckEmit(ct.y, exp(-ct.y * pf), hit, tS / sm, muV, muS, cosT, sunAt(uDeckMid.x) * sT, Lz, ANG_K, Tv);
      L = L * Tv + E; Tview *= Tv;
    }
  }
  // LOW: stratocumulus
  float tLow = shellHit(hc, rd.y, uDeckLow.x);
#if RAYMARCH
  if (uCover.x > 0.0) {
    vec3 Pc = uCamM + rd * max(tLow, 0.0);
    float sT = sunThrough(1, Pc.xz, uDeckLow.x, uDeckMid, sunXZ, cotS, sm);
#if CIRRUS
    sT *= sunThrough(2, Pc.xz, uDeckLow.x, uDeckHigh, sunXZ, cotS, sm);
#endif
    vec3 Lm; float Tm, tH;
    if (marchLow(rd, hc, cosT, muS, sunAt(uDeckLow.x) * sT, Lz * mix(1.0, 0.55, uCover.y), Lm, Tm, tH)) { L = L * Tm + Lm; Tview *= Tm; }
  }
#else
  if (uCover.x > 0.0) {
    vec2 ct = slabCT(0, rd, hc, uDeckLow, P, t0, muV, pf, n);
    if (ct.x > 0.0) {
      float sT = sunThrough(1, P.xz, uDeckLow.x, uDeckMid, sunXZ, cotS, sm);
#if CIRRUS
      sT *= sunThrough(2, P.xz, uDeckLow.x, uDeckHigh, sunXZ, cotS, sm);
#endif
      float tS = ct.y * 0.5;
#if LIGHT_TAPS > 0
      float acc = 0.0;
      for (int k = 1; k <= LIGHT_TAPS; k++) acc += tauLowAt(P.xz + sunXZ * min(uDeckLow.y * 0.5 * cotS * float(k) / float(LIGHT_TAPS), 3000.0), 60.0);
      tS = 0.5 * (ct.y * 0.4 + 0.6 * acc / float(LIGHT_TAPS));
#endif
      float hit = 1.0 - pow(1.0 - ct.x, n);
      vec3 skyAbove = Lz * mix(1.0, 0.55, uCover.y);
      vec3 E = deckEmit(ct.y, exp(-ct.y * pf), hit, tS / sm, muV, muS, cosT, sunAt(uDeckLow.x) * sT, skyAbove, ANG_K, Tv);
      L = L * Tv + E; Tview *= Tv;
    }
  }
#endif
  // aerial fade of the cloud light toward the horizon radiance (SPEC §5.3: exp(-dist / 30 km))
  float dist = tLow > 0.0 ? tLow : 1e6;
  float F = exp(-dist / 30000.0);
  vec3 target = Lhor * (1.0 - Tview) + Lclear * Tview;
  return mix(target, L, F);
}
`;

// skyRT prepass: one ray per skyRT pixel through the current camera
const PREPASS_FRAG = /* glsl */`
${ATMO}
${CLOUDS}
${SKYFULL}
varying vec2 vUv;
uniform mat4 uClipToDir;
uniform sampler2D uPrevSky;   // previous skyRT (temporal accumulation of the jittered volume)
uniform mat4 uPrevVP;         // previous projection × view (directions)
uniform float uHistory;       // 0 = no history this frame
void main() {
  vec4 p = uClipToDir * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(p.xyz / p.w);
  float Tv;
  vec3 L = skyFull(rd, Tv);
  vec4 o = vec4(L, Tv);
#if RAYMARCH
  vec4 c = uPrevVP * vec4(rd, 0.0);
  vec2 puv = c.xy / c.w * 0.5 + 0.5;
  if (uHistory > 0.0 && c.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)))) {
    vec4 h = textureLod(uPrevSky, puv, 0.0);
    o = mix(o, h, uHistory);
  }
#endif
  gl_FragColor = o;
}
`;

// hemisphere pass: 64 azimuths × 32 elevation bands of the upper hemisphere (for Lref, irradiance and the profile)
const HEMI_FRAG = /* glsl */`
${ATMO}
${CLOUDS}
${SKYFULL}
varying vec2 vUv;
void main() {
  float az = vUv.x * 2.0 * PI;
  float el = vUv.y * 0.5 * PI;
  vec3 rd = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  float Tv;
  vec3 L = skyFull(rd, Tv);
  gl_FragColor = vec4(L, Tv);
}
`;

// row means of the hemisphere (parallel reduction step): 32 × 1, rgb = mean radiance of row r, a = mean view T
const ROWS_FRAG = /* glsl */`
uniform sampler2D uHemi;      // 64 × 32
void main() {
  int r = int(gl_FragCoord.x);
  vec4 s = vec4(0.0);
  for (int x = 0; x < 64; x++) s += texelFetch(uHemi, ivec2(x, r), 0);
  gl_FragColor = s / 64.0;
}
`;

// stats: row 0 = elevation profile (16 bands, azimuth mean); row 1 = [Lref, skyUp, sunColor, skyDown, horizon,
// zenith, debug, -]; exponentially blended with the previous stats (uAlpha) so Lref never flickers.
const STATS_FRAG = /* glsl */`
${ATMO}
${CLOUDS}
${SKYFULL}
uniform sampler2D uRows;      // 32 × 1 row means of the 64 × 32 hemisphere
uniform sampler2D uPrev;      // previous stats
uniform float uAlpha;
uniform float uGroundAlbedo;
uniform vec3 uFlockPos;       // m
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec4 row(int r) { return texelFetch(uRows, ivec2(r, 0), 0); }
vec3 band(int b) { return 0.5 * (row(2 * b).rgb + row(2 * b + 1).rgb); }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 o = vec4(0.0);
  if (px.y == 0) {
    vec3 b = band(px.x);
    o = vec4(b, dot(b, LUMA));
  } else {
    if (px.x <= 1 || px.x == 3) {
      // solid-angle mean (Lref) and cosine-weighted irradiance / π (skyUp)
      vec3 sw = vec3(0.0), si = vec3(0.0); float nw = 0.0, ni = 0.0;
      for (int r = 0; r < 32; r++) {
        float el = (float(r) + 0.5) / 32.0 * 0.5 * PI;
        vec3 m = row(r).rgb;
        sw += m * cos(el); nw += cos(el);
        si += m * sin(el) * cos(el); ni += sin(el) * cos(el);
      }
      vec3 v = px.x == 0 ? sw / nw : si / ni;
      if (px.x == 3) {
        float muS = uSunW.y;
        vec3 sun = texelFetch(uPrev, ivec2(2, 1), 0).rgb;            // last sun colour (stats are smoothed anyway)
        v = uGroundAlbedo * (si / ni + sun * max(muS, 0.0));
      }
      o = vec4(v, dot(v, LUMA));
    } else if (px.x == 2) {
      float muS = uSunW.y;
      float sm = max(muS, 0.02);
      float lsx = length(uSunW.xz);
      vec2 sunXZ = lsx > 1e-4 ? uSunW.xz / lsx : vec2(0.0);
      float cotS = clamp(lsx / max(muS, 1e-3), 0.0, 60.0);
      float hp = uFlockPos.y;
      float T = 1.0;
      if (uCover.x > 0.0) T *= sunThrough(0, uFlockPos.xz, hp, uDeckLow, sunXZ, cotS, sm);
      if (uCover.y > 0.0) T *= sunThrough(1, uFlockPos.xz, hp, uDeckMid, sunXZ, cotS, sm);
      if (uCover.z > 0.0) T *= sunThrough(2, uFlockPos.xz, hp, uDeckHigh, sunXZ, cotS, sm);
      vec3 sun = uSunIrr * sunTrans(RG + hp * 1e-3, muS) * T / PI;
      o = vec4(sun, T);
    } else if (px.x == 4) { vec3 b = band(0); o = vec4(b, dot(b, LUMA)); }
    else if (px.x == 5) { vec3 b = band(15); o = vec4(b, dot(b, LUMA)); }
    else if (px.x == 6) {
      float m = 0.0;
      for (int r = 0; r < 32; r++) m += row(r).a;
      o = vec4(m / 32.0, uCover.x, uCover.y, uCover.z);
    }
  }
  vec4 prev = texelFetch(uPrev, px, 0);
  gl_FragColor = (px.y == 1 && px.x == 6) ? o : mix(prev, o, uAlpha);
}
`;

// field pass: each deck's field over one tile (for the inverse-CDF LUT) and the coverage masks (S4)
const FIELD_FRAG = /* glsl */`
${ATMO}
${CLOUDS}
varying vec2 vUv;
uniform int uMode;           // 0 = raw fields (footprint uFP), 1 = coverage masks (field > threshold)
uniform float uFP;
void main() {
  float l = fieldLow(vUv, uFP), m = fieldMid(vUv, uFP), h = fieldHigh(vUv, uFP);
  if (uMode == 0) gl_FragColor = vec4(l, m, h, 1.0);
  else gl_FragColor = vec4(l > uDeckLow.z ? 1.0 : 0.0, m > uDeckMid.z ? 1.0 : 0.0, h > uDeckHigh.z ? 1.0 : 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------
// background quad (scene pass, renderOrder -1000): bilinear upsample of skyRT, sun disc (physical), debug views
const BG_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.99999, 1.0); }
`;
const BG_FRAG = /* glsl */`
${ATMO}
${CLOUDS}
varying vec2 vUv;
uniform sampler2D uSkyTex;
uniform vec2 uRes;            // render size
uniform mat4 uClipToDir;
uniform int uSunDisc;         // 1 = draw the sun disc (physical look)
uniform int uDebug;           // 0 off, 1 coverage, 2 lut, 3 transmittance, 10/11/12 deck low/mid/high
uniform float uFrame;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 suv = gl_FragCoord.xy / uRes;
  vec4 s = textureLod(uSkyTex, suv, 0.0);
  vec3 col = s.rgb;
  vec4 p = uClipToDir * vec4(suv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(p.xyz / p.w);
  // sun disc (physical look): only above the true sea horizon (geometric dip from the eye height), dimmed by the decks
  // along the view (s.a) and gone under a near-closed low deck; reddened by the path, never clipped flat, with a glow
  float dip = sqrt(2.0 * max(uCamM.y, 0.5) / RE);
  float lowGone = 1.0 - smoothstep(0.6, 0.8, uCover.x);
  if (uSunDisc == 1 && uSunW.y > -dip - 0.01 && lowGone > 0.0) {
    float c = dot(rd, uSunW);
    vec3 sunT = uSunIrr * sunTrans(RG + VIEW_H, max(uSunW.y, -dip)) * s.a * lowGone;
    float hor = smoothstep(-dip - 0.0006, -dip + 0.0006, rd.y);
    const float cosR = 0.99998889;           // 0.27°
    if (c > cosR - 4e-6) {
      float x = clamp((1.0 - c) / (1.0 - cosR), 0.0, 1.0);
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - x)));
      float edge = smoothstep(cosR - 4e-6, cosR + 2e-6, c);
      vec3 sunL = sunT / 6.8e-5 * limb;
      float l = dot(sunL, vec3(0.2126, 0.7152, 0.0722));
      col += sunL / (1.0 + l / 400.0) * edge * hor;       // soft-limited: keeps the path's hue, no flat white block
    }
    float a = acos(clamp(c, -1.0, 1.0));
    col += sunT * (0.6 * exp(-a / 0.012) + 0.12 * exp(-a / 0.06)) * hor;   // aureole
  }
  if (uDebug == 1) {                         // coverage: three top-down tiles, deck low / mid / high
    vec2 q = vec2(vUv.x * 3.0, vUv.y * 1.6 - 0.3);
    int k = int(floor(q.x));
    vec2 t = vec2(fract(q.x), q.y);
    col = vec3(0.12);
    if (t.y >= 0.0 && t.y <= 1.0 && t.x > 0.02 && t.x < 0.98) {
      vec2 uv = vec2((t.x - 0.02) / 0.96, t.y);
      float f = k == 0 ? fieldLow(uv, 0.0) : (k == 1 ? fieldMid(uv, 0.0) : fieldHigh(uv, 0.0));
      float thr = k == 0 ? uDeckLow.z : (k == 1 ? uDeckMid.z : uDeckHigh.z);
      col = f > thr ? vec3(0.95) : vec3(0.05 + 0.25 * f);
    }
  } else if (uDebug == 2) {
    col = texture(uSkyViewLUT, vUv).rgb * uSunIrr * 0.6;
  } else if (uDebug == 3) {
    col = texture(uTransLUT, vUv).rgb;
  }
  col += (ign(gl_FragCoord.xy) - 0.5) * 1e-4 * dot(col, vec3(0.3333));   // de-band the upsample
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------
// ground (scene pass): dark, desaturated, aerial-fogged to exactly the sky behind it; sea = sky fresnel
const GROUND_VERT = /* glsl */`
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const GROUND_FRAG = /* glsl */`
${LIGHT}
varying vec3 vW;
uniform sampler2D uSkyTex;
uniform sampler2D uStats;
uniform sampler2D uNoise2D;
uniform vec2 uRes;
uniform vec3 uAlbedo;
uniform float uType;          // 0 sea, 1 reedbed, 2 field, 3 city
uniform float uRadius;
uniform vec2 uWave;           // wave scroll (uv, wrapped)
uniform float uPixAng;        // camera pixel angle (rad)
vec3 profileAt(float el) {    // azimuth-mean sky radiance at elevation el (rad), from the stats row
  float b = clamp(el / (0.5 * 3.14159265) * 16.0 - 0.5, 0.0, 15.0);
  int i = int(floor(b)); float f = b - float(i);
  return mix(texelFetch(uStats, ivec2(i, 0), 0).rgb, texelFetch(uStats, ivec2(min(i + 1, 15), 0), 0).rgb, f);
}
// noise at a world scale (m per tile), mip chosen from the pixel footprint so the ground never aliases
vec4 gz(vec2 xz, float tileM, float fp) { return textureLod(uNoise2D, xz / tileM, log2(max(fp / (tileM / 512.0), 1.0))); }
void main() {
  vec3 d = vW - cameraPosition;
  float dist = length(d);
  vec3 v = d / max(dist, 1e-3);
  float fp = dist * uPixAng / max(abs(v.y), 0.03);
  vec2 xz = vW.xz;
  vec3 alb = uAlbedo;
  // large → small tonal variation, each scale fading out (to its mean) as it would alias
  float big = gz(xz, 9000.0, fp).r, mid = gz(xz + 311.0, 2200.0, fp).r, fine = gz(xz - 97.0, 420.0, fp).a;
  alb *= mix(0.72, 1.28, big) * mix(0.86, 1.14, mid) * mix(0.9, 1.1, fine);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float wet = 0.0;
  if (uType < 0.5) wet = 1.0;                                   // sea
  else if (uType < 1.5) {                                       // reedbed: streaky reeds, open pools
    float pool = gz(xz + 1700.0, 2600.0, fp).r;
    wet = smoothstep(0.34, 0.30, pool);
    float streak = gz(vec2(xz.x * 0.35, xz.y) - 53.0, 260.0, fp).b;
    alb *= mix(0.85, 1.15, streak);
  } else if (uType < 2.5) {                                     // fields: a soft patchwork
    float cell = gz(xz + 5000.0, 6000.0, fp).g;
    alb *= mix(0.8, 1.2, smoothstep(0.35, 0.75, cell));
  } else {                                                      // city: grey blocks
    float blk = gz(floor(xz / 60.0) * 60.0, 4000.0, max(fp, 60.0)).a;
    alb *= mix(0.75, 1.2, blk);
  }
  vec3 col = alb * (uSkyUp + uSunColor * max(uSunDir.y, 0.0));
  if (wet > 0.0) {
    float fade = exp(-fp / 3.0);                                  // waves only where they resolve
    vec2 w1 = gz(xz + uWave * 180.0, 180.0, fp).ga - 0.5;
    vec2 w2 = gz(xz - uWave * 300.0, 47.0, fp).ga - 0.5;
    vec3 nw = normalize(vec3((w1.x + 0.6 * w2.x) * 0.3 * fade, 1.0, (w1.y + 0.6 * w2.y) * 0.3 * fade));
    vec3 r = reflect(v, nw);
    float cosI = max(dot(-v, nw), 0.0);
    float F = 0.02 + 0.40 * pow(1.0 - cosI, 5.0);   // a wind-roughened sea is no mirror at grazing angles (Cox–Munk)
    vec3 water = vec3(0.010, 0.013, 0.015) * (uSkyUp + uSunColor * max(uSunDir.y, 0.0));
    vec3 wcol = mix(water, profileAt(asin(clamp(abs(r.y), 0.0, 1.0))), F);
    col = mix(col, wcol, wet);
  }
  vec3 behind = textureLod(uSkyTex, gl_FragCoord.xy / uRes, 0.0).rgb;   // the sky at this pixel = horizon radiance below it
  float T = exp(-uExtinction * dist) * smoothstep(uRadius, uRadius * 0.55, length(vW.xz));
  // low-lying marine / evening mist: grazing rays cross far more of it, so the last ~1° below the horizon melts into the
  // horizon sky instead of ending in a hard dark band
  T *= 1.0 - 0.9 * exp(-max(-v.y, 0.0) / 0.012);
  gl_FragColor = vec4(mix(behind, col, T), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Grade: scene HDR → display-referred, sRGB-encoded (frameRT). Looks: 0 signature, 1 physical, 2 dusk,
// 3 negative, 4 raw (debug views)
const GRADE_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D uStats;
uniform sampler2D uCurve;     // signature tone curve f(x), x = 2^(u*16 - 12)
uniform mat4 uClipToDir;
uniform int uGLook;
uniform float uEV;
uniform vec3 uTint;           // (0.990, 0.995, 1.000) normalised to luminance 1
uniform float uChroma;        // 0.08
uniform vec2 uSigGrad;        // signature canonical gradient g(el) = x + y·sin(el)
uniform vec3 uSigK;           // signature: k (cloud texture exponent), m (large-scale exponent), blur mip level
uniform sampler2D uSkyTex;    // skyRT (sky only), mipmapped
uniform vec4 uSunG;           // sun direction xyz, altitude (deg)
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 encodeSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 decodeSRGB(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
float curve(float x) {
  float u = (log2(max(x, 1e-9)) + 12.0) / 16.0;
  float f = texture(uCurve, vec2((clamp(u, 0.0, 1.0) * 511.0 + 0.5) / 512.0, 0.5)).r;
  return u > 0.0 ? f : f * x * 4096.0;
}
vec4 profileAt(float el) {   // azimuth-mean sky (rgb, luminance) at elevation el (rad), from the stats row
  float b = clamp(el / (0.5 * 3.14159265) * 16.0 - 0.5, 0.0, 15.0);
  int i = int(floor(b)); float f = b - float(i);
  return mix(texelFetch(uStats, ivec2(i, 0), 0), texelFetch(uStats, ivec2(min(i + 1, 15), 0), 0), f);
}
// SIGNATURE. x = L / Lref, with Lref made local so the pale-paper palette holds in any real weather:
//   x = (L / Ls) · (Ls / Lb)^k · (Lb / Lp)^m · g(el)
// Ls = the sky-only radiance behind this pixel (skyRT, no birds), Lb = the same blurred (skyRT mip), Lp = the
// azimuth-mean sky at this elevation (stats), g(el) = a + b·sin(el) the reference's gentle bright-overcast gradient
// (hemisphere mean ≈ 1, so Lref(el) averages to the hemisphere Lref). Birds and ground keep their full contrast
// against the exact sky behind them (and never halo, since birds are not in skyRT); cloud texture is kept at
// exponent k, large-scale structure (a sunset-lit band, a blue zenith) at m. Chroma is white-balanced to the mean
// sky (a camera's auto-WB) and 8 % of the rest is kept, soft-limited to ±0.4 % so a sunset gap never turns orange (keeps B ≥ R).
vec3 signature(vec3 c, vec3 rd, vec3 wb) {
  float L = dot(c, LUMA);
  float el = asin(clamp(rd.y, 0.0, 1.0));
  float Lp = max(profileAt(el).a, 1e-12);
  float Ls = max(dot(textureLod(uSkyTex, vUv, 0.0).rgb, LUMA), 1e-12);
  float Lb = max(dot(textureLod(uSkyTex, vUv, uSigK.z).rgb, LUMA), 1e-12);
  float xs = pow(Ls / Lb, uSigK.x) * pow(Lb / Lp, uSigK.y) * (uSigGrad.x + uSigGrad.y * sin(el));
  float occ = L / Ls;                 // < 1 where something (a bird, the ground) is darker than the sky behind it
  // Integrator: the sky itself takes the high-key curve (cloud texture as a few codes), but occluders are composited
  // photographically over that graded sky (linear-light multiply). Through f() alone a half-covered (anti-aliased)
  // bird pixel lands only ~15 codes below the sky, so far birds read as faint dust; this keeps cores at 20–60 and
  // makes partial coverage read as it would in a photograph. Continuous at occ = 1; above 1 the curve's shoulder.
  float y = occ >= 1.0 ? curve(occ * xs) : encodeSRGB(vec3(decodeSRGB(vec3(curve(xs))).x * occ)).x;
  vec3 dc = uChroma * ((c / max(L, 1e-12)) / wb - 1.0);
  dc = dc / (1.0 + abs(dc) / 0.004);
  return clamp(y * uTint * (1.0 + dc), 0.0, 1.0);
}
// AgX (Troy Sobotka), as in three.js r170 tonemapping_pars_fragment, re-implemented here
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 SRGB_TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 R2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
                          vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
                          vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
                           vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
                           vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float MINEV = -12.47393, MAXEV = 4.026069;
  color = SRGB_TO_2020 * color;
  color = INSET * color;
  color = max(color, 1e-10);
  color = clamp((log2(color) - MINEV) / (MAXEV - MINEV), 0.0, 1.0);
  color = agxContrast(color);
  color = OUTSET * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = R2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
void main() {
  vec3 c = max(texture(tSrc, vUv).rgb, 0.0);
  vec4 mean = texelFetch(uStats, ivec2(0, 1), 0);
  float Lref = max(mean.a, 1e-12);
  vec3 wb = max(mean.rgb / Lref, vec3(0.05));
  vec4 pc = uClipToDir * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(pc.xyz / pc.w);
  vec3 o;
  if (uGLook == 0 || uGLook == 3) {
    o = signature(c, rd, wb);
    if (uGLook == 3) o = 1.0 - o;
  } else if (uGLook == 1) {
    o = encodeSRGB(agx(c * (0.6 / Lref) * exp2(uEV)));
  } else if (uGLook == 2) {
    float elDeg = degrees(asin(clamp(rd.y, -1.0, 1.0)));
    const vec3 TOP = vec3(0.13843, 0.17465, 0.26636);     // sRGB (104,116,141) linearised
    const vec3 BOT = vec3(0.27889, 0.20864, 0.19807);     // sRGB (144,126,124)
    float t = clamp((elDeg - 4.0) / 37.0, 0.0, 1.0);
    vec3 target = mix(BOT, TOP, t);
    // afterglow: the band 0–15° above the horizon on the sun's side warms to a pink-orange glow (strongest from just
    // before sunset to ~6° after), so the flock reads as near-black sheets against it
    {
      vec2 hz = rd.xz / max(length(rd.xz), 1e-4), sz = uSunG.xz / max(length(uSunG.xz), 1e-4);
      float side = 0.5 + 0.5 * dot(hz, sz);
      float gk = smoothstep(-11.0, -5.0, uSunG.w) * (1.0 - smoothstep(4.0, 14.0, uSunG.w));
      float wb = side * side * side * exp(-max(elDeg, 0.0) / 7.0) * gk;
      const vec3 GLOW = vec3(0.52, 0.25, 0.13);           // sRGB ~(190,137,100)
      const vec3 ROSE = vec3(0.33, 0.21, 0.22);           // anti-solar side: a faint rose band (belt of Venus)
      float wr = (1.0 - side) * (1.0 - side) * exp(-max(elDeg - 2.0, 0.0) / 6.0) * gk * 0.5;
      target = mix(target, GLOW, 0.8 * wb);
      target = mix(target, ROSE, wr);
    }
    vec3 P = profileAt(radians(max(elDeg, 0.0))).rgb;
    float Lp = max(dot(P, LUMA), 1e-12);
    float L = dot(c, LUMA);
    float r = L / Lp;
    float g = r < 1.0 ? r : 1.0 + 0.7 * (1.0 - exp(-(r - 1.0) / 0.7));
    float k = clamp(log2(max(r, 1e-4)) / 3.0, -1.0, 1.0);
    vec3 split = k < 0.0 ? mix(vec3(1.0), vec3(0.88, 0.96, 1.12), -k) : mix(vec3(1.0), vec3(1.07, 1.0, 0.92), k);
    vec3 chromaRel = (c / max(L, 1e-12)) / max(P / Lp, vec3(1e-3));
    vec3 col = target * g * split * mix(vec3(1.0), clamp(chromaRel, 0.0, 3.0), 0.35);
    float l = dot(col, LUMA);
    col = max(vec3(0.0), mix(vec3(l), col, 1.1));
    o = encodeSRGB(col);
  } else if (uGLook == 5) {          // diagnostic: signature x / 2 (linear grey), r = x/2, g = L/Lp/2, b = g(el)/2
    float L = dot(c, LUMA), el = asin(clamp(rd.y, 0.0, 1.0)), Lp = max(profileAt(el).a, 1e-12);
    float gg = uSigGrad.x + uSigGrad.y * sin(el);
    float Ls = max(dot(textureLod(uSkyTex, vUv, 0.0).rgb, LUMA), 1e-12), Lb = max(dot(textureLod(uSkyTex, vUv, uSigK.z).rgb, LUMA), 1e-12);
    float x = (L / Ls) * pow(Ls / Lb, uSigK.x) * pow(Lb / Lp, uSigK.y) * gg;
    o = clamp(vec3(x, L / Lp, Ls / Lb) * 0.5, 0.0, 1.0);
  } else {
    o = clamp(c, 0.0, 1.0);
  }
  gl_FragColor = vec4(o, 1.0);
}
`;

// Present: display-referred input → canvas / RGBA8. Dither (R2 blue-noise-like ±0.5 code), grain, vignette.
const PRESENT_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uFrame;
uniform vec2 uSize;
float r2(vec2 p) { return fract(dot(p, vec2(0.7548776662466927, 0.5698402909980532))); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 c = texture(tSrc, vUv).rgb;
#if VIGNETTE
  vec2 q = (vUv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
  c *= 1.0 - 0.028 * smoothstep(0.45, 1.1, length(q));
#endif
#if GRAIN
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // static paper grain (review: an animated grain fizzed on the flat pale sky); half the old amplitude
  float gn = hash12(gl_FragCoord.xy + 917.0) + hash12(gl_FragCoord.xy * 1.37 + 613.0) - 1.0;
  c += gn * (0.8 / 255.0) * (0.35 + 0.65 * sqrt(clamp(l, 0.0, 1.0)));
#endif
#if DITHER
  c += (r2(gl_FragCoord.xy) - 0.5) / 255.0;          // static ordered dither
#endif
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const SKY_GLSL = {
  light: LIGHT,
  atmosphere: ATMO,
  clouds: CLOUDS,
};
export const SKY_SHADERS = {
  FSQ_VERT, TRANS_FRAG, MS_FRAG, SKYVIEW_FRAG, NOISE2D_FRAG, NOISE3D_FRAG, PREPASS_FRAG, HEMI_FRAG, ROWS_FRAG, STATS_FRAG,
  FIELD_FRAG, BG_VERT, BG_FRAG, GROUND_VERT, GROUND_FRAG, GRADE_FRAG, PRESENT_FRAG,
};
