// main.js: One Bird, a starling-murmuration game. You are one bird in the flock: hold your place, don't hit your
// neighbours, snatch flying fish when the flock skims the sea.
import * as THREE from 'three';
import { loadStarlings, VatLOD, quatFromFwdRoll, bodyCurve } from './birds.js';
import { Path, Flock, mulberry32 } from './flock.js';
import { Input, Player, STICK, stickCurve } from './player.js';
import { WING, matchPhases, bodyAt } from './wings.js';
import { World, Spray, Rings, Feathers, makeEnv, sharedUniforms, LOOK } from './fx.js';
import { FishSchool } from './fish.js';
import { Sound } from './audio.js';
import { loadHero } from './hero.js';
import { Brawl, BRAWL } from './brawl.js';
import { Lobby } from './net.js';
import { leaderboardOn, topScores, postScore, cleanName } from './leaderboard.js';
import * as SH from './shaders.js';

const QS = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('onebird.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('onebird.' + k, JSON.stringify(v)); } catch (_) { /* storage blocked */ } },
};

const DIFF = {
  calm: { label: 'Calm', assist: 0.85, pace: 1.0, ramp: 0.78, tol: 1.3, gust: 0, dodge: 2.8, catchR: 1.2, hitR: 0.26, crossers: 0.5, waves: 0.7 },
  flock: { label: 'Flock', assist: 0.55, pace: 0.75, ramp: 1.0, tol: 1.0, gust: 0.8, dodge: 2.0, catchR: 1.0, hitR: 0.3, crossers: 1, waves: 1 },
  storm: { label: 'Storm', assist: 0.22, pace: 0.45, ramp: 1.22, tol: 0.85, gust: 2.0, dodge: 1.5, catchR: 0.85, hitR: 0.32, crossers: 1.4, waves: 1.3 },
};
// two games: 'murm' (hold your place in the flock, 120 s) and 'fish' (Fish Frenzy: only the flying fish, 90 s)
const runLen = (mode) => +(QS.get('runT') || (mode === 'fish' ? 90 : mode === 'brawl' ? 180 : 120));
let RUN_T = runLen('murm');
// sea runs: four per run, at times and lengths drawn per run around these anchors (seconds of a 120 s run)
function makeSweeps(R) {
  return [21, 50, 78, 103].map((a) => {
    const t0 = (a + (R() - 0.5) * 8) * RUN_T / 120;
    return { t0, t1: t0 + (6.5 + 3.5 * R()) * RUN_T / 120 };
  });
}
let SWEEPS = makeSweeps(Math.random);
// your place in the flock, drawn per run (flock frame: along, lateral, vertical; m)
function makeSlot(R) { return { a: -6 + 10 * R(), r: (R() < 0.5 ? -1 : 1) * (1 + 6 * R()), u: (R() - 0.5) * 1.4 }; }
let SLOT = { a: -3, r: 2.5, u: 0.4 };

const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(screen.width, screen.height) < 600;
const N_BIRDS = +(QS.get('birds') || (QS.get('q') === 'high' ? 7000 : QS.get('q') === 'low' || coarse || small ? 1600 : 4000));

// ------------------------------------------------------------------------------------------------ renderer & scene
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: QS.has('test') });
if (!renderer.capabilities.isWebGL2) { $('loadmsg').textContent = 'This game needs WebGL2.'; throw new Error('WebGL2 required'); }
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
const DPR_CAP = coarse ? 2 : 1.75;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 9000);
const U = sharedUniforms();
const world = new World(scene, U);
const env = makeEnv(renderer);
const spray = new Spray(scene, U);
const down = new Spray(scene, U, 300, { color: [0.16, 0.14, 0.12], gravity: 0.6, drag: 2.2 });   // puffs of down from a hit
const rings = new Rings(scene);
const feathers = new Feathers(scene, env);
const fishes = new FishSchool(scene, env, rings, spray);
fishes.seaH = (x, z) => world.sea.heightAt(x, z);
const sound = new Sound();
const input = new Input(canvas);
input.invertY = store.get('invertY', false);
input.mouseSteer = store.get('mouseSteer', true);
input.sens = clamp(+store.get('sens', 0.8) || 0.8, 0.3, 1.2);

// guide dots along the slot's future path
const GN = 34;
const guide = (() => {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(GN * 3), a = new Float32Array(GN), s = new Float32Array(GN);
  g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aA', new THREE.BufferAttribute(a, 1)); g.setAttribute('aS', new THREE.BufferAttribute(s, 1));
  const m = new THREE.ShaderMaterial({ vertexShader: SH.DOT_VERT, fragmentShader: SH.DOT_FRAG, transparent: true, depthWrite: false,
    uniforms: { uPxPerM: U.uPxPerM, uCol: { value: LOOK.accent.clone() } } });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 8;
  scene.add(pts);
  return { pts, g, p, a, s };
})();

// hoops: rings fixed in the sky along the slot's path, one every 0.45 s of flight. Each is placed once (where the
// slot will be), fades in as the player's bird comes near, and is scored when the bird flies through its plane.
const GATE_DT = 0.45, GATE_AHEAD = 1.9;
const hoops = [];
{
  const g = new THREE.PlaneGeometry(2, 2);
  for (let k = 0; k < 8; k++) {
    const m = new THREE.ShaderMaterial({ vertexShader: SH.RING_VERT, fragmentShader: SH.RING_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uCol: { value: LOOK.accent.clone() }, uA: { value: 0 }, uR: { value: 0.88 }, uW: { value: 0.028 } } });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 8; mesh.visible = false;
    scene.add(mesh);
    hoops.push({ mesh, m, gate: null });
  }
}
const gates = { nextT: 0, streak: 0, passed: 0, missed: 0 };
function resetGates(t) {
  gates.nextT = Math.ceil((t + 0.6) / GATE_DT) * GATE_DT;
  gates.streak = 0; gates.passed = 0; gates.missed = 0;
  for (const h of hoops) { h.gate = null; h.mesh.visible = false; }
}
let lods = null, hero = null, ghost = null, heroGLB = null;
let assets = null;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  overlay.width = Math.round(w * Math.min(window.devicePixelRatio || 1, 2)); overlay.height = Math.round(h * Math.min(window.devicePixelRatio || 1, 2));
  updatePx();
}
function updatePx() {
  const hpx = renderer.domElement.height;
  U.uRes.value.set(renderer.domElement.width, hpx);
  U.uPxPerM.value = hpx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
const overlay = $('ov');
const octx = overlay.getContext('2d');
window.addEventListener('resize', resize);

// ------------------------------------------------------------------------------------------------ game state
const G = {
  mode: 'loading', t: 0, diffKey: store.get('diff', 'flock'), seed: 1,
  path: null, flock: null, player: new Player(), R: mulberry32(7),
  gameMode: ['fish', 'brawl'].includes(store.get('mode', 'murm')) ? store.get('mode', 'murm') : 'murm',
  score: 0, pathPts: 0, qSum: 0, qTime: 0, q: 0, collisions: 0, dunks: 0, fish: 0, combo: 0, bestCombo: 0, lastCatch: -99,
  hist: [], histAcc: 0, histT: 0, nextWave: 0, nextCross: 0, nextFish: 0, toasts: [], shake: 0, timeScale: 1, slowT: 0,
  fovKick: 0, flash: 0, bot: null, orbitA: 0, introT: 0, phaseShown: {}, lastQ: 1,
};
const tmpS = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, bank: 0, v: 13 };
const tmpA = { ...tmpS }, tmpB = { ...tmpS };
const camState = { pos: new THREE.Vector3(0, 30, -20), look: new THREE.Vector3(0, 30, 0), fwd: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), init: false };
const qtmp = [0, 0, 0, 1];
const heroBody = { heave: 0, surge: 0, pitch: 0 };

function profileFor(run) {
  const D = DIFF[G.diffKey];
  if (!run) return () => ({ turn: 0.5, tau: 0.9, hold: 4 });
  if (G.gameMode === 'fish' || G.gameMode === 'brawl') return () => ({ turn: 0.32 * D.ramp, tau: 1.1, hold: 5 });
  return (t) => {
    const p = clamp(t / RUN_T, 0, 1);
    const e = smooth(0.03, 0.95, p);
    return { turn: Math.min(1.35, (0.26 + 0.82 * e) * D.ramp), tau: lerp(1.0, 0.42, e), hold: lerp(4.6, 2.0, e) };
  };
}

function newWorld(run, seed) {
  G.seed = seed;
  const Rw = mulberry32(seed ^ 0x9e3779b9);
  const frenzy = run && G.gameMode === 'fish', brawlRun = run && G.gameMode === 'brawl';
  if (run) { SWEEPS = frenzy || brawlRun ? [] : makeSweeps(Rw); SLOT = makeSlot(Rw); }
  // Fish Frenzy: the flock skims the sea for the whole run; Sky Brawl: the flock wheels round the arena, mid-height
  const sweeps = frenzy ? [{ t0: -100, t1: 1e6 }] : run ? SWEEPS : [{ t0: 24, t1: 32 }, { t0: 74, t1: 82 }, { t0: 124, t1: 132 }];
  G.path = new Path(seed, { profile: profileFor(run), sweeps, tStart: -8, alt: brawlRun ? 22 : 27 + 10 * Rw() });
  if (brawlRun) {
    // keep the murmuration inside the arena, about 40 m out from its middle
    G.path.steer = (t, s) => {
      if (!brawl.on) return null;
      const ax = brawl.cx - s.x, az = brawl.cz - s.z;
      if (Math.hypot(ax, az) < 45) return null;
      return wrapPi(Math.atan2(ax, az) - s.yaw) * 0.8;
    };
  }
  if (frenzy) {
    // keep the murmuration flying alongside: steer toward a point ahead of the player and ~44 m to one side (clear of the flock's half-width),
    // wandering freely once it is there
    const side = Rw() < 0.5 ? -1 : 1;
    G.path.steer = (t, s) => {
      const P = G.player, hl = Math.hypot(P.fx, P.fz) || 1;
      const ax = P.x + (P.fx * 22 - (P.fz / hl) * 44 * side) - s.x, az = P.z + (P.fz * 22 + (P.fx / hl) * 44 * side) - s.z;
      if (Math.hypot(ax, az) < 14) return null;
      const want = Math.atan2(ax, az);
      let d = want - s.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      return d * 0.9;
    };
  }
  const D = DIFF[G.diffKey];
  const dims = { A: 16 + 6 * Rw(), W: 21 + 8 * Rw(), H: 2.6 + 0.8 * Rw() };
  G.flock = new Flock({ N: N_BIRDS, seed, path: G.path, slot: SLOT, dims });
  G.flock.dodgeSpeed = D.dodge; G.flock.hitR = D.hitR;
  G.R = mulberry32(seed * 7 + 3);
  G.path.ensure(10);
}

