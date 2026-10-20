# Murmuration

A three.js (r170) page of a starling murmuration over a real roost, under the real weather for that place and time.
Tens of thousands of GPU-simulated starlings, made from a museum scan, fly in a pale overcast sky. A peregrine falcon
made from a second museum scan hunts them. An **Ornitography** mode, after Xavi Bou's *Ornitographies*, layers
high-speed frames into sculptural traces of each wingbeat.

## Run it

```
node build.js                 # copies src/*.js → assets/js/, writes index.html and assets/manifest.json, checks assets
node tools/serve.js 8765      # any static server works; this one also accepts test captures
```

Open <http://localhost:8765/index.html>. The page needs WebGL2 with float render targets (any current desktop
browser). It loads three.js 0.170.0 from cdn.jsdelivr.net and calls the Open-Meteo API at runtime. Nothing else is
fetched, and no API key is used. Without a network connection it falls back to the last cached weather, then to a
bundled overcast sample, and the readout says which source it is using.

The deliverable is `index.html` plus `assets/` (`js/`, `birds/`, `weather/`, `manifest.json`), about 19.5 MB.

## Controls

| | |
|---|---|
| **Live / Ornitography** (O) | live flight, or the virtual high-speed camera |
| **Signature (pale overcast) / Physical / Dusk** (1 / 2 / 3) | the look; *Signature* is the default |
| **Watcher / Orbit / Falcon** (C) | ground watcher, orbit around the flock, chase camera behind the peregrine |
| **Peregrine** | falcon on/off; **Attack** (F) starts a stoop now; **Gust** (G) sends a wind gust through the flock |
| **Noise** | curl strength, scale, octaves, per-bird wander, evolve, gusts/min, waves/min, seed; **Dice** (R) randomises the seed and blends two presets |
| **Place & time** | roost (7 real sites), local date and time, *Sunset*, *Now*, clock ×1/×10/×60 |
| **Low / Med / High** | quality (phones start on Low) |
| **H** | hide/show all UI (for clean screenshots) |
| click (live) | sends an agitation pulse into the flock where you click |
| drag / wheel (watcher) | look around (it returns to the flock after 4 s) / zoom 20–60° |
| drag / wheel (orbit) | orbit / dolly; auto-rotates when idle |

**Ornitography.** Choose frames (150–1,000), camera fps (60–480), skip, decay, blend (darken, or lighten on a
negative plate), and track (all birds, one bird by clicking, or a shift-click selection; *Auto 24* picks the 24 birds
nearest the centre). **Space** or *Open shutter* starts the exposure. The camera and sky freeze, and the simulation
advances 1/fps of bird time per frame. Each frame's crisp silhouettes are composited with a hard MIN or MAX, so there
is no averaging and no motion blur. *Save PNG* downloads `ornitography_{site}_{YYYYMMDD-HHmm}_{N}f_{fps}fps.png`.
Decay starts at 0.008 per frame. With tens of thousands of birds, a decay of 0 turns the core of the flock into a
flat dark slab; a little decay keeps the newest wing shapes crisp and fades the older ones.

### URL parameters

`q=low|medium|high` · `look=signature|physical|dusk` · `site=brighton|otmoor|hamwall|gretna|aber|rome|tonder` ·
`t=<ISO UTC>|now|sunset` · `wx=live|sample:overcast|sample:clear` · `seed=<int>` ·
`preset=calm|swirling|agitated|pulsing` · `mode=live|ornito` · `cam=watcher|orbit|falcon` ·
`fx=id:0|1,...` · `msaa=` · `scale=` · `lodviz=1` · `skydebug=coverage|lut|deck:low...` · `nofalcon=1` · `bench=1`
(no auto-attack, fixed seed) · `ui=0` (hide UI) · `warm=<steps>` (pre-roll; default 480 = 8 s) · `decay=` ·
`alphapow=` (far-bird darkening, see below).

The deterministic test URL is
`index.html?bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z`.
Live stepping follows real time, so two loads of it match in weather, sun and seed but not frame for frame.

