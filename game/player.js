// player.js: input (mouse stick, touch drag, keyboard) and the player's starling flight model.
import { newWing, stepWing } from './wings.js';
const G = 9.81;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// Stick response. Sensitivity shapes the middle of the throw (lower = gentler small corrections) but never the end
// of it, so a full push always gives a full turn. Pushing past the full-turn ring (mouse or touch), or holding a
// direction key, ramps a hard turn on top (0..1).
export const STICK = { mouseR: 0.3, touchR: 0.16, hardSpan: 0.75, keyHardAfter: 0.3, keyHardRamp: 0.35 };
export function stickCurve(l, sens) {
  const e = 1 + (1.2 - clamp(sens, 0.3, 1.2)) * 1.4;      // 1 at 120 %, 2.26 at 30 %
  return Math.pow(clamp(l, 0, 1), e);
}

export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, active: false, t: -1e9, down: 0 };
    this.touch = { id: null, x0: 0, y0: 0, x: 0, y: 0 };
    this.touchBoost = false;
    this.invertY = false;
    this.mouseSteer = true;
    this.sens = 0.8;               // steering sensitivity (settings): scales how far the stick turns the bird
    this.override = null;          // tests / bot: {sx, sy, boost, brake}
    this.raw = { sx: 0, sy: 0, hard: 0, boost: false, brake: false, src: 'none' };
    this.keyHold = 0; this._kt = performance.now();
    const kd = (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.code;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
      this.keys.add(k);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.active = true; this.mouse.t = performance.now(); }
      else if (e.pointerId === this.touch.id) { this.touch.x = e.clientX; this.touch.y = e.clientY; }
    });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.mouse.active = false; });
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        this.mouse.down |= (e.button === 2 ? 2 : 1); this.mouse.active = true;
        this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.t = performance.now();
      } else if (this.touch.id === null) {
        this.touch.id = e.pointerId; this.touch.x0 = this.touch.x = e.clientX; this.touch.y0 = this.touch.y = e.clientY;
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }
    });
    const up = (e) => {
      if (e.pointerType === 'mouse') this.mouse.down &= ~(e.button === 2 ? 2 : 1);
      else if (e.pointerId === this.touch.id) this.touch.id = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  get touching() { return this.touch.id !== null; }
  read() {
    if (this.override) { const o = this.override; this.raw = { sx: o.sx || 0, sy: o.sy || 0, hard: o.hard || 0, boost: !!o.boost, brake: !!o.brake, src: 'bot' }; return this.raw; }
    const now = performance.now(), kdt = Math.min(0.1, (now - this._kt) / 1000); this._kt = now;
    const K = this.keys;
    let kx = 0, ky = 0;
    if (K.has('KeyA') || K.has('ArrowLeft')) kx -= 1;
    if (K.has('KeyD') || K.has('ArrowRight')) kx += 1;
    if (K.has('KeyW') || K.has('ArrowUp')) ky += 1;
    if (K.has('KeyS') || K.has('ArrowDown')) ky -= 1;
    let boost = K.has('Space') || K.has('ShiftLeft') || K.has('ShiftRight') || (this.mouse.down & 1) || this.touchBoost;
    let brake = K.has('KeyQ') || K.has('ControlLeft') || K.has('KeyE') || (this.mouse.down & 2);
    let sx = 0, sy = 0, src = 'none';
    const W = window.innerWidth, H = window.innerHeight, m = Math.min(W, H);
    if (this.touching) {
      sx = (this.touch.x - this.touch.x0) / (STICK.touchR * m); sy = -(this.touch.y - this.touch.y0) / (STICK.touchR * m); src = 'touch';
    } else if (kx || ky) {
      sx = kx; sy = ky; src = 'keys';
    } else if (this.mouseSteer && this.mouse.active) {
      sx = (this.mouse.x - W / 2) / (STICK.mouseR * m); sy = -(this.mouse.y - H * 0.5) / (STICK.mouseR * m); src = 'mouse';
    }
    const l = Math.hypot(sx, sy);
    let hard = 0;
    if (src === 'mouse' || src === 'touch') hard = clamp((l - 1) / STICK.hardSpan, 0, 1);
    this.keyHold = src === 'keys' && kx ? this.keyHold + kdt : 0;
    if (src === 'keys') hard = clamp((this.keyHold - STICK.keyHardAfter) / STICK.keyHardRamp, 0, 1);
    if (l > 1) { sx /= l; sy /= l; }
    if (src !== 'none' && l > 1e-6) {
      // dead zone for pointers, then the sensitivity curve on the magnitude (direction kept)
      const dz = src === 'keys' ? 0 : 0.07;
      const lm = Math.min(l, 1), lc = lm < dz ? 0 : stickCurve((lm - dz) / (1 - dz), this.sens);
      sx *= lc / lm; sy *= lc / lm;
    }
    if (this.invertY && src !== 'none') sy = -sy;
    this.raw = { sx, sy, hard, boost: !!boost, brake: !!brake, src };
    return this.raw;
  }
}

