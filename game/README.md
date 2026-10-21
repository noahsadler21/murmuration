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

- Every run is different: the flock's path, its altitude rhythm, its shape and folding, the timing of the sea runs and
  your place in the flock are all drawn from a fresh seed.

**Fish Frenzy** is the second game on the start screen: 90 seconds with the flock skimming the sea beside you and
flying fish leaping all around, alone, in pairs or as whole schools. Only the fish count. Catches within four seconds
chain (×2, ×3, ...); a splashdown or a collision breaks the chain. It is graded on fish caught.

Flights: **Calm** (strong flocking instinct, wide tube), **Flock**, **Storm** (gusts, tight tube, slow neighbours).

## Leaderboard

The results screen can show a shared top 10 for each game and flight, stored in a free Supabase project. It is
hidden until `game/leaderboard-config.js` holds the project URL and its public anon key. To set it up:

1. Create a free project at supabase.com.
2. In the SQL editor, run:
   ```sql
   create table scores (
     id bigint generated always as identity primary key,
     created_at timestamptz default now(),
     name text not null check (char_length(name) between 1 and 16),
     mode text not null check (mode in ('murm', 'fish')),
     diff text not null check (diff in ('calm', 'flock', 'storm')),
     score int not null check (score between 1 and 60000),
     fish int not null default 0 check (fish between 0 and 400),
     pct int not null default 0 check (pct between 0 and 100)
   );
   alter table scores enable row level security;
   create policy "read scores" on scores for select using (true);
   create policy "post scores" on scores for insert with check (true);
   ```
3. Copy the Project URL and the anon public key (Project Settings → API) into `game/leaderboard-config.js`,
   then commit and push.

Anyone can post through the public key (as with any key-free web game), so the table's checks cap names and scores
at plausible values; delete stray rows in the Supabase table editor.

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
`node game/tests/look.js` saves a look sheet, `node game/tests/hero.js` a close-up of your bird's wingbeat, `node game/tests/frenzy.js` a Fish Frenzy sheet; `node game/tests/shot.js "<query>" out.png "<js>"` one screenshot.

## How it works

- `flock.js`: a leader path steered by a manoeuvre scheduler (turn rate and response ramp up over the run, sea runs
  pull it down to the water). Each bird has a fixed place in the flock's frame and reads the path a little in the past,
  so a turn sweeps through the flock as a fold; the sheet also breathes, arches, undulates and twists, and agitation
  waves run across it. All of it is an analytic function of time, so the slot's future (the guide) is exact and the
  CPU knows every bird for collisions. Birds near you dodge at a limited speed; a hit bird becomes a rigid body.
- `wings.js`: each bird flies in flap / glide / bound bursts (Tobalske 1995), switching pose only at the point of the
  wingbeat that already matches the glide or bound pose (measured from the baked cycle at load, so rebaked assets keep
  working), sinking a little in bounds and glides. Birds bank from their own sideways acceleration and lift the nose
  in a glide. Your bird keeps beating under boost and folds its wings in a steep dive.
- Wing blur: extra wing-only draws a fraction of a wingbeat earlier and later act as a camera shutter (six samples on
  your bird, two on near birds), so the 13.3 Hz wingbeat reads as fluid instead of strobing at 60 fps.
- `birds.js` / `shaders.js`: the project's `murm-vat-1` starlings from `../assets/birds/` as instanced
  vertex-animation meshes (real scan close up for your bird, retro / silhouette / micro LODs for the flock, with the
  main page's min-pixel widening and screen-space dilation for far birds).
- `sea.js`: the open sea. A camera-centred radial grid displaced by eight Gerstner waves (a moderate wind sea), a
  tileable ripple normal map built at start-up from a wind-wave spectrum and sampled at four scales with mipmaps
  (so the far sea averages out instead of shimmering), Fresnel reflection of the overcast, light scattered through
  steep wave faces and sparse whitecaps where crests pinch. The same waves run on the CPU, so dunks, splashes and
  fish leaps sit on the real surface.
- `fish.js`, `fx.js`, `audio.js`: procedural low-poly flying fish, sea and sky, spray, rings, feathers, synthesized
  sound (no files).

Credits: starling scan by Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0. three.js (MIT),
0.170.0 from jsDelivr.

`node game/tools/snapshot.js [out.html]` freezes the current game, assets included, into one self-contained HTML file
(`game/snapshots/` is not committed).