`window.murm` exposes `stats()`, `gpuBench(n)`, `frameP95(sec)`, `framing()`, `view(name)` (`default`,
`orbit-close`, `inside`, `top`, `falcon`, `falcon-side`, `wide`), `setQuality/setLook/setMode/seed/setSite/setTime/useSampleWeather`,
`pause/resume/tick`, `capture(name)`, and the modules' debug objects as `murm.flock`, `murm.sky` and `murm.trails`.

## What drives it

- **Flock** (`src/flock.js`, `src/flock_shaders.js`). A GPU simulation with topological k = 7 neighbours
  (Ballerini 2008), marginal opacity (Pearce 2014) and scale-free curl noise (Cavagna 2010). It adds banking turns
  (Hemelrijk & Hildenbrandt 2011), roost and altitude springs, wind by height, gusts, excitable agitation waves
  (Procaccini 2011; Hemelrijk 2015), and flap / glide / bound bouts at 13.3 Hz (Tobalske 1995; Ben-Gida 2013).
  Birds are drawn from four vertex-animated LODs (1,816 / 422 / 58 / 12 triangles).
- **Peregrine.** A CPU agent that patrols, selects a target, stoops (up to 45 m/s), strikes, pulls out and climbs.
  It is a skinned GLB with flap, glide, stoop (teardrop) and flare clips. The flock flees it, flash-expands around
  the strike and sends an agitation wave.
- **Sky** (`src/sky.js`, `src/sky_shaders.js`). Hillaire (2020) atmosphere tables and three cloud decks (low, mid,
  cirrus), each covering exactly the forecast fraction for its level and drifting with the real wind at 850, 500 or
  300 hPa. The sun position follows the NOAA/SunCalc algorithm for the site and time. The *Signature* grade turns the
  physical sky into a soft, high-key, cool pale-grey overcast. Clouds become a few codes of tonal variation, and birds
  stay dark against the exact sky behind them.
- **Weather** (`src/weather.js`). Open-Meteo forecast, falling back to historical-forecast, archive,
  localStorage and finally a bundled sample. It supplies cloud cover per level, wind at 10 m, 80 m, 850/500/300 hPa,
  gusts, temperature, dew point (which sets the cloud-base height) and visibility (which sets haze and aerial
  perspective). In *Now* mode it refetches every 30 minutes.
- **Roost descent** (integrator). As dusk deepens (sun altitude −0.5° to −3.5°), the flock's ceiling eases from
  220 m to 60 m, as real murmurations drop toward the roost.

## Performance (I2)

Measured with `node tests/integration/perf.js` (headless Chrome, ANGLE D3D11, 1280×720 CSS at DPR 1.25). GPU ms are
timer-query medians over 90 frames. **The machine available had an NVIDIA RTX 3070, not the Intel Arc iGPU the
spec targets, so the Arc numbers are still unmeasured.** The sky builder's ×4.5 throughput estimate puts MEDIUM's
default view at roughly 2.8 ms on the Arc, against a 10.5 ms budget. Please confirm on the Arc.

| quality | birds | render px | MSAA | default ms | orbit-close ms | inside ms | falcon ms | ornito +ms (trails pass) | p95 frame | 60 fps? |
|---|---|---|---|---|---|---|---|---|---|---|
| low | 10,240 | 1088×612 | 0 | 0.23 | 1.09 | 0.76 | 0.67 | 0.36 | 16.8 ms | yes (3070) |
| medium | 30,720 | 1600×900 | 4 | 0.63 | 1.25 | 0.88 | 0.85 | 0.05 | 16.8 ms | yes (3070) |
| high | 81,920 | 1600×900 | 4 | 1.26 | 1.54 | 1.21 | 0.77 | 0.12 | 16.8 ms | yes (3070) |

High's render size equals medium's here because DPR 1.25 is below both dprCaps. The p95 frame time is the 60 Hz
vsync interval in every view. CPU main thread is about 0.3 ms per frame at all levels. Medium's default view splits
into sky.prepass 0.11, flock.sim 0.15, flock.lodkey 0.004, scene 0.31, grade 0.04 and present 0.02 ms. At these
sub-millisecond sizes this GPU's clock changes between runs move individual numbers by ±0.3 ms, so the low row's
orbit-close and ornito values are noise-inflated.