// ------------------------------------------------------------------------------------------------ loading
async function boot() {
  resize();
  // the game's own copy of the birds (the new v5 starling) first; the main site's birds if that is missing
  let base = new URL(QS.get('assets') === 'site' ? '../assets/birds/' : 'assets/birds/', location.href).href;
  try { assets = await loadStarlings(base, (k) => { $('loadbar').style.width = Math.round(k * 90) + '%'; }); }
  catch (e) { base = new URL('../assets/birds/', location.href).href; assets = await loadStarlings(base, (k) => { $('loadbar').style.width = Math.round(k * 90) + '%'; }); }
  // the player's feathered bird; without it the VAT hero below stands in
  try { heroGLB = await loadHero(base + 'starling_hero.glb', env); scene.add(heroGLB.root); heroGLB.root.visible = false; }
  catch (e) { console.warn('hero bird: using the VAT starling (' + e.message + ')'); heroGLB = null; }
  $('loadbar').style.width = '100%';
  const shared = U;
  lods = {
    near: new VatLOD(assets.retro, { max: N_BIRDS, defines: { TEXTURED: 1 }, shared, dark: 0.42 }),
    mid: new VatLOD(assets.sil, { max: N_BIRDS, defines: { DILATE: 1 }, shared, dark: 0.42 }),
    far: new VatLOD(assets.micro, { max: N_BIRDS, defines: { MINPIXEL: 1, DILATE: 1 }, shared, dark: 0.42, premult: true, renderOrder: 3 }),
  };
  // where in the baked wingbeat the wings already look like the glide and the bound pose
  Object.assign(WING, matchPhases(assets.sil));
  // wingbeat variants only as many as every LOD carries; body motion from the asset when it ships one
  WING.variants = Math.min(...Object.values(assets).map((a) => a.meta.variants));
  WING.body = bodyCurve(assets.retro.meta);
  hero = new VatLOD(assets.real, { max: 1, defines: { TEXTURED: 1, NORMALMAP: 1, SMOOTH_NRM: 1, IRID: 1, GLOSS: 1 }, shared, dark: 0.85 });
  // shutter: about a 180° shutter at 60 fps is 1/120 s, a ninth of a 13.3 Hz wingbeat; six samples across it
  hero.addBlur(scene, [-0.055, -0.035, -0.015, 0.015, 0.035, 0.055], 0.15);
  lods.near.addBlur(scene, [-0.045, 0.045], 0.32);
  ghost = new VatLOD(assets.real, { max: 1, defines: { GHOST: 1, SMOOTH_NRM: 1 }, shared, transparent: true, renderOrder: 9 });
  ghost.uniforms.uGhost.value.copy(LOOK.accent);
  brawl.lod = new VatLOD(assets.real, { max: BRAWL.rivals, defines: { TEXTURED: 1, NORMALMAP: 1, SMOOTH_NRM: 1, IRID: 1, GLOSS: 1 }, shared, dark: 0.75 });
  for (const L of [lods.near, lods.mid, lods.far, hero, ghost, brawl.lod]) scene.add(L.mesh);
  newWorld(false, (Math.random() * 1e9) | 0);
  G.t = 0;
  // warm the shaders up so the first frame of play doesn't hitch
  setMode('title');
  frame(0.016);
  renderer.compile(scene, camera);
  $('loading').classList.add('hidden');
  window.ready = true;
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------------------------------------ modes
function setMode(m) {
  G.mode = m;
  document.body.dataset.mode = m;
  $('title').classList.toggle('hidden', m !== 'title');
  $('results').classList.toggle('hidden', m !== 'end');
  $('pause').classList.toggle('hidden', m !== 'paused');
  $('hud').classList.toggle('hidden', !(m === 'play' || m === 'intro' || m === 'paused'));
}

function startRun(opts = {}) {
  if (opts.diff) G.diffKey = opts.diff;
  if (opts.mode) G.gameMode = opts.mode;
  store.set('diff', G.diffKey); store.set('mode', G.gameMode);
  RUN_T = runLen(G.gameMode);
  document.body.dataset.game = G.gameMode;
  const GM = G.gameMode;
  $('capTop').textContent = GM === 'fish' ? 'fish caught' : GM === 'brawl' ? 'birds left' : 'in line';
  $('capFish').textContent = GM === 'fish' ? 'Chain' : GM === 'brawl' ? 'Knockouts' : 'Fish';
  $('capHits').textContent = GM === 'fish' ? 'Leapt' : GM === 'brawl' ? 'Feathers' : 'Hits';
  G.endAt = null;
  sound.start();
  const seed = opts.seed ?? ((Math.random() * 1e9) | 0);
  brawl.stop();
  G.botTarget = undefined; G.botClose = false;
  newWorld(true, seed);
  Object.assign(G, {
    score: 0, pathPts: 0, qSum: 0, qTime: 0, q: 1, collisions: 0, dunks: 0, fish: 0, combo: 0, bestCombo: 0, lastCatch: -99,
    hist: [], histAcc: 0, histT: 0, nextWave: 17 * RUN_T / 120, nextCross: 34 * RUN_T / 120, nextFish: 0, shake: 0, timeScale: 1, slowT: 0,
    fovKick: 0, flash: 0, phaseShown: {}, lastQ: 1,
  });
  fishes.caught = fishes.missed = fishes.spawned = 0;
  for (const f of fishes.list) f.state = 'off';
  const introLen = opts.skipIntro ? 0 : 3.2;
  G.t = -introLen;
  G.introT = 0; G.introLen = introLen;
  resetGates(G.t);
  G.flock.slotAt(G.t, tmpS);
  const S = slotFlow(G.t);
  G.player.reset(tmpS.x, tmpS.y, tmpS.z, Math.atan2(S.fx, S.fz), Math.asin(S.fy), S.v);
  G.camFrom = { pos: camState.pos.clone(), look: camState.look.clone() };
  camState.init = false;
  setMode(introLen > 0 ? 'intro' : 'play');
  $('count').classList.toggle('hidden', introLen <= 0);
  renderTimeline();
  if (G.gameMode === 'fish' && introLen <= 0) G.nextFish = 0.5;
  if (G.gameMode === 'brawl') {
    const on = opts.net || { role: 'solo' };
    if (on.role === 'client' && on.spawn) {
      // a guest starts where the host placed it, facing into the arena
      const [x, y, z, yaw] = on.spawn;
      G.player.reset(x, y, z, yaw, 0, 13);
    }
    brawl.start(seed, G.player, G.diffKey, G.R, { ...on, myName: on.myName || cleanName($('netName').value) || 'You' });
    G.nextFish = 4;
    if (on.role === 'host') net.lobby.broadcast({ k: 'start', seed, diff: G.diffKey, cx: brawl.cx, cz: brawl.cz, spawns: brawl.spawns, intro: G.introLen });
  } else brawl.stop();
  G.online = G.gameMode === 'brawl' && opts.net && opts.net.role !== 'solo' ? opts.net.role : null;
}

function endRun() {
  setMode('end');
  for (const f of floaters) f.el.remove();
  floaters.length = 0;
  if (G.gameMode === 'brawl') return endBrawl();
  const frenzy = G.gameMode === 'fish';
  const pct = G.qTime > 0 ? 100 * G.qSum / G.qTime : 0;
  // knocking a neighbour out now scores points instead of costing grade; only splashdowns cost grade
  const eff = pct - 1.5 * G.dunks;
  // Fish Frenzy grades on fish per minute (the catch count scaled to a 90 s run)
  const fpm = G.fish * 90 / RUN_T;
  const grade = frenzy ? (fpm >= 42 ? 'S' : fpm >= 30 ? 'A' : fpm >= 20 ? 'B' : fpm >= 11 ? 'C' : 'D')
    : eff >= 93 ? 'S' : eff >= 85 ? 'A' : eff >= 74 ? 'B' : eff >= 60 ? 'C' : 'D';
  const key = (frenzy ? 'best.fish.' : 'best.') + G.diffKey;
  const best = store.get(key, 0);
  const score = Math.round(G.score);
  if (score > best) store.set(key, score);
  $('rGrade').textContent = grade;
  $('rGrade').dataset.g = grade;
  $('rPctL').textContent = frenzy ? 'Flying fish caught' : 'In line with the flock';
  $('rHitsL').textContent = frenzy ? 'Best chain' : 'Collisions';
  $('rFishL').textContent = frenzy ? 'Splashdowns · collisions' : 'Flying fish';
  if (frenzy) {
    $('rPct').textContent = `${G.fish} of ${fishes.spawned}`;
    $('rHits').textContent = G.bestCombo > 1 ? `×${G.bestCombo}` : '–';
    $('rFish').textContent = `${G.dunks} · ${G.collisions}`;
  } else {
    $('rPct').textContent = pct.toFixed(1) + '%';
    $('rHits').textContent = String(G.collisions) + (G.dunks ? ` + ${G.dunks} splashdown${G.dunks > 1 ? 's' : ''}` : '');
    $('rFish').textContent = `${G.fish}` + (G.bestCombo > 1 ? ` · best chain ×${G.bestCombo}` : '');
  }
  $('rTitle').textContent = frenzy ? 'Fish Frenzy over' : 'Run complete';
  $('sparkCap').textContent = frenzy ? 'fish caught, second by second' : 'in line, second by second (sea runs shaded)';
  $('rScore').textContent = score.toLocaleString();
  $('rBest').textContent = score > best ? 'new best' : 'best ' + best.toLocaleString();
  $('rDiff').textContent = DIFF[G.diffKey].label;
  $('rLine').textContent = frenzy ? frenzyLine(grade) : gradeLine(grade, pct);
  drawSpark();
  sound.chime(grade === 'S' || grade === 'A');
  G.result = { grade, pct, collisions: G.collisions, dunks: G.dunks, fish: G.fish, score };
  showLeaderboard();
}

// shared leaderboard on the results screen (hidden unless game/leaderboard-config.js is filled in)
function lbRender(rows, me) {
  const ol = $('lbList'); ol.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    const n = document.createElement('span'); n.textContent = r.name;
    const v = document.createElement('span'); v.textContent = Number(r.score).toLocaleString();
    li.append(n, v);
    if (me && r.name === me.name && Number(r.score) === me.score) li.className = 'me';
    ol.appendChild(li);
  }
  if (!rows.length) $('lbMsg').textContent = 'No scores yet for this game and flight. Be the first.';
}
async function showLeaderboard() {
  $('lb').classList.toggle('hidden', !leaderboardOn);
  if (!leaderboardOn) return;
  $('lbName').value = store.get('name', '');
  $('lbPost').disabled = !(G.result && G.result.score > 0); G.posted = false;
  $('lbMsg').textContent = `Top 10 · ${G.gameMode === 'fish' ? 'Fish Frenzy' : 'Murmuration'} · ${DIFF[G.diffKey].label}`;
  try { lbRender(await topScores(G.gameMode, G.diffKey)); } catch (e) { $('lbMsg').textContent = 'The leaderboard could not be reached.'; }
}
$('lbForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = cleanName($('lbName').value);
  if (!name) { $('lbMsg').textContent = 'Type a name first (letters and numbers, up to 16).'; return; }
  if (G.posted || !G.result) return;
  store.set('name', name);
  $('lbPost').disabled = true;
  try {
    const ok = await postScore({ name, mode: G.gameMode, diff: G.diffKey, score: G.result.score, fish: G.result.fish, pct: G.result.pct });
    G.posted = ok;
    $('lbMsg').textContent = ok ? 'Posted.' : 'That score could not be posted.';
    lbRender(await topScores(G.gameMode, G.diffKey), { name, score: G.result.score });
  } catch (err) { $('lbMsg').textContent = 'Posting failed. Check your connection and try again.'; $('lbPost').disabled = false; }
});
const ORD = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
function endBrawl() {
  const B = brawl, me = B.player;
  const place = me.dead ? me.place : 1 + B.birds.filter((b) => b.state === 'fly').length - (B.winner === 'player' ? 0 : 0);
  const won = !me.dead && B.alive() === 1;
  const placeN = won ? 1 : me.dead ? me.place : 1 + B.birds.filter((b) => b.state === 'fly').length;
  G.score += won ? 1000 : Math.max(0, (BRAWL.rivals + 1 - placeN)) * 60;
  const grade = placeN === 1 ? 'S' : placeN <= 3 ? 'A' : placeN <= 6 ? 'B' : placeN <= 9 ? 'C' : 'D';
  const key = 'best.brawl.' + G.diffKey, best = store.get(key, 0), score = Math.round(G.score);
  if (score > best) store.set(key, score);
  $('rTitle').textContent = won ? 'Last bird flying!' : `Out in ${ORD(placeN)} place`;
  $('rGrade').textContent = grade; $('rGrade').dataset.g = grade;
  $('rPctL').textContent = 'Placing'; $('rPct').textContent = `${ORD(placeN)} of ${BRAWL.rivals + 1}`;
  $('rHitsL').textContent = 'Knockouts · hits landed'; $('rHits').textContent = `${me.kos} · ${me.hits}`;
  $('rFishL').textContent = 'Survived'; $('rFish').textContent = `${Math.round(Math.min(G.t, RUN_T))} s`;
  $('rScore').textContent = score.toLocaleString();
  $('rBest').textContent = score > best ? 'new best' : 'best ' + best.toLocaleString();
  $('rDiff').textContent = DIFF[G.diffKey].label;
  $('rLine').textContent = won ? 'Twelve starlings went up; you came down alone. The sky is yours.'
    : placeN <= 3 ? 'So close. Boost into birds from the side, and keep your back clear.'
      : 'Ram birds faster than they ram you, catch a fish to grow back a feather, and stay inside the ring.';
  $('sparkCap').textContent = 'birds still flying, second by second';
  drawSpark();
  sound.chime(won);
  G.result = { grade, place: placeN, won, kos: me.kos, hits: me.hits, score, fish: G.fish, pct: 0, collisions: G.collisions, dunks: G.dunks };
  showLeaderboard();
}
function frenzyLine(g) {
  if (g === 'S') return 'A gannet would be jealous. Hardly a fish got back to the water.';
  if (g === 'A') return 'Sharp timing on the dives. The sea run was yours.';
  if (g === 'B') return 'A good haul. Lead the fish a little more and the chains will grow.';
  if (g === 'C') return 'Some catches. Watch for the dark shapes under the surface and dive early.';
  return 'The fish got away this time. Aim where the fish will be, not where it is.';
}
function gradeLine(g, pct) {
  if (g === 'S') return 'Indistinguishable from the flock. A real starling would not notice you.';
  if (g === 'A') return 'You moved with the murmuration. Only a sharp eye would pick you out.';
  if (g === 'B') return 'Mostly in step. The flock forgave a few wobbles.';
  if (g === 'C') return 'You kept up, just. The neighbours noticed.';
  return 'The flock flew on without you. Try again on Calm, or ease off the stick.';
}

