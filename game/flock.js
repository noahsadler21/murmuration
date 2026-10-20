// flock.js: the choreographed murmuration of the One Bird game.
//
// The flock follows a procedurally steered leader path (Path). Every bird has a fixed place in the flock's own frame
// (along a, lateral r, vertical u). Its world position is the leader path sampled a little in the past (the turn
// reaches the back of the flock later, so turns sweep through it as a fold), plus a slowly breathing, bending and
// twisting sheet shape, plus agitation waves, plus a small personal wobble. The player's slot is one such place; the
// birds are laid out so a clear lane runs through the flock along it. Everything is an analytic function of time, so
// the slot's future (the guide line) is exact, and the CPU has every bird's position for collisions.
//
// Birds near the player dodge at a limited speed, so a smooth flyer slips between them and a barging one hits them.
// A hit bird leaves the formation and tumbles into the sea under simple rigid-body physics.
import { quatFromFwdRoll } from './birds.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const G = 9.81;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------------------------------------ leader path
export const PATH_DT = 1 / 30;
const RING = 2048;              // samples kept (68 s); the flock reads at most ~3 s back and ~8 s ahead
const ST = 14;                  // px py pz | fx fy fz | rx ry rz | ux uy uz | bank | speed

export class Path {
  // profile(t) → { turn: peak yaw rate rad/s, tau: turn response s, hold: manoeuvre length s }
  // sweeps: [{t0, t1}] when the flock skims the sea
  constructor(seed, { profile, sweeps = [], tStart = -6, alt = 30 }) {
    this.rng = mulberry32(seed);
    this.profile = profile;
    this.sweeps = sweeps;
    this.buf = new Float32Array(RING * ST);
    this.tStart = tStart;
    this.k = -1;
    this.baseAlt = alt;
    this.s = { x: 0, y: alt, z: 0, yaw: this.rng() * Math.PI * 2, pitch: 0, yawRate: 0, target: 0, nextT: tStart, v: 13, lastSign: 1 };
  }
  sweepW(t) {
    let w = 0;
    for (const s of this.sweeps) w = Math.max(w, smooth(s.t0 - 6, s.t0 - 1.5, t) * (1 - smooth(s.t1, s.t1 + 3, t)));
    return w;
  }
  altTarget(t) {
    const b = this.baseAlt + 7 * Math.sin(t * 0.37 + 0.6) + 4 * Math.sin(t * 0.86 + 2.1);
    return lerp(b, 7.5, this.sweepW(t));
  }
  _step() {
    const s = this.s, dt = PATH_DT, R = this.rng;
    this.k++;
    const t = this.tStart + this.k * dt;
    const P = this.profile(t);
    if (t >= s.nextT) {
      const straight = R() < 0.14;
      const sign = R() < 0.72 ? -s.lastSign : s.lastSign;
      s.lastSign = sign;
      s.target = straight ? (R() - 0.5) * 0.2 * P.turn : sign * P.turn * (0.4 + 0.6 * R());
      s.nextT = t + P.hold * (0.65 + 0.7 * R());
    }
    s.yawRate += (s.target - s.yawRate) * (1 - Math.exp(-dt / P.tau));
    s.yaw += s.yawRate * dt;
    const vyT = Math.max(-8.5, Math.min(5, (this.altTarget(t) - s.y) * 0.45));
    const pT = Math.asin(Math.max(-0.62, Math.min(0.45, vyT / s.v)));
    s.pitch += (pT - s.pitch) * (1 - Math.exp(-dt / 0.6));
    s.v = 13 + 1.2 * Math.sin(t * 0.41) - 3 * Math.sin(s.pitch);
    const cp = Math.cos(s.pitch);
    const fx = Math.sin(s.yaw) * cp, fy = Math.sin(s.pitch), fz = Math.cos(s.yaw) * cp;
    s.x += fx * s.v * dt; s.y += fy * s.v * dt; s.z += fz * s.v * dt;
    // frame: right = cross(f, +Y) normalised, up = cross(right, f), then bank about f (+ = right wing down)
    // a positive yaw rate turns toward −right (yaw grows toward +X from +Z, which is the bird's left), so bank is −
    const bank = -Math.max(-1.15, Math.min(1.15, Math.atan(s.v * s.yawRate / G)));
    let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    const c = Math.cos(bank), sn = Math.sin(bank);
    const o = (this.k % RING) * ST, B = this.buf;
    B[o] = s.x; B[o + 1] = s.y; B[o + 2] = s.z;
    B[o + 3] = fx; B[o + 4] = fy; B[o + 5] = fz;
    B[o + 6] = rx * c - ux * sn; B[o + 7] = -uy * sn; B[o + 8] = rz * c - uz * sn;
    B[o + 9] = ux * c + rx * sn; B[o + 10] = uy * c; B[o + 11] = uz * c + rz * sn;
    B[o + 12] = bank; B[o + 13] = s.v;
  }
  ensure(t) { while (this.tStart + this.k * PATH_DT < t + 0.1) this._step(); }
  // linear interpolation of a path sample at time t into o (an object with P F R U bank v arrays/fields)
  sample(t, o) {
    let f = (t - this.tStart) / PATH_DT;
    const kMin = Math.max(0, this.k - RING + 2);
    if (f < kMin) f = kMin;
    if (f > this.k - 1e-4) { this.ensure(t + 1); }
    const k0 = Math.floor(f), w = f - k0;
    const a = (k0 % RING) * ST, b = ((k0 + 1) % RING) * ST, B = this.buf;
    for (let i = 0; i < 14; i++) o.d[i] = B[a + i] + (B[b + i] - B[a + i]) * w;
    return o;
  }
}