**Per-effect cost** at medium. Each flag is toggled at runtime and measured on/off alternately over 4 rounds of 60
frames in the same session (`perf.js --fx`), so clock drift cancels. Deltas are GPU ms.

| effect | default view | inside view | note |
|---|---|---|---|
| sky.cloudRaymarch | +0.127 | | **off by default** (see below) |
| sky.multiScatter | +0.027 | | high only |
| sky.cirrus | +0.019 | | |
| sky.silverLining | +0.006 | | |
| sky.cloudLightTaps 2 vs 0 | ≈0 | | |
| flock.lod0 | ≈0 | +0.035 | |
| flock.wingTransmit | ≈0 | +0.015 | |
| flock.selfShadow | +0.012 | ≈0 (±0.04) | high only |
| flock.iridescence, aerial, minPixel, normalMapLOD0 | ≈0 | ≤0.01 | |
| falcon.real | ≈0 (falcon-side view) | | |
| post.grain / vignette / dither | +0.011 / +0.010 / +0.004 | | |
| MSAA 4 vs 0 | +0.10 | | |
| render scale 1.0 vs 0.75 | +0.31 | | |

Raw data: `tests/integration/perf.json`.

## Tests and captures

```
node tests/integration/shots.js     # models/preview/page_*.png (+ console check per load)
node tests/integration/perf.js      # perf table above; add --fx for the per-effect table
node tests/integration/s6.js && python -I tests/integration/s6_sheet.py   # I3: S6 on the page + captures/signature_vs_reference.png
```

Every page load in these runs had **zero console errors**. The builders' own suites are in `tests/flock`,
`tests/sky`, `tests/trails` and `tests/blender`.

**I3 (signature vs reference)**, from `tests/integration/s6.json` with the flock hidden:

- Top rows are (195, 196, 197) and bottom rows (194, 195, 196): both pass ±4.
- B − R is 1–4, the largest channel spread is 4, sky std is 1.8 codes and there is no banding (column step 0.11): all pass.
- **Fail: the top-to-bottom gradient is 0.7 codes (spec 3–10).** The watcher looks up at the flock (pitch ~58°),
  where the overcast gradient is nearly flat. The reference panel is framed near the horizon. Capping the look-up
  at 45° only brought it to 1 code, so I kept the larger birds.
- `captures/signature_vs_reference.png` puts the two side by side. The sky palette matches. The difference is in the
  birds: the reference shows 200 birds at ~30 m, so each is a large crisp silhouette. The page shows 30,720 birds at
  ~125 m, so in the watcher view each is a 3–4 px dark tick, and the flock reads as a murmuration photographed from
  the ground. The large-silhouette look appears in the `orbit-close` and `inside` views, from the orbit camera when
  zoomed in, and in Ornitography.

## Integration decisions (departures from SPEC.md)

- **Watcher camera.** The SPEC's fixed watcher (1.7 m eye, 260 m from the roost) saw the flock as 1–2 px grey
  smoke. The watcher still stands at 1.7 m on the side away from the sun, but walks slowly (5 s damping) to keep the
  flock about one frame-width across, at 60–340 m, looking up at most 62°. Median bird span is 3.3–4.5 px. The look
  target leads the flock by its velocity, so a 12 m/s flock is not left trailing off-centre.
- **Signature grade of occluders** (`src/sky_shaders.js`, `signature()`). The sky keeps the high-key tone curve, but
  anything darker than the sky behind it (birds, ground) is composited photographically: a linear-light multiply of
  the graded sky. Through the curve alone, a half-covered anti-aliased bird pixel came out only ~15 codes below the
  sky, so the flock read as faint dust. Bird cores stay at sRGB 20–60, and the S6 sky numbers did not change.
- **Far-bird darkening** (`src/flock.js`, `src/flock_shaders.js`). The micro LOD's min-pixel widening uses
  alpha = k^−1.4 instead of k^−2 (new uniform `uAlphaPow`, URL `alphapow=`; 2 = area-exact). This only affects birds
  narrower than 2 px.
