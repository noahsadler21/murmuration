// main.js: the integrator (SPEC §1, §8). Boots the page, owns the render targets, the cameras, the profiler and the
// event wiring, and runs the §1 frame pipeline:
//
//   plan → time/weather → camera → sky.update → flock.update × steps → flock.updateLOD → scene → grade → (stamp) → present
//
// Deliberate departures from the SPEC, all documented in README.md:
//  * Watcher camera. The SPEC's fixed watcher (1.7 m eye, 260 m from the roost) sees a 30k-bird flock at true scale
//    as 1–2 px grey smoke. The watcher here still stands on the ground (1.7 m) on the side away from the sun, but walks
//    slowly (critically damped, ~5 s) to keep the flock about half the frame wide, which is what I1 asks for.
//  * Ornitography freezes the camera when the shutter opens (not when the mode is entered), so the flock can be framed
//    first; it unfreezes on 'New' or when leaving the mode.
//  * waveDelay is set to 0.04 s at boot (the flock builder's measured recommendation for 18–35 m/s fronts).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeState, QUALITY, NOISE_PRESETS } from './state.js';
import { Sky, Grade } from './sky.js';
import { SITES, fetchWeather, sampleWeather, applyToState, sunTimes, localDateOf, needsRefetch } from './weather.js';
import { Flock } from './flock.js';
import { Trails } from './trails.js';
import { initUI, CREDIT_LINES } from './ui.js';

const DEG = Math.PI / 180;
const V3 = THREE.Vector3;
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const errors = [];
const setStatus = (t, err) => { if (!statusEl) return; statusEl.textContent = t; statusEl.classList.toggle('err', !!err); statusEl.classList.toggle('gone', !t); };
addEventListener('error', (e) => errors.push(String(e.message || e)));
addEventListener('unhandledrejection', (e) => errors.push(String((e.reason && e.reason.message) || e.reason)));

// ------------------------------------------------------------------------------------------------ URL + state
const P = new URLSearchParams(location.search);
const state = makeState();
// Integrator default: the raymarched 3-D low deck (high quality) reads as smooth 'marshmallow' masses and looks worse
// than the 2-D stratocumulus decks, so it is off unless asked for with ?fx=sky.cloudRaymarch:1.
const fxOverride = { 'sky.cloudRaymarch': 0 };
for (const kv of (P.get('fx') || '').split(',').filter(Boolean)) { const [k, v] = kv.split(':'); if (k) fxOverride[k] = +v; }
function applyQualityToState(q) {
  if (!QUALITY[q]) q = 'medium';
  state.quality = q; state.preset = QUALITY[q]; state.fx = { ...QUALITY[q].fx, ...fxOverride };
}
applyQualityToState(P.get('q') || 'medium');
if (['signature', 'physical', 'dusk'].includes(P.get('look'))) state.look = P.get('look');
state.site = SITES.find((s) => s.id === P.get('site')) || SITES[0];
const bench = P.get('bench') === '1';
state.noise.seed = P.has('seed') ? (+P.get('seed') | 0) : (bench ? 1 : (Math.random() * 1e5) | 0);
const presetName = NOISE_PRESETS[P.get('preset')] ? P.get('preset') : 'swirling';
Object.assign(state.noise, NOISE_PRESETS[presetName], { preset: presetName });
if (P.get('cam') && ['watcher', 'orbit', 'falcon'].includes(P.get('cam'))) state.camera.mode = P.get('cam');
if (P.get('nofalcon') === '1') state.falcon.enabled = false;
if (bench) state.falcon.autoAttack = false;
state.flock.params.waveDelay = 0.04;          // flock builder F5: 0.07 gives ~10 m/s fronts; 0.04 gives 13–23 m/s
state.camera.autoOrbit = true;
state.camera.fovDeg = 24;                     // review P1: a longer lens from farther away (see WATCH)
// Ornitography: with tens of thousands of birds a hard MIN over 300 stamps saturates the flock's core into a flat slab;
// a slight per-stamp decay (0.8 %) keeps the newest wing shapes crisp and lets older ones fade like graphite strokes.
state.ornito.decay = P.has('decay') ? +P.get('decay') : 0.008;
// review fix P11: the all-birds plate stacks frames like semi-transparent film ('layer'), so a 30k-bird exposure builds a
// graded graphite volume instead of a min-blended slab; selections use the hard darken blend (crisp wing silhouettes)
state.ornito.blend = 'layer';
let wxOpt = P.get('wx') || 'live';

// ------------------------------------------------------------------------------------------------ renderer
const canvas = $('c');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
} catch (e) { renderer = null; }
const gl = renderer && renderer.getContext();
if (!renderer || !(gl instanceof WebGL2RenderingContext) || !gl.getExtension('EXT_color_buffer_float')) {
  setStatus('This page needs WebGL2 with float render targets.', true);
  throw new Error('This page needs WebGL2 with float render targets.');
}
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // every tone curve lives in the grade shader (§0)
renderer.setPixelRatio(1);
// three r170's readRenderTargetPixelsAsync leaves its PBO bound to PIXEL_PACK_BUFFER until the fence resolves, which
// breaks any synchronous readPixels in between (the PNG export, tests). Unbind it right after every async read.
{
  const orig = renderer.readRenderTargetPixelsAsync.bind(renderer);
  renderer.readRenderTargetPixelsAsync = function (...a) { const p = orig(...a); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); return p; };
}

// ------------------------------------------------------------------------------------------------ profiler (§1)
const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const prof = {
  on: false, cur: null, frame: null,
  begin(name) { if (!this.on || !tq) return; this.end(); const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); this.cur = { name, q }; },
  end() { if (!this.on || !this.cur) return; gl.endQuery(tq.TIME_ELAPSED_EXT); this.frame.push(this.cur); this.cur = null; },
};

// ------------------------------------------------------------------------------------------------ targets
let RW = 2, RH = 2, sceneRT = null, frameRT = null, curMsaa = -1;
const msaaFor = () => (P.has('msaa') ? +P.get('msaa') : state.preset.msaa);
const scaleFor = () => (P.has('scale') ? +P.get('scale') : state.preset.scale);
function makeTargets() {
  const m = msaaFor();
  if (!sceneRT || m !== curMsaa) {
    if (sceneRT) sceneRT.dispose();
    sceneRT = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples: m, depthBuffer: true, stencilBuffer: false });
    curMsaa = m;
  }
  if (!frameRT) frameRT = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
}