// ------------------------------------------------------------------------------------------------ flock
export class Flock {
  // slot: {a, r, u} of the player's place; lane: {r, u} half-sizes of the clear lane (m)
  constructor({ N, seed, path, slot, lane = { r: 1.6, u: 1.15 }, dims = { A: 19, W: 25, H: 3.0 } }) {
    this.N = N; this.path = path; this.slot = slot; this.lane = lane;
    this.A = dims.A; this.W = dims.W; this.H = dims.H;
    this.c = 26;                // turn propagation through the flock (m/s), about twice the flight speed
    this.skew = 0.5;            // extra lag across the flock (s): turns sweep diagonally
    this.fold = 1;              // sheet deformation amount (difficulty)
    this.dodgeSpeed = 3.2;      // how fast a neighbour can get out of the player's way (m/s)
    this.dodgeR = 1.25;         // personal space of a neighbour (m)
    this.hitR = 0.3;            // contact distance, bird centre to bird centre (m)
    this.waves = [];
    this.crossers = new Map();
    this.falling = new Map();
    this._S = { d: new Float32Array(14) };
    this._o = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, bank: 0, v: 13, wave: 0 };
    this._q = [0, 0, 0, 1];
    this._layout(seed);
  }

  _layout(seed) {
    const R = mulberry32(seed ^ 0x5bd1e995);
    const { A, W, H, N } = this;
    const inside = (a, r, u) => {
      const ang = Math.atan2(r / W, a / A);
      const lump = 1 + 0.13 * Math.sin(3 * ang + 0.7) + 0.08 * Math.sin(5 * ang + 2.3);
      const rn = r / W;
      const h = H * (1 - 0.45 * rn * rn) * (1 + 0.15 * Math.sin(a * 0.21 + r * 0.17));
      return (a / A) ** 2 + rn * rn < lump * lump && Math.abs(u) < h * Math.sqrt(Math.max(0, 1 - ((a / A) ** 2 + rn * rn) / (lump * lump * 1.15)));
    };
    const inLane = (a, r, u) => ((r - this.slot.r) / this.lane.r) ** 2 + ((u - this.slot.u) / this.lane.u) ** 2 < 1
      || Math.hypot(a - this.slot.a, r - this.slot.r, u - this.slot.u) < 2.2;
    // patchy density, as in photographs of murmurations: smooth value noise at two scales, never fully empty
    const hsh = (x, y, z) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const vnoise = (x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
      const l = (a, b, t) => a + (b - a) * t;
      return l(l(l(hsh(xi, yi, zi), hsh(xi + 1, yi, zi), sx), l(hsh(xi, yi + 1, zi), hsh(xi + 1, yi + 1, zi), sx), sy),
        l(l(hsh(xi, yi, zi + 1), hsh(xi + 1, yi, zi + 1), sx), l(hsh(xi, yi + 1, zi + 1), hsh(xi + 1, yi + 1, zi + 1), sx), sy), sz);
    };
    const density = (a, r, u) => {
      const n = 0.65 * vnoise(a / 11, r / 13, u / 5) + 0.35 * vnoise(a / 4.5 + 7, r / 5 + 3, u / 3 + 1);
      const k = Math.min(1, Math.max(0, (n - 0.3) / 0.4));
      return 0.12 + 0.88 * k * k * (3 - 2 * k);
    };
    let s = Math.cbrt((4 / 3) * Math.PI * A * W * H * 0.5 / N);
    let pts = [];
    for (let tries = 0; tries < 30; tries++) {
      pts = [];
      for (let a = -A * 1.25; a <= A * 1.25; a += s) for (let r = -W * 1.25; r <= W * 1.25; r += s) for (let u = -H * 1.3; u <= H * 1.3; u += s) {
        const ja = a + (R() - 0.5) * 0.62 * s, jr = r + (R() - 0.5) * 0.62 * s, ju = u + (R() - 0.5) * 0.62 * s;
        if (inside(ja, jr, ju) && !inLane(ja, jr, ju) && R() < density(ja, jr, ju)) pts.push([ja, jr, ju]);
      }
      if (pts.length >= N) break;
      s *= 0.975;
    }
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    this.N = Math.min(N, pts.length);
    const n = this.N;
    this.a = new Float32Array(n); this.r = new Float32Array(n); this.u = new Float32Array(n);
    this.wob = new Float32Array(n * 6);
    this.flap = new Float32Array(n * 6);   // rate, phase, glide freq, glide phase, bound freq, bound phase
    this.scale = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.a[i] = pts[i][0]; this.r[i] = pts[i][1]; this.u[i] = pts[i][2];
      const w = this.wob, o = i * 6;
      w[o] = 0.25 + 0.5 * R(); w[o + 1] = 0.2 + 0.45 * R(); w[o + 2] = 0.3 + 0.6 * R();
      w[o + 3] = R() * 6.283; w[o + 4] = R() * 6.283; w[o + 5] = R() * 6.283;
      const f = this.flap;
      f[o] = 13.3 * (0.92 + 0.16 * R()); f[o + 1] = R();
      f[o + 2] = 2.2 + 2.4 * R(); f[o + 3] = R() * 6.283; f[o + 4] = 0.35 + 0.4 * R(); f[o + 5] = R() * 6.283;
      this.scale[i] = 0.95 + 0.1 * R();
    }
    this.state = new Uint8Array(n);        // 0 in formation, 1 falling, 2 gone
    this.pos = new Float32Array(n * 3); this.prev = new Float32Array(n * 3); this.fwd = new Float32Array(n * 3);
    this.dodge = new Float32Array(n * 3);
    this.camDist = new Float32Array(n);
    this.inited = false;
    this.lost = 0;
  }

  // world placement of flock coordinates (a, r, u) at time t (into this._o, or o)
  place(a, r, u, t, o = this._o, withWaves = true) {
    const { A, W } = this;
    const L = (A - a) / this.c + this.skew * 0.5 * (r / W + 1);
    const tau = t - L;
    const d = this.path.sample(tau, this._S).d;
    const fold = this.fold;
    const br = 0.15 * Math.sin(0.29 * tau + 1.1);
    const a2 = a * (1 - 0.7 * br), r2 = r * (1 + br);
    const rn = r / W;
    const an = a / A;
    // the sheet arches across its width and undulates along its length (an S seen side-on): where it turns edge-on
    // to the eye it reads as a dark band, as in photographs of real murmurations
    const u2 = u * (1 + 0.22 * Math.sin(0.21 * tau + 0.4)) + fold * Math.sin(0.17 * tau + 2.0) * (rn * rn - 0.33) * W * 0.2
      + fold * 0.2 * A * Math.sin(2.3 * an + 0.33 * tau + 0.6) * (0.65 + 0.35 * rn);
    const tw = fold * (0.5 * Math.sin(0.13 * tau + 0.9) * an + 0.3 * Math.sin(0.19 * tau + 2.2) * rn);
    const ct = Math.cos(tw), st = Math.sin(tw);
    const r3 = r2 * ct - u2 * st;
    let u3 = r2 * st + u2 * ct;
    let wb = 0;
    if (withWaves) {
      for (let k = 0; k < this.waves.length; k++) {
        const w = this.waves[k];
        if (t < w.t0 - 0.5 || t > w.t0 + w.dur + 0.5) continue;
        const sc = a * w.ca + r * w.sa;
        const front = w.s0 + w.speed * (t - w.t0);
        const x = (sc - front) / w.width;
        if (x * x > 9) continue;
        const env = smooth(w.t0 - 0.5, w.t0 + 0.8, t) * (1 - smooth(w.t0 + w.dur - 0.8, w.t0 + w.dur + 0.5, t));
        const g = Math.exp(-x * x) * env;
        // a dip-and-recover: the band drops, the birds behind the front rise a little as they pull out
        u3 += -w.amp * g * (1 - 0.6 * x);
        wb += w.bank * g * x;
      }
    }
    const along = a2 - A + d[13] * L;
    o.x = d[0] + d[3] * along + d[6] * r3 + d[9] * u3;
    o.y = d[1] + d[4] * along + d[7] * r3 + d[10] * u3;
    o.z = d[2] + d[5] * along + d[8] * r3 + d[11] * u3;
    o.fx = d[3]; o.fy = d[4]; o.fz = d[5];
    o.bank = d[12] + wb; o.v = d[13];
    return o;
  }

  slotAt(t, o) { return this.place(this.slot.a, this.slot.r, this.slot.u, t, o, true); }

  addWave(t0, R, strength = 1) {
    const th = R() * Math.PI * 2;
    const ca = Math.cos(th), sa = Math.sin(th);
    const ext = this.A * Math.abs(ca) + this.W * Math.abs(sa);
    const width = 3.2 + 2 * R();
    const speed = 15 + 8 * R();
    const s0 = -ext - 2 * width;
    this.waves.push({ t0, ca, sa, width, speed, s0, dur: (2 * ext + 4 * width) / speed, amp: (1.1 + 0.9 * R()) * strength, bank: 0.55 * (R() < 0.5 ? -1 : 1) });
  }

  // a bird ahead of the player drifts back through the lane, crossing it (it does not dodge while it does)
  addCrosser(t, R, playerSlot) {
    const { a, r, u } = this;
    const cand = [];
    for (let i = 0; i < this.N; i++) {
      if (this.state[i] || this.crossers.has(i)) continue;
      const da = a[i] - playerSlot.a, dr = r[i] - playerSlot.r, du = u[i] - playerSlot.u;
      if (da > 7 && da < 13 && Math.abs(dr) > 1.7 && Math.abs(dr) < 3.2 && Math.abs(du) < 0.8) cand.push(i);
    }
    if (!cand.length) return -1;
    const i = cand[Math.floor(R() * cand.length)];
    const dur = 2.6 + R() * 0.8;
    const da = -(a[i] - playerSlot.a) - 1.5;             // drift back past the player's place
    const dr = -2 * (r[i] - playerSlot.r);               // to the mirror side of the lane
    this.crossers.set(i, { t0: t, dur, da, dr, du: (R() - 0.5) * 0.6 });
    return i;
  }

  // one frame: positions, orientations, dodges, hits, falling birds, LOD buckets.
  // player: {x,y,z, vx,vy,vz, invuln}; lods: {near, mid, far} VatLOD; cam: {x,y,z}
  update(t, dt, player, cam, lods, cb) {
    const { N, a, r, u, wob, flap, scale, state, pos, prev, fwd, dodge } = this;
    const o = this._o, q = this._q;
    // retire finished waves and crossers
    this.waves = this.waves.filter((w) => t < w.t0 + w.dur + 1);
    for (const [i, c] of this.crossers) if (t > c.t0 + c.dur + 1.2) this.crossers.delete(i);
    const px = player ? player.x : 1e9, py = player ? player.y : 1e9, pz = player ? player.z : 1e9;
    const dR = this.dodgeR, dMax = this.dodgeSpeed * dt, hitR2 = this.hitR * this.hitR;
    let nearest = 1e9, nearCount = 0;
    lods.near.begin(); lods.mid.begin(); lods.far.begin();
    const sm = dt > 0 ? 1 - Math.exp(-dt / 0.09) : 0;
    for (let i = 0; i < N; i++) {
      const s = state[i];
      if (s === 2) continue;
      const i3 = i * 3;
      let roll, ph, gw, bw;
      if (s === 0) {
        const w = i * 6;
        let ai = a[i] + 0.35 * Math.sin(wob[w] * t + wob[w + 3]);
        let ri = r[i] + 0.42 * Math.sin(wob[w + 1] * t + wob[w + 4]);
        let ui = u[i] + 0.28 * Math.sin(wob[w + 2] * t + wob[w + 5]);
        const cr = this.crossers.size ? this.crossers.get(i) : undefined;
        if (cr) {
          const k = smooth(cr.t0, cr.t0 + cr.dur, t);
          const kb = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - cr.t0) / cr.dur)));
          ai += cr.da * k; ri += cr.dr * k; ui += cr.du * kb;
        }
        this.place(ai, ri, ui, t, o, true);
        let x = o.x, y = o.y, z = o.z;
        // dodge the player (not while crossing: that bird is not looking)
        let ddx = dodge[i3], ddy = dodge[i3 + 1], ddz = dodge[i3 + 2];
        const ex = x - px, ey = y - py, ez = z - pz;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 < dR * dR * 4 || ddx || ddy || ddz) {
          let tx = 0, ty = 0, tz = 0;
          if (!cr && e2 < dR * dR) {
            const e = Math.sqrt(e2) + 1e-6, push = Math.min(0.75, (dR - e) * 0.95) / e;
            tx = ex * push; ty = ey * push * 0.8; tz = ez * push;
          }
          let mx = tx - ddx, my = ty - ddy, mz = tz - ddz;
          const ml = Math.sqrt(mx * mx + my * my + mz * mz);
          const lim = tx || ty || tz ? dMax : dMax * 0.35;
          if (ml > lim) { const k = lim / ml; mx *= k; my *= k; mz *= k; }
          ddx += mx; ddy += my; ddz += mz;
          if (Math.abs(ddx) + Math.abs(ddy) + Math.abs(ddz) < 1e-4) ddx = ddy = ddz = 0;
          dodge[i3] = ddx; dodge[i3 + 1] = ddy; dodge[i3 + 2] = ddz;
          x += ddx; y += ddy; z += ddz;
        }
        if (this.inited && dt > 0) {
          const vx = (x - pos[i3]) / dt, vy = (y - pos[i3 + 1]) / dt, vz = (z - pos[i3 + 2]) / dt;
          const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (vl > 2) {
            fwd[i3] += (vx / vl - fwd[i3]) * sm; fwd[i3 + 1] += (vy / vl - fwd[i3 + 1]) * sm; fwd[i3 + 2] += (vz / vl - fwd[i3 + 2]) * sm;
          }
        } else { fwd[i3] = o.fx; fwd[i3 + 1] = o.fy; fwd[i3 + 2] = o.fz; }
        prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        // contact with the player
        const hx = x - px, hy = y - py, hz = z - pz;
        const h2 = hx * hx + hy * hy + hz * hz;
        if (h2 < nearest) nearest = h2;
        if (h2 < 9) nearCount++;
        if (h2 < hitR2 && player && player.invuln <= 0 && cb && cb.onHit) {
          cb.onHit(i, x, y, z);
          continue;
        }
        roll = o.bank + 0.22 * Math.sin(wob[w + 1] * t + wob[w + 4] + 1.57);
        const f = flap;
        flap[w + 1] = (f[w + 1] + dt * f[w]) % 1;
        ph = f[w + 1];
        gw = smooth(0.35, 0.8, Math.sin(f[w + 2] * t + f[w + 3]));
        if (o.fy < -0.12) gw = Math.max(gw, smooth(-0.12, -0.3, o.fy));
        bw = smooth(0.9, 0.99, Math.sin(f[w + 4] * t + f[w + 5])) * (1 - gw);
      } else {
        // falling: rigid-body tumble under gravity and drag, wings flailing
        const F = this.falling.get(i);
        F.vy -= G * dt;
        const dr = Math.exp(-0.35 * dt); F.vx *= dr; F.vy *= dr; F.vz *= dr;
        pos[i3] += F.vx * dt; pos[i3 + 1] += F.vy * dt; pos[i3 + 2] += F.vz * dt;
        const Q = F.q, wx = F.wx, wy = F.wy, wz = F.wz;
        const qx = Q[0], qy = Q[1], qz = Q[2], qw = Q[3], hd = 0.5 * dt;
        Q[0] += hd * (wx * qw + wy * qz - wz * qy); Q[1] += hd * (wy * qw + wz * qx - wx * qz);
        Q[2] += hd * (wz * qw + wx * qy - wy * qx); Q[3] += hd * (-wx * qx - wy * qy - wz * qz);
        const ql = Math.hypot(Q[0], Q[1], Q[2], Q[3]); Q[0] /= ql; Q[1] /= ql; Q[2] /= ql; Q[3] /= ql;
        F.ph = (F.ph + dt * F.flail) % 1;
        F.age += dt;
        if (pos[i3 + 1] < 0.03) {
          state[i] = 2; this.falling.delete(i); this.lost++;
          if (cb && cb.onSplash) cb.onSplash(pos[i3], pos[i3 + 2], 0.7);
          continue;
        }
        const cx = pos[i3] - cam.x, cy = pos[i3 + 1] - cam.y, cz = pos[i3 + 2] - cam.z;
        const cd = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const L = cd < 12 ? lods.near : cd < 80 ? lods.mid : lods.far;
        L.push(pos[i3], pos[i3 + 1], pos[i3 + 2], scale[i], Q, F.ph, 0, 0.5 + 0.5 * Math.sin(F.age * 9));
        continue;
      }
      // LOD bucket by camera distance; birds brushing the lens are not drawn
      const cx = pos[i3] - cam.x, cy = pos[i3 + 1] - cam.y, cz = pos[i3 + 2] - cam.z;
      const cd = Math.sqrt(cx * cx + cy * cy + cz * cz);
      this.camDist[i] = cd;
      if (cd < 0.45) continue;
      quatFromFwdRoll(q, fwd[i3], fwd[i3 + 1], fwd[i3 + 2], roll);
      const L = cd < 7.5 ? lods.near : cd < 80 ? lods.mid : lods.far;
      L.push(pos[i3], pos[i3 + 1], pos[i3 + 2], scale[i], q, ph, gw, bw);
    }
    lods.near.end(); lods.mid.end(); lods.far.end();
    this.inited = true;
    this.nearest = Math.sqrt(nearest); this.nearCount = nearCount;
  }

  // knock bird i out of the formation with the player's impact
  knock(i, ivx, ivy, ivz, R) {
    const i3 = i * 3, f = this.fwd, v = this._o.v || 13;
    const vx = f[i3] * v, vy = f[i3 + 1] * v, vz = f[i3 + 2] * v;
    const q = quatFromFwdRoll([0, 0, 0, 1], f[i3], f[i3 + 1], f[i3 + 2], 0);
    const spin = 9 + 9 * R();
    let ax = R() - 0.5, ay = R() - 0.5, az = R() - 0.5; const al = Math.hypot(ax, ay, az) || 1;
    // it keeps most of the player's momentum, so it tumbles across the view before it drops away
    this.falling.set(i, {
      vx: vx * 0.15 + ivx * 0.8 + (R() - 0.5) * 3, vy: vy * 0.15 + ivy * 0.8 + 1.4 + R() * 1.4, vz: vz * 0.15 + ivz * 0.8 + (R() - 0.5) * 3,
      wx: ax / al * spin, wy: ay / al * spin, wz: az / al * spin, q, ph: 0, flail: 9 + 8 * R(), age: 0,
    });
    this.state[i] = 1;
    this.crossers.delete(i);
  }

  // rough centre of the flock (for the title camera)
  centre(t, o) { return this.place(0, 0, 0, t, o, false); }
}
