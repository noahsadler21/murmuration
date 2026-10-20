# MURMURATION: build contract (SPEC v1)

This is a three.js r170 page of a starling murmuration over a real roost, under real weather. Four builders work in
parallel on disjoint files, then an integrator joins them. Anything this spec pins (names, formats, paths, units,
uniforms, events) is a contract. Change it only by editing this file and telling the other builders. Anything it
leaves open is the owning builder's choice.

`ROOT` = `C:/Users/noahs/OneDrive - Syracuse University/LA Studio/NOAHS EXPERIMENT/murmuration`. Paths below are
relative to ROOT. Read `LOOKTEST.md` first.

---

## 0. Ground rules

| rule | detail |
|---|---|
| Ownership | **Flock**: `src/flock.js`, `src/flock_shaders.js`, `tests/flock/*`. **Sky**: `src/sky.js`, `src/sky_shaders.js`, `src/weather.js`, `assets/weather/*`, `tests/sky/*`. **Blender**: `blender/*`, `models/out/*`, `models/preview/*` (new files only), `assets/birds/*`, `tests/blender/*`. **Trails**: `src/trails.js`, `src/ui.js`, `template.html`, `tests/trails/*`. **Integrator** (after the four): `src/main.js`, `src/state.js` (copied verbatim from §2), `build.js`, `tools/*`, `README.md`, `tests/integration/*`. Nobody edits another builder's files. |
| Siblings | `../monkey-school` and `LA Studio/fish-school-real` are **read-only**. COPY code you want from them (GPUComputationRenderer use, `boneTexture`, `gpuBench`, `frameP95`, async readback, `tools/serve.js`, the CDP harness `monkey-school/models/test/perf_quick.js`) into your own files. |
| Downloads | None. You may not run npm install, fetch textures or fetch models. The only network use is what the page does at runtime: three.js `0.170.0` from `cdn.jsdelivr.net` through the import map (the same as the sibling pages) and the Open-Meteo calls in §5.1. No API keys. |
| Blender | `"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P script.py -- args` |
| Tests | Each builder tests in `tests/<builder>/`, with its own copy of `serve.js` there (root = ROOT) and a stub `STATE` from §2. Write captures through `POST /capture?name=<builder>_<what>.png`, which saves them to `captures/`. Write measured numbers to `tests/<builder>/results.json`. Use headless Chrome over CDP with `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` on the Intel Arc iGPU. A test window is 1280×720 CSS px at deviceScaleFactor 1.25. |
| Modules | Each `src/*.js` is an ES module. It imports only `three`, `three/addons/...` and the sibling `./x.js` files named here. `build.js` copies `src/*.js` to `assets/js/` and writes `index.html` from `template.html`. |
| Units/frame | World units are metres and seconds. The origin is the roost at ground level. **+X = east, +Y = up, +Z = south** (north = -Z). Azimuths are degrees clockwise from north. A wind direction is the direction the wind blows FROM (meteorological). A wind vector is the direction it blows TO: `windVector(s, d) = (-s·sin d, 0, +s·cos d)`. A sun direction is `(sin A·cos h, sin h, -cos A·cos h)`. |
| Bird model frame | glTF frame: **+Z = head, +Y = back, +X = the bird's left wing**. The origin is the body centre at the wing root. Units are metres. This is Blender's starling frame (head -Y, back +Z) after glTF export. Starling: span 0.39 m, length 0.205 m. |
| Colour | Scene render targets hold linear HDR. `frameRT` and later targets hold **display-referred, sRGB-encoded** values (0..1). Use `renderer.toneMapping = NoToneMapping`. Every tone curve is in the grade shader. A custom full-screen pass must not include `colorspace_fragment`. |
| Required GL | WebGL2 + `EXT_color_buffer_float`. Without them, show "This page needs WebGL2 with float render targets." `EXT_disjoint_timer_query_webgl2` is optional (profiling only). |

---

## 1. Frame pipeline (integrator wires it; every builder must fit it)

```
per rAF frame:
 1  plan = trails.plan(state)                         // {steps, dt, stamp}; live: steps=1..2 of 1/60 s
 2  state.time advance (dt*steps*scale); weather.applyToState(state, sampleWeather(wx, state.time.nowMs)) at 1 Hz
 3  sky.update(dtReal, camera)        prof 'sky.lut', 'sky.prepass'   // LUTs, clouds, skyRT, writes state.light/sun/clouds
 4  repeat plan.steps: flock.update(plan.dt, camera)   prof 'flock.sim'  // sim + falcon
    flock.updateLOD(camera)                            prof 'flock.lodkey' // GPU LOD key + async readback, CPU buckets
 5  renderer.setRenderTarget(sceneRT); clear; renderer.render(scene, camera)   prof 'scene'
        scene = sky.object3d (bg quad renderOrder -1000, ground) + flock.object3d (4 bird LODs + falcon)
 6  grade.render(sceneRT.texture, frameRT)             prof 'grade'
 7  if plan.stamp: trails.stamp(frameRT.texture)        prof 'trails'
 8  grade.present(trails.active ? trails.output : frameRT.texture)   prof 'present'   // dither, grain, vignette → canvas
```

| target | format | size | owner |
|---|---|---|---|
| `sceneRT` | RGBA16F + depth24, `samples` = quality MSAA | render size | integrator |
| `frameRT` | RGBA16F, display-referred sRGB-encoded | render size | integrator |
| `accRT` | RGBA16F | render size | trails |

Render size = `floor(cssW·min(DPR, dprCap)·scale)` × the same for height (§3).

Profiler interface (integrator implements; builders call it, and it may be a no-op):
`prof.begin(name)` / `prof.end()`. Calls are sequential and never nested. Names are exactly those above, plus
`flock.pick` and `trails.export`.

---

## 2. Shared STATE (`src/state.js`, verbatim)

```js
import * as THREE from 'three';
const V3 = THREE.Vector3;
export const QUALITY = {   // §3; fx flags may be overridden by ?fx=name:0|1,...
  low:    { birds: [128, 80],  dprCap: 1.0,  scale: 0.85, msaa: 0, nbrEvery: 2, opacityEvery: 4, hash: 256, dens: [32, 32, 16, 12],
            lodCap: [0, 600, Infinity, Infinity], lodPx: [160, 24, 5], skyScale: 0.5,
            fx: { 'sky.multiScatter': 0, 'sky.cloudRaymarch': 0, 'sky.cloudLightTaps': 1, 'sky.silverLining': 1, 'sky.cirrus': 1,
                  'flock.lod0': 0, 'flock.iridescence': 0, 'flock.wingTransmit': 0, 'flock.selfShadow': 0, 'flock.aerial': 1,
                  'flock.minPixel': 1, 'flock.normalMapLOD0': 0, 'falcon.real': 0, 'post.grain': 0, 'post.vignette': 1, 'post.dither': 1 } },
  medium: { birds: [256, 120], dprCap: 1.25, scale: 1.0,  msaa: 4, nbrEvery: 1, opacityEvery: 2, hash: 512, dens: [64, 64, 32, 6],
            lodCap: [24, 3000, Infinity, Infinity], lodPx: [160, 24, 5], skyScale: 0.5,
            fx: { 'sky.multiScatter': 0, 'sky.cloudRaymarch': 0, 'sky.cloudLightTaps': 2, 'sky.silverLining': 1, 'sky.cirrus': 1,
                  'flock.lod0': 1, 'flock.iridescence': 1, 'flock.wingTransmit': 1, 'flock.selfShadow': 0, 'flock.aerial': 1,
                  'flock.minPixel': 1, 'flock.normalMapLOD0': 0, 'falcon.real': 1, 'post.grain': 1, 'post.vignette': 1, 'post.dither': 1 } },
  high:   { birds: [320, 256], dprCap: 2.0,  scale: 1.0,  msaa: 4, nbrEvery: 1, opacityEvery: 1, hash: 512, dens: [64, 64, 32, 6],
            lodCap: [64, 8000, Infinity, Infinity], lodPx: [160, 20, 5], skyScale: 0.75,
            fx: { 'sky.multiScatter': 1, 'sky.cloudRaymarch': 1, 'sky.cloudLightTaps': 2, 'sky.silverLining': 1, 'sky.cirrus': 1,
                  'flock.lod0': 1, 'flock.iridescence': 1, 'flock.wingTransmit': 1, 'flock.selfShadow': 1, 'flock.aerial': 1,
                  'flock.minPixel': 1, 'flock.normalMapLOD0': 1, 'falcon.real': 1, 'post.grain': 1, 'post.vignette': 1, 'post.dither': 1 } },
};
export const NOISE_PRESETS = {
  //          curl m/s², scale ×extent, octaves, wander m/s², gusts/min, waves/min, opacityTarget, pulse
  calm:     { curl: 0.6, scale: 1.0, octaves: 2, wander: 0.3, gustRate: 0,   waveRate: 0,   opacityTarget: 0.30, pulse: false },
  swirling: { curl: 2.2, scale: 0.5, octaves: 3, wander: 0.4, gustRate: 0.5, waveRate: 0.5, opacityTarget: 0.35, pulse: false },
  agitated: { curl: 1.6, scale: 0.3, octaves: 4, wander: 0.9, gustRate: 1,   waveRate: 4,   opacityTarget: 0.40, pulse: false },
  pulsing:  { curl: 1.2, scale: 0.6, octaves: 3, wander: 0.4, gustRate: 0,   waveRate: 1,   opacityTarget: 0.35, pulse: true },
};
export const FLOCK_DEFAULTS = {
  k: 7, v0: 12.5, vMin: 9, vMax: 20, speedNoise: 0.10,
  wAlign: 2.4, wCohesion: 0.9, rSep: 1.0, wSep: 9.0, wOpacity: 5.0, wLevel: 0.6,
  wRoost: 1.0, roostRadius: 320, altMin: 35, altMax: 220, altK: 0.08, windDrift: 1.0,
  maxBankDeg: 65, maxLatG: 1.6, agitatedLatG: 3.0, rollRate: 6.0,
  waveDelay: 0.07, excitedDur: 0.6, refractory: 2.0, pProp: 0.92, bankPulseDeg: 55, speedBoost: 2.5,
  fleeRadius: 18, detectRadius: 45, flashRadius: 10, flashImpulse: 8,
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
```