// ------------------------------------------------------------------------------------------------ helpers
// slot direction / speed by central difference
const flowOut = { fx: 0, fy: 0, fz: 1, v: 13 };
function slotFlow(t) {
  G.flock.slotAt(t - 0.04, tmpA); G.flock.slotAt(t + 0.04, tmpB);
  const dx = tmpB.x - tmpA.x, dy = tmpB.y - tmpA.y, dz = tmpB.z - tmpA.z, l = Math.hypot(dx, dy, dz) || 1;
  flowOut.fx = dx / l; flowOut.fy = dy / l; flowOut.fz = dz / l; flowOut.v = l / 0.08;
  return flowOut;
}

function toast(text, kind = '', dur = 2.2) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); setTimeout(() => el.remove(), 400); }, dur * 1000);
}
const floaters = [];
function floatText(text, x, y, z, kind) {
  const el = document.createElement('div');
  el.className = 'float ' + kind; el.textContent = text;
  $('floaters').appendChild(el);
  floaters.push({ el, x, y, z, age: 0 });
}

function renderTimeline() {
  const tl = $('tlMarks');
  tl.innerHTML = '';
  for (const s of SWEEPS) {
    const m = document.createElement('i');
    m.style.left = (100 * s.t0 / RUN_T) + '%'; m.style.width = (100 * (s.t1 - s.t0) / RUN_T) + '%';
    tl.appendChild(m);
  }
}

// ------------------------------------------------------------------------------------------------ the bot (tests, demo)
function botInput() {
  const P = G.player, t = G.t, F = G.flock;
  let tx, ty, tz, mode = G.bot;
  if (mode === 'fish') {
    let best = null, bd = 1e9;
    for (const f of fishes.list) {
      if (f.state !== 'air') continue;
      const d = Math.hypot(f.x - P.x, f.y - P.y, f.z - P.z);
      const ahead = (f.x - P.x) * P.fx + (f.z - P.z) * P.fz;
      if (d < 40 && ahead > -1 && d < bd) { bd = d; best = f; }
    }
    if (best) { const lead = Math.min(0.5, bd / 16); tx = best.x + best.vx * lead; ty = best.y + best.vy * lead; tz = best.z + best.vz * lead; }
    else mode = 'lane';
  }
  if (mode === 'brawl') {
    // hunt the nearest rival, leading it
    let best = null, bd = 1e9;
    for (const b of brawl.birds) { if (b.state !== 'fly') continue; const d = Math.hypot(b.x - P.x, b.y - P.y, b.z - P.z); if (d < bd) { bd = d; best = b; } }
    if (best) { const lead = Math.min(0.7, bd / 12); tx = best.x + (best.vx - P.vx) * lead; ty = best.y + (best.vy - P.vy) * lead; tz = best.z + (best.vz - P.vz) * lead; G.botClose = bd > 18; }
    else mode = 'lane';
  }
  if (mode === 'ram') {
    // lock onto the nearest bird ahead and fly straight at it until it is hit (or lost)
    let bi = G.botTarget ?? -1;
    if (bi >= 0 && (F.state[bi] || t > G.botUntil)) bi = -1;
    if (bi < 0) {
      let bd = 1e9;
      for (let i = 0; i < F.N; i++) {
        if (F.state[i]) continue;
        const ex = F.pos[i * 3] - P.x, ey = F.pos[i * 3 + 1] - P.y, ez = F.pos[i * 3 + 2] - P.z;
        const ahead = ex * P.fx + ey * P.fy + ez * P.fz;
        const d = Math.hypot(ex, ey, ez);
        if (ahead > 0.8 && d < bd) { bd = d; bi = i; }
      }
      G.botTarget = bi; G.botUntil = t + 2.5;
    }
    if (bi >= 0) {
      // intercept: aim where the bird will be, using its velocity relative to ours
      const b3 = bi * 3, d = Math.hypot(F.pos[b3] - P.x, F.pos[b3 + 1] - P.y, F.pos[b3 + 2] - P.z), lead = Math.min(0.6, d / 6);
      tx = F.pos[b3] + (F.vS[b3] - P.vx) * lead; ty = F.pos[b3 + 1] + (F.vS[b3 + 1] - P.vy) * lead; tz = F.pos[b3 + 2] + (F.vS[b3 + 2] - P.vz) * lead;
      G.botClose = d < 4;
    } else mode = 'lane';
  }
  let along = 0;
  if (mode === 'lane') {
    F.slotAt(t + 0.45, tmpA); tx = tmpA.x; ty = tmpA.y; tz = tmpA.z;
    F.slotAt(t, tmpB);
    const S = slotFlow(t);
    along = (P.x - tmpB.x) * S.fx + (P.y - tmpB.y) * S.fy + (P.z - tmpB.z) * S.fz;
  }
  const dx = tx - P.x, dy = ty - P.y, dz = tz - P.z;
  const yawT = Math.atan2(dx, dz), pitchT = Math.atan2(dy, Math.hypot(dx, dz));
  const A = DIFF[G.diffKey].assist;
  const sx = clamp(-wrapPi(yawT - P.yaw) * 2.4 - P.yawRate * 0.08, -1, 1);
  const sy = clamp((pitchT - P.pitch * (1 - A)) * 2.0, -1, 1);
  return { sx, sy, boost: mode === 'fish' || (mode === 'ram' && !G.botClose) || (mode === 'brawl' && !G.botClose) ? true : mode === 'lane' && along < -1.5, brake: mode === 'lane' && along > 1.5 };
}

