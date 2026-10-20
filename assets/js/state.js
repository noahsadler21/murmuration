// state.js: shared STATE (SPEC §2). Owner: integrator. Tuned after review (see README 'Status'): smooth separation
// at rSep 1.2 m, alignment 3.2, roost radius 140 m with wind drift 0.4, lower opacity targets, wheeling (turn/turnHz/steer).
import * as THREE from 'three';
const V3 = THREE.Vector3;
export const QUALITY = {   // §3; fx flags may be overridden by ?fx=name:0|1,...
  // low (review P8/F2): full-resolution flock with 2× MSAA (birds were aliased 1–2 px squares), 6 m density cells
  low:    { birds: [64, 32],   dprCap: 1.0,  scale: 1.0, msaa: 2, nbrEvery: 2, opacityEvery: 4, hash: 256, dens: [64, 64, 32, 6],
            lodCap: [0, 1200, Infinity, Infinity], lodPx: [160, 14, 4], skyScale: 0.5,
            fx: { 'sky.multiScatter': 0, 'sky.cloudRaymarch': 0, 'sky.cloudLightTaps': 1, 'sky.silverLining': 1, 'sky.cirrus': 1,
                  'flock.lod0': 0, 'flock.iridescence': 0, 'flock.wingTransmit': 0, 'flock.selfShadow': 0, 'flock.aerial': 1,
                  'flock.minPixel': 1, 'flock.normalMapLOD0': 0, 'falcon.real': 0, 'post.grain': 0, 'post.vignette': 1, 'post.dither': 1 } },
  medium: { birds: [64, 64],   dprCap: 1.25, scale: 1.0,  msaa: 4, nbrEvery: 1, opacityEvery: 2, hash: 512, dens: [64, 64, 32, 6],
            lodCap: [300, 4096, Infinity, Infinity], lodPx: [36, 12, 4], skyScale: 0.5,
            fx: { 'sky.multiScatter': 0, 'sky.cloudRaymarch': 0, 'sky.cloudLightTaps': 2, 'sky.silverLining': 1, 'sky.cirrus': 1,
                  'flock.lod0': 1, 'flock.iridescence': 1, 'flock.wingTransmit': 1, 'flock.selfShadow': 0, 'flock.aerial': 1,
                  'flock.minPixel': 1, 'flock.normalMapLOD0': 0, 'falcon.real': 1, 'post.grain': 1, 'post.vignette': 1, 'post.dither': 1 } },
  high:   { birds: [128, 64],  dprCap: 2.0,  scale: 1.0,  msaa: 4, nbrEvery: 1, opacityEvery: 1, hash: 512, dens: [64, 64, 32, 6],
            lodCap: [800, 8192, Infinity, Infinity], lodPx: [28, 10, 4], skyScale: 0.75,
            fx: { 'sky.multiScatter': 1, 'sky.cloudRaymarch': 1, 'sky.cloudLightTaps': 2, 'sky.silverLining': 1, 'sky.cirrus': 1,
                  'flock.lod0': 1, 'flock.iridescence': 1, 'flock.wingTransmit': 1, 'flock.selfShadow': 1, 'flock.aerial': 1,
                  'flock.minPixel': 1, 'flock.normalMapLOD0': 1, 'falcon.real': 1, 'post.grain': 1, 'post.vignette': 1, 'post.dither': 1 } },
};
export const NOISE_PRESETS = {
  //          curl m/s², scale ×extent, octaves, wander m/s², gusts/min, waves/min, opacityTarget, pulse,
  //          turn (rad, wheeling amplitude), turnHz (wheeling rate), steer (1/s, how hard the flock follows its wheel)
  calm:     { curl: 0.6, scale: 1.0, octaves: 2, wander: 0.3, gustRate: 0,   waveRate: 0,   opacityTarget: 0.13, pulse: false, turn: 0.8, turnHz: 0.03,  steer: 0.35 },
  swirling: { curl: 1.2, scale: 0.6, octaves: 3, wander: 0.4, gustRate: 0.5, waveRate: 0.5, opacityTarget: 0.15, pulse: false, turn: 1.0, turnHz: 0.045, steer: 0.5 },
  agitated: { curl: 1.6, scale: 0.3, octaves: 4, wander: 0.6, gustRate: 1,   waveRate: 4,   opacityTarget: 0.17, pulse: false, turn: 1.1, turnHz: 0.07,  steer: 0.6 },
  pulsing:  { curl: 1.2, scale: 0.6, octaves: 3, wander: 0.4, gustRate: 0,   waveRate: 1,   opacityTarget: 0.15, pulse: true,   turn: 0.9, turnHz: 0.04,  steer: 0.5 },
};
export const FLOCK_DEFAULTS = {
  k: 7, v0: 12.5, vMin: 9, vMax: 20, speedNoise: 0.10,
  wAlign: 3.2, wCohesion: 0.9, rSep: 1.2, wSep: 9.0, wOpacity: 8.0, wLevel: 0.6, wFlat: 0.015,
  wRoost: 1.0, roostRadius: 140, altMin: 25, altMax: 110, altK: 0.08, windDrift: 0.4,
  maxBankDeg: 65, maxLatG: 1.6, agitatedLatG: 3.0, rollRate: 6.0,
  waveDelay: 0.07, excitedDur: 0.6, refractory: 2.0, pProp: 0.92, bankPulseDeg: 55, speedBoost: 1.0,
  fleeRadius: 25, detectRadius: 45, flashRadius: 10, flashImpulse: 8,
  flapHz: 13.3, flapHzPerMs: 0.3, glideShare: 0.2, boundShare: 0.1, boutBeats: [3, 9], pauseSec: [0.12, 0.45],
};
export function makeState() {
  const L = new Map();
  return {
    version: 1,
    quality: 'medium', preset: QUALITY.medium, fx: { ...QUALITY.medium.fx },
    look: 'signature',                    // 'signature' | 'physical' | 'dusk'
    mode: 'live',                         // 'live' | 'ornito'
    camera: { mode: 'watcher', fovDeg: 35, frozen: false },   // 'watcher' | 'orbit' | 'falcon'
    site: null,                           // a SITES entry (§5.1)
    time: { startMs: 0, nowMs: 0, followNow: false, scale: 1, simT: 0, frame: 0, dt: 0, paused: false },
    weather: { status: 'loading', source: 'none', sample: null, error: null },   // sample = WXSample (§5.1)
    wind: { v10: new V3(), v80: new V3(), v850: new V3(), v500: new V3(), v300: new V3(), gust10: 0 },
    sun: { dir: new V3(0, 1, 0), azimuthDeg: 0, altitudeDeg: 0, sunriseMs: 0, sunsetMs: 0 },
    clouds: { low: 0, mid: 0, high: 0, total: 0, baseLowM: 1200 },
    light: { u: null },                   // shared uniform bag, created by Sky (§5.4)
    flock: { count: 0, params: { ...FLOCK_DEFAULTS }, centroid: new V3(0, 110, 0), extent: new V3(150, 30, 80),
             velocity: new V3(), stats: { polarization: 0, medianSpeed: 0, flap: 0, glide: 0, bound: 0, excited: 0, lodCounts: [0, 0, 0, 0] } },
    noise: { preset: 'swirling', ...NOISE_PRESETS.swirling, seed: 1, evolve: 0.05 },
    falcon: { enabled: true, autoAttack: true, attackEverySec: [45, 90], state: 'off', pos: new V3(), vel: new V3(), targetId: -1, speed: 0 },
    ornito: { running: false, frames: 150, done: 0, vfps: 240, skip: 0, decay: 0, blend: 'darken', track: 'all',
              selection: [], showUntracked: false, caption: false },
    on(ev, fn) { (L.get(ev) || L.set(ev, new Set()).get(ev)).add(fn); return () => L.get(ev).delete(fn); },
    emit(ev, p) { for (const fn of L.get(ev) || []) fn(p); },
  };
}
