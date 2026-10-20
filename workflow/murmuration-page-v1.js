export const meta = {
  name: 'murmuration-page-v1',
  description: 'Build the starling murmuration web page: GPU flock, real-sky weather backdrop, Xavi Bou trail mode, noise path controls; tail fix; review + fix',
  phases: [
    { title: 'Design', detail: 'SPEC.md contract (Opus high)' },
    { title: 'Build', detail: 'flock sim+render || sky+weather || Blender tail+assets || trail mode+UI (parallel, disjoint files)' },
    { title: 'Integrate', detail: 'wire, run, measure, screenshots (Opus high)' },
    { title: 'Review', detail: 'look+sky lens || murmuration behaviour+perf lens (report only)' },
    { title: 'Fix', detail: 'apply findings, final screenshots (Opus high)' },
  ],
}

const ROOT = (args && args.root) || 'C:/Users/noahs/OneDrive - Syracuse University/LA Studio/NOAHS EXPERIMENT/murmuration'
const BLENDER = (args && args.blender) || 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe'
const CTX = `PROJECT: a three.js web page of a STARLING MURMURATION at dusk, ROOT="${ROOT}". Read ROOT/LOOKTEST.md first: the bird assets are a low-poly European starling made from a CC0 museum scan (Virtual Museums of Małopolska, Tomek Natural Science Museum, inventory MP 314): ROOT/models/out/starling/starling_retro.glb (406 triangles, flat shaded, 1k atlas) and starling_real.glb (1,788 triangles, 2k atlas), with a 12-bone rig and a researched flap cycle (13.3 Hz, downstroke 57%, wrist-flexed upstroke), plus glide and bound poses. Blender scripts are in ROOT/blender/. The sibling projects ROOT/../monkey-school and "LA Studio/fish-school-real" have a working three.js r170 GPU flocking page (GPUComputationRenderer boids, instanced meshes with GPU bone tables, headless Chrome testing via CDP, node tools/serve.js); reuse ideas and code by COPYING into ROOT, and never edit those projects. Blender: "${BLENDER}". PREDATOR: a real museum PEREGRINE FALCON scan is downloaded at ROOT/models/raw/peregrine/scene.gltf (The Watt Institution, Inverclyde; CC-BY 4.0; about 1M triangles; a perched taxidermy mount with folded wings; two base-colour textures). Make the falcon from it with the same method as the starling in LOOKTEST.md: low-poly retro and realistic variants, a bake from the scan, and spread wings textured from its own feathers. A peregrine has a 0.95–1.1 m span, with long, pointed, broad-based wings, a dark slate-grey back, pale finely barred underparts and a black moustache. Its poses are powered flight (stiff, shallow beats at about 4–5 Hz), glide, and a STOOP with the wings tucked into a teardrop dive for attacks. Credit it as 'Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0'. Do not download anything except the Open-Meteo API calls the page makes at runtime. No API keys.
USER GOALS:
- A murmuration that behaves like the real thing (thousands of starlings).
- REAL SKY DATA for the backdrop: clouds, sun and wind from real weather at a real place and time.
- A XAVI BOU "Ornitographies" tracking mode. He layers 150–1,000 high-speed frames so each bird leaves a sculptural trace of its wingbeats; this is reference only, don't copy his images.
- NOISE INPUTS that randomise and change the flight paths.
- A retro low-poly look that stays tasteful, and as realistic as it can be within that.
SKY LOOK the user loves (CORRECTED by the user, so do NOT use the dusk panel): the TOP TWO panels of ROOT/models/preview/starling_v2_silhouette_flock.png, a BRIGHT OVERCAST sky. It's a pale, cool, very slightly blue-tinted light grey, nearly uniform (about #c4c5c6 at the top to #c0c1c2, with only a faint gradient and no strong horizon colour), soft and shadowless, with crisp DARK starling silhouettes that read graphically against it (like a pale paper sky). Make this the page's signature look and the default view. The real weather and sun still drive the sky (cloud texture and cover, wind, sun position), but grade toward this pale overcast palette: a soft, high-key, low-saturation, cool-grey colour grade, with clouds as subtle tonal variation in the grey rather than dramatic sunset colour. Offer toggles for 'signature (pale overcast)', 'physical' and 'dusk'. Check the default view side by side against those top panels.
QUALITY BAR: the user was very unhappy with a previous project whose screenshots "looked terrible". Be critical; the page must look beautiful and run efficiently (60 fps on MEDIUM on an Intel Arc iGPU; low, medium and high quality levels; measure). Every visual effect is gated per quality level and measured. Output index.html plus an assets/ folder (no artifact size cap needed).`

