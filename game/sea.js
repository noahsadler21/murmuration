// sea.js: the open sea under bright overcast.
//
// Geometry: a camera-centred radial grid (fine near the camera, geometric toward the horizon) displaced by eight
// Gerstner waves of a moderate wind sea (significant height about 0.7 m). Small-scale structure comes from a
// tileable ripple normal map built here at start-up from a wind-wave spectrum; sampled at three scales with mipmaps and
// anisotropic filtering, it fades to a correct average far away instead of shimmering. Shading: Fresnel reflection of
// the overcast sky, a dark slate body colour, light scattered through the steep wave faces, and sparse whitecaps
// where the Gerstner crests pinch. The same waves run on the CPU (heightAt) so splashes, dunks and fish leaps sit on
// the actual surface.
import * as THREE from 'three';

const G = 9.81;
const TAU = Math.PI * 2;

// eight swell/wind-sea components spread around the wind (+X rotated by WIND), lambda in m, amp in m, steepness Q
const WIND = 0.5;
export const WAVES = [
  [0.0, 38, 0.28, 0.5], [0.42, 23, 0.17, 0.55], [-0.38, 15.5, 0.11, 0.6], [0.85, 9.8, 0.065, 0.65],
  [-0.9, 6.4, 0.042, 0.7], [0.25, 4.1, 0.026, 0.72], [-0.15, 2.7, 0.016, 0.75], [1.3, 1.8, 0.01, 0.75],
].map(([a, lam, amp, q], i) => {
  const ang = WIND + a, k = TAU / lam;
  return { dx: Math.cos(ang), dz: Math.sin(ang), k, w: Math.sqrt(G * k), amp, q, ph: i * 2.399 };
});

// height of the surface at world (x, z), time t (vertical Gerstner component, ignoring the small horizontal shift)
export function heightAt(x, z, t, fade = 1) {
  let h = 0;
  for (const W of WAVES) h += W.amp * Math.sin(W.k * (W.dx * x + W.dz * z) - W.w * t + W.ph);
  return h * fade;
}