// ------------------------------------------------------------------------------------------------ frame update
function frame(dtReal) {
  const D = DIFF[G.diffKey];
  const playing = G.mode === 'play';
  const running = G.mode === 'play' || G.mode === 'intro' || G.mode === 'title' || G.mode === 'end';
  if (G.slowT > 0) { G.slowT -= dtReal; G.timeScale = lerp(G.timeScale, 0.32, 0.5); } else G.timeScale = lerp(G.timeScale, 1, 1 - Math.exp(-dtReal / 0.12));
  const dt = running ? dtReal * G.timeScale : 0;
  const F = G.flock, P = G.player;
  if (running) G.t += dt;
  const t = G.t;
  // Fish Frenzy steers the flock toward the player, so it plans only a little ahead
  G.path.ensure(t + (G.gameMode === 'fish' && G.mode !== 'title' && G.mode !== 'end' ? 1.2 : 9));
  // difficulty ramp on the flock itself
  const p = clamp(t / RUN_T, 0, 1);
  F.fold = G.mode === 'title' || G.mode === 'end' ? 1.5 : 0.55 + 0.95 * smooth(0.05, 0.9, p) * D.ramp;

  // events: waves, crossers, fish
  if (playing || G.mode === 'title') {
    if (t >= G.nextWave) {
      const strength = G.mode === 'title' ? 0.9 : 0.75 + 0.6 * p;
      F.addWave(t + 2.4, G.R, strength * D.waves ** 0.5);
      if (playing && !G.phaseShown.wave) { G.phaseShown.wave = 1; setTimeout(() => toast('A wave is running through the flock', 'info'), 1200); }
      G.nextWave = t + (G.mode === 'title' ? 5 : lerp(9, 3.2, p) / D.waves) * (0.75 + 0.5 * G.R());
    }
    if (playing && G.gameMode === 'murm' && t >= G.nextCross) {
      const i = F.addCrosser(t, G.R, F.slot);
      if (i >= 0 && !G.phaseShown.cross) { G.phaseShown.cross = 1; toast('Watch out: neighbours drifting through your lane', 'info', 2.6); }
      G.nextCross = t + lerp(8, 3, p) / D.crossers * (0.7 + 0.6 * G.R());
    }
    if (t >= G.nextFish) (G.gameMode === 'fish' && G.mode !== 'title' ? spawnFrenzy(t)
      : G.gameMode === 'brawl' && G.mode !== 'title' ? (spawnFrenzy(t), G.nextFish = t + 3.5 + G.R() * 3) : spawnFish(t));
    if (playing && G.gameMode === 'murm') {
      for (const s of SWEEPS) {
        const k = 'sw' + s.t0;
        if (t > s.t0 - 2.5 && !G.phaseShown[k]) { G.phaseShown[k] = 1; toast('Sea run — dive for the flying fish', 'fish', 2.6); sound.chime(true); }
      }
      if (t > RUN_T * 0.4 && !G.phaseShown.mid) { G.phaseShown.mid = 1; toast('The turns are getting tighter', 'info'); }
      if (t > RUN_T * 0.78 && !G.phaseShown.late) { G.phaseShown.late = 1; toast('Final stretch: hold on', 'info'); }
    }
  }

  // the player
  let S = null;
  if (G.mode !== 'title' && G.mode !== 'end') {
    F.slotAt(t, tmpS);
    S = slotFlow(t);
    if (G.mode === 'intro') {
      // locked to the slot while the camera swoops in
      P.reset(tmpS.x, tmpS.y, tmpS.z, Math.atan2(S.fx, S.fz), Math.asin(S.fy), S.v);
      P.roll = tmpS.bank;
      G.introT += dtReal;
      const c = Math.ceil(G.introLen - G.introT);
      $('count').textContent = c > 0 ? String(c) : 'Go';
      if (G.introT >= G.introLen) {
        setMode('play'); $('count').textContent = 'Go'; setTimeout(() => $('count').classList.add('hidden'), 500);
        toast(G.gameMode === 'fish' ? 'Catch the flying fish. Quick catches chain for more.'
          : G.gameMode === 'brawl' ? 'Ram the other birds out of the sky. Stay inside the ring.' : 'Hold your place in the flock', 'info', 2.8);
        if (G.gameMode === 'fish') G.nextFish = t + 0.3;
      }
    } else if (playing) {
      const inp = G.bot ? (input.override = botInput(), input.read()) : input.read();
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / n;
      for (let k = 0; k < n; k++) {
        const ex = P.x - tmpS.x, ey = P.y - tmpS.y, ez = P.z - tmpS.z;
        const along = ex * S.fx + ey * S.fy + ez * S.fz;
        P.seaY = world.sea.heightAt(P.x, P.z);
        P.step(h, inp, S, S.v, along, G.gameMode !== 'murm' ? FRENZY_FLIGHT[G.diffKey] : D, G.R, onDunk);
        // a dip into the sea: a splash going in and coming out, and a wake of spray while the body is in the water
        if (P.wetEnter || P.wetExit) { rings.ring(P.x, P.z, 1.2, 1.1, 0.45); spray.splash(P.x, P.z, 0.6, G.R); sound.splash(0.3); }
        if (P.wet && (P.wakeT -= h) <= 0) { P.wakeT = 0.09; spray.splash(P.x, P.z, 0.35, G.R); rings.ring(P.x, P.z, 0.7, 0.9, 0.3); }
      }
      if (G.gameMode === 'fish') frenzyTick(dt);
      else if (G.gameMode === 'brawl') brawlTick(dt, t);
      else grade(dt, S, D);
      if (t >= RUN_T || (G.endAt !== null && t >= G.endAt)) { endRun(); }
    }
  }

  // flock
  const playerForFlock = G.mode === 'play' ? P : (G.mode === 'intro' ? { ...P, invuln: 1 } : null);
  // Sky Brawl is just the fighters over the sea: the murmuration sits that one out
  const noFlock = G.gameMode === 'brawl' && G.mode !== 'title';
  if (noFlock) { for (const L of [lods.near, lods.mid, lods.far]) { L.begin(); L.end(); } }
  else F.update(t, dt, playerForFlock, camera.position, lods, { onHit, onSplash: (x, z, s) => { rings.ring(x, z, 1.4, 1.3, 0.5); spray.splash(x, z, s, G.R); sound.splash(0.4); } });
  fishes.update(dt, t, G.mode === 'play' ? P : null, D.catchR, onCatch, G.R);
  spray.update(dt); down.update(dt); rings.update(dt); feathers.update(dt);
  brawl.render(t);

  // camera
  updateCamera(dtReal, S);
  world.update(t, camera);

  // the player's bird, the ghost and the guide
  hero.begin(); ghost.begin();
  if (G.mode !== 'title' && G.mode !== 'end') {
    // nose up a touch in a glide, body riding the bound's sink (visual only; the flight model is unchanged)
    const fl = Math.max(0, 1 - P.glide - P.bound);
    const bd = bodyAt(P.phase, heroBody);
    const pu = 0.087 * P.glide + 0.05 * P.bound + bd.pitch * fl;
    const hl = Math.hypot(P.fx, P.fy + pu, P.fz);
    quatFromFwdRoll(qtmp, P.fx / hl, (P.fy + pu) / hl, P.fz / hl, P.roll);
    const showHero = !(G.gameMode === 'brawl' && brawl.on && brawl.player.dead);
    const hx = P.x + P.fx * bd.surge * fl, hy = P.y + P.sinkY + bd.heave * fl, hz = P.z + P.fz * bd.surge * fl;
    if (showHero) hero.push(hx, hy, hz, 1, qtmp, P.phase, P.glide, P.bound);
    if (heroGLB) { heroGLB.root.visible = showHero; if (showHero) heroGLB.update(hx, hy, hz, qtmp, P.phase, P.glide, P.bound, dtReal); }
    const off = G.mode === 'play' && G.dist !== undefined ? G.dist : 0;
    const camD = camera.position.distanceTo(_v.set(tmpS.x, tmpS.y, tmpS.z));
    const ga = G.mode === 'play' && G.gameMode === 'murm' ? smooth(0.9, 2.2, off) * smooth(1.2, 2.6, camD) * 0.6 : 0;
    if (ga > 0.01) {
      quatFromFwdRoll(qtmp, S.fx, S.fy, S.fz, tmpS.bank);
      ghost.push(tmpS.x, tmpS.y, tmpS.z, 1, qtmp, (t * 13.3) % 1, 0.2, 0);
    }
    ghost.uniforms.uGhostA.value = ga;
    if (G.gameMode === 'murm') updateGuide(t, off); else { guide.pts.visible = false; for (const h of hoops) h.mesh.visible = false; }
  } else { guide.pts.visible = false; for (const h of hoops) h.mesh.visible = false; }
  hero.end(); ghost.end();
  // with the feathered bird loaded, the VAT hero only lends its wing-blur copies
  if (heroGLB) { hero.mesh.visible = false; if (G.mode === 'title' || G.mode === 'end') heroGLB.root.visible = false; }
}

function grade(dt, S, D) {
  const P = G.player;
  const ex = P.x - tmpS.x, ey = P.y - tmpS.y, ez = P.z - tmpS.z;
  const al = ex * S.fx + ey * S.fy + ez * S.fz;
  const px = ex - al * S.fx, py = ey - al * S.fy, pz = ez - al * S.fz;
  const dist = Math.sqrt(px * px + py * py + pz * pz + (al * 0.5) ** 2);
  const qT = 1 - smooth(1.15 * D.tol, 4.2 * D.tol, dist);
  const cos = P.fx * S.fx + P.fy * S.fy + P.fz * S.fz;
  const qA = smooth(0.55, 0.95, cos);
  const q = qT * (0.4 + 0.6 * qA);
  G.q = q; G.dist = dist; G.cos = cos;
  G.qSum += q * dt; G.qTime += dt;
  G.pathPts += q * dt * 25;
  G.score += q * dt * 25;
  G.histAcc += q * dt; G.histT += dt;
  if (G.histT >= 1) { G.hist.push(G.histAcc / G.histT); G.histAcc = 0; G.histT = 0; }
  if (q < 0.25 && G.lastQ >= 0.25 && dist > 6) toast('Get back to your place: fly through the rings', 'warn', 1.6);
  G.lastQ = q;
}