**Events** (`state.emit(name, payload)`). The UI emits them, the integrator handles them, and modules may also listen.

| event | payload | effect |
|---|---|---|
| `quality` | `'low'\|'medium'\|'high'` | the integrator rebuilds the targets and calls `flock.setCount`, `sky.setQuality` and `trails.setSize` |
| `look` | look id | `sky.setLook` |
| `mode` | `'live'\|'ornito'` | entering ornito freezes the camera; leaving it unfreezes the camera and the sky |
| `camera` | `'watcher'\|'orbit'\|'falcon'` | camera switch |
| `site` / `time` | site id / `{iso}` or `'now'` or `'sunset'` | refetch the weather and reset `time` |
| `noise` | partial `state.noise` | the values are already merged into the state |
| `preset` | preset name | merge `NOISE_PRESETS[name]` |
| `randomise` | none | new seed, plus a random blend of two presets |
| `falcon` | `bool` | enable or disable the falcon |
| `attack` | none | `flock.attack()` |
| `gust` | none | `flock.gust()` |
| `pulse` | `{origin, dir}` (V3) | `flock.excite`; the canvas click in live mode |
| `ornito:start` / `ornito:stop` / `ornito:new` | none | trails `begin` / `end` / clear |
| `ornito:frame` | `{done, frames}` | the indicator |
| `ornito:export` | none | `trails.exportPNG` |
| `select` | `{ids}` | `flock.setTracked` |
| `weather` | `WXSample` | readout |
| `resize` | `{w, h}` | targets |

---

## 3. Quality, effects and perf budget

Every visual effect has an id in `QUALITY[q].fx`, set per quality level. `?fx=id:0|1,...` overrides it, and
each effect's cost is measured on/off with `murm.gpuBench` (§8). The numeric effect is `sky.cloudLightTaps`
(0, 1 or 2). MSAA and render scale are measured the same way, through the `?msaa=` and `?scale=` URL parameters.

**Budget** (Arc iGPU, Chrome ANGLE D3D11, 1280×720 CSS at DPR 1.25; GPU ms via timer queries; 60 fps on MEDIUM is the hard requirement):

| pass | low | medium | high |
|---|---|---|---|
| `flock.sim` (nbr + vel + state + pos + hash + density + opacity) | 0.8 | 2.0 | 4.0 |
| `flock.lodkey` + readback | 0.1 | 0.2 | 0.3 |
| `sky.lut` (amortised) + `sky.prepass` | 0.6 | 1.3 | 2.5 |
| `scene` (bg composite, ground, birds, falcon) | 2.5 | 5.0 | 7.5 |
| `grade` + `present` | 0.3 | 0.6 | 0.8 |
| `trails` (ornito only) | 0.3 | 0.6 | 0.9 |
| **total, default view** | **≤ 5** | **≤ 10.5** | **≤ 16** |
| total, `orbit-close` / `inside` views | ≤ 6 | ≤ 12.5 | ≤ 20 (discrete GPU) |
| frame p95 (rAF, visible window) | ≤ 17.5 ms | ≤ 17.5 ms | report |
| CPU main thread per frame | ≤ 3 ms | ≤ 4 ms | ≤ 6 ms |

**Bird counts:** low 10,240, medium 30,720 and high 81,920 (the `birds` W×H above) are targets. The integrator
measures them. If a quality level misses its total, shrink H in steps of 8 rows, then record the final counts and
times in the README perf table (§9).

---

## 4. Flock builder: `src/flock.js`, `src/flock_shaders.js`

### 4.1 Exports

```js
export class Flock {
  static async loadAssets(base = 'assets/birds/')   // → ASSETS {starling:{real,retro,sil,micro}, falcon:{real,retro}}
  constructor({ renderer, state, assets, prof })
  object3d                    // THREE.Group: 4 bird LOD meshes + falcon; added to the scene by the integrator
  setCount(n)                 // realloc to QUALITY[q].birds (W,H); respawns
  reset(seed)                 // respawn: ellipsoid 120×40×80 m centred (0,110,0), common heading ± 20°, Morton-sorted index
  update(dt, camera)          // ONE fixed sim step of dt (≤ 1/30); falcon AI; reads state; writes state.flock.*, state.falcon.*
  updateLOD(camera)           // GPU LOD key pass, async readback, CPU buckets → instance index buffers
  setStampMode(m)             // 'all' | 'tracked' (render only tracked birds; falcon counts as id -2)
  setTracked(ids)             // array of bird ids (≤ 64), 'all', or [] ; R8 mask texture W×H
  pick(ndcX, ndcY, camera)    // → Promise<id> ; -2 = falcon, -1 = none (1×1 RGBA8 id pass, setViewOffset)
  excite(origin, dir)         // seed agitation for birds within 6 m of the ray (first 60 m of flock along it)
  gust()                      // spawn a gust now
  attack()                    // falcon starts an attack now (from any state but 'off')
  debug                       // { readAll(): Promise<{pos,vel,state,nbr}>, knnAccuracy(n=512), polarization(),
                              //   corrLength(), waveSpeed(), lodviz(bool), stateFractions() }
  dispose()
}
export function makeStandInStarling(lod)   // procedural flapping bird in the in-memory VAT form (§6.2): tests only
```

`ASSETS.starling.<lod>` is the decoded in-memory form of §6.2:
`{ meta, index: Uint16Array, uv: Float32Array, vatPos: Uint16Array (half), vatNrm: Uint8Array, albedo: Texture|null, mask: Texture|null, normal: Texture|null }`.
`ASSETS.falcon.<lod>` is a GLTF result `{ scene, animations }`. Until the Blender assets exist, use
`makeStandInStarling` and a stand-in falcon (a scaled starling).

### 4.2 Simulation textures

Bird `i` sits at texel `(i % W, floor(i / W))`. Every target ping-pongs.