const camera = new THREE.PerspectiveCamera(state.camera.fovDeg, 16 / 9, 0.3, 80000);
camera.position.set(0, 1.7, 260);
const scene = new THREE.Scene();
scene.matrixWorldAutoUpdate = true;

const sky = new Sky({ renderer, state, prof });
const grade = new Grade({ renderer, state });
scene.add(sky.object3d);
sky.setLook(state.look);
const trails = new Trails({ renderer, state, prof });
let flock = null;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, state.preset.dprCap);
  const sc = scaleFor();
  const cw = Math.max(1, canvas.clientWidth || innerWidth), ch = Math.max(1, canvas.clientHeight || innerHeight);
  RW = Math.max(16, Math.floor(cw * dpr * sc)); RH = Math.max(16, Math.floor(ch * dpr * sc));
  renderer.setSize(RW, RH, false);
  makeTargets();
  sceneRT.setSize(RW, RH); frameRT.setSize(RW, RH);
  sky.setSize(RW, RH); grade.setSize(RW, RH); trails.setSize(RW, RH);
  if (flock) flock.setRenderSize(RW, RH);
  camera.aspect = cw / ch; camera.updateProjectionMatrix();
  state.emit('resize', { w: RW, h: RH });
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------------------------------------ weather + time
let wx = null, timeMode = P.get('t') || 'sunset', wxToken = 0, lastWxApply = -1e15, lastRefetchCheck = 0;
function tMsFor(spec, site, refMs) {
  if (spec === 'now') return Date.now();
  if (spec === 'sunset') return sunTimes(localDateOf(refMs || Date.now(), site.tz), site.lat, site.lon).sunsetMs;
  const t = Date.parse(typeof spec === 'object' ? spec.iso : spec);
  return isFinite(t) ? t : sunTimes(localDateOf(Date.now(), site.tz), site.lat, site.lon).sunsetMs;
}
async function setTime(spec, { refetch = false, refMs } = {}) {
  const site = state.site;
  timeMode = typeof spec === 'object' ? spec.iso : spec;
  const tMs = tMsFor(spec, site, refMs);
  const D = localDateOf(tMs, site.tz);
  const token = ++wxToken;
  if (refetch || !wx || wx.siteId !== site.id || wx.date !== D || needsRefetch(wx, tMs, false)) {
    state.weather.status = 'loading';
    try {
      const w = await fetchWeather(site, D, { wx: wxOpt, log: (m) => console.info(m) });
      if (token !== wxToken) return;
      wx = w;
    } catch (e) {
      if (token !== wxToken) return;
      state.weather.status = 'error'; state.weather.error = String(e.message || e);
      console.warn('weather failed', e);
    }
  }
  state.time.startMs = state.time.nowMs = tMs;
  state.time.followNow = spec === 'now';
  sky.resetClouds();
  applyWeatherNow(true);
}
function applyWeatherNow(force) {
  if (!wx) return;
  const t = state.time.nowMs;
  if (!force && Math.abs(t - lastWxApply) < 1000) return;
  lastWxApply = t;
  const s = sampleWeather(wx, t);
  applyToState(state, s);
  state.source = wx.source;
  if (force) state.emit('weather', s);
}

// ------------------------------------------------------------------------------------------------ cameras
const smooth = { look: new V3(0, 110, 0), lookV: new V3(), ground: new V3(), groundV: new V3(), dist: 170, distV: 0, init: false };
const look = { yaw: 0, pitch: 0, lastUser: -1e9, dragging: false };
let viewOverride = null;        // murm.view(): {name, place(dt)}
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false; orbit.enableDamping = true; orbit.dampingFactor = 0.08;
orbit.minDistance = 15; orbit.maxDistance = 900; orbit.autoRotateSpeed = 0.3;   // r170: autoRotateSpeed 1 = 1 rpm when update(dt) gets dt
orbit.enablePan = false;
let orbitLastUser = -1e9, orbitPrevTarget = new V3(), orbitInit = false;
orbit.addEventListener('start', () => { orbitLastUser = performance.now(); });
orbit.addEventListener('end', () => { orbitLastUser = performance.now(); });
const falconCam = { dir: new V3(1, 0, 0), init: false };

function damp(cur, vel, target, dt, tau) {   // critically damped spring (vectors), smooth time tau
  const w = 2 / tau, x = w * dt, k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const ch = cur.clone().sub(target), tmp = vel.clone().addScaledVector(ch, w).multiplyScalar(dt);
  vel.sub(tmp.clone().multiplyScalar(w)).multiplyScalar(k);
  cur.copy(target).add(ch.add(tmp).multiplyScalar(k));
}
function dampS(cur, vel, target, dt, tau) {
  const w = 2 / tau, x = w * dt, k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const ch = cur - target, tmp = (vel + w * ch) * dt;
  return [target + (ch + tmp) * k, (vel - w * tmp) * k];
}
const sunHoriz = () => { const A = state.sun.azimuthDeg * DEG; return new V3(Math.sin(A), 0, -Math.cos(A)); };
// the flock's on-screen width as a fraction of the frame from the 255 sampled birds (flock.subData), plus the median span
function framing() {
  if (!flock || !flock.subData) return null;
  const d = flock.subData, xs = [], p = new V3();
  camera.updateMatrixWorld();
  let dists = [];
  for (let j = 0; j < 255; j++) {
    p.set(d[j * 4], d[j * 4 + 1], d[j * 4 + 2]);
    dists.push(p.distanceTo(camera.position));
    p.project(camera);
    if (p.z < 1) xs.push(p.x);
  }
  xs.sort((a, b) => a - b); dists.sort((a, b) => a - b);
  const pxPerM = RH / (2 * Math.tan(camera.fov * DEG / 2));
  if (!xs.length) return { widthFrac: 0, medianSpanPx: 0.39 * pxPerM / dists[dists.length >> 1] };
  const lo = xs[Math.floor(xs.length * 0.03)], hi = xs[Math.floor(xs.length * 0.97)];
  return { widthFrac: +((hi - lo) / 2).toFixed(3), medianSpanPx: +(0.39 * pxPerM / dists[dists.length >> 1]).toFixed(2), medianDistM: +dists[dists.length >> 1].toFixed(1) };
}

