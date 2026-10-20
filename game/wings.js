// wings.js: flap / glide / bound bursts for one starling (Tobalske 1995: starlings fly in bursts of flapping broken by
// short glides with the wings out and brief bounds with the wings folded).
//
// A burst switches pose only at the point of the wingbeat that already looks like the next pose: the glide starts
// where the downstroke passes through the extended glide shape, the bound where the flexed upstroke is closest to the
// folded wing. Those two phases are measured from the baked cycle itself (matchPhases), so the blend between the flap
// row and the glide or bound row never cuts through the wing, and a rebaked cycle keeps working.
//
// The body follows: it sinks a few centimetres in a bound and a little in a glide, and recovers while flapping, so
// close birds ride the shallow undulation of real flap-bounding flight.
import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// phase (0..1) of the flap cycle whose pose is closest to row `row` (RMS over all vertices), for a murm-vat-1 asset
export function matchPhase(asset, row) {
  const M = asset.meta, v = M.verts, n = M.cycleFrames || 32, P = asset.vatPos;
  const h = THREE.DataUtils.fromHalfFloat;
  const at = (r, i, c) => h(P[(r * v + i) * 4 + c]);
  let best = 0, bd = Infinity;
  for (let r = 0; r < n; r++) {
    let d = 0;
    for (let i = 0; i < v; i++) for (let c = 0; c < 3; c++) { const e = at(r, i, c) - at(row, i, c); d += e * e; }
    if (d < bd) { bd = d; best = r; }
  }
  return best / n;
}
export function matchPhases(asset) {
  const M = asset.meta;
  return { glide: matchPhase(asset, M.rowGlide ?? 32), bound: matchPhase(asset, M.rowBound ?? 33) };
}

export const WING = { glide: 0.27, bound: 0.8, variants: 1, body: null };   // set from the asset at load (main.js)

// body root motion at wing phase p while flapping: from the asset's body curve when it has one, otherwise a small
// heave (the body rises after the downstroke's lift peak, ~0.32 of the cycle; a 1 g peak at 13.3 Hz is +-1.4 mm) and
// a +-1.5 deg pitch. Returns into o {heave m, surge m, pitch rad}.
export function bodyAt(p, o) {
  const B = WING.body;
  if (B) {
    const n = B.heave.length, f = p * n, i = Math.floor(f) % n, j = (i + 1) % n, w = f - Math.floor(f);
    o.heave = B.heave[i] + (B.heave[j] - B.heave[i]) * w;
    o.surge = B.surge[i] + (B.surge[j] - B.surge[i]) * w;
    o.pitch = B.pitch[i] + (B.pitch[j] - B.pitch[i]) * w;
  } else {
    o.heave = -0.0015 * Math.cos(6.2832 * (p - 0.32));
    o.surge = 0;
    o.pitch = 0.026 * Math.sin(6.2832 * (p - 0.2));
  }
  return o;
}

export function newWing(R, rate = 13.3) {
  const w = { p: R(), rate, mode: 0, beats: 1 + Math.floor(R() * 6), next: 1, dur: 0.2, left: 0, gw: 0, bw: 0, sinkY: 0, sinkV: 0 };
  return w;
}

// plan the next burst from the climb (sin of the flight-path angle): climbing birds flap long and rarely rest,
// descending ones glide for longer
function plan(w, climb, R) {
  if (climb > 0.12) { w.beats = 6 + Math.floor(R() * 7); w.next = R() < 0.85 ? 1 : 2; }
  else if (climb < -0.15) { w.beats = 1 + Math.floor(R() * 2); w.next = 1; }
  else { w.beats = 3 + Math.floor(R() * 5); w.next = R() < 0.72 ? 1 : 2; }
  w.dur = w.next === 1 ? (climb < -0.15 ? 0.3 + 0.5 * R() : 0.1 + 0.28 * R()) : 0.07 + 0.1 * R();
}

const crossed = (p0, p1, x) => (p1 >= p0 ? p0 < x && p1 >= x : p0 < x || p1 >= x);

// force: null, 'flap' (keep beating, e.g. boost) or 'tuck' (fold the wings and hold, e.g. a steep dive)
export function stepWing(w, dt, climb, R, force = null) {
  if (dt <= 0) return w;
  const G = WING.glide, B = WING.bound;
  if (w.mode === 0) {
    const p0 = w.p;
    w.p += dt * w.rate * (1 + 0.15 * Math.max(0, climb));
    if (w.p >= 1) { w.p -= 1; w.beats--; }
    if (force === 'tuck') {
      if (crossed(p0, w.p, B)) { w.mode = 2; w.p = B; w.left = 1e9; }
    } else if (w.beats <= 0 && force !== 'flap') {
      const x = w.next === 1 ? G : B;
      if (crossed(p0, w.p, x)) { w.mode = w.next; w.p = x; w.left = w.dur; }
    }
  } else {
    w.left -= dt;
    if (force === 'flap' || (force !== 'tuck' && w.left <= 0) || (force === 'tuck' && w.mode === 1)) { w.mode = 0; plan(w, climb, R); }
  }
  // blend toward the pose of the current mode (fast: a starling snaps its wings in and out)
  const gT = w.mode === 1 ? 1 : 0, bT = w.mode === 2 ? 1 : 0;
  w.gw = clamp(w.gw + Math.sign(gT - w.gw) * dt / 0.05, Math.min(w.gw, gT), Math.max(w.gw, gT));
  w.bw = clamp(w.bw + Math.sign(bT - w.bw) * dt / 0.045, Math.min(w.bw, bT), Math.max(w.bw, bT));
  // body: drops in a bound, sinks slowly in a glide, springs back up while flapping
  const acc = w.mode === 2 ? -5.5 : w.mode === 1 ? -0.9 : -w.sinkY * 30 - w.sinkV * 9;
  w.sinkV += acc * dt;
  if (w.mode !== 0) w.sinkV *= Math.exp(-dt * 2);
  w.sinkY = clamp(w.sinkY + w.sinkV * dt, -0.22, 0.06);
  return w;
}