- **`sky.cloudRaymarch` off by default.** The high-quality volumetric low deck reads as smooth "marshmallow" masses
  and looks worse than the 2-D decks. Turn it on with `?fx=sky.cloudRaymarch:1`.
- **Ornitography** freezes the camera when the shutter opens, not on entering the mode, so you can frame the flock
  first. It unfreezes on *New* or when you return to live. Decay defaults to 0.008.
- **waveDelay 0.04** at boot (flock builder's F5 measurement: 0.07 gives ~10 m/s fronts).
- **PBO fix.** three r170's `readRenderTargetPixelsAsync` leaves a pixel-pack buffer bound, which breaks
  synchronous reads such as the PNG export. main.js unbinds it after every async read, for every module.
- **Roost descent** (above) and the `wide` / `falcon-side` views are additions.

## Known issues

- Arc iGPU performance is unmeasured (no Arc on this machine); see the performance section.
- The agitated noise preset often settles into a compact, highly ordered ball (polarisation about 0.98) rather than
  the ragged 0.70–0.95 the SPEC wants. This is the flock builder's F2 finding; fixing it means retuning
  `NOISE_PRESETS.agitated` in the verbatim `state.js`. The presets are stochastic: in another run the same preset
  gave a stretched, fragmented flock.
- In the wide dusk view the flock (2–3 px birds over dappled cloud) reads lighter than a real photograph would.
- The I3 gradient fails as described above.
- The peregrine's wing feathers repeat slightly when seen from above at close range (Blender builder).

## Credits

- European starling scan: Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0
- Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0 —
  <https://sketchfab.com/3d-models/peregrine-falcon-falco-peregrinus-49cb0ef2fa2847b0aca92ab6deecf919>
- Weather data by Open-Meteo.com (CC-BY 4.0) — <https://open-meteo.com/>
- three.js r170 (MIT)
- Sun position after SunCalc (V. Agafonkin, BSD-2), NOAA solar equations
- Ornitography mode inspired by Xavi Bou's *Ornitographies* (reference only; none of his imagery is used)

Science: Ballerini et al. 2008 (PNAS 105:1232); Cavagna et al. 2010 (PNAS 107:11865); Pearce et al. 2014
(PNAS 111:10422); Hemelrijk & Hildenbrandt 2011 (PLoS ONE 6:e22479); Procaccini et al. 2011 (Anim. Behav. 82:759);
Hemelrijk et al. 2015 (Behav. Ecol. Sociobiol. 69:755); Carere et al. 2009 (Anim. Behav. 77:101); Tobalske 1995
(J. Exp. Biol. 198:1259); Ben-Gida et al. 2013 (PLoS ONE 8:e80086); Hillaire 2020 (EGSR).

## Data sources

- **Weather:** Open-Meteo forecast API (`api.open-meteo.com/v1/forecast`), historical-forecast API and archive API,
  requested at runtime for the chosen site and date. Two bundled synthetic samples
  (`assets/weather/sample_overcast.json`, `sample_clear.json`) are the offline fallback and are labelled
  "sample weather (offline)".
- **Sun:** computed locally (NOAA / SunCalc method). It is checked against Open-Meteo's sunset to within 0.1 min.
- **Birds:** low-poly models baked in Blender (`blender/`) from the two museum scans above. The provenance is in
  `LOOKTEST.md`, `assets/birds/CREDITS.json` and `models/preview/peregrine_*.png`.


## Status (2026-10-20, after the look and behaviour reviews)

### Done

**Flock behaviour**
- **Jitter:** the separation kernel is now smooth (zero force and slope at rSep = 1.2 m). Roll follows a 0.15 s low-pass of the lateral demand.
  - In the calm preset no birds sit at the roll-rate limit (was 50 %), and the half-second roll swing is 1.4–3° (was 53°).
  - Median jerk is 1.7 m/s³ (was about 520).
- **Shape:** the opacity targets were lowered (0.13–0.17) and made anisotropic, with a weak vertical flattening spring. The centroid pull now acts only beyond 2.5 × the median radius.
  - Flocks are flattened sheets (RMS axes about 17–45 × 7–20 × 4–7 m; the thin axis is usually vertical) and stay one cluster.
- **Wheeling:** a large-scale steering field (noise.turn / turnHz / steer) sweeps across the flock as a delayed turn wave. The roost radius is 140 m with an orbiting component, and wind drift is 0.4.
  - The flock now circles over the roost (paths loop through about ±120 m), and the noise presets change the path, not only the shape.
- **Falcon:**
  - It patrols 100–150 m above the flock, 60–70 m off.
  - The tucked stoop starts only once the dive is steeper than 35°.
  - It targets a bird on the flock's surface (0.8–1.2 × the median radius).
  - It seeds an agitation wave at the nearest bird within 30 m.
  - The flee radius is 25 m.
  - Measured: strike at 0.2 m, with up to 40–65 % of birds excited.
- **Quality switch:** the flight in progress is carried over (a strided subset going down, jittered clones going up). The flock no longer respawns as an egg.
- **Boot framing:** the sub-sample is stamped with the sim time it was taken at, so the first frame is framed on the real centroid. It used to start off-screen and swing in.
- **High-refresh displays:** birds are drawn ahead by the time not yet simulated (`uLead`), so motion is smooth at 75–165 Hz.
- **Test stepping:** `murm.render(n)` steps exactly one 1/60 s frame per call.

**Look**
- **Watcher:** a ground observer 150–900 m away with a 24° lens (down to 11°). It looks toward the sun's side, swung up to 65° so the flock's long axis is seen broadside, and frames the 2–98 % bird box to half the width. During a stoop it widens to include the falcon.
- **Birds:**
  - Far birds are dilated 0.5 px in screen space, so sub-pixel wings stay dark dashes.
  - Coverage follows the projected wing area, so banked birds read darker.
  - In the signature and dusk looks, birds take ambient light only (0.3 / 0.25 × albedo), so they are near-black silhouettes. A sunny day no longer washes them out.
- **Cirrus:**
  - The tile is now 64 × 19.2 km, domain-warped twice into hooks and broken up by a 37 km field.
  - The mip is chosen from the footprint's long axis.
  - The streaks fade to the deck mean below muV 0.06–0.16 and beyond 15–45 km.
  - In the signature look the cirrus is a faint, blurred tonal drift.
  - The moiré, the venetian-blind stripes and the visible tiling are gone.
- **Sun disc (physical look):**
  - It is masked at the true sea horizon and dimmed by the decks.
  - It disappears under 60–80 % low cloud.
  - It is soft-limited rather than clipped, with an aureole.
- **Horizon mist:** the last 1° below the horizon melts into the horizon sky, so there is no hard sea band.
- **Aerial haze:** below the horizon, birds are hazed toward the darker hazed sea, never toward a brighter colour than what lies behind them.
- **Dusk:** a pink-orange afterglow fills the band 0–15° above the horizon on the sun's side, with a faint rose band opposite.
- **Grain and dither:** both are static (half the old grain), so the pale sky no longer fizzes.
- **Low quality:** full-resolution render, 2× MSAA and 6 m density cells.

**Ornitography**
- **Auto-framing when the shutter opens:**
  - One bird is seen from below at 55°, with its 0.4 s path framed and its wings at least 70 px.
  - Selections are framed to 60 % of the width.
  - All birds get a longer lens, so birds are at least 7 px.
- **Decay:** 0 for selections, 0.008 for all-birds plates.
- **'Layered (film stack)' blend:** the new default for all-birds plates. Each stamp multiplies the plate by a fraction of its darkness, so 30k birds build a graded graphite volume instead of a uniformly black slab. Selections keep the hard darken blend.
- **Auto selection:** auto-selected birds are spread over the flock instead of stacked into one rod.
- **1000 fps option:** at 1000 fps the single-bird ribbon has smooth wing fans instead of a sawtooth.

**Falcon**
- **Chase camera:** it sits behind and above the falcon on the line to its quarry, so the flock fills the frame.
- **Rendering:** the scan's albedo contrast is expanded, and the underwing gets some bounce light, so the barring, slate back and moustache read. Orientation was checked from top, bottom and side.

**Misc**
- An empty favicon (no 404 in the console).
- `tests/integration/final.js` regenerates every final capture.

### Performance (headless Chrome, ANGLE D3D11, RTX 3070, `node tests/integration/perf.js`)

Median GPU ms per frame:

| quality | birds | render | default | orbit-close | inside | falcon | ornito (+) |
|---|---|---|---|---|---|---|---|
| low | 10,240 | 1280×720, MSAA 2 | 0.50 | 0.61 | 1.53* | 0.46 | 1.26* |
| medium | 30,720 | 1600×900, MSAA 4 | 0.58 | 0.94 | 0.86 | 0.62 | 0.11 |
| high | 81,920 | 1600×900, MSAA 4 | 1.10 | 1.46 | 1.32 | 1.06 | 1.62 |

\* The low figures are inflated by GPU clock-down at idle load; they are not more expensive than medium.

- **Frame pacing:** rAF p95 is 16.9 ms (vsync) at every level, and CPU is about 0.6 ms per frame.
- **Console:** zero errors on every load, quality switch, look, camera and Ornitography run.
- **Arc estimate:** at the ×4.5–5 RTX-3070-to-Arc factor, medium is about 2.6–2.9 ms against the 10.5 ms budget.

### Final captures (`models/preview/final_*`)

| file | what | verdict |
|---|---|---|
| `final_watcher.png`, `final_watcher_ui.png` | The default: signature look, medium, watcher | Good. The sky matches the reference (centre rows 195–198 vs 190–198); crisp dark birds and a dark fold. |
| `final_watcher_vs_reference.png` | Side by side with the reference top panel | The sky tone matches. The vertical gradient is 1–5 codes here vs about 6 in the reference: the 24° lens spans fewer degrees of elevation. |
| `final_wide_dusk.png` | Dusk look, high (81,920 birds), wide view from the promenade, sun −3.7° | Good flock and sky. The sea in the lower third is a flat, dull brown. |
| `final_dusk_watcher.png` | Dusk look over clear sample weather, sun −4.6° | The best frame of the set: an afterglow band behind a flock with a dense dark head. |
| `final_agitation_wave.png` | Four stills 0.6 s apart after a falcon pass (watcher, high) | A dark band crosses the flock. It is legible, but it reads as a fold sweeping across rather than the crisp, fast ripple of the best real footage. |
| `final_falcon_strike.png` | Chase camera: stoop, strike, pull-out | Good. The flock opens around the falcon. |
| `final_ornito_all.png` | 150 frames at 240 fps, all birds, layered | Good. A tonal graphite volume with flow lines. The tail of the flock runs off the right edge (it is a longer-lens crop). |
| `final_ornito_one.png` | One bird, 400 frames at 1000 fps, from below | Clean, with smooth wing fans. The ribbon fills only about a third of the width, so the composition is sparse. |
| `final_murmuration.mp4` | 12 s, high quality: the default view, then a falcon pass at 5 s | Shows sheets folding, a dark band forming and the flock looping apart after the pass. |

### What remains

- **Arc iGPU:** still not measured on the target hardware. Re-run `node tests/integration/perf.js` on the Arc.
- **Flock outline:** at times the outline is a soft, rounded lump with a near-straight edge, rather than the crisp, pointed ribbons of the best murmurations. A further shape term (stronger flattening along the turn, edge-bird centrality) would help.
- **Agitated preset:**
  - It still produces the most jerk: p90 about 550 m/s³ in a window that caught a bank-pulse wave.
  - Its polarisation dips to 0.83–0.88 during waves; the target is ≥ 0.93 in normal flight.
- **Agitation waves from the ground:** they read as moving dark folds, not sharp ripples. Very dense regions are already saturated, so extra bank adds little contrast there.
- **Low quality:** 10,240 birds read lighter (sparser) than medium in the watcher view.
- **Physical look:** the reported vertical bright band (P5) did not reproduce with the new camera, so it was not specifically fixed.
- **Run-to-run variation:** live stepping follows wall-clock time, so runs are not frame-identical. `final.js` steps the sim deterministically after load, but the frames between load and the first step vary.
