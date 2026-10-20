# Murmuration: handoff to another machine

**2026-10-20, NEXT:** the page is built and live at https://noahsadler21.github.io/murmuration/ (repo github.com/noahsadler21/murmuration). The next job is the bird realism pass in `BIRD-REALISM.md`: a one-bird look test first. On the remote desktop, say *"Do the bird realism look test per BIRD-REALISM.md."* The status table below is from the 10-19 pause and is out of date.

Paused on 2026-10-19 at about 17:15. The user freed the GPU and wants to continue on their remote desktop. This folder is in OneDrive, so it syncs on its own. Wait for the sync to finish before starting (SPEC.md, src/, blender/, models/ and workflow/ should all be present).

## Where it stands

| Step | State |
|---|---|
| Look tests v1 and v2 (single starling) | Done; see LOOKTEST.md and models/preview/starling_v2_*.png |
| Design | Done: `SPEC.md` (60 KB contract) |
| Build: trails and UI | Partly done: `src/trails.js` and `src/ui.js` are drafted; tests not finished |
| Build: Blender | Partly done: the tail fix and asset bake were in progress (`blender/s3_*`, `s4_bake.py`, `models/preview/_s3_*`); the peregrine falcon was not started |
| Build: flock | Started; little or nothing on disk yet |
| Build: sky and weather | Started; little or nothing on disk yet |
| Integrate, review, fix | Not started |

## Look decisions (the user's)

- **Signature sky:** the BRIGHT OVERCAST top panels of `models/preview/starling_v2_silhouette_flock.png`. It's a pale, cool, very slightly blue-grey (about #c4c5c6 to #c0c1c2), nearly uniform, with crisp dark starling silhouettes. It is not the dusk panel. Real weather still drives the clouds, cover, wind and sun underneath, with toggles for signature, physical and dusk.
- **Birds:** retro low-poly starlings from the CC0 museum scan (`models/out/starling/`), with the realistic variant near the camera.
- **Predator:** a real peregrine falcon from the Watt Institution scan (`models/raw/peregrine/`, CC-BY 4.0). It needs flight, glide and stoop poses.
- **Ornitography (Xavi Bou) mode:** layered per-frame silhouettes, never motion blur, with PNG export.
- **Noise controls:** curl noise, turbulence, wander, seed, gusts, and presets.
- **Quality bar:** it must look genuinely good. Review screenshots critically before calling anything done, and keep 60 fps on medium.
- **Deliverable:** the user wants a LINK when done: a local `index.html` (serve the folder) and, if feasible, a published artifact.

## How to resume on the remote desktop

1. **Install the tools:** Blender 5.x, Node, and Chrome or Edge, for headless tests. ComfyUI is not needed.
2. **Open Claude Code** in this folder and say: *"Resume the murmuration build per HANDOFF.md."*
3. **Run the workflow:** Claude runs `workflow/murmuration-page-v1.js` with the Workflow tool, passing args for this machine's paths:
   ```
   Workflow({ scriptPath: "<this folder>/workflow/murmuration-page-v1.js",
              args: { root: "<this folder, forward slashes>", blender: "<path to blender.exe>" } })
   ```
   The design step only re-reads `SPEC.md`. The builders are told to continue from the files already here.
4. **Model choice:** the agents run on Opus (high effort for flock, sky, integrate and fix; medium for Blender and trails).
5. **When it finishes:** serve the folder (`node tools/serve.js 8765`, or any static server) and open `http://localhost:8765/index.html`.

## Credits to keep in the page

- Starling scan: Virtual Museums of Małopolska (Tomek Natural Science Museum, MP 314), CC0.
- Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0.
- Weather data by Open-Meteo.com (CC-BY 4.0).
- three.js (MIT).