function onHit(i, x, y, z) {
  const P = G.player, F = G.flock;
  F.knock(i, P.vx, P.vy, P.vz, G.R);
  P.hit(G.R);
  // knocking a neighbour out of the sky scores
  const pts = G.gameMode === 'brawl' ? 25 : 75;
  G.collisions++; G.score += pts;
  feathers.burst(x, y, z, P.vx, P.vy, P.vz, 18, G.R);
  for (let k = 0; k < 40; k++) {
    const a = G.R() * 6.283, b = G.R() * 2 - 1, sp = 0.6 + G.R() * 2.6;
    down.emit(x, y, z, Math.cos(a) * sp + P.vx * 0.85, b * sp + P.vy * 0.85, Math.sin(a) * sp + P.vz * 0.85, 1.2 + G.R() * 1.4, 0.025 + G.R() * 0.035);
  }
  feathers.burst(P.x, P.y, P.z, P.vx, P.vy, P.vz, 5, G.R);
  sound.hit();
  G.shake = 0.4; G.flash = 0.35; G.slowT = Math.max(G.slowT, 0.09);
  floatText(`+${pts}`, x, y + 0.3, z, 'good');
  if (G.collisions === 1) toast('Knocked one out of the sky!', 'fish', 1.8);
}
function onDunk(x, z) {
  const frenzy = G.gameMode === 'fish';
  G.dunks++; if (!frenzy) G.score = Math.max(0, G.score - 80); G.combo = 0; G.lastCatch = -99;
  rings.ring(x, z, 2.2, 1.5, 0.6); spray.splash(x, z, 1.4, G.R); sound.splash(1);
  G.shake = 0.35;
  floatText(frenzy ? 'splash: chain broken' : 'splash −80', x, 0.8 + world.sea.heightAt(x, z), z, 'bad');
}
function onCatch(f) {
  const t = G.t;
  G.combo = t - G.lastCatch < CHAIN_S ? G.combo + 1 : 1;
  G.lastCatch = t;
  G.bestCombo = Math.max(G.bestCombo, G.combo);
  G.fish++;
  const pts = 100 * G.combo;
  G.score += pts;
  if (G.gameMode === 'brawl' && brawl.player.hp < BRAWL.hp && !brawl.player.dead) {
    if (G.online === 'client') net.lobby.send({ k: 'heal' }); else brawl.player.hp++;
    toast('A fish: one feather back', 'fish', 1.4);
  }
  sound.fish(G.combo);
  for (let k = 0; k < 14; k++) {
    const a = G.R() * 6.283, b = G.R() * 2 - 1, s = 1 + G.R() * 2;
    spray.emit(f.x, f.y, f.z, Math.cos(a) * s + f.vx * 0.3, b * s + 0.5, Math.sin(a) * s + f.vz * 0.3, 0.5 + G.R() * 0.4, 0.035);
  }
  G.slowT = 0.16; G.fovKick = 5;
  floatText(G.combo > 1 ? `+${pts}  ×${G.combo}` : `+${pts}`, f.x, f.y + 0.35, f.z, 'good');
  const el = $('sFish'); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

const CHAIN_S = 4;
const brawl = new Brawl(scene, null);
const brawlHooks = {
  seaH: (x, z) => world.sea.heightAt(x, z),
  onSplash: (x, z) => { rings.ring(x, z, 1.6, 1.3, 0.55); spray.splash(x, z, 0.9, G.R); sound.splash(0.5); },
  onHit: (by, b, x, y, z, byPlayer) => {
    feathers.burst(x, y, z, b.vx, b.vy, b.vz, byPlayer ? 14 : 6, G.R);
    if (byPlayer) { G.score += 50; floatText('+50', x, y + 0.3, z, 'good'); sound.hit(); G.shake = Math.max(G.shake, 0.25); G.slowT = 0.07; }
  },
  onKO: (b, byPlayer) => {
    if (byPlayer) { G.score += 250; toast(`You knocked ${b.name} out! +250`, 'fish', 1.8); }
    else if (G.R() < 0.5) toast(`${b.name} is out`, 'info', 1.2);
  },
  onPlayerHit: (by, x, y, z) => {
    const P = G.player;
    P.hit(G.R); feathers.burst(P.x, P.y, P.z, P.vx, P.vy, P.vz, 12, G.R); sound.hit();
    G.shake = 0.5; G.flash = 1; G.slowT = 0.09;
    floatText('−1 feather', P.x, P.y + 0.4, P.z, 'bad');
  },
  onPlayerOut: (by) => {
    toast(by && by.name ? `${by.name} knocked you out` : 'You are out', 'warn', 2);
    if (G.online === 'host') toast('You are hosting: the match goes on until one bird is left', 'info', 3);
    else G.endAt = G.t + 1.6;
  },
};
let ringWarn = 0;
function brawlTick(dt, t) {
  brawl.update(dt, t, G.player, brawlHooks);
  G.q = brawl.player.hp / BRAWL.hp;
  G.histT += dt;
  if (G.histT >= 1) { G.hist.push(brawl.alive()); G.histT = 0; }
  const out = Math.hypot(G.player.x - brawl.cx, G.player.z - brawl.cz) > brawl.radius(t);
  if (out && t > ringWarn) { toast('Outside the ring: get back in before you lose a feather', 'warn', 1.8); ringWarn = t + 4; }
  if (brawl.winner === 'player' && G.endAt === null) { toast('Last bird flying!', 'fish', 2.4); G.endAt = t + 2; }
  else if (brawl.winner === 'rival' && G.endAt === null && G.online) { G.endAt = t + 2; }
  netTick(dt);
}
// Fish Frenzy flight: no pull toward a place in the flock, a light flocking instinct so a centred stick flies on with
// the birds, and the same gusts as the chosen flight
const FRENZY_FLIGHT = Object.fromEntries(Object.entries(DIFF).map(([k, d]) => [k, { ...d, assist: d.assist * 0.35, pace: 0 }]));

// Fish Frenzy: fish leap all around where you will be in two to three seconds, alone, in pairs, or now and then a
// whole school fanning out at once
function spawnFrenzy(t) {
  const R = G.R, P = G.player, D = DIFF[G.diffKey];
  const hl = Math.hypot(P.fx, P.fz) || 1, fx = P.fx / hl, fz = P.fz / hl, rx = -fz, rz = fx;
  const school = R() < 0.1;
  const n = school ? 5 + Math.floor(R() * 3) : R() < 0.4 ? 2 : 1;
  const lead = 2.1 + R() * 1.2;
  const sp = Math.hypot(P.vx, P.vz);
  const cx = P.x + fx * sp * lead, cz = P.z + fz * sp * lead;
  const lat0 = (R() - 0.5) * 2 * (school ? 6 : 13), al0 = (R() - 0.4) * 14;
  for (let k = 0; k < n; k++) {
    const lat = lat0 + (school ? (k - n / 2) * 1.6 : (R() - 0.5) * 3), al = al0 + (R() - 0.5) * (school ? 3 : 6);
    const ang = (R() - 0.5) * (school ? 0.5 : 1.6) + (school ? 0 : (R() - 0.5) * 0.6);
    const dx = fx * Math.cos(ang) - rx * Math.sin(ang), dz = fz * Math.cos(ang) - rz * Math.sin(ang);
    const qx = cx + rx * lat + fx * al, qz = cz + rz * lat + fz * al;
    fishes.spawn(t, t + lead + k * (school ? 0.12 : 0.3), qx, world.sea.heightAt(qx, qz) + 1.2 + R() * 3, qz, dx, dz, 7 + R() * 4, R);
  }
  if (school && !G.phaseShown.school) { G.phaseShown.school = 1; toast('A whole school is breaking the surface', 'fish', 2.2); }
  G.nextFish = t + (0.55 + R() * 0.75) / Math.sqrt(D.ramp);
}
function frenzyTick(dt) {
  // the top bar shows how long the current chain stays open
  G.q = G.combo > 0 ? clamp(1 - (G.t - G.lastCatch) / CHAIN_S, 0, 1) : 0;
  G.histAcc += 0; G.histT += dt;
  if (G.histT >= 1) { G.hist.push(G.fish); G.histT = 0; }
}

function spawnFish(t) {
  const R = G.R, F = G.flock;
  const lead = 2.6 + R() * 0.7, tA = t + lead;
  F.slotAt(tA, tmpA);
  if (tmpA.y < 13.5 && G.path.sweepW(tA) > 0.3) {
    const S = slotFlow(tA);
    F.slotAt(tA, tmpA);
    const hx = S.fx, hz = S.fz, hl = Math.hypot(hx, hz) || 1;
    const fx = hx / hl, fz = hz / hl, rx = -fz, rz = fx;
    const n = R() < 0.35 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const lat = (R() < 0.5 ? -1 : 1) * (0.3 + R() * (G.mode === 'title' ? 14 : 4.5));
      const al = (R() - 0.5) * 4 + k * 1.5;
      const ang = (R() - 0.5) * 0.7;
      const dx = fx * Math.cos(ang) - rx * Math.sin(ang), dz = fz * Math.cos(ang) - rz * Math.sin(ang);
      fishes.spawn(t, tA + k * 0.25, tmpA.x + rx * lat + fx * al, 1.4 + R() * 2.6, tmpA.z + rz * lat + fz * al, dx, dz, 8 + R() * 3, R);
    }
    G.nextFish = t + 0.8 + R() * 0.8;
  } else {
    // the odd fish far below the flock: a tempting, expensive detour
    if (G.t > 3) {
      const tA = t + 3.2;
      const S = slotFlow(tA); F.slotAt(tA, tmpA);
      const hl = Math.hypot(S.fx, S.fz) || 1, fx = S.fx / hl, fz = S.fz / hl;
      const lat = (R() - 0.5) * 24;
      fishes.spawn(t, tA, tmpA.x - fz * lat, 1.6 + R() * 2, tmpA.z + fx * lat, fx, fz, 9 + R() * 2, R);
    }
    G.nextFish = t + 3 + R() * 4;
  }
}

function updateGuide(t, off) {
  const g = guide;
  const vis = G.mode === 'play' || G.mode === 'intro';
  g.pts.visible = vis;
  if (!vis) return;
  const bright = G.mode === 'intro' ? 0.8 : 0.45 + 0.55 * smooth(0.6, 2.2, off);
  for (let k = 0; k < GN; k++) {
    const dtk = 0.3 + k * 0.06;
    G.flock.slotAt(t + dtk, tmpA);
    g.p[k * 3] = tmpA.x; g.p[k * 3 + 1] = tmpA.y; g.p[k * 3 + 2] = tmpA.z;
    g.a[k] = bright * smooth(0, 3, k) * (1 - smooth(GN * 0.55, GN, k));
    g.s[k] = 0.07;
  }
  for (const n of ['position', 'aA', 'aS']) g.g.attributes[n].needsUpdate = true;
  updateGates(t, bright);
}