// The player's bird. Heading is yaw/pitch; roll follows the turn. Speed relaxes to the slot's speed, with boost /
// brake on top and a little energy exchange in climbs and dives. "Instinct" (difficulty assist) eases the heading
// toward the local flock flow when the stick is centred, as a real starling aligns with its neighbours.
export class Player {
  constructor() { this.reset(0, 30, 0, 0); }
  reset(x, y, z, yaw, pitch = 0, speed = 13) {
    this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.pitch = pitch; this.speed = speed;
    this.yawRate = 0; this.roll = 0; this.sx = 0; this.sy = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.energy = 1; this.boosting = 0; this.braking = 0;
    this.invuln = 0; this.stun = 0; this.kick = 0;
    this.phase = 0; this.glide = 0; this.bound = 0; this.flapRate = 13.3; this.sinkY = 0;
    let sd = 12345; this.wing = newWing(() => ((sd = (sd * 16807) % 2147483647) / 2147483647), 13.3);
    this.gust = { x: 0, z: 0, tx: 0, tz: 0, t: 0 };
    this.dunks = 0;
    this._dir();
  }
  _dir() {
    const cp = Math.cos(this.pitch);
    this.fx = Math.sin(this.yaw) * cp; this.fy = Math.sin(this.pitch); this.fz = Math.cos(this.yaw) * cp;
  }
  // flow: {fx,fy,fz} unit direction of the local flock; slotSpeed (m/s); alongErr (m, + = ahead of slot)
  step(dt, inp, flow, slotSpeed, alongErr, cfg, R, onDunk) {
    const tauS = 0.07;
    const ks = 1 - Math.exp(-dt / tauS);
    let ix = inp.sx, iy = inp.sy;
    if (this.stun > 0) { ix += Math.sin(this.stun * 31) * 0.5; iy += Math.cos(this.stun * 23) * 0.3; this.stun -= dt; }
    this.sx += (ix - this.sx) * ks; this.sy += (iy - this.sy) * ks;
    const ax = Math.abs(this.sx), ay = Math.abs(this.sy);
    const flowYaw = Math.atan2(flow.fx, flow.fz), flowPitch = Math.asin(clamp(flow.fy, -1, 1));
    const A = cfg.assist;
    const hard = inp.hard || 0;
    this.hard = (this.hard || 0) + (hard - (this.hard || 0)) * (1 - Math.exp(-dt / 0.08));
    const maxYR = 1.9 + 1.7 * this.hard;
    // stick right turns right: right is −yaw (yaw grows toward the bird's left)
    let yrCmd = -Math.sign(this.sx) * Math.pow(ax, 1.25) * maxYR;
    yrCmd += A * (1 - ax) * clamp(wrapPi(flowYaw - this.yaw) * 2.6, -maxYR, maxYR);
    this.yawRate += (yrCmd - this.yawRate) * (1 - Math.exp(-dt / (0.13 - 0.06 * this.hard)));
    this.yaw += this.yawRate * dt + this.kick * dt;
    this.kick *= Math.exp(-dt * 4);
    let pCmd = this.sy * (0.78 + 0.3 * this.hard) + A * (1 - ay) * flowPitch;
    pCmd = clamp(pCmd, -1.1, 0.95);
    this.pitch += (pCmd - this.pitch) * (1 - Math.exp(-dt / 0.2));
    this._dir();
    // speed
    const boostOn = inp.boost && this.energy > 0.02;
    this.boosting += ((boostOn ? 1 : 0) - this.boosting) * (1 - Math.exp(-dt / 0.15));
    this.braking += ((inp.brake ? 1 : 0) - this.braking) * (1 - Math.exp(-dt / 0.15));
    if (boostOn) this.energy = Math.max(0, this.energy - dt * 0.38); else this.energy = Math.min(1, this.energy + dt * 0.16);
    const pace = cfg.pace * clamp(-alongErr * 0.9, -3.5, 3.5);
    const vT = slotSpeed + pace + this.boosting * 6.5 - this.braking * 5;
    this.speed += -G * Math.sin(this.pitch) * 0.45 * dt - this.hard * Math.abs(this.yawRate) * 0.6 * dt;
    this.speed += (vT - this.speed) * (1 - Math.exp(-dt / 0.8));
    this.speed = clamp(this.speed, 5, 26);
    // gusts (storm difficulty): a slowly wandering lateral push
    const g = this.gust;
    g.t -= dt;
    if (g.t <= 0) { const a = R() * Math.PI * 2, m = cfg.gust * (0.4 + 0.6 * R()); g.tx = Math.cos(a) * m; g.tz = Math.sin(a) * m; g.t = 1.5 + 2.5 * R(); }
    g.x += (g.tx - g.x) * (1 - Math.exp(-dt / 0.9)); g.z += (g.tz - g.z) * (1 - Math.exp(-dt / 0.9));
    this.vx = this.fx * this.speed + g.x; this.vy = this.fy * this.speed; this.vz = this.fz * this.speed + g.z;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    // the sea surface under the bird (set by the game from the wave field each frame)
    const floorY = (this.seaY || 0) + 0.45;
    if (this.y < floorY) {
      this.y = floorY;
      if (this.pitch < 0.1) { this.pitch = 0.42; this.speed *= 0.7; this.dunks++; if (onDunk) onDunk(this.x, this.z); }
    }
    if (this.y > 140) { this.y = 140; this.pitch = Math.min(this.pitch, 0); }
    this.invuln = Math.max(0, this.invuln - dt);
    // visual roll: a coordinated turn (bank = atan(v·ω/g)), right turn = right wing down = + roll
    const rollT = clamp(-Math.atan(this.speed * this.yawRate / G), -1.4, 1.4);
    this.roll += (rollT - this.roll) * (1 - Math.exp(-dt / 0.12));
    // wings: the same flap / glide / bound bursts as the flock; boost keeps the wings beating, a steep dive folds
    // them into a stoop, and a hard turn or climb means more beats between rests
    const climb = Math.sin(this.pitch) + Math.min(0.3, Math.abs(this.yawRate) * 0.12);
    const force = this.boosting > 0.5 || this.stun > 0 ? 'flap' : this.pitch < -0.55 ? 'tuck' : null;
    const W = this.wing;
    W.rate = 13.3 * (1 + 0.1 * this.boosting);
    stepWing(W, dt, climb, R, force);
    this.phase = W.p; this.glide = W.gw; this.bound = W.bw; this.sinkY = W.sinkY;
  }
  hit(R) {
    this.speed *= 0.72;
    this.kick = (R() - 0.5) * 2.4;
    this.pitch += (R() - 0.5) * 0.4;
    this.stun = 0.45; this.invuln = 0.6;
  }
}