const WIDE = { dMin: 130, k: 0.95, ndc: 0.22 };
// Watcher (review fix P1): a ground observer 150–900 m away with a 24° lens, so the flock sits 10–25° above the horizon.
// From there the eye looks along the flock's thin sheet, folds overlap into dark bands, and the horizon stays in frame.
// fill = target fraction of the frame width for the flock's 4–96 % spread (+15 % margin) across the line of sight.
const WATCH = { fill: 0.5, fillH: 0.46, dMin: 150, dMax: 900, ndcY: 0.08, horizonNdc: -1.06, tauWalk: 8, maxEl: 17, minFov: 11 };
const _wx = { w: 60, h: 25 };
function flockSpreadAcross(dir) {      // width across dir (horizontal) and height, from the 255 sampled birds
  const d = flock && flock.subData;
  if (!d) return { w: Math.max(40, Math.hypot(state.flock.extent.x, state.flock.extent.z) * 0.7), h: Math.max(15, state.flock.extent.y) };
  const c = state.flock.centroid, rx = -dir.z, rz = dir.x, a = [], b = [];
  for (let j = 0; j < 255; j++) { a.push((d[j * 4] - c.x) * rx + (d[j * 4 + 2] - c.z) * rz); b.push(d[j * 4 + 1] - c.y); }
  a.sort((x, y) => x - y); b.sort((x, y) => x - y);
  const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
  return { w: q(a, 0.96) - q(a, 0.04), h: q(b, 0.96) - q(b, 0.04) };
}
// screen-space box of the sampled birds (4–96 %) for the current camera, NDC
function flockBoxNDC() {
  const d = flock && flock.subData; if (!d) return null;
  camera.updateMatrixWorld();
  const xs = [], ys = [], p = new V3();
  for (let j = 0; j < 255; j++) { p.set(d[j * 4], d[j * 4 + 1], d[j * 4 + 2]).project(camera); if (p.z < 1) { xs.push(p.x); ys.push(p.y); } }
  if (xs.length < 30) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.floor(f * (arr.length - 1))];
  const b = { x0: q(xs, 0.02), x1: q(xs, 0.98), y0: q(ys, 0.02), y1: q(ys, 0.98) };
  // during an attack the falcon joins the framing (review: the stoop happened off-screen), with a small margin
  const fs = state.falcon && state.falcon.state;
  const near = state.falcon && state.falcon.pos.distanceTo(state.flock.centroid) < 2.5 * ((flock && flock.rMed) || 25) + 70;
  if (['stoop', 'strike', 'pullout'].includes(fs) && near) {
    p.copy(state.falcon.pos).project(camera);
    if (p.z < 1) { b.x0 = Math.min(b.x0, p.x - 0.08); b.x1 = Math.max(b.x1, p.x + 0.08); b.y0 = Math.min(b.y0, p.y - 0.08); b.y1 = Math.max(b.y1, p.y + 0.08); }
  }
  return b;
}
// The watcher's line of sight: toward the sun's side (backlit silhouettes), swung up to 65° toward the side that
// sees the flock's long horizontal axis broadside, so its ribbons and folds read instead of an end-on lump. Eased (6 s).
const _wdir = new V3();
function watchDir(dt, snap) {
  const s = sunHoriz();
  let want = s.clone();
  const d = flock && flock.subData;
  if (d) {
    const c = state.flock.centroid; let xx = 0, xz = 0, zz = 0;
    for (let j = 0; j < 255; j++) { const x = d[j * 4] - c.x, z = d[j * 4 + 2] - c.z; xx += x * x; xz += x * z; zz += z * z; }
    const th = 0.5 * Math.atan2(2 * xz, xx - zz), ax = new V3(Math.cos(th), 0, Math.sin(th));
    const l1 = (xx + zz) / 2 + Math.hypot((xx - zz) / 2, xz), l2 = (xx + zz) / 2 - Math.hypot((xx - zz) / 2, xz);
    const elong = Math.sqrt(Math.max(l1, 1e-6) / Math.max(l2, 1e-6));          // horizontal aspect (RMS)
    const n = new V3(-ax.z, 0, ax.x); if (n.dot(s) < 0) n.negate();
    const ang = Math.min(Math.acos(THREE.MathUtils.clamp(n.dot(s), -1, 1)), 65 * DEG);
    const w = THREE.MathUtils.clamp((elong - 1.15) / 0.8, 0, 1);
    const sgn = Math.sign(s.x * n.z - s.z * n.x) || 1;
    want = s.clone().applyAxisAngle(new V3(0, 1, 0), -sgn * ang * w);
  }
  if (snap || _wdir.lengthSq() < 0.5) _wdir.copy(want);
  else _wdir.lerp(want, Math.min(1, dt / 6)).normalize();
  return _wdir.clone();
}
function placeWatcher(dt, snap) {
  const c = smooth.look;
  const s = watchDir(dt, snap);
  const hv = camera.fov * DEG / 2, tv = Math.tan(hv), th = tv * camera.aspect;
  const h = Math.max(5, c.y - 1.7);
  if (snap || !smooth.init || !(smooth.dist > 0)) {
    const sp = flockSpreadAcross(s);
    smooth.dist = Math.max(sp.w * 1.15 / (WATCH.fill * 2 * th), h / Math.tan(1.12 * hv));
    smooth.distV = 0; smooth.aim = { x: 0, y: 0 };
  }
  const D = THREE.MathUtils.clamp(smooth.dist, WATCH.dMin, WATCH.dMax);
  const Dh = Math.sqrt(Math.max(1, D * D - h * h));
  const g = new V3(c.x, 1.7, c.z).addScaledVector(s, -Dh);
  if (snap || !smooth.init) { smooth.ground.copy(g); smooth.groundV.set(0, 0, 0); }
  else damp(smooth.ground, smooth.groundV, g, dt, WATCH.tauWalk);
  camera.position.copy(smooth.ground).setY(1.7);
  camera.lookAt(c);
  // base tilt: flock a little above centre, the horizon just below the frame when the geometry allows
  const el = Math.atan2(c.y - 1.7, Math.hypot(c.x - camera.position.x, c.z - camera.position.z));
  const pitch = Math.max(Math.min(el - Math.atan(WATCH.ndcY * tv), Math.atan(-WATCH.horizonNdc * tv)), el - Math.atan(0.45 * tv));
  camera.rotateX(-(el - pitch));
  // screen-space correction from the sampled birds' box: centre it (x 0, y ndcY), and walk in or out so it fills
  // `fill` of the width (or fillH of the height); both eased, so the framing breathes with the flock, never jumps
  const box = flockBoxNDC();
  if (box) {
    const bw = (box.x1 - box.x0) / 2, bh = (box.y1 - box.y0) / 2;
    const frac = Math.max(bw / WATCH.fill, bh / WATCH.fillH);
    const ex = (box.x0 + box.x1) / 2, ey = (box.y0 + box.y1) / 2 - WATCH.ndcY;
    const kA = snap ? 1 : Math.min(1, dt / 1.2);
    smooth.aim.x += (Math.atan(ex * th) - smooth.aim.x) * kA;
    smooth.aim.y += (Math.atan(ey * tv) - smooth.aim.y) * kA;
    // S = the flock's size in "distance × tan(half-fov)" units; a photographer's choice: stand back far enough that the
    // flock is at most maxEl above the horizon (its thin sheet seen at a grazing angle), then zoom in (down to
    // minFov) until it fills the frame. Birds stay the same size on screen; the lens gets longer.
    const S = frac * D * Math.tan(camera.fov * DEG / 2);
    const base = state.camera.fovDeg * DEG / 2;
    const Dw = THREE.MathUtils.clamp(Math.max(S / Math.tan(base), h / Math.tan(WATCH.maxEl * DEG)), WATCH.dMin, WATCH.dMax);
    const fw = THREE.MathUtils.clamp(2 * Math.atan(S / Dw) / DEG, Math.min(WATCH.minFov, state.camera.fovDeg), state.camera.fovDeg);
    if (snap) { smooth.dist = Dw; smooth.fov = fw; smooth.fovV = 0; }
    else {
      [smooth.dist, smooth.distV] = dampS(smooth.dist, smooth.distV, Dw, dt, 3.0);
      [smooth.fov, smooth.fovV] = dampS(smooth.fov || fw, smooth.fovV || 0, fw, dt, 3.0);
    }
  }
  if (smooth.aim) { camera.rotateOnWorldAxis(new V3(0, 1, 0), -smooth.aim.x * 0.98); camera.rotateX(smooth.aim.y * 0.98); }
  if (smooth.fov > 0 && Math.abs(camera.fov - smooth.fov) > 1e-4) { camera.fov = smooth.fov; camera.updateProjectionMatrix(); }
  // drag-to-look offset; eases back after 4 s
  const idle = (performance.now() - look.lastUser) / 1000;
  if (!look.dragging && idle > 4) { const k2 = Math.min(1, dt / 1.2); look.yaw -= look.yaw * k2; look.pitch -= look.pitch * k2; }
  if (look.yaw || look.pitch) { camera.rotateOnWorldAxis(new V3(0, 1, 0), look.yaw); camera.rotateX(look.pitch); }
}
function placeOrbit(dt) {
  if (!orbitInit) {
    orbitInit = true;
    const s = sunHoriz();
    orbit.target.copy(smooth.look);
    camera.position.copy(smooth.look).addScaledVector(s, -170).add(new V3(0, 35, 0));
    orbitPrevTarget.copy(orbit.target);
  }
  // follow the smoothed centroid: carry the camera with the target
  const delta = smooth.look.clone().sub(orbitPrevTarget);
  orbit.target.add(delta); camera.position.add(delta); orbitPrevTarget.copy(orbit.target);
  orbit.autoRotate = state.camera.autoOrbit !== false && (performance.now() - orbitLastUser) > 4000;
  orbit.update(dt);
  if (camera.position.y < 2) camera.position.y = 2;
}
function placeFalcon(dt, snap) {
  const F = state.falcon;
  if (!F.enabled || F.state === 'off') { placeWatcher(dt, snap); return; }
  // review fix: the chase camera sits behind and above the falcon on the line from its quarry, so the flock fills the
  // frame beyond it (patrol: the flock's centre; attack: the chosen bird), instead of looking along the heading at sea
  const fa = flock && flock.falc;
  const attack = ['select', 'stoop', 'strike', 'pullout'].includes(F.state) && fa && fa.targetId >= 0;
  const q = attack ? fa.tgtPos.clone().addScaledVector(fa.tgtVel, flock.t - fa.tgtT) : state.flock.centroid.clone();
  const v = q.clone().sub(F.pos); const dist = v.length(); if (dist < 1) v.set(1, 0, 0); v.normalize();
  if (snap || !falconCam.init) { falconCam.dir.copy(v); falconCam.init = true; }
  else falconCam.dir.lerp(v, Math.min(1, dt / 0.35)).normalize();
  const d = falconCam.dir;
  const back = attack ? 6 : 8;
  camera.position.copy(F.pos).addScaledVector(d, -back).add(new V3(0, 1.0, 0));
  // the falcon sits just below the frame centre, its quarry (and the flock) beyond it
  camera.lookAt(F.pos.clone().addScaledVector(d, Math.min(dist * 0.5, 25)).add(new V3(0, 0.6, 0)));
}
function updateCamera(dt, snap = false) {
  if (state.camera.frozen) return;
  // smoothed look target: critically damped toward the centroid, 1.5 s
  // (a critically damped follow lags a moving target by tau·v, ~18 m for a 12 m/s flock: feed the velocity forward)
  const aim = state.flock.centroid.clone().addScaledVector(state.flock.velocity, 1.5);
  if (snap || !smooth.init) { smooth.look.copy(state.flock.centroid); smooth.lookV.copy(state.flock.velocity); }
  else damp(smooth.look, smooth.lookV, aim, dt, 1.5);
  const fov = viewOverride && viewOverride.fov ? viewOverride.fov
    : (!viewOverride && state.camera.mode === 'watcher' && smooth.fov > 0 && !snap ? smooth.fov : state.camera.fovDeg);
  if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  const mode = state.camera.mode;
  orbit.enabled = mode === 'orbit' && !viewOverride;
  if (viewOverride) viewOverride.place(dt);
  else if (mode === 'orbit') placeOrbit(dt);
  else if (mode === 'falcon') placeFalcon(dt, snap);
  else placeWatcher(dt, snap);
  smooth.init = true;
  camera.updateMatrixWorld();
}