| texture | format | content |
|---|---|---|
| `texPos` | RGBA32F W×H | xyz = position (m); w = flap phase [0,1), where 0 = top of stroke |
| `texVel` | RGBA32F W×H | xyz = ground velocity (m/s); w = roll (rad, smoothed, + = right wing down) |
| `texState` | RGBA32F W×H | x = glide weight, y = bound weight, z = bout timer (s; > 0 flapping bout, < 0 pause), w = `tEx`, the sim time of the last excitation (−1e4 = never; wraps at 4096 s) |
| `texNbrA`, `texNbrB` | RGBA32F W×H, MRT (`WebGLRenderTarget({count:2})`) | the 8 nearest neighbour ids (float ints), sorted near to far; slots 0–6 interact, slot 7 is a buffer |
| `texHash` | R32F hash×hash | spatial hash, cell 2.5 m: `id+1` of the last bird scattered (GL_POINTS, no blend); 0 = empty |
| `texDens` | RGBA16F tiled 3D atlas | `dens = [nx, ny, nz, cell m]` (quality); rgb = Σ velocity, a = count; additive point scatter; grid centred on `state.flock.centroid` snapped to the cell |
| `texOpacity` | RGBA16F, same atlas | xyz = Σ_d d·O(d) over 6 Fibonacci directions × 8 steps; w = mean O; recomputed every `opacityEvery` frames |
| `texLodKey` | RGBA8 (W/4)×H | 4 birds per texel: code = 0 if outside the frustum (1 m margin), else clamp(round(32·log2(spanPx+1)), 1, 255) |
| `texSub` | RGBA32F 256×2 | row 0 = pos, row 1 = vel of birds `j·floor(N/256)`; slot 255 = `state.falcon.targetId`; read back async every frame |

Pass order per step: hash scatter, then density scatter (and the opacity pass when due), then nbr (every
`nbrEvery` frames), then vel, then state, then pos. All reads are nearest-filtered `texelFetch`.

### 4.3 Rules (vel pass), with every weight in `state.flock.params`

1. **Topological neighbours** (Ballerini et al. 2008). The 8-slot list is refined each nbr pass by
   nearest-neighbour descent. The candidates are the current 8, plus 8 neighbours-of-neighbours (slot
   `(frame + k) % 8` of neighbour k), plus the hash occupants of 4 cells (the own cell and 3 of the 26 neighbouring
   cells, picked per bird per frame by hash). Drop self and duplicates, then keep the 8 nearest. Interaction uses
   slots 0–6 (k = 7).
2. **Alignment** `wAlign·(mean v_nbr − v)`. **Cohesion** `wCohesion·(mean p_nbr − p)`, capped at 4 m/s².
   **Separation** `wSep·Σ (p − p_j)/d²` for d < rSep.
3. **Marginal opacity** (Pearce et al. 2014): `wOpacity·(opacityTarget − Ō)·normalize(Σ d·O(d))`, sampled from
   `texOpacity` (manual trilinear). O = 1 − exp(−σ·∫ρ ds) with σ = 0.02 m² per bird. This makes the dark sheets and
   bands, and it keeps the projected opacity marginal.
4. **Scale-free fluctuations** (Cavagna et al. 2010). A curl-noise acceleration has strength `noise.curl` and
   octaves `noise.octaves` (lacunarity 2, gain 0.5, so amplitude falls as 1/f). Its base wavelength is
   `noise.scale · |state.flock.extent|`, so the correlation length scales with flock size. The field is advected by
   the wind and evolves at `noise.evolve`. A second scalar channel modulates the preferred speed by ±`speedNoise·v0`.
   `noise.seed` offsets the domain.
5. **Per-bird wander** `noise.wander`: smooth per-bird value noise in time (rate 0.7 Hz), seeded by hash(i, seed).
6. **Speed**: relax `|v_air|` toward the preferred speed with τ = 1 s, clamped to [vMin, vMax]. Excited birds get
   +speedBoost.
7. **Banking turns** (Hemelrijk & Hildenbrandt 2011). Lateral acceleration is clamped to `maxLatG·g`
   (`agitatedLatG` while excited). The target roll is `atan(a_lat/g)` + the escape pulse, limited to
   ±maxBankDeg and slewed at ≤ rollRate. **Level flight**: `−wLevel·v_y`.
8. **Roost and altitude**. Horizontally, beyond roostRadius, steer toward (0,·,0) with `wRoost·(d − R)/100` m/s².
   Vertically, outside [altMin, altMax], a soft spring of `altK·Δ²` capped at 6 m/s².
9. **Wind**: ground v = air v + `windDrift·wind(y)`, with |wind| capped at 12 m/s. `wind(y)`: below 10 m `v10`;
   10–80 m log-interpolate `v10→v80` (`w = ln(y/10)/ln 8`); 80–1500 m lerp `v80→v850`. Heading and the render
   orientation use the air velocity.
10. **Gusts**: up to 2 active, as uniforms `uGustA[2]` (centre xyz, radius 80 m) and `uGustB[2]` (velocity xyz,
    envelope 0..1). They spawn upwind of the flock at `noise.gustRate` per minute, or on `gust()`. A gust is
    4–10 m/s at the wind direction ±30°, travels at the wind speed and lives 6 s.
11. **Pulsing preset**: `opacityTarget` swings 0.25↔0.50 (period 9 s) and curl ×0.5↔1.5 (period 13 s).

### 4.4 Agitation waves (state pass; Procaccini et al. 2011, Hemelrijk et al. 2015, Carere et al. 2009)

Each bird is an excitable cell on the topological graph. A bird is excited for `age = t − tEx ∈ [0, excitedDur]`,
refractory until `excitedDur + refractory`, and at rest after that. A resting bird becomes excited, with
probability pProp, when any neighbour in slots 0–6 has `age ∈ [waveDelay, waveDelay + 0.12]`. Seeds come from:

- the falcon within detectRadius while it is in `stoop`, `strike` or `pullout`;
- `excite()`;
- spontaneous seeds at `noise.waveRate` per minute, at a random peripheral bird.