function updateGates(t, bright) {
  const P = G.player, tol = DIFF[G.diffKey].tol, rad = 0.7 * tol;
  const scoring = G.mode === 'play';
  // place the rings that have come within GATE_AHEAD of the slot's flight; once placed, a ring never moves
  while (gates.nextT < t + GATE_AHEAD) {
    const h = hoops.find((x) => !x.gate);
    if (!h) break;
    const tk = gates.nextT; gates.nextT += GATE_DT;
    G.flock.slotAt(tk, tmpA); const bank = tmpA.bank;
    G.flock.slotAt(tk + 0.05, tmpB);
    let fx = tmpB.x - tmpA.x, fy = tmpB.y - tmpA.y, fz = tmpB.z - tmpA.z; const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    h.gate = { t: tk, x: tmpA.x, y: tmpA.y, z: tmpA.z, fx, fy, fz, state: 'live', sPrev: null, t1: 0, a: 0 };
    const m = h.mesh;
    m.position.set(tmpA.x, tmpA.y, tmpA.z);
    m.up.set(0, 1, 0);
    m.lookAt(tmpB.x, tmpB.y, tmpB.z);
    m.rotateZ(bank);
    m.scale.setScalar(rad / 0.88);
    h.m.uniforms.uCol.value.copy(LOOK.accent);
  }
  for (const h of hoops) {
    const g = h.gate;
    if (!g) continue;
    const ex = P.x - g.x, ey = P.y - g.y, ez = P.z - g.z;
    const sd = ex * g.fx + ey * g.fy + ez * g.fz;          // signed distance of the bird past the ring's plane
    const d = Math.hypot(ex, ey, ez);
    if (g.state === 'live') {
      if (g.sPrev !== null && g.sPrev < 0 && sd >= 0) {
        const rr = Math.hypot(ex - sd * g.fx, ey - sd * g.fy, ez - sd * g.fz);
        if (rr < rad * 1.2) {
          g.state = 'passed'; g.t1 = t;
          if (scoring) {
            gates.passed++; gates.streak++;
            // a ring is worth about as much as the in-line points for the same stretch, more on a streak
            G.score += 5 + Math.min(gates.streak - 1, 10);
            if (gates.streak % 10 === 0) { floatText(gates.streak + ' rings', g.x, g.y + 0.4, g.z, 'good'); sound.chime(true); }
          }
        } else { g.state = 'missed'; g.t1 = t; if (scoring) { gates.missed++; gates.streak = 0; } }
      } else if (t > g.t + 1.2 || sd > 4) { g.state = 'missed'; g.t1 = t; if (scoring) { gates.missed++; gates.streak = 0; } }
      g.sPrev = sd;
    }
    const m = h.mesh, U = h.m.uniforms;
    m.visible = true;
    const cd = camera.position.distanceTo(m.position);
    if (g.state === 'live') {
      // appears as the bird comes into its vicinity
      const want = bright * 0.95 * smooth(26, 10, d) * smooth(0.8, 2.2, cd);
      g.a += (want - g.a) * 0.25;
      U.uA.value = g.a;
    } else if (g.state === 'passed') {
      const k = (t - g.t1) / 0.35;
      m.scale.setScalar((rad / 0.88) * (1 + 0.45 * k));
      U.uCol.value.copy(LOOK.accent).lerp(_white, 0.6);
      U.uA.value = Math.max(0, 1 - k) * Math.max(g.a, 0.6);
      if (k >= 1) { h.gate = null; m.visible = false; }
    } else {
      const k = (t - g.t1) / 0.4;
      U.uA.value = Math.max(0, 1 - k) * g.a * 0.5;
      if (k >= 1) { h.gate = null; m.visible = false; }
    }
  }
}
const _white = new THREE.Color(1, 1, 1);

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _f2 = new THREE.Vector3();
function updateCamera(dt, S) {
  const P = G.player;
  if (G.mode === 'title' || G.mode === 'end' || !S) {
    G.flock.centre(G.t, tmpA);
    G.orbitA += dt * 0.045;
    const R = 150;
    const target = _v.set(tmpA.x, tmpA.y, tmpA.z);
    const eye = _w.set(tmpA.x + Math.cos(G.orbitA) * R, Math.max(6, tmpA.y * 0.45 + 2), tmpA.z + Math.sin(G.orbitA) * R);
    if (!camState.init) { camState.pos.copy(eye); camState.look.copy(target); camState.init = true; }
    camState.pos.lerp(eye, 1 - Math.exp(-dt / 0.6)); camState.look.lerp(target, 1 - Math.exp(-dt / 0.6));
    camera.position.copy(camState.pos); camera.up.set(0, 1, 0); camera.lookAt(camState.look);
    camera.fov = 36;
    // frame the flock to the right of the title panel (or above it on a phone)
    const W = innerWidth, H = innerHeight;
    if (G.mode === 'title') {
      if (W > 760) camera.setViewOffset(W, H, -0.17 * W, 0, W, H); else camera.setViewOffset(W, H, 0, 0.16 * H, W, H);
    } else camera.clearViewOffset();
    camera.updateProjectionMatrix(); updatePx();
    return;
  }
  // chase: behind and above, following a smoothed heading; a little of the bank shows in the horizon
  const f = _u.set(P.fx, P.fy, P.fz);
  if (!camState.init) { camState.fwd.copy(f); camState.init = true; camState.off = null; }
  camState.fwd.lerp(f, 1 - Math.exp(-dt / 0.2)).normalize();
  // the camera follows only part of the bird's climb or dive, so the horizon stays in view
  const cf = _f2.set(camState.fwd.x, camState.fwd.y * 0.55, camState.fwd.z).normalize();
  // while the bird skims in the water the camera rises a little, so wave crests don't hide it
  camState.wet = (camState.wet || 0) + ((P.wet ? 1 : 0) - (camState.wet || 0)) * (1 - Math.exp(-dt / 0.25));
  const back = 1.5 + P.boosting * 0.45, upOff = 0.4 + 0.6 * camState.wet;
  // smooth the offset from the bird, not the world position, so speed never drags the camera back
  const want = _w.set(-cf.x * back, -cf.y * back + upOff, -cf.z * back);
  if (!camState.off) camState.off = want.clone();
  camState.off.lerp(want, 1 - Math.exp(-dt / 0.08));
  let pos = new THREE.Vector3(P.x, P.y, P.z).add(camState.off);
  pos.y = Math.max(pos.y, world.sea.heightAt(pos.x, pos.z) + 0.45 + 0.5 * camState.wet);
  let lk = _v.set(P.x + cf.x * 5, P.y + cf.y * 5 + 0.4, P.z + cf.z * 5).clone();
  if (G.mode === 'intro') {
    const k = smooth(0, 1, G.introT / Math.max(0.01, G.introLen * 0.8));
    const e = k * k * (3 - 2 * k);
    pos = G.camFrom.pos.clone().lerp(pos, e);
    lk = G.camFrom.look.clone().lerp(lk, e);
  }
  if (G.shake > 0) {
    const s = G.shake * 0.09;
    pos.x += (Math.random() - 0.5) * s; pos.y += (Math.random() - 0.5) * s; pos.z += (Math.random() - 0.5) * s;
    G.shake = Math.max(0, G.shake - dt * 1.6);
  }
  if (camera.view && camera.view.enabled) camera.clearViewOffset();
  camState.pos.copy(pos); camState.look.copy(lk);
  camera.position.copy(pos);
  // roll a quarter of the bird's bank into the camera
  const r = P.roll * 0.22;
  const rt = new THREE.Vector3().crossVectors(cf, new THREE.Vector3(0, 1, 0)).normalize();
  camera.up.set(0, 1, 0).multiplyScalar(Math.cos(r)).addScaledVector(rt, -Math.sin(r));
  camera.lookAt(lk);
  G.fovKick = Math.max(0, G.fovKick - dt * 12);
  const fov = (G.mode === 'intro' ? lerp(40, 62, smooth(0, 1, G.introT / G.introLen)) : 62) + P.boosting * 8 + G.fovKick;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); updatePx(); }
}