// named views for tests and captures (murm.view)
function makeView(name) {
  const c = () => smooth.look;
  const ext = () => state.flock.extent;
  const s = () => sunHoriz();
  switch (name) {
    case 'default': return null;
    case 'orbit-close': return { name, place() {
      const d = new V3(-s().x, -0.25, -s().z).normalize();
      camera.position.copy(c()).addScaledVector(d, Math.max(ext().x, ext().z) * 0.5 + 25); camera.lookAt(c()); } };
    case 'inside': return { name, place() {
      const v = state.flock.velocity.clone(); v.y = 0; if (v.lengthSq() < 1) v.set(1, 0, 0); v.normalize();
      camera.position.copy(c()).addScaledVector(v, -10); camera.lookAt(c().clone().addScaledVector(v, 30)); } };
    case 'top': return { name, place() { camera.position.copy(c()).add(new V3(0.01, 320, 0)); camera.lookAt(c()); } };
    case 'falcon': return { name, place(dt) { placeFalcon(dt); } };
    case 'falcon-side': return { name, place() {     // the peregrine side-on from 5 m, slightly below
      const F = state.falcon, v = F.vel.clone().setY(0); if (v.lengthSq() < 1) v.set(1, 0, 0); v.normalize();
      const side = new V3().crossVectors(v, new V3(0, 1, 0)).normalize();
      camera.position.copy(F.pos).addScaledVector(side, 5).add(new V3(0, -1.2, 0)); camera.lookAt(F.pos); } };
    case 'wide': return { name, fov: 40, place() {      // from the promenade: flock high in frame, horizon above the control bar
      const D = Math.max(WIDE.dMin, Math.hypot(ext().x, ext().z) * WIDE.k);
      const g = c().clone().addScaledVector(s(), -D); g.y = 8;
      camera.position.copy(g);
      const d = c().clone().sub(g), dh = Math.hypot(d.x, d.z);
      const el = Math.max(6 * DEG, Math.atan2(d.y, dh) - Math.atan(WIDE.ndc * Math.tan(20 * DEG)));
      camera.lookAt(g.clone().add(new V3(d.x / dh, Math.tan(el), d.z / dh))); } };
    default: return null;
  }
}
function setView(name) {
  viewOverride = makeView(name);
  if (name === 'falcon') { state.camera.mode = 'falcon'; viewOverride = null; }
  else if (name === 'default') state.camera.mode = 'watcher';
  updateCamera(1 / 60, true);
}