While excited, a bird rolls by `bankPulseDeg·sin(π·age/excitedDur)`. The roll is signed away from the stimulus
(uniform `uWaveOrigin`: the falcon's position, or the click point). The bird turns with that roll, flaps
continuously, and adds +speedBoost. The rolling change in projected wing area is what makes the travelling
**dark band** visible. Flee: within fleeRadius of the falcon, `25·(1 − d/R)²` m/s² away from it. **Flash
expansion**: a falcon pass within 6 m gives birds within flashRadius a radial impulse of flashImpulse.
**Compaction**: with a patrolling falcon within 80 m, wCohesion ×1.5 and opacityTarget +0.1.

### 4.5 Flight states (Tobalske 1995)

The phase advances at `f = flapHz + flapHzPerMs·(|v_air| − 12.5)`, ×1.15 while excited. The bout logic sits in
`texState.z`:

- A flapping bout lasts a random 3–9 beats. Then comes a pause of 0.12–0.45 s.
- A pause is a **bound** with probability `clamp(boundShare + (|v| − 12.5)/16, 0.05, 0.5)`, and otherwise a
  **glide**. A glide starts at phase ≈ 0.28 (extended wing); a bound starts at phase ≈ 0.91.
- The glide and bound weights slew over 0.08 s.
- There is no pause while climbing (`v_y > 2 m/s`), excited, or within 1 s after being excited.

At cruise, the mix must come out at about 70 / 20 / 10 % flap / glide / bound.

### 4.6 Rendering

**LODs** are bucketed on the CPU from the `texLodKey` readback, which may run 1–3 frames late. Walk the codes from
255 down, with 10 % hysteresis from a per-bird `Uint8Array` of the previous LOD:

| LOD | asset | rule | shading |
|---|---|---|---|
| 0 | `starling_real` | span > lodPx[0], up to lodCap[0], `flock.lod0` | albedo + mask (AO, gloss, iridescence); baked normal map if `flock.normalMapLOD0` (cotangent frame from derivatives); smooth VAT normals |
| 1 | `starling_retro` | span > lodPx[1], up to lodCap[1] | albedo + mask; flat normal `normalize(cross(dFdx(p), dFdy(p)))` |
| 2 | `starling_sil` | span > lodPx[2] | flat colour `meta.albedoLinear`; flat normal |
| 3 | `starling_micro` | all other birds in the frustum | flat colour; **min-pixel**: widen the span to ≥ 2.0 px and alpha = trueArea/drawnArea; premultiplied blend, depth test on, no depth write, drawn after LOD0–2 |

Each LOD is one indexed `InstancedBufferGeometry`. It has `aVid` (vertex id), `uv`, `index`, and the instanced
`aBird` (Float32 bird ids; `instanceCount` = the bucket size). The shaders are `ShaderMaterial`, not Raw, and
side is DoubleSide for wings. The vertex shader works like this:

- It fetches pos, vel and state.
- VAT row = phase·32; it lerps two cycle rows, then mixes toward row 32 (glide) and row 33 (bound).
- It orients the bird: forward = normalize(v_air) with +5° nose-up in a glide, roll about forward from `vel.w`, and
  per-bird scale 1 ± 0.04.
- It discards untracked birds in `tracked` mode.

**Lighting** uses only the shared chunk in §5.4: `col = albedo·(skyAmbient(n)·ao + uSunColor·max(dot(n,uSunDir),0))`,
then `skyAerial(col, wpos)` if `flock.aerial` is on. **Iridescence** (`flock.iridescence`, LOD0/1 only) is a
thin-film sheen: mask.B·Fresnel·a purple↔green cosine palette at strength 0.15·skyAmbient. **Wing transmission**
(`flock.wingTransmit`) adds `0.35·albedo·uSkyUp·vatPos.w·max(0, −n·v)`. **Self-shadow** (`flock.selfShadow`)
multiplies the ambient by exp(−τ_up) from 4 upward samples of `texDens`.

No motion blur: the crisp silhouette is the signature. **Debug**: `?lodviz=1` tints the LODs red, green, blue and
yellow.

### 4.7 Peregrine (CPU agent in flock.js)

The falcon is drawn as a `SkinnedMesh`. It uses `peregrine_real` when its span is over 100 px and `falcon.real` is
on, and `peregrine_retro` otherwise. An `AnimationMixer` plays the clips in §6.4: `flap` with timeScale = beat Hz,
crossfaded with the pose clips over 0.25 s (0.4 s into `stoop`). Its material must use the §5.4 light chunk and
`skyAerial` (patch it with `onBeforeCompile`). The falcon is exposed to the sim as `uPred` (xyz, w = 1 when active)
and `uPredVel`. Its states:

| state | behaviour | pose |
|---|---|---|
| `patrol` | It circles a point 150 m upwind of the centroid, 90–140 m above it, at radius 180 m and 13 m/s air speed. It flies in 4.5 Hz bouts of 6–12 beats, alternating with 2–5 s glides. The next attack comes after a random `attackEverySec` (if autoAttack is on) or on `attack()`. | flap / glide |
| `select` | It picks a target from `texSub`: the peripheral bird nearest the falcon side of the flock, in the lowest local density. That becomes `targetId`, written into slot 255. | glide |
| `stoop` | Proportional navigation (N = 3) toward the predicted intercept. Speed rises at 8 m/s² + g·sin(dive) up to 45 m/s. Lateral acceleration is limited to 3 g. | `stoop`, then within 25 m a 0.6 stoop + 0.4 glide blend (cupped, steering) |
| `strike` | Closest approach (≤ 3 m counts as a near miss). There are no kills in v1, since real success on murmurations is low. | stoop → flare |
| `pullout` | It pitches up at 2.5 g for 0.5 s while speed decays to 20 m/s. | `flare` |
| `climb` | It flaps at 4.8 Hz and 12 m/s, climbing at 15° until it reaches patrol altitude, then returns to `patrol`. | flap |
| `off` | Hidden; `uPred.w` = 0. | |

`?bench=1` disables autoAttack and fixes the seed.

---

## 5. Sky builder: `src/sky.js`, `src/sky_shaders.js`, `src/weather.js`

### 5.1 weather.js

```js
export const SITES = [   // id, name, lat, lon, tz, groundType ('sea'|'reedbed'|'field'|'city'), roost note
  { id: 'brighton', name: 'Brighton West Pier, UK',          lat: 50.8214, lon: -0.1517, tz: 'Europe/London', ground: 'sea' },   // DEFAULT
  { id: 'otmoor',   name: 'RSPB Otmoor, Oxfordshire, UK',    lat: 51.8120, lon: -1.1720, tz: 'Europe/London', ground: 'reedbed' },
  { id: 'hamwall',  name: 'RSPB Ham Wall, Somerset, UK',     lat: 51.1510, lon: -2.7880, tz: 'Europe/London', ground: 'reedbed' },
  { id: 'gretna',   name: 'Gretna Green, Scotland, UK',      lat: 54.9970, lon: -3.0650, tz: 'Europe/London', ground: 'field' },
  { id: 'aber',     name: 'Aberystwyth Pier, Wales, UK',     lat: 52.4153, lon: -4.0874, tz: 'Europe/London', ground: 'sea' },
  { id: 'rome',     name: 'Rome (Termini), Italy',           lat: 41.9010, lon: 12.5010, tz: 'Europe/Rome',   ground: 'city' },
  { id: 'tonder',   name: 'Sort Sol, Tønder Marsh, Denmark', lat: 54.9400, lon: 8.8000,  tz: 'Europe/Copenhagen', ground: 'reedbed' },
];
export const OPEN_METEO_CREDIT = 'Weather data by Open-Meteo.com (CC-BY 4.0)';
export async function fetchWeather(site, localDate /* 'YYYY-MM-DD' in site tz */)  // → WX (fallback chain below)
export function sampleWeather(wx, tMs)              // → WXSample (hourly linear; wind interpolated as vectors)
export function applyToState(state, sample)         // fills state.weather.sample, state.wind.*, state.clouds.*
export function sunPosition(tMs, lat, lon)          // → { azimuthDeg, altitudeDeg, dir: THREE.Vector3 (world) }
export function sunTimes(localDate, lat, lon)       // → { sunriseMs, sunsetMs, civilDuskMs, solarNoonMs } (UTC ms; h0 = −0.833°)
export function windVector(speed, dirFromDeg, out)  // §0 convention
```

**Request A** (forecast) covers dates in [today − 92 d, today + 15 d]. Use exactly this URL on one line, with D
the requested local date:

```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,visibility,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_80m,wind_direction_80m,wind_speed_850hPa,wind_direction_850hPa,wind_speed_500hPa,wind_direction_500hPa,wind_speed_300hPa,wind_direction_300hPa&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=sunrise,sunset&start_date={D-1}&end_date={D+1}&wind_speed_unit=ms&timeformat=unixtime&timezone=auto
```

**Fallback chain.** On an HTTP error, a JSON `{error:true}` or an 8 s timeout (AbortController), retry once and
then move to the next step:

1. **B**: `https://historical-forecast-api.open-meteo.com/v1/forecast?` with the same `hourly`, `daily` and units, and no `current` (dates ≥ 2022-01-01).
2. **C**: `https://archive-api.open-meteo.com/v1/archive?` with `hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_100m,wind_direction_100m` and the same `daily`, units and dates.
3. **localStorage** `murm:wx:v1:{siteId}:{D}` (every success is written there).
4. **The bundled sample**: `assets/weather/sample_overcast.json` (the default), or `sample_clear.json` via `?wx=sample:clear`.

`WX.source` is one of `'forecast'`, `'historical-forecast'`, `'archive'`, `'cache'` or `'sample'`.

**Missing fields** (null, or absent in C) are derived:

| field | rule |
|---|---|
| v80 | v100·0.97 |
| v850 | v80·1.5, veered +15° |
| v500 | ·2.4, +30° |
| v300 | ·3.2, +40° |
| visibility | 20000 m, or 5000 m if RH > 95 % |

Refetch in "now" mode every 30 min. **Samples** are Sky-authored files in the Open-Meteo response format, with
`"synthetic": true` and 72 h of data. *Overcast*: low 95 %, mid 60 %, high 30 %; 10 m wind 6 m/s from 225°, 80 m
9 m/s, 850 hPa 14 m/s from 235°, 500 hPa 22 m/s from 250°, 300 hPa 35 m/s from 260°; visibility 18 km; 10 °C;
RH 85 %. *Clear*: low 5 %, mid 0 %, high 40 % cirrus; light westerly; visibility 30 km.

`WXSample = { tMs, source, cloudCover, cloudLow, cloudMid, cloudHigh /*0..1*/, wind10, wind80, wind850, wind500,
wind300 /*{speed m/s, dirDeg}*/, gust10, temperatureC, dewPointC, humidity /*0..1*/, visibilityM, pressureHPa }`.
In "now" mode, the `current` block overrides the surface fields.

**Sun**: the SunCalc/NOAA algorithm, re-implemented. It must be within 0.1° of NOAA. Convert SunCalc's
south-based azimuth to the §0 convention. **Default time** is today's sunset at the site (`t=sunset`); the UI
offers site, date, time, "now", "sunset" and clock speed ×1/×10/×60.

### 5.2 Atmosphere (Hillaire 2020 LUTs)

| LUT | size and format |
|---|---|
| transmittance | 256×64 RGBA16F |
| multi-scatter | 32×32 (only with `sky.multiScatter`; otherwise a constant isotropic term) |
| sky-view | 192×108 RGBA16F |

Recompute when the sun moves more than 0.1° or the haze changes. The constants are Earth R 6360 km, top 6460 km,
Rayleigh (5.802, 13.558, 33.1)e-6 /m with H 8 km, Mie scattering 3.996e-6 and absorption 4.4e-6 with H 1.2 km and
g 0.8, and ozone (0.650, 1.881, 0.085)e-6 in a 25 ± 15 km tent. The Mie density is scaled by
`clamp(20000/visibilityM, 0.5, 8)`.

### 5.3 Clouds (in `sky.prepass`, at skyScale resolution)

The prepass renders into `skyRT` (RGBA16F, linear filter). The bg quad samples it, then dithers and upsamples. It
draws three decks on spherical shells, compositing far to near: high, then mid, then low.

| deck | altitude | type | noise | wind |
|---|---|---|---|---|
| low | base = clamp(125·(T − Td), 300, 2000) m (Espy LCL); thickness 500 m | stratocumulus: Worley-clumped FBM, 1.5 km cells | `noise2D`; with `sky.cloudRaymarch`, 12 view steps + 3 light steps through `noise3D` | v850 |
| mid | 4000 m, thickness 500 m | altocumulus: 300 m cells | `noise2D` | v500 |
| high | 9000 m | cirrus (`sky.cirrus`): domain-warped streaks 8 km × 0.6 km, along v300 | `noise2D` | v300 |

**Coverage is exact.** At init, build a 256-entry inverse-CDF LUT of each deck's noise, so the covered fraction
equals that deck's cloud fraction.

**Lighting**:

- dual-lobe Henyey-Greenstein (g 0.6 / −0.3) with Beer-powder;
- `sky.cloudLightTaps` offset samples toward the sun for self-shadow;
- **silver lining** (`sky.silverLining`): forward-scatter brightening at thin edges;
- ambient from the sky-view zenith;
- fade to the horizon radiance as exp(−dist/30 km).

Each deck's offset is `v_layer·t`, plus slow evolution. `noise2D` is 512² RGBA8, tileable and mipmapped, generated
on the GPU at init. `noise3D` is a 64³ RGBA8 `WebGL3DRenderTarget`, high quality only.

The sun under cloud is attenuated by `exp(−Σ τ_deck)` along `uSunDir`. That attenuation feeds `uSunColor`.

### 5.4 Exports and the shared light chunk

```js
export class Sky {
  constructor({ renderer, state, prof })   // creates state.light.u (below)
  object3d                                 // Group: bg quad (renderOrder -1000, depthWrite false) + ground plane
  update(dtReal, camera)                   // sun from state.time/site, LUTs, clouds, prepass (skipped while frozen), light uniforms
  setLook(look); setQuality(q); setFrozen(bool); setSize(w, h)
  get skyTexture
  debug                                    // { view('coverage'|'lut'|'deck:low'...), meanSky(), Lref }
  dispose()
}
export class Grade {
  constructor({ renderer, state })
  render(srcHDRTex, dstRT)   // look grade → display-referred sRGB-encoded (§5.5)
  present(srcTex)            // to canvas: post.dither (blue-noise ±0.5/255), post.grain, post.vignette; no colorspace include
  presentTo(srcTex, rt8)     // same into an RGBA8 target (PNG export)
  setSize(w, h)
}
export function createGround(state)   // used by Sky; site ground type; dark, desaturated, aerial-fogged; 'sea' = sky fresnel
```

**`state.light.u`** is shared by reference (`uniforms: { ...state.light.u, ...own }`). Sky owns the values. Units
are scene radiance: `uSkyUp`/`uSkyDown` are the cosine-weighted hemisphere irradiance / π; `uSunColor` is the
sun irradiance / π after the atmosphere and clouds. `sky_shaders.js` exports `SKY_GLSL.light`, which is exactly
the code below. Sky may improve its internals but must keep the names and signatures. Flock pastes the same text
into its stand-in.

```glsl
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyUp; uniform vec3 uSkyDown;
uniform vec3 uHorizonColor; uniform vec3 uZenithColor; uniform float uExtinction; uniform float uAerialMax; uniform int uLook;
vec3 skyAmbient(vec3 n) { return mix(uSkyDown, uSkyUp, n.y * 0.5 + 0.5); }
vec3 skyAerial(vec3 col, vec3 wpos) {
  vec3 d = wpos - cameraPosition; float dist = length(d);
  vec3 sky = mix(uHorizonColor, uZenithColor, clamp(d.y / max(dist, 1e-3), 0.0, 1.0));
  return mix(col, sky, min(uAerialMax, 1.0 - exp(-uExtinction * dist)));
}
```

`uExtinction = 3.912 / visibilityM` (Koschmieder) and `uAerialMax = 0.85`.

### 5.5 Looks. SIGNATURE is the default and the page's identity

The reference is the **top two panels** of `models/preview/starling_v2_silhouette_flock.png`; the top panel's sky
crop is (8, 80)–(1288, 764) px. Measured: the sky runs from sRGB (197,197,198) at the top to (190,191,192) at the
bottom. It is nearly uniform, very slightly blue (B ≥ R by 1–2), soft and shadowless. The bird cores are around
(46,42,40), in the range 20–60, with lit wings up to about 110. The sky stays physical (§5.2–5.3, the real sun and
clouds) and the grade does the rest:

| look | grade |
|---|---|
| `signature` | `x = luminance/Lref`, where Lref is the mean upper-hemisphere sky radiance including clouds. Use a smooth monotone C1 curve `f` with f(1) = 0.765 ± 0.005 (encoded), f′(1) ≈ 0.10 (so cloud variation reads as a few codes, not drama), f(0.06) ≈ 0.18 and f(0.02) ≈ 0.08. Output `f(x)·tint`, where tint = (0.990, 0.995, 1.000) normalised to luminance 1, and keep 8 % of the physical chroma. The sun shows only as a faint glow (≤ +3 codes) at its azimuth. There is no sun disc. The ground is about (70,72,74), fogged to the horizon. |
| `physical` | Exposure 0.6/Lref·2^ev. AgX (re-implemented). Sun disc when it is unoccluded. |
| `dusk` | Physical, then remapped by view elevation toward the bottom panel's palette: top (104,116,141), bottom (144,126,124). Modulate by the physical luminance ratio; split-tone cool shadows and warm highlights; saturation 1.1. |
| `negative` (internal; used only by the ornito lighten blend) | 1 − signature, which gives a charcoal sky with pale birds. |

---

## 6. Blender builder: `blender/*`, `models/out/*`, `assets/birds/*`

### 6.1 Starling tail fix (v3 of `s3_build.py` / `s5_rig.py`; keep the v2 copies in `blender/v2/`)

The v2 tail runs 5.8 cm root to tip (about 4.7 cm showing) and tapers in side view. Make it end **just behind the
folded wingtips**:

- **Tip position.** Tip Y = `Y_foldTip + 0.006 ± 0.003` m. `Y_foldTip` is the rear-most Y of the scan's crossed
  primaries in `s1_scan_oriented`, measured from the s2b capture mask. If that cannot be isolated, use
  `TAIL_TIP − 0.016`. Expect a tip at y ∈ [0.076, 0.084], a root-to-tip length of 4.2–4.6 cm, and 3.0–3.5 cm
  visible behind the rump.
- **Glide check.** In the glide pose, the tail must not extend more than 4.0 cm behind the wingtips.
- **Square, with real thickness.** Thickness goes from 10.4 mm at the root to 6.5 mm at 60 % to ≥ 6.0 mm at the
  tip. The undertail-covert surface runs parallel to the top over the last 60 %. The end wall is vertical within
  10°, with a 1 mm bevel.
- **Planform.** Width fans from 1.7 to 3.8 cm, with the 2.2 mm central notch kept.
- **Texture.** Re-map the per-rectrix texture to the new length; that removes most of the v2 2× stretch.

Re-run s3 → s4 → s5 (`run_all.sh`) and keep the triangle counts within §6.3.

### 6.2 Starling VAT export: `blender/s8_vat.py`, which writes `assets/birds/`

| file | content |
|---|---|
| `starling_{real,retro,sil,micro}.json` + `.bin` | format `murm-vat-1` (below) |
| `starling_real_albedo.png`, `starling_real_mask.png`, `starling_real_normal.png` | 2048², from v3 (normal = baked) |
| `starling_retro_albedo.png`, `starling_retro_mask.png` | 1024² |
| `CREDITS.json` | `{ "starling": "European starling scan: Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0", "peregrine": "Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0", "peregrineUrl": "https://sketchfab.com/3d-models/peregrine-falcon-falco-peregrinus-49cb0ef2fa2847b0aca92ab6deecf919" }` |

The **new LODs** are built in s3/s5 and skinned by a data-transfer of the retro weights:

- `sil`: 40–64 triangles. A 4-sided, 5-station body loft, a head cone, a 2-triangle tail, and 4 quads per wing.
- `micro`: ≤ 12 triangles. A rhombus body (4), a tail (2), and 3 per wing (an arm triangle and 2 hand triangles).

All four LODs share one rig and the poses `cycle_pose()`, `glide` and `bound`.

**Rows:** rows 0–31 are `cycle_pose(k/32)` (phase 0 = top, downstroke 0 → 0.57); row 32 is `glide`; row 33 is
`bound`. Positions are the evaluated deformed mesh in the glTF frame (§0) — (x, z, −y) from Blender.

**.bin** is little-endian. Each block starts on a 4-byte boundary, at the offsets given in the JSON:
`index u16[tris·3]`, `uv f32[verts·2]` (V flipped for three.js: v' = 1 − v),
`vatPos f16[34·verts·4]` (row-major: row r, vertex v; xyz = position, w = 1 for a wing vertex and 0 for a body
vertex), and `vatNrm u8[34·verts·4]` (xyz = n·127.5 + 127.5, w = 255·span fraction). The constraint is
verts ≤ 4096 (VAT width = verts, height = 34). Vertices are split only at UV seams.

```json
{ "format": "murm-vat-1", "name": "starling_retro", "lod": 1, "verts": 0, "tris": 0, "rows": 34, "cycleFrames": 32,
  "rowGlide": 32, "rowBound": 33, "wingbeatHz": 13.3, "downstroke": 0.57, "spanM": 0.39, "lengthM": 0.205,
  "frame": "glTF +Z head, +Y back, +X left wing, metres",
  "bbox": [0,0,0,0,0,0],
  "buffers": { "index": {"offset":0,"count":0}, "uv": {"offset":0,"count":0}, "vatPos": {"offset":0,"count":0}, "vatNrm": {"offset":0,"count":0} },
  "textures": { "albedo": "starling_retro_albedo.png", "mask": "starling_retro_mask.png", "normal": null },
  "albedoLinear": { "body": [0,0,0], "wing": [0,0,0] } }
```

**Milestone M1 (first):** export the VAT from the *current v2* rig, in this exact format, so Flock can integrate
early. Re-export after the tail fix; the format must not change.

### 6.3 Triangle counts

| asset | triangles |
|---|---|
| starling real | 1,700–1,900 |
| starling retro | 380–430 |
| starling sil | 40–64 |
| starling micro | ≤ 12 |
| peregrine real | 2,500–3,500 |
| peregrine retro | 450–700 |

### 6.4 Peregrine from `models/raw/peregrine/scene.gltf`: `blender/p0_inspect.py` … `p6_render.py`, `run_falcon.sh`

The method is the same as LOOKTEST.md's. The scan is about 1M triangles in 13 meshes, with two 6 MB base-colour
JPEGs, on a rock mount.

1. **p0/p1.** Import and weld. Delete the rock, legs and feet. Level the body and straighten the head. Scale
   bill-to-tail to **0.40 m**.
2. **p2.** Orthographic captures of the folded wings (dorsal), the breast and flanks (the barred underparts), the
   back, the head and the tail. These give albedo plus a high-passed normal.
3. **p3. Build both variants.** The spread **wing** is long, pointed and broad-based:
   - span **1.00 m** (accept 0.95–1.10) in the glide;
   - root chord 0.17 m, wrist chord 0.14 m;
   - the hand is 55 % of the semi-span, with P9 forming a sharp tip;
   - aspect ratio about 6.5;
   - the trailing edge is nearly straight to the wrist.

   The **tail** is 0.15 m long, narrow (6 cm closed) and square to slightly rounded. Each feather strip gets UVs
   from the falcon's own captures: the dorsal flight feathers come from the folded-wing capture, and the
   **underwing** from the barred breast and flank capture.
4. **p4. Bake** from the scan. **Plumage correction.** The specimen is brown-backed, while the target is an adult.
   Make this a documented colour remap in Lab, with no painting and no AI:
   - **Dorsal:** keep L*, move a* and b* toward slate (a mean of about sRGB (78,84,92)), keeping 15 % of the
     chroma.
   - **Underparts:** keep the barring's luminance pattern and remap to cream-white (about (225,220,205)) with grey
     bars.
   - **Malar (moustache) and crown:** a geometric mask below and behind the eye, darkened to L* ≤ 20.

   Use one atlas per variant: 2048² for real and 1024² for retro.
5. **p5. Rig.** The 12 bones keep the starling names (`body, neck, head, tail, humerus/forearm/hand/primaries .L/.R`),
   plus `tailfan.L` and `tailfan.R` (14 bones at most). Export GLB actions with `export_animation_mode='ACTIONS'`
   and no Draco. The PNG textures are embedded.

   | clip | definition |
   |---|---|
   | `flap` | One stiff, shallow beat over a 1.0 s duration (the runtime sets the rate to 4–5 Hz). The humerus runs +28° to −24°. Downstroke 55 %. A small wrist flex on the upstroke (hand 15–20°). |
   | `glide` | Wings flat, +3° dihedral, hands swept back 10°, tail closed. |
   | `stoop` | **Teardrop**: wings folded tight along the flanks, primaries over the tail, tail closed, head forward. Top-view area ≤ 25 % of the glide's, and maximum width ≤ 0.16 m. |
   | `flare` | Wings 60 % open and raised +20°, tail fanned to 0.14 m. |

   Every clip except `flap` is a single-pose clip. The files are
   `assets/birds/peregrine_real.glb` and `peregrine_retro.glb`. The armature is named `peregrine_rig` and the mesh
   `peregrine`. The frame is §0's.
6. **p6. Previews** in `models/preview/`:
   - `peregrine_scan_views.png` (raw, then cleaned);
   - `peregrine_lowpoly_compare.png` (scan, real and retro);
   - `peregrine_poses.png` (flap ×4 phases, glide, stoop and flare × top/side/front);
   - `peregrine_vs_starling_scale.png`;
   - `peregrine_colour_remap.png` (before and after);
   - `starling_v3_tail.png` (v2 vs v3, side/top/below, glide, with the wingtip line drawn).

---

## 7. Trails builder: `src/trails.js`, `src/ui.js`, `template.html`

### 7.1 Ornitography (after Xavi Bou's *Ornitographies*, used as reference only; no copied imagery)

```js
export class Trails {
  constructor({ renderer, state, prof })
  setSize(w, h)
  plan(state)            // → {steps, dt, stamp}. live: {1–2 steps of 1/60 s, stamp:false}.
                         //   ornito running: {steps: skip+1, dt: 1/vfps, stamp: true}  (slow-motion virtual high-speed camera)
  begin(plateTex)        // shutter opens: accRT = plate (sky-only frame, birds hidden); done = 0
  stamp(frameTex)        // decay: acc = mix(acc, plate, decay) (blend CONSTANT_ALPHA); then blendEquation MIN (darken) or MAX (lighten) with frameTex
                         // done++; emit 'ornito:frame'; at done == frames → end()
  end(); clear()
  get active(); get output()   // accRT.texture while an exposure is running or finished, until 'ornito:new' or live mode
  async exportPNG(grade) // grade.presentTo(acc, rgba8) → readPixels → canvas → PNG download
                         //   filename: ornitography_{siteId}_{YYYYMMDD-HHmm local}_{frames}f_{vfps}fps.png
  debug                  // { stampCount, lastPlate, compareToPlate() }
  dispose()
}
```

**Integrator duties on `ornito:start`:**

1. Freeze the camera and the sky (`sky.setFrozen`).
2. Render the plate with `flock.object3d.visible = false`, grade it, then call `trails.begin(plate)`.
3. Call `flock.setStampMode(track === 'all' ? 'all' : 'tracked')`.
4. The **lighten** blend uses Grade look `negative` for the plate and the frames.

**Track modes:**

- `one`: a click picks the bird (`flock.pick`).
- `selection`: shift-click adds birds, up to 64; "Auto 24" picks the 24 tracked birds nearest the centre of the
  screen.
- `all`: every bird.

The falcon (id −2) is included when it is picked, or in `all`.

| control | range | default |
|---|---|---|
| frames N | 150–1,000 | 150 |
| virtual fps | 60 / 120 / 240 / 480 | 240 |
| skip | 0–7 | 0 |
| decay | 0–0.05 per stamp | 0 |
| blend | darken / lighten | darken |
| track | one / selection / all | all |
| show untracked live | toggle | off |
| caption on PNG | toggle (site, date, N, fps) | off |

The **look** is layered chronophotography. Each stamp is a crisp, MSAA-resolved silhouette in its actual VAT wing
pose. Stamps overlap into ribbons through MIN/MAX. Never use averaging, accumulation-buffer blur or motion blur.
At 240 fps a 12.5 m/s bird moves 5 cm per stamp (a quarter of its length), with 18 stamps per wingbeat.

**Shutter indicator**: a red dot, the count `done / N`, a progress ring, and the bird-time exposure
(`N·(skip+1)/vfps` s). Space starts and stops the shutter.

### 7.2 UI (`ui.js`, `template.html`)

`export function initUI({ state, sites, credits })` builds no WebGL. It only reads `state` and emits §2 events.
It updates on `weather`, `ornito:frame`, and on a 4 Hz stats tick (`murm.stats()` if present).

**template.html** has `<canvas id="c">`, a `#status` loader, and the import map:

```
three        → https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js
three/addons/→ https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/
```

It loads `<script type="module" src="assets/js/main.js">`, and `build.js` replaces `%BUILD%` in it.

**Pinned ids**:

| group | ids |
|---|---|
| title | `#title` (Murmuration plus site, date and local time) |
| readout | `#readout`: cloud low/mid/high %, 10 m and 80 m wind as speed with an arrow, temperature, visibility, sun altitude and azimuth, the source badge ("live", "historical", "cached" or "sample weather (offline)") |
| main bar `#bar` | `[data-mode=live\|ornito]`, `[data-look=signature\|physical\|dusk]` (labelled "Signature (pale overcast)", "Physical", "Dusk"), `[data-cam=watcher\|orbit\|falcon]`, `[data-q=low\|medium\|high]`, `#falconToggle`, `#attackBtn`, `#gustBtn`, `#noiseBtn`, `#placeBtn`, `#creditsBtn`, `#fps` |
| `#noisePanel` | `#nzPreset` (calm, swirling, agitated, pulsing), `#nzCurl` (0–4), `#nzScale` (0.1–2), `#nzOct` (1–5), `#nzWander` (0–2), `#nzSeed` with `#nzRandom`, `#nzGustRate` (0–4) |
| `#placePanel` | `#siteSel`, `#dateIn`, `#timeIn`, `#nowBtn`, `#sunsetBtn`, `#clockSel` (×1, ×10, ×60) |
| `#ornitoPanel` | shown only in ornito mode: `#ofFrames`, `#ofVfps`, `#ofSkip`, `#ofDecay`, `#ofBlend`, `#ofTrack`, `#ofAuto`, `#ofUntracked`, `#ofCaption`, `#ofStart`, `#ofNew`, `#ofExport`, `#shutter` |
| `#credits` | the four required lines **verbatim**: "European starling scan: Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0"; "Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0" (linked); "Weather data by Open-Meteo.com (CC-BY 4.0)" (linked to https://open-meteo.com/); "three.js r170 (MIT)". Also "Sun position after SunCalc (V. Agafonkin, BSD-2)", "Ornitography mode inspired by Xavi Bou's *Ornitographies*", and the science references from §4. |

**Keys:** O = mode, 1/2/3 = look, C = camera, F = attack, G = gust, R = randomise, Space = shutter (in ornito mode).

**Style.** The palette is pale-paper and matches the signature sky:

- panels: rgba(250,250,251,0.62), with a 1 px rgba(30,32,36,0.10) border and backdrop blur;
- ink: #1d1e20; dim ink: rgba(29,30,32,0.62); one accent: #2f3a4a;
- shutter red: #c8352b;
- font: system-ui, 12–13 px, with tabular numbers.

The panels must look tasteful over all three looks, and nothing may sit over the frame centre. Buttons use
`aria-pressed`. A phone at 375 px wide gets a full-width wrapping bar, a 16 px gutter and no horizontal scroll.
Phones default to low quality. With `prefers-reduced-motion`, auto-orbit and auto-attack are off.

---

## 8. Integrator: `src/main.js`, `src/state.js`, `build.js`, `tools/*`, `tests/integration/*`, `README.md`

- **Boot.** Parse the URL parameters (below). Run `makeState`. Create the renderer
  (`powerPreference: 'high-performance'`, antialias false; MSAA lives on `sceneRT`). Construct `Sky`, then
  `Flock.loadAssets` + `Flock`, then `Trails`, then `initUI`. Show the sky before the birds load.
- **Cameras.**
  - **watcher** (the default): eye at 1.7 m, 260 m from the roost on the side away from the sun's azimuth, so the
    flock is between the watcher and the sun. The look target is the smoothed centroid (critically damped,
    1.5 s). Vertical FOV 35° (wheel 20–60°). Dragging looks around; auto-follow resumes after 4 s.
  - **orbit**: OrbitControls around the smoothed centroid, default 180 m (15–900 m), auto-rotate at 0.3 rpm when
    idle.
  - **falcon**: a chase camera 6 m behind and 2 m above the falcon.
  - Both orbit and watcher are disabled while frozen.
- **Pointer.** A click (moved < 5 px within < 300 ms) emits `pulse` in live mode, and does `pick` and `select` in
  ornito mode.
- **URL parameters.**

  | parameter | values |
  |---|---|
  | `q` | quality level |
  | `look` | look id |
  | `site` | site id |
  | `t` | ISO UTC, `now` or `sunset` |
  | `wx` | `live`, `sample:overcast` or `sample:clear` |
  | `seed` | integer |
  | `preset` | noise preset |
  | `mode` | `live` or `ornito` |
  | `cam` | camera mode |
  | `fx` | effect overrides (§3) |
  | `msaa` | MSAA override |
  | `scale` | render-scale override |
  | `lodviz` | 1 = LOD tint |
  | `skydebug` | sky debug view |
  | `nofalcon` | disable the falcon |
  | `bench` | 1 = no auto-attack, fixed seed |

  The **deterministic test URL** is
  `index.html?bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z`.
- **`window.murm`.** It mounts `murm.flock`, `murm.sky` and `murm.trails` as the modules' `debug` objects.

  | method | returns or does |
  |---|---|
  | `stats()` | `{fps, ms, quality, birds, lodCounts, tris, look, mode, weatherSource, sun:{az,alt}, errors}` |
  | `gpuBench(n=60)` | `{median, p90, perPass:{name:ms}}` |
  | `frameP95(sec)` | rAF frame-time p95 |
  | `setQuality`, `setLook`, `setMode`, `seed`, `setSite`, `setTime`, `useSampleWeather` | setters |
  | `view(name)` | `name` is `default`, `orbit-close` (25 m from the flock edge), `inside`, `top` or `falcon` |
  | `pause()`, `resume()`, `tick(dt, n)` | sim control |
  | `capture(name)` | save a capture (§0) |

- **build.js** (node, no dependencies): copies `src/*.js` to `assets/js/`, writes `index.html` from `template.html`
  with `%BUILD%` = a timestamp plus a short hash, writes `assets/manifest.json` (files, bytes, sha1), and checks
  that every asset in §6.2 and §6.4 exists. `tools/serve.js` is copied from monkey-school.
- **Deliverable:** `index.html` + `assets/` (`js/`, `birds/`, `weather/`).

---

## 9. Acceptance tests

Every test runs in headless Chrome on the Arc iGPU (§0) at each quality level, and records its numbers in
`tests/<builder>/results.json`. Every page load must have **zero** console errors or exceptions (favicon excluded).

**Flock (F)**

| # | test | pass |
|---|---|---|
| F1 | kNN accuracy vs CPU brute force, 512 random birds | ≥ 90 % of the true 7 nearest are in the 8 slots after 3 s; ≥ 98 % after 10 s while moving |
| F2 | Polarisation φ = \|Σv̂\|/N | calm 0.90–0.99; agitated 0.70–0.95 |
| F3 | Speed | median 11–14 m/s; 1st–99th percentile within [9, 20] |
| F4 | Scale-free correlation | the first zero of the connected velocity correlation C(r), on 2,048 sampled birds, is ξ/L ∈ [0.25, 0.45] at both 10k and 30k birds (Cavagna 2010) |
| F5 | Agitation wave from an edge `excite` | front speed 18–35 m/s; band thickness ≤ 12 m; it decays (birds go refractory) without re-triggering loops |
| F6 | Bounds over 5 min with 10 m/s wind | 99 % of birds in [altMin − 10, altMax + 20]; horizontal ≤ roostRadius + 150 m |
| F7 | Flight states at cruise | flap / glide / bound = 65–75 / 15–25 / 5–15 % |
| F8 | Falcon cycle | patrol → select → stoop → strike → pullout → climb → patrol; peak stoop 40–50 m/s; a vacuole of ≥ 4 m clear around it at the strike; one wave per stoop |
| F9 | LOD | `?lodviz=1` captures (`orbit-close`, `default`); drawn birds = birds in the frustum (none lost); no visible pop on a 3 s dolly (12-frame capture strip); caps respected |
| F10 | Close-up | LOD0 at 400 px: albedo, sheen and AO correct; wing root and tail OK; capture `flock_closeup.png` |
| F11 | Perf | `flock.sim` and `scene` within §3 at each quality level; each `flock.*` effect measured on/off |
| F12 | Look | in the default view, bird cores are sRGB 20–60 and lit wings ≤ 115 under signature |

**Sky (S)**

| # | test | pass |
|---|---|---|
| S1 | URL | request A is built byte-exact for brighton on a fixed D |
| S2 | Fallbacks | live works for 3 sites; with CDP `Network.emulateNetworkConditions{offline:true}` the source is `sample` and the readout badge shows it; the localStorage cache is used on a second offline load |
| S3 | Sun | Brighton 2025-12-21 12:00 UTC altitude 15.7 ± 0.3°, azimuth 180 ± 1.5°; lat 0, lon 0, 2025-03-20 12:07 UTC altitude ≥ 88.5°; sunset within 2 min of Open-Meteo `daily.sunset` for 3 sites |
| S4 | Coverage | `?skydebug=coverage`: the covered fraction matches each deck's cloud fraction within ±0.05 at 0, 0.25, 0.5, 0.75 and 1 |
| S5 | Cloud drift | each deck's offset equals v_layer·t; a screen motion test, looking up, matches the v850 heading within 10° |
| S6 | Signature vs reference | the deterministic URL in the default view, at 1296×716 CSS DPR 1, `murm.flock` hidden, on the sky crop: top-row mean within ±4 of (196,197,198) and bottom-row mean within ±4 of (191,192,193); top − bottom 3–10 codes; per-pixel B − R ∈ [0, 4]; max − min channel ≤ 5; sky std 0.8–5 codes (clouds present but subtle); no column step > 1 code (no banding). The integrator composes `captures/signature_vs_reference.png`: the reference's top two panels next to the same framing of the page. |
| S7 | Other looks | dusk, top/bottom rows within ±12 of (104,116,141) / (144,126,124); physical, AgX with no clipping in the sky; captures of all three looks |
| S8 | Perf | `sky.*` within §3; each `sky.*` effect measured |

**Blender (B)**

| # | test | pass |
|---|---|---|
| B1 | Tail | §6.1 numbers measured in Blender and printed; `starling_v3_tail.png` |
| B2 | VAT | every `.json` follows §6.2; the `.bin` lengths match; rows 0, 16, 32 and 33 rebuilt from the VAT match the evaluated mesh within 0.3 mm; verts ≤ 4096 |
| B3 | Triangles | §6.3 ranges |
| B4 | Falcon | glide span 0.95–1.10 m; length 0.38–0.46 m; dorsal mean sRGB R,G,B 65–100 with B ≥ R + 4 and saturation ≤ 0.15; underparts L* ≥ 75 with bar high-pass std ≥ 6 codes; malar L* ≤ 20; stoop top-view area ≤ 25 % of glide, width ≤ 0.16 m |
| B5 | Load | `tests/blender/load.html` (three r170 GLTFLoader) loads both GLBs with the clips `flap`, `glide`, `stoop` and `flare` and ≤ 14 bones, and the starling VATs animate |
| B6 | Previews | every §6.4 p6 sheet exists and is honestly captioned |

**Trails and UI (T)**

| # | test | pass |
|---|---|---|
| T1 | Shutter | the camera matrix is bit-identical during the exposure; exactly N stamps; the indicator reaches N/N and stops |
| T2 | Not a smear | at decay 0, every stamp's darkest pixel equals the single-frame bird darkness ±3 codes (MIN, not averaging); outside the ribbons acc equals the plate ±1 code; in `one` mode at 240 fps the ribbon shows distinct repeating wing shapes, with the luminance autocorrelation along the path peaking at 18 ± 2 stamps |
| T3 | Lighten | the MAX path with the negative grade works; capture both |
| T4 | Decay | a stamp k frames old keeps contrast (1 − d)^k ±2 codes |
| T5 | PNG | the filename follows §7.1; its dimensions equal the render size; it matches the presented acc ±1 code |
| T6 | Track modes | untracked birds are absent from acc in `one` and `selection` |
| T7 | UI | every pinned id exists and emits its event; keys work; 375 px has no horizontal scroll; credits are verbatim; contrast ≥ 4.5:1 on panels over all three looks |
| T8 | Perf | `trails` ≤ §3 at medium |

**Integration (I)**

| # | test | pass |
|---|---|---|
| I1 | End to end | the default load (live weather, today's sunset, Brighton, medium) shows the signature view with the flock filling 35–60 % of the frame width and a median bird span of 4–9 px |
| I2 | Perf table | `README.md` holds this table, filled with measured values, plus a per-effect cost table |
| I3 | Default view check | S6 run on the integrated page; `signature_vs_reference.png` reviewed critically, with differences listed honestly |

**I2 perf table**, filled from measurements:

| quality | birds | render px | MSAA | default ms | orbit-close ms | inside ms | falcon ms | ornito +ms | p95 frame | 60 fps? |
|---|---|---|---|---|---|---|---|---|---|---|
| low | 10,240 | 1088×612 | 0 | | | | | | | |
| medium | 30,720 | 1600×900 | 4 | | | | | | | |
| high | 81,920 | 1600×900 | 4 | | | | | | | |

---

## 10. References (for the credits and the code comments)

- Ballerini et al. 2008, PNAS 105: 1232 (topological interaction, k ≈ 7).
- Cavagna et al. 2010, PNAS 107: 11865 (scale-free correlations).
- Pearce et al. 2014, PNAS 111: 10422 (marginal opacity).
- Hemelrijk & Hildenbrandt 2011, PLoS ONE 6: e22479 (StarDisplay, banking).
- Procaccini et al. 2011, Anim. Behav. 82: 759 (propagating waves).
- Hemelrijk et al. 2015, Behav. Ecol. Sociobiol. 69: 755 (agitation waves).
- Carere et al. 2009, Anim. Behav. 77: 101 (predator-induced patterns).
- Tobalske 1995, J. Exp. Biol. 198: 1259 (flap / glide / bound).
- Ben-Gida et al. 2013, PLoS ONE 8: e80086 (13.3 Hz).
- Hillaire 2020, EGSR (sky LUTs).
- Open-Meteo.com (CC-BY 4.0).
