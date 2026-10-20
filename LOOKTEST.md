# Starling look test (single bird, no flock code yet)

Source: European starling, Virtual Museums of Malopolska / Tomek Natural Science Museum, inventory MP 314, CC0
(`models/raw/starling/`). It is a perched taxidermy mount on a branch, rod and wooden base: 328k triangles,
8192 px diffuse / normal / occlusion / specular-glossiness textures. The specimen is in winter plumage
(heavy white and buff spotting).

## Pipeline (all Blender 5.2, headless; scripts in `blender/`)

| step | script | what it does |
|---|---|---|
| 0 | `s0_inspect.py` | import, weld, components (bird + base plate), z-histogram (rod, branch), 4 raw views |
| 1 | `s1_clean.py` | delete base, rod, branch, legs and the leg stub, fill holes; level the body (PCA long axis was tilted 42.8 deg); straighten the head (yaw/pitch 39 deg about the neck, then roll 41 deg found by a mirror-symmetry fit in `diag_head_roll.py`); scale to 20.5 cm bill to tail |
| 2 | `s2_capture.py` | orthographic captures of both folded wings (albedo, tangent-frame normal incl. the scan's normal map, occlusion, spec) at 10.9 px/mm |
| 3 | `s3_build.py` | builds both low-poly birds (body loft, tail, spread wings, UVs) |
| 4 | `s4_bake.py -- real/retro` | Cycles selected-to-active bakes plus the wing composite, the texture-derived detail normal and the masks |
| 5 | `s5_rig.py` | joins the parts, spreads the tail, adds the 12-bone rig and weights, defines the poses, exports GLB |
| 6 | `s6_render.py -- compare/normals/poses/flock`, `compose_sheets.py` | renders and contact sheets |

`run_all.sh` reruns steps 3 to 5 and `render_all.sh compare poses normals flock` reruns step 6. Steps 0 to 2 only need to run once.

**Frame:** metres, head toward -Y, back toward +Z, bird's left wing +X and right wing -X (the same convention as the
monkey-school pipeline). The origin sits at the body centre, about at the wing root. The GLB export converts to glTF +Y-up.

## What was built

| | realistic low-poly | retro low-poly |
|---|---|---|
| triangles | **1,576** (body+tail 928, wings 648) | **312** (body+tail 200, wings 112) |
| vertices | 813 | 170 |
| body | 16-sided loft, 26 stations, smooth | 8-sided loft, 11 stations, flat-shaded |
| wings | 9 secondaries, 9 visible primaries (P8/P9 form the tip), coverts band, serrated trailing edge, closed two-sided shell | 3 arm strips, 4 hand strips, clean straight edges, two-sided |
| tail | 6 strips, square end with a slight notch, spread 1.45x | 3 strips |
| size | length 20.5 cm, span 39.0 cm | same |
| textures | 2048^2 atlas: albedo, normal (baked / baked+detail / detail only), mask | 1024^2 atlas (same layout) |
| rig | 12 bones: body, neck, head, tail, humerus/forearm/hand/primaries x2 | same rig |
| files | `models/out/starling/starling_real.glb` (8.5 MB with PNGs) | `starling_retro.glb` (1.4 MB) |