// ------------------------------------------------------------------------------------------------ UI hide (H key, ?ui=0)
{
  const st = document.createElement('style');
  st.textContent = 'body.noui .ui, body.noui #status { display: none !important; }';
  document.head.appendChild(st);
  if (P.get('ui') === '0') document.body.classList.add('noui');
  addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey || (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('noui');
  });
}

// ------------------------------------------------------------------------------------------------ pointer
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now(), yaw: look.yaw, pitch: look.pitch };
  if (state.camera.mode === 'watcher' && !state.camera.frozen && !viewOverride) { look.dragging = true; canvas.setPointerCapture(e.pointerId); }
});
canvas.addEventListener('pointermove', (e) => {
  if (!down || !look.dragging) return;
  const k = camera.fov * DEG / canvas.clientHeight;
  look.yaw = down.yaw + (e.clientX - down.x) * k;
  look.pitch = THREE.MathUtils.clamp(down.pitch + (e.clientY - down.y) * k, -0.6, 0.6);
  look.lastUser = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dtm = performance.now() - down.t;
  look.dragging = false;
  if (moved > 5) look.lastUser = performance.now();
  down = null;
  if (moved < 5 && dtm < 300) onClick(e);
});
canvas.addEventListener('wheel', (e) => {
  if (state.camera.mode === 'orbit') return;   // OrbitControls zooms
  e.preventDefault();
  state.camera.fovDeg = THREE.MathUtils.clamp(state.camera.fovDeg * Math.exp(e.deltaY * 0.001), 8, 60);
}, { passive: false });
function ndcOf(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
}
async function onClick(e) {
  if (!flock) return;
  const [x, y] = ndcOf(e);
  if (state.mode === 'live') {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x, y), camera);
    state.emit('pulse', { origin: ray.ray.origin.clone(), dir: ray.ray.direction.clone() });
  } else if (state.mode === 'ornito' && !state.ornito.running) {
    const id = await flock.pick(x, y, camera);
    if (id === -1) return;
    const o = state.ornito;
    if (o.track === 'all') o.track = 'one';
    let ids = o.track === 'selection' || e.shiftKey ? [...new Set([...o.selection, id])].slice(0, 64) : [id];
    if (e.shiftKey && o.track === 'one') o.track = 'selection';
    state.emit('select', { ids });
  }
}