// tileable ripple normal map: random wavevectors on the integer lattice (so the tile wraps), a k^-3.5 slope spectrum
// biased along the wind; stores the surface gradient in RG, a foam-texture noise in B
function rippleTexture(size = 256, seed = 7) {
  let s = seed;
  const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const waves = [];
  for (let n = 0; n < 90; n++) {
    const kx = Math.round((R() * 2 - 1) * 22), ky = Math.round((R() * 2 - 1) * 22);
    const k = Math.hypot(kx, ky);
    if (k < 2) continue;
    const align = Math.abs((kx * Math.cos(WIND) + ky * Math.sin(WIND)) / k);
    waves.push([kx, ky, Math.pow(k, -1.75) * (0.35 + 0.65 * align * align), R() * TAU]);
  }
  const fw = [];
  for (let n = 0; n < 40; n++) fw.push([Math.round((R() * 2 - 1) * 30), Math.round((R() * 2 - 1) * 30), R() * TAU]);
  const gx = new Float32Array(size * size), gy = new Float32Array(size * size), fo = new Float32Array(size * size);
  let m = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    let ax = 0, ay = 0, f = 0;
    for (const [kx, ky, a, p] of waves) { const c = Math.cos(TAU * (kx * u + ky * v) + p) * a * TAU; ax += c * kx; ay += c * ky; }
    for (const [kx, ky, p] of fw) f += Math.sin(TAU * (kx * u + ky * v) + p);
    const i = y * size + x;
    gx[i] = ax; gy[i] = ay; fo[i] = f;
    m = Math.max(m, Math.abs(ax), Math.abs(ay));
  }
  const data = new Uint8Array(size * size * 4);
  let fmin = Infinity, fmax = -Infinity;
  for (const f of fo) { fmin = Math.min(fmin, f); fmax = Math.max(fmax, f); }
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(127.5 + 127 * gx[i] / m);
    data[i * 4 + 1] = Math.round(127.5 + 127 * gy[i] / m);
    data[i * 4 + 2] = Math.round(255 * (fo[i] - fmin) / (fmax - fmin));
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 16;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// radial grid: rings at geometric radii from 0 to ~6 km, 256 segments
function radialGrid(rings = 180, segs = 256, r1 = 0.35, growth = 1.052) {
  const pos = [], idx = [];
  const radii = [0];
  let r = r1;
  for (let i = 0; i < rings; i++) { radii.push(r); r = r * growth + 0.02; }
  radii.push(9000);
  pos.push(0, 0, 0);
  for (let i = 1; i < radii.length; i++) for (let s = 0; s < segs; s++) {
    const a = (s / segs) * TAU + (i % 2) * (Math.PI / segs);
    pos.push(Math.cos(a) * radii[i], 0, Math.sin(a) * radii[i]);
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let i = 1; i < radii.length - 1; i++) {
    const a0 = 1 + (i - 1) * segs, b0 = 1 + i * segs;
    for (let s = 0; s < segs; s++) {
      const a = a0 + s, a1 = a0 + ((s + 1) % segs), b = b0 + s, b1 = b0 + ((s + 1) % segs);
      idx.push(a, a1, b, a1, b1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const WAVES_GLSL = (n) => /* glsl */`
uniform vec4 uWa[${n}];   // dir.xz, k, omega
uniform vec4 uWb[${n}];   // amp, steepness Q, phase, -
uniform float uTime;
// Gerstner sum at world xz: displacement (dx, h, dz), plus normal terms and the crest pinch (for foam)
void gerstner(vec2 p, float fade, out vec3 disp, out vec3 nrm, out float pinch) {
  disp = vec3(0.0); vec3 s = vec3(0.0); float jac = 0.0;
  for (int i = 0; i < ${n}; i++) {
    vec2 d = uWa[i].xy; float k = uWa[i].z, w = uWa[i].w, A = uWb[i].x * fade, Q = uWb[i].y;
    float th = k * dot(d, p) - w * uTime + uWb[i].z;
    float S = sin(th), C = cos(th), WA = k * A;
    disp += vec3(Q * A * d.x * C, A * S, Q * A * d.y * C);
    s += vec3(d.x * WA * C, Q * WA * S, d.y * WA * C);
    jac += Q * WA * S;
  }
  nrm = normalize(vec3(-s.x, 1.0 - s.y, -s.z));
  pinch = jac;
}
`;

const SEA_VERT = /* glsl */`
${WAVES_GLSL(8)}
varying vec3 vW;
varying float vFade;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float dist = length(w.xz - cameraPosition.xz);
  // waves shrink to nothing toward the horizon, where the grid is too coarse to carry them
  float fade = 1.0 - smoothstep(180.0, 420.0, dist);
  vec3 d, n; float pinch;
  gerstner(w.xz, fade, d, n, pinch);
  w.xyz += d;
  vW = w.xyz; vFade = fade;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SEA_FRAG = (LIGHT) => /* glsl */`
precision highp float;
${LIGHT}
${WAVES_GLSL(8)}
uniform vec3 uDeep, uScatter, uFoam;
uniform sampler2D tRipple;
varying vec3 vW;
varying float vFade;
float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 skyAt(vec3 r) { return r.y >= 0.0 ? mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.7)) : uHorizon * 0.72; }
void main() {
  vec3 dv = vW - cameraPosition;
  float dist = length(dv);
  vec3 V = -dv / max(dist, 1e-3);
  // large waves analytically (re-evaluated per pixel at the undisplaced position: close enough for shading)
  vec3 d, n; float pinch;
  gerstner(vW.xz, vFade, d, n, pinch);
  // ripples: three scales of the tileable map, stretched along the wind and drifting with it
  vec2 wnd = vec2(cos(${WIND.toFixed(3)}), sin(${WIND.toFixed(3)}));
  mat2 toWind = mat2(wnd.x, -wnd.y, wnd.y, wnd.x);
  vec2 q = toWind * vW.xz;
  vec4 r1 = texture2D(tRipple, vec2(q.x / 11.0, q.y / 7.0) + uTime * vec2(0.021, 0.004));
  vec4 r2 = texture2D(tRipple, vec2(q.x / 3.1, q.y / 2.3) + uTime * vec2(-0.012, 0.031) + 0.37);
  vec4 r3 = texture2D(tRipple, vec2(q.x / 0.9, q.y / 0.75) + uTime * vec2(0.05, -0.02) + 0.71);
  vec4 r4 = texture2D(tRipple, vec2(q.x / 0.32, q.y / 0.27) + uTime * vec2(-0.09, 0.06) + 0.13);
  vec2 g = (r1.xy - 0.5) * 0.7 + (r2.xy - 0.5) * 0.6 + (r3.xy - 0.5) * 0.45 + (r4.xy - 0.5) * 0.3;
  g = transpose(toWind) * g;
  n = normalize(n + vec3(-g.x, 0.0, -g.y));
  float nv = clamp(dot(n, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 refl = skyAt(reflect(-V, n));
  // body: a dark slate; light scattered through the wave faces that lean toward the viewer and toward the sky
  float face = clamp(dot(normalize(vec3(n.x, 0.0, n.z) + 1e-4), normalize(vec3(V.x, 0.0, V.z) + 1e-4)), 0.0, 1.0);
  float crest = clamp(d.y / 0.45 + 0.5, 0.0, 1.0);
  vec3 body = uDeep + uScatter * (0.35 * crest + 0.65 * crest * face) * (1.0 - nv * 0.5);
  // rough water spreads the reflection: the sky it mirrors is a little dimmer than the sky itself
  vec3 col = mix(body, refl * 0.9, fres);
  // whitecaps: where the crests pinch, broken up by the foam noise; patchy and sparse for a moderate wind
  float foamN = r1.z * 0.6 + r2.z * 0.4;
  float foam = smoothstep(0.42, 0.62, pinch) * smoothstep(0.45, 0.75, foamN) * vFade;
  foam += smoothstep(0.88, 0.97, foamN) * 0.18 * smoothstep(0.1, 0.4, pinch) * vFade;   // old streaks of foam
  col = mix(col, uFoam, clamp(foam, 0.0, 0.85));
  // aerial haze toward a band a little darker than the sky, so the sea line reads crisp but soft
  col = mix(col, uFogCol, 1.0 - exp(-uFogK * 0.75 * dist));
  vec3 o = linearToOutputTexel(vec4(col, 1.0)).rgb;
  o += (h12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(o, 1.0);
}
`;

export class Sea {
  constructor(scene, U, LIGHT, colors) {
    const n = WAVES.length;
    this.U = {
      ...U,
      uWa: { value: WAVES.map((W) => new THREE.Vector4(W.dx, W.dz, W.k, W.w)) },
      uWb: { value: WAVES.map((W) => new THREE.Vector4(W.amp, W.q / (W.k * W.amp * n), W.ph, 0)) },
      uTime: { value: 0 },
      uDeep: { value: colors.deep.clone() }, uScatter: { value: colors.scatter.clone() }, uFoam: { value: colors.foam.clone() },
      tRipple: { value: rippleTexture() },
    };
    this.mesh = new THREE.Mesh(radialGrid(), new THREE.ShaderMaterial({ vertexShader: SEA_VERT, fragmentShader: SEA_FRAG(LIGHT), uniforms: this.U }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -5;
    scene.add(this.mesh);
  }
  update(t, cam) {
    this.mesh.position.set(cam.position.x, 0, cam.position.z);
    this.U.uTime.value = t;
    this.t = t;
  }
  heightAt(x, z) { return heightAt(x, z, this.t || 0); }
}