const RESULT = { type: 'object', properties: { files_changed: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' }, screenshots: { type: 'array', items: { type: 'string' } }, open_issues: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['files_changed', 'tests', 'ok', 'screenshots', 'open_issues', 'summary'] }

phase('Design')
// SPEC.md was already written (2026-10-19). Re-read and summarise it instead of redesigning.
const spec = await agent(`${CTX}
ROOT/SPEC.md already exists and is the contract. Do NOT rewrite it. Read it and return a 15-line summary of the key interfaces and decisions for the builders. If ROOT/SPEC.md is missing, write it per the project goals instead.`, { label: 'design:spec-summary', phase: 'Design', effort: 'medium' })

phase('Build')
const B = [
  { key: 'flock', files: 'src/flock.js, src/flock_shaders.js (and any new src/flock_*.js)', job: 'the GPU murmuration simulation (SPEC §1) and bird rendering (§2), with a standalone test page tests/flock_test.html that runs the flock with a plain gradient sky, so you can verify behaviour and perf headless before integration. Use the current GLBs in models/out/starling; the Blender builder may update them in parallel, and the asset format is in SPEC.', effort: 'high' },
  { key: 'sky', files: 'src/sky.js, src/sky_shaders.js, src/weather.js', job: 'the real-sky backdrop (SPEC §3): Open-Meteo fetch plus cache and fallback, sun position, atmosphere, layered clouds moving with the real wind, and the dusk palette. Include a standalone test page tests/sky_test.html, and render screenshots for 3 real sites or times (clear, broken cloud, overcast), each with the fetched weather values shown.', effort: 'high' },
  { key: 'blender', files: 'blender/*, models/out/*, assets/birds/*', job: 'the tail fix (SPEC §7), then export the bird assets in the SPEC format: the flap/glide/bound animation baked into textures for both meshes, impostor sprites for the far LOD, and the low-poly PEREGRINE FALCON built from the real museum scan (PREDATOR in the context: clean, orient, bake, spread wings from its own feathers; flight, glide and stoop poses). Show it in models/preview/falcon_*.png sheets. Verify with renders in models/preview/ (side tail before/after).', effort: 'medium' },
  { key: 'trails', files: 'src/trails.js, src/ui.js, template.html', job: 'the Xavi Bou Ornitography mode (SPEC §4), the noise controls (§5) and the UI (§6). Test trails with a synthetic animated silhouette source in tests/trails_test.html, making sure the result reads as layered chronophotography rather than motion blur.', effort: 'medium' },
]
const built = await parallel(B.map(b => () => agent(`${CTX}
Read ROOT/SPEC.md (designer summary: ${spec}). YOUR FILES ONLY: ${b.files}. Other builders are working in parallel on the other files, so do not edit them. NOTE: an earlier attempt at this step was paused part-way (2026-10-19), so some of your files may already exist (e.g. src/trails.js, src/ui.js, blender/s3_*/s4_bake.py outputs, models/preview/_s3_*). Inspect them and continue rather than starting over. Build ${b.job} Run your tests headless (Chrome or Edge via CDP; serve ROOT with a small node static server on a free port and stop it afterwards), and look at your screenshots critically with the Read tool. Iterate until they look good. Return the structured result.`, { label: `build:${b.key}`, phase: 'Build', schema: RESULT, effort: b.effort })))

phase('Integrate')
const integ = await agent(`${CTX}
Read ROOT/SPEC.md. The four builders reported:
${JSON.stringify(built, null, 1)}
YOUR JOB: write src/main.js and build.js (which outputs index.html plus assets/), wire everything per the SPEC, fix any interface mismatches in any file, and run it headless for each quality level. Measure fps and GPU ms and check for console errors. Capture screenshots into models/preview/page_*.png:
- the wide murmuration at dusk
- the watcher camera
- an agitation wave after a falcon pass
- the live weather readout
- an Ornitography result after about 300 frames, both all-birds and single-bird
- two noise presets
Look at every screenshot critically and fix anything ugly before reporting. Write ROOT/README.md: how to run, the controls, credits, and the data sources. Return the structured result.`, { label: 'integrate', phase: 'Integrate', schema: RESULT, effort: 'high' })

phase('Review')
const lenses = [
  { key: 'look', p: 'LOOK and SKY: does it look beautiful and believable? Judge the sky (atmosphere, clouds, sun, how they match the fetched weather), the starling silhouettes at distance and close up, the colour and tone, aliasing and flicker, and the Ornitography images (do they read like layered chronophotography?). Compare against your knowledge of real murmuration photography (e.g. dark flowing sheets against a pink-orange dusk sky). List concrete defects with fixes.' },
  { key: 'behaviour', p: 'MURMURATION BEHAVIOUR and PERF: does the flock move like a real murmuration (cohesive dense sheets, sudden density waves, smooth folding shapes, banking, no jitter, no explosions or collapse into a ball, plausible speed and scale, wind drift, a falcon escape wave)? Do the noise controls change paths meaningfully? Measure fps and frame times per quality, and check memory and console errors. List concrete defects with fixes.' },
]
const reviews = await parallel(lenses.map(l => () => agent(`${CTX}
Integration report: ${JSON.stringify(integ)}
You are a critical reviewer (${l.key}). ${l.p} Load ROOT/index.html headless (serve ROOT with a small node static server on a free port and stop it afterwards), capture fresh frames over time, and Read the screenshots. DO NOT edit project files; report only. Return a prioritised defect list: each with symptom, evidence (file or frame), likely cause, and a concrete fix.`, { label: `review:${l.key}`, phase: 'Review', effort: 'high' })))

phase('Fix')
const fix = await agent(`${CTX}
Reviewer findings:
${reviews.filter(Boolean).join('\n\n-----\n\n')}
Integration report: ${JSON.stringify(integ)}
YOUR JOB:
1. Fix the findings in priority order (any project file).
2. Rebuild, and re-verify headless per quality level.
3. Capture FINAL screenshots in models/preview/final_*.png: wide dusk murmuration, watcher view, agitation wave, ornitography all-birds, ornitography single-bird, plus a short screen recording if feasible.
4. Look at each one critically, and only call a screenshot final if it looks genuinely good; say plainly if something still doesn't.
5. Append a "status" section to README.md: what's done, the perf numbers, and what remains.
Return the structured result.`, { label: 'fix', phase: 'Fix', schema: RESULT, effort: 'high' })

return { spec, built, integ, reviews, fix }