// ------------------------------------------------------------------------------------------------ selection helpers
async function birdsNearCentre(n) {
  if (!flock) return [];
  const { pos, N } = await flock.debug.readAll();
  camera.updateMatrixWorld();
  const p = new V3(), cand = [];
  for (let i = 0; i < N; i++) {
    p.set(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]).project(camera);
    if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95) continue;
    cand.push([p.x * p.x * camera.aspect * camera.aspect + p.y * p.y, i]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  if (n <= 1) return cand.slice(0, n).map((c) => c[1]);
  // several birds: spread over the flock's central region (greedy minimum screen spacing), so their traces sit side by
  // side instead of stacking into one dark rod
  const out = [], xy = [];
  for (const sep of [0.08, 0.05, 0.03, 0]) {
    for (const [, i] of cand) {
      if (out.length >= n) break;
      if (out.includes(i)) continue;
      p.set(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]).project(camera);
      if (xy.some(([x, y]) => Math.hypot((x - p.x) * camera.aspect, y - p.y) < sep)) continue;
      out.push(i); xy.push([p.x, p.y]);
    }
    if (out.length >= n) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ ornitography
let showUntrackedTex = null;
async function ornitoStart() {
  if (!flock || state.mode !== 'ornito' || trails.running) return;
  const o = state.ornito;
  if (o.track !== 'all' && !o.selection.length) {
    const ids = await birdsNearCentre(o.track === 'one' ? 1 : 24);
    state.emit('select', { ids });
  }
  flock.setTracked(o.track === 'all' ? 'all' : o.selection);
  flock.setStampMode(o.track === 'all' ? 'all' : 'tracked');
  if (o.track !== 'all' && o.blend === 'layer') o.blend = 'darken';   // selections: crisp, hard-blended wing shapes
  grade.setLookOverride(o.blend === 'lighten' ? 'negative' : null);
  // review fix P11: decay 0 (true chronophotography) for selections; the light decay only for all-birds plates
  if (!P.has('decay')) o.decay = o.track === 'all' ? 0.008 : 0;
  if (o.autoFrame !== false) await ornitoFrame(o);
  state.camera.frozen = true;
  sky.setFrozen(false);
  updateCamera(0);
  sky.update(1 / 60, camera);        // one last sky prepass from the frozen camera, then hold it
  sky.setFrozen(true);
  flock.updateLOD(camera);
  flock.object3d.visible = false;
  renderScene();
  grade.render(sceneRT.texture, frameRT);
  flock.object3d.visible = true;
  trails.begin(frameRT.texture);
}
// Auto-framing when the shutter opens (review P11). The exposure lasts T = frames / vfps seconds of bird time:
//  * one bird: seen from below at 45° and to the side, so the wing outlines spread into fans, its whole path (now
//    → +T) about 60 % of the frame width;
//  * a selection: the same view direction as now, the selection's path box at 60 % of the width;
//  * all birds: a longer lens on the flock's core so birds are ≥ 8 px and the wingbeat scallops resolve.
async function ornitoFrame(o) {
  if (!flock) return;
  const T = Math.max(0.1, (o.frames || 150) / (o.vfps || 240));
  const pxW = () => RW / (2 * Math.tan(camera.fov * DEG / 2) * camera.aspect);
  if (o.track === 'all') {
    const fr = framing();
    if (fr && fr.medianSpanPx > 0 && fr.medianSpanPx < 8) {
      const f = Math.max(5, camera.fov * fr.medianSpanPx / (o.allPx || 7));
      const c = state.flock.centroid.clone().addScaledVector(state.flock.velocity, T * 0.5);
      const pos = camera.position.clone();
      viewOverride = { name: 'ornito-all', fov: f, place() { camera.position.copy(pos); camera.lookAt(c); } };
      updateCamera(0, true);
    }
    return;
  }
  const ids = o.selection.slice(0, 200);
  if (!ids.length) return;
  const { pos, vel } = await flock.debug.readAll();
  const pts = [], mv = new V3();
  for (const id of ids) {
    const p = new V3(pos[id * 4], pos[id * 4 + 1], pos[id * 4 + 2]), v = new V3(vel[id * 4], vel[id * 4 + 1], vel[id * 4 + 2]);
    pts.push(p.clone(), p.clone().addScaledVector(v, T)); mv.add(v);
  }
  const c = new V3(); for (const p of pts) c.add(p); c.divideScalar(pts.length);
  let dir;
  if (ids.length === 1) {
    const f = mv.clone().setY(0).normalize(), side = new V3().crossVectors(f, new V3(0, 1, 0)).normalize();
    const e = -55 * DEG;   // camera below the bird, looking up at 55°: the wings show their planform
    dir = side.multiplyScalar(Math.cos(e)).add(new V3(0, Math.sin(e), 0)).normalize();
  } else dir = camera.position.clone().sub(c).normalize();
  // extent of the path box across the view
  const right = new V3().crossVectors(dir, new V3(0, 1, 0)).normalize(), up = new V3().crossVectors(right, dir).normalize();
  let w = 0.5, h = 0.5;
  for (const p of pts) { const d = p.clone().sub(c); w = Math.max(w, Math.abs(d.dot(right))); h = Math.max(h, Math.abs(d.dot(up))); }
  const fov = state.camera.fovDeg, tv = Math.tan(fov * DEG / 2), th = tv * camera.aspect;
  let dist = Math.max(w / (0.6 * th), h / (0.6 * tv), 3);
  // one bird: never so far that its wings shrink below ~70 px (a long exposure then runs off the frame edges)
  if (ids.length === 1) dist = Math.min(dist, 0.38 * RH / (2 * tv) / 70);
  viewOverride = { name: 'ornito-sel', fov, place() { camera.position.copy(c).addScaledVector(dir, dist); camera.lookAt(c); } };
  updateCamera(0, true);
}
function ornitoRelease() {
  if (viewOverride && /^ornito/.test(viewOverride.name)) viewOverride = null;
  state.camera.frozen = false;
  sky.setFrozen(false);
  grade.setLookOverride(null);
  if (flock) flock.setStampMode('all');
}

// ------------------------------------------------------------------------------------------------ events (§2)
function setQuality(q) {
  if (!QUALITY[q]) return;
  applyQualityToState(q);
  resize();
  sky.setQuality(q);
  if (flock) { flock.setCount(); flock.setRenderSize(RW, RH); smooth.init = false; }
}
state.on('quality', setQuality);
state.on('look', (l) => { sky.setLook(l); });
state.on('mode', (m) => {
  if (m === 'live') { if (trails.running) trails.end(); trails.clear(); ornitoRelease(); }
});
state.on('camera', (c) => {
  viewOverride = null;
  state.camera.mode = c;
  if (c === 'orbit') orbitInit = false;
  if (c === 'falcon') falconCam.init = false;
  updateCamera(1 / 60, c === 'watcher');
});
state.on('site', (id) => {
  const s = SITES.find((x) => x.id === id); if (!s) return;
  state.site = s;
  setTime(timeMode === 'now' ? 'now' : (timeMode === 'sunset' ? 'sunset' : { iso: new Date(state.time.nowMs).toISOString() }), { refMs: state.time.nowMs });
});
state.on('time', (spec) => setTime(spec, { refMs: state.time.nowMs }));
state.on('preset', (name) => { if (NOISE_PRESETS[name]) Object.assign(state.noise, NOISE_PRESETS[name], { preset: name }); });
state.on('randomise', () => {
  const names = Object.keys(NOISE_PRESETS);
  const a = names[(Math.random() * names.length) | 0];
  let b = a; while (b === a) b = names[(Math.random() * names.length) | 0];
  const t = Math.random(), A = NOISE_PRESETS[a], B = NOISE_PRESETS[b];
  for (const k of Object.keys(A)) {
    if (typeof A[k] === 'number') state.noise[k] = A[k] + (B[k] - A[k]) * t;
    else state.noise[k] = t < 0.5 ? A[k] : B[k];
  }
  state.noise.octaves = Math.round(state.noise.octaves);
  state.noise.preset = t < 0.5 ? a : b;
  state.noise.seed = (Math.random() * 1e6) | 0;
});
state.on('falcon', (on) => { state.falcon.enabled = !!on; });
state.on('attack', () => { if (flock) flock.attack(); });
state.on('gust', () => { if (flock) flock.gust(); });
state.on('pulse', (p) => { if (flock && p) flock.excite(p.origin, p.dir); });
state.on('ornito:start', () => { ornitoStart().catch((e) => console.error(e)); });
state.on('ornito:new', () => { ornitoRelease(); });
state.on('ornito:export', () => { trails.exportPNG(grade).catch((e) => console.error(e)); });
state.on('select', async (p) => {
  if (!flock || !p) return;
  if (p.auto) { const ids = await birdsNearCentre(p.auto); state.emit('select', { ids }); return; }
  if (p.ids === 'all') flock.setTracked('all');
  else if (Array.isArray(p.ids)) { state.ornito.selection = p.ids.slice(0, 64); flock.setTracked(state.ornito.selection); }
});

// ------------------------------------------------------------------------------------------------ the frame (§1)
function renderScene() {
  renderer.setRenderTarget(sceneRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
}
const fpsMeter = { ema: 60, ms: 16.7 };
let last = performance.now(), frameNo = 0;
let frameHook = null;

// roost descent: as dusk deepens the murmuration flies lower before going down to roost; the altitude band's ceiling
// eases from 220 m to 60 m (floor 35 → 20 m) between sun altitude −0.5° and −3.5°
function roostDescent() {
  const k = THREE.MathUtils.clamp((-0.5 - state.sun.altitudeDeg) / 3, 0, 1), fp = state.flock.params;
  fp.altMax = 110 - k * 50; fp.altMin = 25 - k * 10;
}
function frame(dtReal, forcePlan) {
  const plan = forcePlan || trails.plan(state);
  const T = state.time;
  // 2. time + weather
  const dtSim = plan.dt * plan.steps;
  if (T.followNow) T.nowMs = Date.now();
  else if (!T.paused) T.nowMs += dtSim * 1000 * (state.mode === 'ornito' && trails.running ? 1 : T.scale);
  T.dt = dtSim; T.frame++;
  if (!(state.mode === 'ornito' && trails.active)) applyWeatherNow(false);
  if (T.followNow && performance.now() - lastRefetchCheck > 60000) {
    lastRefetchCheck = performance.now();
    if (wx && needsRefetch(wx, T.nowMs, true)) setTime('now', { refetch: true });
  }
  roostDescent();
  // camera, then 3. sky (it needs the camera for its prepass)
  updateCamera(Math.max(dtReal, 1e-3));
  sky.update(dtReal, camera);
  // 4. flock
  if (flock) {
    for (let i = 0; i < plan.steps; i++) { flock.update(plan.dt, camera); T.simT += plan.dt; }
    flock.updateLOD(camera);
    // draw the birds ahead by the real time the fixed 1/60 s steps have not simulated yet (smooth on 75–165 Hz)
    flock.U.uLead.value = (!forcePlan && !plan.stamp && !T.paused && !(state.mode === 'ornito' && trails.active))
      ? THREE.MathUtils.clamp(trails._liveAcc || 0, -1 / 60, 1 / 60) : 0;
  }
  // 5. scene
  prof.begin('scene');
  renderScene();
  prof.end();
  // 6. grade
  prof.begin('grade');
  grade.render(sceneRT.texture, frameRT);
  prof.end();
  // 7. stamp
  if (plan.stamp) trails.stamp(frameRT.texture);
  // 8. present
  let out = frameRT.texture;
  if (trails.active) {
    out = trails.output;
    if (state.ornito.showUntracked && flock) {
      // a ghost of the whole live flock under the exposure: re-render with every bird
      const mode = flock.stampMode;
      flock.setStampMode('all');
      renderScene(); grade.render(sceneRT.texture, frameRT);
      flock.setStampMode(mode);
      out = trails.composite(frameRT.texture);
    }
  }
  prof.begin('present');
  grade.present(out);
  prof.end();
  frameNo++;
  if (frameHook) frameHook(frameNo);
}

function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  if (dt > 0) { fpsMeter.ema += ((1 / dt) - fpsMeter.ema) * 0.05; fpsMeter.ms += (dt * 1000 - fpsMeter.ms) * 0.05; }
  if (!loopPaused) {
    try { frame(dt); } catch (e) { errors.push(String(e && e.stack || e)); console.error(e); loopPaused = true; setStatus('Rendering stopped: ' + (e.message || e), true); }
  }
  requestAnimationFrame(loop);
}
let loopPaused = false;
// wait until the 255-bird sub-sample (centroid, spread) has been read back for the current sim time
async function settleSub(maxMs = 1500) {
  if (!flock) return;
  const was = loopPaused; loopPaused = true;
  const t0 = performance.now(), wait = () => new Promise((r) => setTimeout(r, 8));
  while (flock.subBusy && performance.now() - t0 < maxMs) await wait();
  const want = flock.t;
  flock.updateLOD(camera);
  while (flock.subT < want - 1e-6 && performance.now() - t0 < maxMs) await wait();
  loopPaused = was; last = performance.now();
}

// ------------------------------------------------------------------------------------------------ window.murm (§8)
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return +s[s.length >> 1].toFixed(3); };
const murm = window.murm = {
  state, renderer, camera, THREE, errors, get RW() { return RW; }, get RH() { return RH; },
  get flockObj() { return flock; }, get skyObj() { return sky; }, get trailsObj() { return trails; }, grade,
  flock: null, sky: sky.debug, trails: trails.debug,
  stats() {
    const st = state.flock.stats;
    const info = flock ? flock.debug.info() : null;
    return { fps: fpsMeter.ema, ms: fpsMeter.ms, quality: state.quality, birds: flock ? flock.N : 0, lodCounts: st.lodCounts.slice(),
      tris: info ? info.tris : 0, look: state.look, mode: state.mode, weatherSource: wx ? wx.source : 'none',
      sun: { az: state.sun.azimuthDeg, alt: state.sun.altitudeDeg }, errors: errors.length, falcon: state.falcon.state,
      polarization: st.polarization, excited: st.excited, render: [RW, RH], msaa: curMsaa };
  },
  framing, watch: WATCH, wide: WIDE,
  async gpuBench(n = 60, opts = {}) {
    if (!tq) return { error: 'no EXT_disjoint_timer_query_webgl2' };
    const wasPaused = loopPaused; loopPaused = true;
    await new Promise((r) => requestAnimationFrame(r));
    const frames = [], cpu = [];
    prof.on = true;
    for (let i = 0; i < n; i++) {
      prof.frame = [];
      const t0 = performance.now();
      frame(1 / 60, opts.plan || (state.mode === 'ornito' && trails.running ? undefined : { steps: 1, dt: 1 / 60, stamp: false }));
      cpu.push(performance.now() - t0);
      prof.end();
      frames.push(prof.frame);
      if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
    prof.on = false;
    const per = {}, tot = [];
    for (const f of frames) {
      const r = {}; let disjoint = false;
      for (const { name, q } of f) {
        for (let k = 0; k < 500 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((res) => setTimeout(res, 2));
        if (gl.getParameter(tq.GPU_DISJOINT_EXT)) disjoint = true;
        else r[name] = (r[name] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
      }
      if (disjoint) continue;
      for (const k in r) (per[k] = per[k] || []).push(r[k]);
      tot.push(Object.values(r).reduce((a, b) => a + b, 0));
    }
    loopPaused = wasPaused; last = performance.now();
    const out = { median: med(tot), p90: +tot.slice().sort((a, b) => a - b)[Math.floor(tot.length * 0.9)].toFixed(3), cpuMedian: med(cpu), perPass: {} };
    for (const k in per) out.perPass[k] = med(per[k]);
    return out;
  },
  async frameP95(sec = 4) {
    const iv = []; let prev = performance.now();
    await new Promise((res) => { const t0 = prev; const f = (now) => { iv.push(now - prev); prev = now; if (now - t0 < sec * 1000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    iv.shift(); iv.sort((a, b) => a - b);
    return { frames: iv.length, p50: +iv[iv.length >> 1].toFixed(2), p95: +iv[Math.floor(iv.length * 0.95)].toFixed(2) };
  },
  setQuality(q) { if (q !== state.quality) state.emit('quality', q); },
  setLook(l) { state.look = l; state.emit('look', l); },
  setMode(m) { if (m !== state.mode) { state.mode = m; state.emit('mode', m); } },
  seed(n) { state.noise.seed = n | 0; if (flock) flock.reset(n | 0); smooth.init = false; },
  setSite(id) { state.emit('site', id); },
  setTime(spec) { return setTime(spec, { refMs: state.time.nowMs }); },
  useSampleWeather(name = 'overcast') { wxOpt = name === 'live' ? 'live' : 'sample:' + name; return setTime(timeMode === 'now' ? 'now' : { iso: new Date(state.time.nowMs).toISOString() }, { refetch: true }); },
  view(name) { setView(name); return viewOverride ? viewOverride.name : state.camera.mode; },
  // aim a fixed camera at bird `id` from `dist` m, side-on to its flight, centred where it will be after `lead` s
  async frameBird(id, dist = 20, lead = 0.6, elevDeg = -20) {
    const { pos, vel } = await flock.debug.readAll();
    const p = new V3(pos[id * 4], pos[id * 4 + 1], pos[id * 4 + 2]), v = new V3(vel[id * 4], vel[id * 4 + 1], vel[id * 4 + 2]);
    const c = p.clone().addScaledVector(v, lead);
    const f = v.clone().setY(0).normalize(), side = new V3().crossVectors(f, new V3(0, 1, 0)).normalize();
    const e = elevDeg * DEG;
    const dir = side.multiplyScalar(Math.cos(e)).add(new V3(0, Math.sin(e), 0));
    viewOverride = { name: 'bird', place() { camera.position.copy(c).addScaledVector(dir, dist); camera.lookAt(c); } };
    updateCamera(0);
    return { pos: p.toArray(), vel: v.toArray() };
  },
  birdsNearCentre,
  pause() { state.time.paused = true; },
  resume() { state.time.paused = false; loopPaused = false; last = performance.now(); },
  hold(b) { loopPaused = !!b; last = performance.now(); },
  // n sim steps of dt with the LOD/camera kept current, no presenting (fast-forward)
  async tick(dt = 1 / 60, n = 60) {
    const was = loopPaused; loopPaused = true;
    for (let i = 0; i < n; i++) {
      state.time.nowMs += dt * 1000; applyWeatherNow(false); if (i % 30 === 0) { sky.update(dt, camera); roostDescent(); }
      if (flock) flock.update(dt, camera);
      if (i % 4 === 3 || i === n - 1) { updateCamera(dt * 4); if (flock) flock.updateLOD(camera); }
      if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
    }
    loopPaused = was; last = performance.now();
  },
  // n frames of exactly one 1/60 s step each (tests, sheets); yields between frames so the async sub-sample readback
  // (centroid, framing) keeps up as it does live
  async render(n = 1) {
    const was = loopPaused; loopPaused = true;
    for (let i = 0; i < n; i++) {
      frame(1 / 60, state.time.paused ? { steps: 0, dt: 1 / 60, stamp: false } : { steps: 1, dt: 1 / 60, stamp: false });
      await new Promise((r) => setTimeout(r, 2));
    }
    loopPaused = was; last = performance.now();
  },
  async capture(name) {
    frame(1 / 60, { steps: 0, dt: 1 / 60, stamp: false });
    const url = canvas.toDataURL('image/png');
    return (await fetch('/capture?name=' + encodeURIComponent(name), { method: 'POST', body: url })).text();
  },
  onFrame(fn) { frameHook = fn; },
  get wx() { return wx; },
  get timeMode() { return timeMode; },
};

// ------------------------------------------------------------------------------------------------ boot
(async () => {
  setStatus('loading sky and weather…');
  await setTime(timeMode);
  if (P.get('skydebug')) sky.debug.view(P.get('skydebug'));
  updateCamera(1 / 60, true);
  initUI({ state, sites: SITES, credits: CREDIT_LINES, presets: NOISE_PRESETS });
  if (P.get('mode') === 'ornito') { state.mode = 'ornito'; state.emit('mode', 'ornito'); }
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });    // the sky shows before the birds load
  setStatus('loading starlings…');
  const assets = await Flock.loadAssets('assets/birds/');
  flock = new Flock({ renderer, state, assets, prof });
  flock.setRenderSize(RW, RH);
  flock.U.uAlphaPow.value = P.has('alphapow') ? +P.get('alphapow') : 1.0;   // sub-minimum birds: alpha = k^-pow (2 = area-exact)
  flock.U.uMinPx.value = P.has('minpx') ? +P.get('minpx') : 1.6;
  flock.U.uDilate.value = P.has('dilate') ? +P.get('dilate') : 0.5;
  if (P.get('lodviz') === '1') flock.debug.lodviz(true);
  scene.add(flock.object3d);
  murm.flock = flock.debug;
  // let the flock settle out of its spawn ellipsoid before the first presented frame (about 8 s of bird time)
  await murm.tick(1 / 60, P.has('warm') ? +P.get('warm') : 480);
  await settleSub();               // a fresh centroid / spread before the first framed frame (no swing-in from off-screen)
  smooth.init = false; updateCamera(1 / 60, true);
  setStatus('');
  window.ready = true;
})().catch((e) => {
  errors.push(String(e && e.stack || e));
  console.error(e);
  setStatus('Could not start: ' + (e.message || e), true);
});