The mask texture holds R = AO (from the scan's occlusion map), G = glossiness and B = iridescence mask.

**Body.** For each station, rays are cast from a centreline onto the scan. The result is mirror-symmetrised. The
folded-wing bulge is trimmed off the flanks (3.5 mm). The neck has no waist, because flying starlings carry a short,
thick neck. The rump is tapered and lowered into the tail root, since the scan's rump is padded by the folded tertials
and crossed wingtips. The UVs are a cylindrical unwrap at 8.6 px/mm with the seam along the belly.

**Spread wings.** The scan's atlas is a photogrammetry patchwork of thousands of tiny islands, so mapping onto
"the folded wing's UV island" was not possible. I used projection from the re-posed scan instead:

1. Capture the folded wing orthographically.
2. Give every feather strip of the spread wing its own UV strip in that capture:
   - the feather's length runs along the visible primary or secondary fringes, with the tip at the capture's feather tips;
   - the coverts zone (leading 42 % of chord) maps to the spotted covert/scapular patch at native scale.

The normal channel is captured in the same frame. The folded wing's own curvature is removed with a high-pass, so
only the feather relief remains.

The underwing is derived from the same capture, with no AI. It is grey-brown (sRGB about 103/94/86) and keeps the
dorsal feather structure as low-contrast luminance detail, without buff fringes or white spots.

## Answer to "could we extract normals from the real textures?"

Yes, and it is built: `starling_real_normal_texonly.png` holds the texture-derived normal on its own, and
`starling_real_normal_detail.png` holds it combined with the baked normal. The recipe:

1. Perceptual luminance of the baked albedo.
2. Masked high-pass with sigma about 0.6 mm.
3. tanh soft-clip, so the white spot tips read as raised scale tips, not spikes.
4. Height to normal (strength 6).
5. RNM blend onto the baked normal, which comes from the scan geometry plus the scan's own normal map.

The measurements are below. The pixel numbers are mean |difference| on the bird's pixels, 0-255 sRGB, with Cycles
and a dusk sun. The noise floor is the same image (iii) rendered with a second sampling seed. All values are in
`starling_normals_compare.png`.

| bird span on screen | (i) albedo to (ii) baked | (ii) to (iii) + detail | render noise floor |
|---|---|---|---|
| 400 px | 2.1 | 0.9 | 1.0 |
| 80 px | 1.9 | 0.8 | 1.7 |
| 20 px | 2.0 | 1.0 | 3.3 |

**Honest reading:**
- **Close range (bird about 900 px or more):** the **baked normal clearly helps**. The wing gets real feather relief,
  the back gets the scan's lumps and the head gets its shape (rows 1-2 of the sheet). The **texture-derived detail
  adds a fine grain**: it is visible at grazing light but subtle, and it does not change the read.
- **400 px:** the baked normal is still slightly visible (2.1 against a floor of 1.0). The derived detail is at the noise floor.
- **80 px and 20 px, the real murmuration range:** **neither normal map is meaningfully visible.** The difference sits
  at or under the render-noise floor. At these sizes what matters is the silhouette, the flap pose, the albedo's
  overall darkness and the sheen.
- **Gloss and iridescence from `specularGlossiness`: it carries no independent information.** On the raw 2k texture,
  spec level = 1.145 x diffuse luminance (r = 0.991). Glossiness is a constant 178/255, apart from a few blobs. Both
  were baked as required, but the iridescence mask (B channel) had to be derived from the albedo instead: dark,
  low-saturation body feathers count as iridescent, and the flight feathers are damped. It drives a thin-film layer
  (about 480 nm, IOR 1.55) and lower roughness. That is a stand-in, not measured data.
- The scan's own normal map changes the baked normal only slightly (mean |dN| 0.012 per component). Almost all of
  the baked relief comes from the scan geometry.

**What pushes realism most, in order:**
1. The real albedo from the scan (spots, buff fringes, the correct near-black ground colour).
2. A correct silhouette and wing planform with a believable flap pose.
3. The wing feather texture laid along the feather direction.
4. AO and sheen.
5. The baked normal, which matters only up close.

The texture-derived detail normal is last; I would ship it only on the near-camera LOD, or not at all.

## Honest weaknesses

- **Flank texture is folded-wing texture.** The scan has no flank under its folded wings, so the low-poly flanks
  carry the wing's brown, buff-edged feathers instead of spotted flank feathers (visible in the side view). A fix
  would be to re-project the breast pattern onto the flank band.
- **Tail texture is partly the crossed wingtips.** The scan's tail is covered by the primaries. The tail's baked
  normal is flattened for this reason, and the tail texture is stretched about 1.45x laterally by the spread.
- **Wing texture is re-sampled, not unique per feather.** Each feather strip reuses one of two template bands (with
  per-feather offsets). At close range the repetition is visible, and the trailing-edge feather tips form a regular
  dark saw-tooth band. Fine at 400 px and below, a bit "designed" up close.
- **Wing to body junction** is a plain intersection with no blend shape. A seam is visible at close range, and the
  wing root can open a gap at extreme upstroke angles.
- **Body proportions** follow the taxidermy mount, which is fluffed. The belly is a little deep for a sleek flying
  starling. The head has a slight dome where a real starling's crown is flatter.
- **The upstroke** is a single hand-set flexed pose. The side view shows it as a fairly large raised sail. It needs
  reference footage (starling flight video) before animation.
- **The glide and downstroke poses differ only modestly from the top.** That is enough to judge the silhouette, but
  they are not tuned.
- The underwing is plausible but invented from the dorsal pattern; it is not a scan.
- There is no eye highlight. The scan's eye is dark-on-dark and the bill is dark (winter), so the head reads as a dark wedge.
- The dusk sky is a simple gradient world, not a physical sky.

## Silhouette and flock read

`starling_silhouette_flock_test.png` shows 200 instanced retro birds:
- 10 baked flap phases plus 15 % gliding;
- random headings around one flow direction and random bank;
- a bright overcast dome over dark ground;
- an observer about 30 m below and across.

The pointed triangular wing, short tail and wedge head read clearly as starlings at 10-30 px. The mix of flap phases
gives the right flicker of shapes. The retro mesh is fully adequate at this distance.

## Recommendations for the flock (estimates, not yet measured in three.js)

- **Do not skin per instance.** Bake the flap cycle into a vertex-animation texture (VAT) or morph targets:
  - 16-24 frames;
  - positions plus normals;
  - retro: 170 verts x 24 frames, a tiny texture;
  - real: 813 x 24.

  Then draw each LOD as one `InstancedMesh`. Per-instance attributes are position, orientation, phase and flap-rate.
  The vertex shader interpolates the frames. The rig in `s5_rig.py` (`cycle_pose`) is the source for those frames.
- **LODs, by on-screen wingspan:**

  | LOD | mesh | textures | when |
  |---|---|---|---|
  | LOD0 | realistic 1.6k tris | 2k albedo + baked normal + mask (detail normal optional) | above about 150 px; a few dozen birds at most |
  | LOD1 | retro 312 tris | 512-1k albedo, no normal map | about 25-150 px |
  | LOD2 | a 40-80 tri silhouette bird (to build next: body wedge + 2 wing triangles + tail) | flat colour | about 6-25 px |
  | LOD3 | camera-facing quad or point sprite with a few pose frames in an atlas | | below about 6 px |

- **Birds per quality level (laptop RTX-class GPU; rough):**

  | quality | flock size | LOD0 near birds | approx. triangles/frame |
  |---|---|---|---|
  | low | 2-3k | none, LOD1/2 only | under 1M |
  | medium | about 10k | about 20 | 2-3M |
  | high | 30-50k | about 50 | 5-8M |

  Measure all of these in the real page before committing.
- **Shading budget:** at murmuration distances, spend effort on silhouette, flap timing, motion blur and sky colour,
  not on normal maps. Keep the sheen and darkness of the albedo. The thin-film iridescence only matters for close fly-bys.

## Files

**Previews** (`models/preview/`):

| file | contents |
|---|---|
| `starling_scan_views.png` | raw scan from 4 views, then the cleaned and re-posed scan from 4 views |
| `starling_lowpoly_compare.png` | scan vs realistic vs retro, same cameras, dusk light |
| `starling_normals_compare.png` | (i)/(ii)/(iii) close up and at 400/80/20 px, with the measurements |
| `starling_flight_poses.png` | upstroke, downstroke and glide x top/side/front x both variants |
| `starling_silhouette_flock_test.png` | the flock test: overcast, a native-pixel crop, and dusk |

The underscore files there are diagnostics; `_atlas_real.png` is the texture atlas.

**Outputs** (`models/out/starling/`):
- `starling_{real,retro}.glb`
- `starling_{real,retro}_albedo.png`
- `_normal_baked.png`, `_normal_detail.png`, `_normal_texonly.png`, `_mask.png` (same `real`/`retro` prefix)

**Intermediates** (`models/blend/`): `s0_scan_raw.blend`, `s1_scan_oriented.blend` (the cleaned scan),
`s3_lowpoly.blend`, `s5_rigged.blend`, and the `cap_*` captures.


---

# v2: second look test (tail, wing root and profile, flap cycle)

The v1 files are kept for comparison. Their outputs are in `models/out/starling/v1/`, their blends in
`models/blend/v1/` and their scripts in `blender/v1/`. The v2 renders are the `starling_v2_*` files in
`models/preview/`.

## What changed

| | v1 | v2 |
|---|---|---|
| realistic tris | 1,576 | **1,788** (body+tail 956, wings 832) |
| retro tris | 312 | **406** (body+tail 214, wings 192) |
| tail | thin two-sided fan, baked from the scan (its top was really the crossed wingtips), spread 1.45x after the bake | **closed wedge with thickness**: stacked rectrices on top, undertail coverts below, side and end walls. 5.8 cm from root to tip (about 4.7 cm showing behind the rump). Fanned from 1.7 to 4.0 cm, square end with a 2.2 mm central notch, 10.4 mm thick at the root and 3.5 mm at the tip |
| tail texture | ray bake | **the scan's own tail feathers**: new top and bottom orthographic captures (`s2b_tail_capture.py`, 20 px/mm). Top: the part of the dorsal tail behind the crossed wingtips. Bottom: undertail coverts plus rectrix undersides. Mapped per rectrix strip, along the feather; the normals come from the same captures with a high-pass |
| wing root | a separate shell intersecting the body, visible seam | **fairing strip**: rib 0 is ray-projected onto the body surface on the upper flank (shoulder at z +13 mm). The strip from rib 0 to rib 1 (10 mm) uses the body's own texture (nearest-point UVs) and, on the realistic bird, custom normals that blend from the body normal to the wing normal by 16 mm. It is skinned 100 % body at rib 0 and 100 % humerus at rib 1, so it stretches like skin when flapping |
| wing section | flat plate with a linear bump | **cambered airfoil**: NACA-style thickness (up to 6 mm at the arm, under 1 mm at the hand), camber 2.6 mm at the root, rounded leading-edge row at 6 % of chord, thin feathered trailing edge |
| glide | humerus +8 deg, hand +2 deg (read as a fin in side view) | humerus **+5 deg**, hand **-6 deg**, primaries -2 deg: nearly flat with slightly lowered hands |
| poses | 3 hand-set poses, smoothstep between 4 keys (stops at each key) | **6-key cycle** (top 0, mid-down 0.28, bottom 0.57, early-up 0.68, mid-up 0.80, late-up 0.91), with **downstroke = 57 %** of the cycle. A periodic non-uniform Catmull-Rom spline, so there are no stops. Separate **glide** and **bound** (partly folded) poses |

Upstroke: the wrist flexes, the hand sweeps up to 100 deg back toward the body and supinates (LE up), the primaries
rotate up to -28 deg, and the hand trails below the wrist as the wrist leads. Downstroke: the wing is extended and
swept about 10 deg forward, the arm pronates 10 deg, and the primaries bend up 6-7 deg under load. The stroke runs
from +48 deg (top) to -40 deg (bottom). At a 19 cm semi-span that is a tip excursion of about 26 cm, which matches
the measured 28 cm.

## Sources

- **Ben-Gida et al. 2013**, *Estimation of unsteady aerodynamics in the wake of a freely flying European starling*,
  PLOS ONE 8(11): e80086 ([journal](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0080086),
  [arXiv](https://arxiv.org/abs/1306.0146)). A starling at 12 m/s: wingbeat **13.3 Hz**, max span **38.2 cm**,
  mean chord 6 cm, AR 6.4, peak-to-peak **wingtip amplitude 28 cm**, St 0.30. The 39 cm span, the cycle amplitude
  and the 13.3 Hz in `s5_rig.py` come from here.
- **Tobalske 1995**, *Neuromuscular control and kinematics of intermittent flight in the European starling*,
  J. Exp. Biol. 198: 1259 ([JEB](https://cob.silverchair.com/jeb/article/198/6/1259/6940/Neuromuscular-control-and-kinematics-of)).
  Starlings alternate flapping and non-flapping phases at every speed from 8 to 18 m/s. Glides are the most common
  non-flapping posture; bounds increase with speed; wingbeat frequency rises with speed. Hence the 70 / 20 / 10 %
  flap / glide / bound mix in the flock test.
- **Rayner, Viscardi, Ward and Speakman 2001**, *Aerodynamics and energetics of intermittent flight in birds*,
  Am. Zool. 41: 188 ([BioOne](https://bioone.org/journals/american-zoologist/volume-41/issue-2/0003-1569(2001)041[0188:AAEOIF]2.0.CO;2/Aerodynamics-and-Energetics-of-Intermittent-Flight-in-Birds1/10.1668/0003-1569(2001)041[0188:AAEOIF]2.0.CO;2.full)).
  Bounds are flexed wings held against the body, glides are on spread wings, and a starling's speed varies about
  +/-1 m/s over a flap-glide cycle.
- **Muijres et al. 2012**, pied flycatcher wind-tunnel PIV, J. R. Soc. Interface
  ([Lund](https://portal.research.lu.se/en/publications/leading-edge-vortex-in-a-slow-flying-passerine/)).
  In the passerine "feathered upstroke" the wing is retracted close to the body and the primaries are spread.
- **Kirchhefer, Kopp and Gurka**, starling wake studies
  ([BGU](https://cris.bgu.ac.il/en/publications/the-near-wake-of-a-freely-flying-european-starling-2/)).
  They found no downwash during the upstroke, which suggests an aerodynamically inactive, flexed upstroke.
- **Ward et al. 2001**, J. Exp. Biol. 204: 3311. In starlings, downstroke ratio and stroke-plane angle matter more
  for power than frequency or amplitude.

I could not get the tables from Ward or Tobalske (the JEB pages returned 403), so **no measured starling downstroke
ratio was available**. The 57 % downstroke is a choice inside the requested 55-60 %, not a measured value.

## Remaining weaknesses (v2)

- **Primaries are not individually slotted.** The hand is one continuous shell; separate feathers would tear the
  shared ribs. "Slotting" is approximated by hand supination, primaries rotation and sweep. At 20-80 px this is
  invisible; up close it reads as a rotated hand, not separated feathers. Fixing it would mean splitting P6-P9 into
  separate strips with their own bones.
- **The tail in side view is still a fairly long tapered wedge** rather than a blunt block, because the undertail
  coverts taper toward the tip. It is far better than the v1 spike, but a real tail looks a touch blunter.
- **The tail texture is stretched about 2x along its length.** Only about 2.5 cm of the scan's dorsal tail is
  uncovered by wingtips, so the rectrix pattern is extrapolated across the 5.8 cm tail. Rectrices are fairly
  uniform, so it reads correctly, but the buff fringes are a little long.
- **The fairing is a stretch strip, not a corrective shape.** At the top of stroke and in the bound, the strip
  stretches and its body texture smears slightly. No corrective blend shapes yet.
- **The near-wing top surface** reads as a thin pale plate above the back in a slightly-above side view (grazing
  light on the buff fringes). This is correct geometry, but it is the brightest part of the side silhouette.
- **The flexed upstroke and the bound are hand-set** from the qualitative descriptions above, not traced from
  starling video frames. The upstroke's hand trails below the body in the side view; that is plausible
  (the wrist leads), but it is unverified against footage.
- **Everything from v1 still applies**: flank texture is folded-wing texture, wing feather textures are re-used
  templates, and the iridescence mask is derived, not measured.

## v2 files

**Previews** (`models/preview/`):

| file | contents |
|---|---|
| `starling_v2_compare.png` | v1 vs v2, realistic and retro, glide, from side, top, below, front and 3/4 |
| `starling_v2_flap_cycle.png` | 8 cycle phases from side and front for both variants, plus glide and bound (incl. top) |
| `starling_v2_silhouette_flock.png` | the 200-bird test with the v2 cycle plus glide and bound states |
| `starling_v2_flap.mp4` | 96 frames at 24 fps: three wingbeats at about 13x slow motion, then a blend into the glide, both variants |

The `_tiles_v2/` folder holds the render tiles.

**Scripts** (`blender/`): `s2b_tail_capture.py` (new), `s7_v2_render.py` and `compose_v2.py` (new). `s3_build.py`,
`s4_bake.py` and `s5_rig.py` are updated in place, with v1 copies in `blender/v1/`.

**Outputs:** `starling_{real,retro}.glb` and the textures in `models/out/starling/` are now v2.