// ------------------------------------------------------------------------------------------------ HUD
let fpsE = 60;
function hud(dtReal) {
  const P = G.player;
  if (G.mode === 'play' || G.mode === 'intro' || G.mode === 'paused') {
    const frenzy = G.gameMode === 'fish';
    const pct = G.qTime > 0.2 ? 100 * G.qSum / G.qTime : 100;
    const bw = G.gameMode === 'brawl';
    $('pct').textContent = bw ? String(brawl.on ? brawl.alive() : BRAWL.rivals + 1) : frenzy ? String(G.fish) : G.mode === 'intro' ? '–' : pct.toFixed(0);
    $('qfill').style.width = (100 * (frenzy ? G.q : G.mode === 'intro' ? 1 : G.q)) + '%';
    $('hud').dataset.q = frenzy ? 'good' : G.q > 0.75 ? 'good' : G.q > 0.3 ? 'mid' : 'bad';
    $('sScore').textContent = Math.round(G.score).toLocaleString();
    $('sFish').textContent = bw ? brawl.player.kos : frenzy ? (G.combo > 1 && G.q > 0 ? '×' + G.combo : '–') : G.fish;
    $('sHits').textContent = bw ? '●'.repeat(Math.max(0, brawl.player.hp)) + '○'.repeat(Math.max(0, BRAWL.hp - brawl.player.hp)) : frenzy ? fishes.spawned : G.collisions + G.dunks;
    if (bw) $('hud').dataset.q = brawl.player.hp >= 3 ? 'good' : brawl.player.hp === 2 ? 'mid' : 'bad';
    const rem = Math.max(0, RUN_T - Math.max(0, G.t));
    $('sTime').textContent = `${Math.floor(rem / 60)}:${String(Math.floor(rem % 60)).padStart(2, '0')}`;
    $('tlFill').style.width = (100 * clamp(G.t / RUN_T, 0, 1)) + '%';
    $('boostFill').style.width = (100 * P.energy) + '%';
    $('boost').classList.toggle('on', P.boosting > 0.5);
    G.flash = Math.max(0, G.flash - dtReal * 2.5);
    $('flash').style.opacity = (G.flash * 0.55).toFixed(3);
  }
  // floating texts
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.age += dtReal;
    const v = _v.set(f.x, f.y + f.age * 0.6, f.z).project(camera);
    if (f.age > 1.3 || v.z > 1) { f.el.remove(); floaters.splice(i, 1); continue; }
    f.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -50%)`;
    f.el.style.opacity = String(1 - smooth(0.8, 1.3, f.age));
  }
  drawOverlay();
  fpsE = lerp(fpsE, 1 / Math.max(dtReal, 1e-3), 0.05);
}

function drawOverlay() {
  const W = overlay.width, H = overlay.height, k = W / innerWidth;
  octx.clearRect(0, 0, W, H);
  if (!(G.mode === 'play' || G.mode === 'intro')) return;
  const acc = '#f07634';
  octx.save(); octx.scale(k, k);
  const w = innerWidth, h = innerHeight;
  // fish in the air: a thin ring around each; fish about to leap: a small tick on the water
  for (const f of fishes.list) {
    if (f.state !== 'air' && f.state !== 'lurk') continue;
    const x = f.state === 'air' ? f.x : f.bx, y = f.state === 'air' ? f.y : world.sea.heightAt(f.bx, f.bz), z = f.state === 'air' ? f.z : f.bz;
    const v = _v.set(x, y, z).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
    const d = camera.position.distanceTo(_w.set(x, y, z));
    if (d > 90) continue;
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    const r = clamp(0.45 * U.uPxPerM.value / k / d, 7, 40);
    octx.globalAlpha = f.state === 'air' ? clamp(1.4 - d / 70, 0.3, 1) : 0.5 * clamp(1 - (f.tB - G.t), 0, 1);
    octx.strokeStyle = acc; octx.lineWidth = 1.5;
    octx.beginPath();
    if (f.state === 'air') octx.arc(sx, sy, r, 0, Math.PI * 2);
    else { octx.moveTo(sx - r, sy); octx.lineTo(sx + r, sy); }
    octx.stroke();
  }
  octx.globalAlpha = 1;
  // where is my place? when the slot leaves the screen, an arrow at the edge points back to it
  if (G.gameMode === 'brawl' && brawl.on) drawRivals(w, h, k, acc);
  if (G.mode === 'play' && G.gameMode === 'murm') {
    const v = _v.set(tmpS.x, tmpS.y, tmpS.z).project(camera);
    const behind = v.z > 1;
    let x = v.x, y = v.y;
    if (behind) { x = -x; y = -y; }
    const off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88;
    if (off && G.dist > 2.5) {
      const m = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.84, 1e-3);
      x /= m; y /= m;
      const sx = (x * 0.5 + 0.5) * w, sy = (-y * 0.5 + 0.5) * h;
      const a = Math.atan2(-y, x);
      octx.translate(sx, sy); octx.rotate(a);
      octx.fillStyle = acc; octx.globalAlpha = 0.9;
      octx.beginPath(); octx.moveTo(12, 0); octx.lineTo(-7, -8); octx.lineTo(-3, 0); octx.lineTo(-7, 8); octx.closePath(); octx.fill();
      octx.setTransform(k, 0, 0, k, 0, 0);
    }
  }
  // steering feedback: mouse reticle relative to the dead zone, or the touch stick
  if (input.raw.src === 'mouse' && G.mode === 'play') {
    const m = Math.min(w, h), R1 = STICK.mouseR * m, hard = input.raw.hard;
    octx.globalAlpha = 0.5; octx.strokeStyle = '#1d1e20'; octx.lineWidth = 1;
    octx.beginPath(); octx.arc(w / 2, h / 2, 0.07 * R1, 0, Math.PI * 2); octx.stroke();
    // full turn ring; beyond it the hard-turn zone, lit as you push into it
    octx.globalAlpha = 0.16 + 0.3 * hard; octx.setLineDash([4, 6]);
    octx.beginPath(); octx.arc(w / 2, h / 2, R1, 0, Math.PI * 2); octx.stroke(); octx.setLineDash([]);
    octx.globalAlpha = 0.8; octx.strokeStyle = hard > 0.05 ? acc : '#1d1e20'; octx.lineWidth = 1 + 1.5 * hard;
    octx.beginPath(); octx.arc(input.mouse.x, input.mouse.y, 5 + 3 * hard, 0, Math.PI * 2); octx.stroke();
  } else if (input.touching) {
    const T = input.touch, R = STICK.touchR * Math.min(w, h), hard = input.raw.hard, RH = R * (1 + STICK.hardSpan);
    octx.globalAlpha = 0.35; octx.strokeStyle = '#1d1e20'; octx.lineWidth = 1.5;
    octx.beginPath(); octx.arc(T.x0, T.y0, R, 0, Math.PI * 2); octx.stroke();
    octx.globalAlpha = 0.15 + 0.35 * hard; octx.setLineDash([4, 6]); octx.strokeStyle = hard > 0.05 ? acc : '#1d1e20';
    octx.beginPath(); octx.arc(T.x0, T.y0, RH, 0, Math.PI * 2); octx.stroke(); octx.setLineDash([]);
    octx.globalAlpha = 0.6; octx.fillStyle = hard > 0.05 ? acc : '#1d1e20';
    const dx = T.x - T.x0, dy = T.y - T.y0, l = Math.hypot(dx, dy), m = l > RH ? RH / l : 1;
    octx.beginPath(); octx.arc(T.x0 + dx * m, T.y0 + dy * m, 14, 0, Math.PI * 2); octx.fill();
  }
  octx.restore();
}

// rival markers: a small caret above each bird in view, with its feathers left
function drawRivals(w, h, k, acc) {
  octx.font = '600 11px system-ui, sans-serif'; octx.textAlign = 'center'; octx.textBaseline = 'alphabetic';
  const labels = [];
  for (const b of brawl.birds) {
    if (b.state !== 'fly') continue;
    const d = camera.position.distanceTo(_w.set(b.x, b.y, b.z));
    const v = _v.set(b.x, b.y + 0.35, b.z).project(camera);
    const inView = v.z < 1 && Math.abs(v.x) < 0.96 && Math.abs(v.y) < 0.92;
    if (!inView) { edgeArrow(b, v, d, w, h, acc, labels); continue; }
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h - 6;
    octx.globalAlpha = clamp(1.3 - d / 160, 0.55, 1);
    octx.fillStyle = acc;
    octx.beginPath(); octx.moveTo(sx - 5, sy - 7); octx.lineTo(sx + 5, sy - 7); octx.lineTo(sx, sy); octx.closePath(); octx.fill();
    for (let i = 0; i < BRAWL.hp; i++) {
      octx.beginPath(); octx.arc(sx - 6 + i * 6, sy - 12, 2, 0, Math.PI * 2);
      if (i < b.hp) octx.fill(); else { octx.strokeStyle = acc; octx.lineWidth = 1; octx.stroke(); }
    }
    labels.push({ x: sx, y: sy - 18, text: d < 60 ? b.name : `${b.name} ${Math.round(d)} m`, d });
  }
  // labels, nearest first; one that would overlap a placed one steps down a line (or is dropped after four tries)
  labels.sort((a, b) => a.d - b.d);
  const placed = [];
  octx.fillStyle = '#1d1e20';
  for (const L of labels) {
    const wd = octx.measureText(L.text).width + 6;
    let y = L.y, ok = false;
    for (let k = 0; k < 4 && !ok; k++) {
      ok = !placed.some((p) => Math.abs(p.x - L.x) < (p.w + wd) / 2 && Math.abs(p.y - y) < 13);
      if (!ok) y += 13;
    }
    if (!ok) continue;
    placed.push({ x: L.x, y, w: wd });
    octx.globalAlpha = clamp(1.25 - L.d / 160, 0.55, 1);
    octx.fillText(L.text, L.x, y);
  }
  octx.globalAlpha = 1;
}
// a bird off screen: an arrow on the screen edge pointing at it, with its name and distance (nearer = bolder)
function edgeArrow(b, v, d, w, h, acc, labels) {
  let x = v.x, y = v.y;
  if (v.z > 1) { x = -x; y = -y; }                         // behind the camera: the projection is mirrored
  if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) y = -1;
  const mx = 0.92, my = 0.84, s = Math.max(Math.abs(x) / mx, Math.abs(y) / my);
  x /= s; y /= s;
  const sx = (x * 0.5 + 0.5) * w, sy = (-y * 0.5 + 0.5) * h, a = Math.atan2(-y, x);
  const near = clamp(1 - d / 150, 0, 1);
  octx.globalAlpha = 0.5 + 0.5 * near;
  octx.save(); octx.translate(sx, sy); octx.rotate(a);
  octx.fillStyle = acc;
  const L = 9 + 5 * near;
  octx.beginPath(); octx.moveTo(L, 0); octx.lineTo(-L * 0.6, -L * 0.62); octx.lineTo(-L * 0.25, 0); octx.lineTo(-L * 0.6, L * 0.62); octx.closePath(); octx.fill();
  octx.restore();
  // label on the inside of the arrow, kept on screen
  const lx = clamp(sx - Math.cos(a) * 26, 34, w - 34), ly = clamp(sy + Math.sin(a) * 18 + 4, 16, h - 8);
  labels.push({ x: lx, y: ly, text: `${b.name} ${Math.round(d)} m`, d });
  octx.globalAlpha = 1;
}

function drawSpark() {
  const c = $('spark'), x = c.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = c.clientWidth || 300, H = c.clientHeight || 60;
  c.width = W * dpr; c.height = H * dpr; x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const h = G.hist; if (h.length < 2) return;
  if (G.gameMode === 'brawl') {
    x.strokeStyle = '#e0672a'; x.lineWidth = 1.6; x.lineJoin = 'round';
    x.beginPath();
    h.forEach((n, i) => { const px = (i + 0.5) / Math.max(h.length, 30) * W, py = H - 2 - (n / (BRAWL.rivals + 1)) * (H - 6); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke();
    return;
  }
  if (G.gameMode === 'fish') {
    // cumulative catch curve
    const top = Math.max(1, h[h.length - 1]);
    x.strokeStyle = '#e0672a'; x.lineWidth = 1.6; x.lineJoin = 'round';
    x.beginPath();
    h.forEach((n, i) => { const px = (i + 0.5) / RUN_T * W, py = H - 2 - (n / top) * (H - 6); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke();
    return;
  }
  // sea runs as faint bands behind the line
  x.fillStyle = 'rgba(47,58,74,0.07)';
  for (const s of SWEEPS) x.fillRect(W * s.t0 / RUN_T, 0, W * (s.t1 - s.t0) / RUN_T, H);
  x.strokeStyle = 'rgba(29,30,32,0.15)'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, H * 0.25); x.lineTo(W, H * 0.25); x.stroke();
  x.strokeStyle = '#2f3a4a'; x.lineWidth = 1.6; x.lineJoin = 'round';
  x.beginPath();
  h.forEach((q, i) => { const px = (i + 0.5) / RUN_T * W, py = H - 2 - q * (H - 6); i ? x.lineTo(px, py) : x.moveTo(px, py); });
  x.stroke();
}

// ------------------------------------------------------------------------------------------------ loop
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (!G.manual) {
    frame(dt);
    hud(dt);
    sound.update(G.player.speed, G.flock.nearCount || 0, G.player.y, G.mode === 'play');
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------------------------------------ online lobbies
const net = { lobby: new Lobby(), sendT: 0 };
function netTick(dt) {
  if (!G.online) return;
  net.sendT -= dt;
  if (net.sendT > 0) return;
  const P = G.player;
  if (G.online === 'host') { net.sendT = 1 / 15; net.lobby.broadcast(brawl.snapshot(P)); }
  else {
    net.sendT = 1 / 20;
    const r = (v) => +v.toFixed(3);
    net.lobby.send({ k: 's', x: r(P.x), y: r(P.y), z: r(P.z), vx: r(P.vx), vy: r(P.vy), vz: r(P.vz), fx: r(P.fx), fy: r(P.fy), fz: r(P.fz), r: r(P.roll), p: r(P.phase), g: r(P.glide), b: r(P.bound) });
  }
}
net.lobby.onMessage = (from, m) => {
  if (!m) return;
  if (net.lobby.role === 'host') {
    if (m.k === 's') brawl.setRemote(from, m);
    else if (m.k === 'heal') brawl.heal(from);
    else if (m.k === 'left' && brawl.on) brawl.leave(from);
  } else {
    if (m.k === 'start') {
      G.gameMode = 'brawl'; G.diffKey = m.diff;
      startRun({ seed: m.seed, mode: 'brawl', diff: m.diff, skipIntro: !(m.intro > 0),
        net: { role: 'client', myId: net.lobby.myId, myName: cleanName($('netName').value) || 'Guest', cx: m.cx, cz: m.cz, spawn: m.spawns[net.lobby.myId] } });
    } else if (m.k === 'w' && G.online === 'client') {
      brawl.applySnapshot(m, brawlHooks, performance.now() / 1000);
      // follow the host's clock (the flock, the ring and the countdown are all timed from it)
      const lag = m.t - G.t;
      if (Math.abs(lag) > 0.5) G.t = m.t; else G.t += lag * 0.1;
    }
  }
};
net.lobby.onPlayers = (list) => {
  const ol = $('netPlayers'); ol.innerHTML = '';
  for (const p of list) { const li = document.createElement('li'); li.textContent = p.name + (p.id === 'host' ? ' (host)' : '') + (p.id === net.lobby.myId ? ' (you)' : ''); ol.appendChild(li); }
  $('netStart').classList.toggle('hidden', net.lobby.role !== 'host');
  $('netMsg').textContent = net.lobby.role === 'host'
    ? `${list.length} in the lobby. Share the code; start when everyone is in (empty seats get rival birds).`
    : 'Waiting for the host to start the match.';
};
net.lobby.onClose = (reason) => {
  document.body.dataset.online = '0';
  $('netLobby').classList.add('hidden');
  $('netMsg').textContent = reason ? `Lobby closed: ${reason}.` : 'Left the lobby.';
  if (G.online && (G.mode === 'play' || G.mode === 'intro')) { toast(reason || 'Disconnected', 'warn', 2.5); G.endAt = G.t + 0.5; }
  G.online = null;
};
net.lobby.onError = (msg) => { $('netMsg').textContent = 'Connection problem: ' + msg; };
function netName() {
  const n = cleanName($('netName').value) || store.get('name', '');
  if (!n) { $('netMsg').textContent = 'Type your name first.'; $('netName').focus(); return null; }
  $('netName').value = n; store.set('name', n);
  return n;
}
function netOpen(code) {
  document.body.dataset.online = '1';
  $('netLobby').classList.remove('hidden');
  $('netCodeShow').textContent = code;
}
$('netName').value = store.get('name', '');
$('netCreate').addEventListener('click', async () => {
  const name = netName(); if (!name) return;
  $('netMsg').textContent = 'Opening a lobby…';
  try { const code = await net.lobby.host(name); netOpen(code); net.lobby.onPlayers(net.lobby.players); }
  catch (e) { $('netMsg').textContent = 'Could not open a lobby: ' + e.message + '. Check your connection.'; }
});
$('netJoin').addEventListener('click', async () => {
  const name = netName(); if (!name) return;
  $('netMsg').textContent = 'Joining…';
  try { const code = await net.lobby.join($('netCode').value, name); netOpen(code); }
  catch (e) { net.lobby.close(); $('netMsg').textContent = 'Could not join: ' + e.message + '. Some networks block direct connections; try another network.'; }
});
$('netCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('netJoin').click(); });
$('netLeave').addEventListener('click', () => net.lobby.close());
$('netCopy').addEventListener('click', () => {
  const c = net.lobby.code;
  navigator.clipboard?.writeText(c).then(() => { $('netMsg').textContent = `Copied ${c}.`; }, () => { $('netMsg').textContent = `Code: ${c}`; });
});
$('netStart').addEventListener('click', () => {
  if (net.lobby.role !== 'host') return;
  G.gameMode = 'brawl'; syncModeButtons();
  const humans = net.lobby.players.filter((p) => p.id !== 'host');
  // online matches skip the countdown: every bird starts at its own seat in the arena
  startRun({ mode: 'brawl', skipIntro: true, net: { role: 'host', myId: 'host', myName: net.lobby.players[0].name, humans } });
});

// ------------------------------------------------------------------------------------------------ UI wiring
function pauseToggle(force) {
  if (G.mode === 'play' && force !== false) { setMode('paused'); }
  else if (G.mode === 'paused' && force !== true) { setMode('play'); last = performance.now(); }
}
document.querySelectorAll('[data-diff]').forEach((b) => {
  b.setAttribute('aria-pressed', String(b.dataset.diff === G.diffKey));
  b.addEventListener('click', () => {
    G.diffKey = b.dataset.diff; store.set('diff', G.diffKey);
    document.querySelectorAll('[data-diff]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.diff === G.diffKey)));
    $('bestLine').textContent = bestText();
  });
});
function bestText() {
  const b = store.get((G.gameMode === 'fish' ? 'best.fish.' : G.gameMode === 'brawl' ? 'best.brawl.' : 'best.') + G.diffKey, 0);
  return b ? `Best on ${DIFF[G.diffKey].label}: ${b.toLocaleString()}` : '';
}
function syncModeButtons() {
  document.querySelectorAll('[data-game]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.game === G.gameMode)));
  $('online').classList.toggle('hidden', G.gameMode !== 'brawl');
  if (G.gameMode !== 'brawl' && net.lobby.role) net.lobby.close();
  $('modeLine').textContent = G.gameMode === 'fish'
    ? 'Fish Frenzy: the flock skims the sea for 90 seconds and flying fish leap all around. Catch as many as you can; quick catches chain.'
    : G.gameMode === 'brawl'
      ? 'Sky Brawl: you and eleven rival starlings, three feathers each. Ram them out of the sky, catch fish to grow feathers back, stay inside the closing ring. Last bird flying wins.'
      : 'Murmuration: two minutes inside the flock. Hold your place, keep in line, knock stray neighbours out for points, and dive for fish on the sea runs.';
  $('bestLine').textContent = bestText();
}
document.querySelectorAll('[data-game]').forEach((b) => b.addEventListener('click', () => { G.gameMode = b.dataset.game; store.set('mode', G.gameMode); syncModeButtons(); }));
syncModeButtons();
$('birdCount').textContent = N_BIRDS.toLocaleString();
$('fly').addEventListener('click', () => startRun());
$('again').addEventListener('click', () => {
  if (net.lobby.role) { G.online = null; brawl.stop(); newWorld(false, (Math.random() * 1e9) | 0); G.t = 0; camState.init = false; setMode('title'); return; }
  startRun();
});
$('menu').addEventListener('click', () => { newWorld(false, (Math.random() * 1e9) | 0); G.t = 0; camState.init = false; G.nextWave = 0; G.nextFish = 0; setMode('title'); });
$('resume').addEventListener('click', () => pauseToggle(false));
$('quit').addEventListener('click', () => { newWorld(false, (Math.random() * 1e9) | 0); G.t = 0; camState.init = false; G.nextWave = 0; G.nextFish = 0; setMode('title'); });
const optInv = $('optInvert'), optMouse = $('optMouse'), optSens = $('optSens');
optSens.value = Math.round(input.sens * 100); $('optSensV').textContent = optSens.value + '%';
optSens.addEventListener('input', () => { input.sens = +optSens.value / 100; $('optSensV').textContent = optSens.value + '%'; store.set('sens', input.sens); });
optInv.checked = input.invertY; optMouse.checked = input.mouseSteer;
optInv.addEventListener('change', () => { input.invertY = optInv.checked; store.set('invertY', optInv.checked); });
optMouse.addEventListener('change', () => { input.mouseSteer = optMouse.checked; store.set('mouseSteer', optMouse.checked); });
function syncMute() { document.querySelectorAll('.mute').forEach((b) => { b.setAttribute('aria-pressed', String(sound.muted)); b.textContent = sound.muted ? 'Sound off' : 'Sound on'; }); }
document.querySelectorAll('.mute').forEach((b) => b.addEventListener('click', () => { sound.start(); sound.setMuted(!sound.muted); syncMute(); }));
syncMute();
const boostBtn = $('boostBtn');
boostBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.touchBoost = true; });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) boostBtn.addEventListener(ev, () => { input.touchBoost = false; });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || e.code === 'KeyP') pauseToggle();
  else if (e.code === 'KeyM') { sound.start(); sound.setMuted(!sound.muted); syncMute(); }
  else if (e.code === 'Enter' && (G.mode === 'title' || G.mode === 'end')) startRun();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseToggle(true); });
$('pause').addEventListener('click', (e) => { if (e.target === $('pause')) pauseToggle(false); });

// ------------------------------------------------------------------------------------------------ test / debug API
window.game = {
  G, DIFF, get SLOT() { return SLOT; }, get SWEEPS() { return SWEEPS; }, get RUN_T() { return RUN_T; }, fishes, input, camera, scene, renderer, get lods() { return lods; }, get hero() { return hero; }, get ghost() { return ghost; },
  brawl, net, stickCurve, get heroGLB() { return heroGLB; },
  start: (o) => startRun(o),
  bot: (m) => { G.bot = m || null; if (!m) input.override = null; },
  // advance the simulation in fixed steps without waiting for frames (headless tests)
  advance(sec, dt = 1 / 60) {
    G.manual = true;
    const n = Math.round(sec / dt);
    for (let i = 0; i < n && G.mode !== 'end'; i++) frame(dt);
    hud(dt);
    renderer.render(scene, camera);
    G.manual = false;
    return this.stats();
  },
  render() { renderer.render(scene, camera); },
  stats() {
    const F = G.flock;
    let falling = 0; for (let i = 0; i < F.N; i++) if (F.state[i] === 1) falling++;
    return {
      mode: G.mode, t: +G.t.toFixed(2), diff: G.diffKey, pathPct: G.qTime > 0 ? +(100 * G.qSum / G.qTime).toFixed(2) : null,
      q: +G.q.toFixed(3), dist: G.dist && +G.dist.toFixed(2), collisions: G.collisions, dunks: G.dunks, fish: G.fish, fishSpawned: fishes.spawned,
      fishMissed: fishes.missed, rings: { passed: gates.passed, missed: gates.missed, streak: gates.streak }, score: Math.round(G.score), birds: F.N, falling, lost: F.lost, fps: Math.round(fpsE), result: G.result || null,
      draw: { near: lods.near.n, mid: lods.mid.n, far: lods.far.n }, calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
    };
  },
  end: () => endRun(),
};

boot().catch((e) => { console.error(e); $('loadmsg').textContent = 'Could not load the birds: ' + e.message; });
