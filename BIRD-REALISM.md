# Bird realism pass: brief (run on the remote desktop)

Written on 2026-10-20. The user asked to "push the realism on the birds, their flight movements, wing movements and texture", and to use fewer birds. The fewer-birds part is DONE: commit 3a1bf8c set about 4k birds on medium, 2k on low and 8k on high. The real model now draws out to 36 px. The silhouettes are darker, with less haze and less min-pixel fade in the signature and dusk looks.

**Rule:** prove it on ONE bird first. Render the look test, send it to the user, and wait for a yes before rebaking the flock assets. Review every render critically before sending it; the user rejected weak images on the monkey project.

## Problems found (orbit close-up plus `models/preview/starling_v2_flap_cycle.png`)

1. **Wing planform is wrong.** The wings are long and swept, like a gull or falcon. A starling's wing is short, broad at the base and triangular, with a pointed tip, a fairly straight leading edge and a visible wrist. Close up the birds read as crumpled origami. Rebuild it from measured starling outlines: span 37–42 cm, wing chord at the wrist about 7–8 cm, aspect ratio about 6, tip formed by P8–P9. Use published planform figures as measurements only, never as textures.
2. **Grey plate on the back.** The scan's folded-wing surface shows as an untextured grey band in side view (s3 low-poly, the v3 tail sheet). Hide it or re-UV it to the body texture.
3. **Wing texture is one tiled feather patch.** It needs distinct primaries, secondaries and coverts with buff tips, the pale spotting of winter plumage, and a darker, glossier underwing. Build all of it from the scan's own albedo: bake and project; no photos as textures, no ComfyUI conditioning on reference photos.
4. **Wingbeat.** The mid-upstroke is over-flexed and collapses into a crumpled tent shape in front view. Rework the 32-row VAT cycle:
   - **Downstroke:** a fully extended, swept-forward downstroke.
   - **Upstroke:** a wrist-flex upstroke with the hand pulled in, but still readable as a wing.
   - **Variants:** add 3–4 per-bird variants for amplitude and timing.
   - **Rows 32 and 33:** keep row 32 as the glide pose and row 33 as the bound pose (wings tucked).
   - **Rate:** keep 13.3 Hz (Ben-Gida 2013) in flap-glide-bound bursts (Tobalske 1995).
5. **Flight motion** (`src/flock_shaders.js` vertex stage and the sim):
   - **Bobbing:** a small vertical bob locked to the flap phase and the bursts.
   - **Banking:** a sharper roll in turns; `maxBankDeg` is already 65.
   - **Pitch:** a slight pitch change between flap and glide.
   - **Wingbeat:** per-bird variation in wingbeat rate.

## Pipeline

- **Blender scripts:** `blender/s3_build.py` (the low-poly build), `s4_bake.py`, `s5_rig.py`, `s8_vat.py` (the VAT export, 34 rows) and `s9_impostor.py`.
- **Source data:** the raw scan is in `models/raw/starling` (CC0, Małopolska MP 314). It syncs via OneDrive and is not in git.
- **Runtime:** it reads `assets/birds/starling_{real,retro,sil,micro}.{json,bin}` and the textures (`src/flock.js`, `loadVat`).
- **Build:** `node build.js` copies src to assets/js and rewrites index.html.
- **Serve:** `node tools/serve.js 8765`, then open http://localhost:8765/index.html?q=medium. The orbit camera with a scroll zoom shows close birds.

## Look test deliverable

Send the user one sheet, `models/preview/starling_v4_looktest.png`:
- **Strips:** side, top and front strips of the v4 flap cycle.
- **Comparison:** v2 versus v4 at the same scale.
- **Hero render:** a close bird on the pale overcast background.

Also send a 3 s clip, `starling_v4_flap.mp4`. Only after the user approves: rebake all LODs and the impostor, run `node build.js`, check 60 fps on medium, commit, and push. GitHub Pages then updates https://noahsadler21.github.io/murmuration/ on its own.
