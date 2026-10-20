# One Bird

A browser game made from the murmuration page's look and starling assets: you are one starling inside a murmuration
of 4,000 (1,600 on phones), flying over a grey-blue sea under a bright overcast sky.

- **Hold your place.** The flock sweeps, folds and sends waves through itself; your bird has a slot in it. The orange
  rings and dots show your slot's path for the next two seconds, and an orange ghost bird appears where you should be
  when you stray. The live **in line %** is the share of time you spend inside the tolerance tube around the slot,
  weighted by how well your heading matches the flock's flow.
- **Don't touch your neighbours.** They make room for a smooth flyer but can't dodge a barging one. A bird you hit
  tumbles out of the sky in a burst of feathers and falls into the sea (−120). Later in the run some neighbours drift
  back through your lane.
- **Flying fish.** On the four sea runs the flock skims the water. A dark shape under the surface means a fish is about
  to leap; dive and grab it in the air (+100, chained catches multiply). Every dive costs you in-line time.
- Two minutes per run, getting harder as it goes (tighter, faster turns, more waves). At the end you get a grade
  (S–D, from in-line % minus collisions), your score and a second-by-second chart of the run.

Flights: **Calm** (strong flocking instinct, wide tube), **Flock**, **Storm** (gusts, tight tube, slow neighbours).

## Controls

| | Desktop | Touch |
|---|---|---|
| Steer | mouse (offset from centre), or WASD / arrows | drag anywhere |
| Boost | Space / Shift / left click | Boost button |
| Ease off | Q / right click | |
| Pause / sound | Esc, M | |

## Run it

```
node tools/serve.js 8765
```
then open http://localhost:8765/game/index.html (`?q=high` for 7,000 birds, `?q=low` for 1,600, `?birds=N`).

## Tests

```
node game/tests/run.js
```
loads the page in headless Chrome/Edge and plays scripted runs: a bot that follows the guide (high in-line %), no
input (poor grade), a bot that rams its neighbours (collisions, falling birds), a fish-diving bot, real keyboard
events, the countdown and the HUD. Results go to `game/tests/results.json`, screenshots to `captures/`.
`node game/tests/look.js` saves a look sheet; `node game/tests/shot.js "<query>" out.png "<js>"` one screenshot.

## How it works

- `flock.js`: a leader path steered by a manoeuvre scheduler (turn rate and response ramp up over the run, sea runs
  pull it down to the water). Each bird has a fixed place in the flock's frame and reads the path a little in the past,
  so a turn sweeps through the flock as a fold; the sheet also breathes, arches, undulates and twists, and agitation
  waves run across it. All of it is an analytic function of time, so the slot's future (the guide) is exact and the
  CPU knows every bird for collisions. Birds near you dodge at a limited speed; a hit bird becomes a rigid body.
- `birds.js` / `shaders.js`: the project's `murm-vat-1` starlings from `../assets/birds/` as instanced
  vertex-animation meshes (real scan close up for your bird, retro / silhouette / micro LODs for the flock, with the
  main page's min-pixel widening and screen-space dilation for far birds).
- `fish.js`, `fx.js`, `audio.js`: procedural low-poly flying fish, sea and sky, spray, rings, feathers, synthesized
  sound (no files).

Credits: starling scan by Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0. three.js (MIT),
0.170.0 from jsDelivr.
