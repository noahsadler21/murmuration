// Headless gameplay test:  node game/tests/run.js
// Serves the repo, loads game/index.html in headless Chrome/Edge and drives full runs with scripted input:
//   lane   a bot that follows the guide       → high in-line %, few or no collisions
//   idle   no input at all                    → a poor grade (the flock leaves you behind)
//   ram    a bot that flies at its neighbours → collisions, birds knocked out of the sky and into the sea
//   fish   a bot that dives at flying fish    → fish caught, at a cost in in-line %
//   keys   real keyboard events via CDP       → the input path works end to end
// Writes game/tests/results.json and screenshots to captures/.
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp.js');

const checks = [];
const check = (name, ok, info) => { checks.push({ name, ok: !!ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`); };

(async () => {
  const s = await open({ width: 1280, height: 720, dsf: 1.25 });
  const out = {};
  try {
    await s.nav('game/index.html?test=1');
    await sleep(1500);
    check('title screen shows', await s.evalp(`game.G.mode === 'title' && !document.getElementById('title').classList.contains('hidden')`), {});

    // lane bot, full run
    let r = JSON.parse(await s.evalp(`game.start({seed: 21, diff: 'flock', skipIntro: true}); game.bot('lane'); JSON.stringify(game.advance(${125}))`));
    out.lane = r;
    check('lane bot finishes the run', r.mode === 'end' && r.result, r.result);
    check('lane bot is in line > 85 %', r.pathPct > 85, { pathPct: r.pathPct });
    check('lane bot has ≤ 2 collisions', r.collisions <= 2, { collisions: r.collisions });
    await s.evalp('game.G.manual = true; game.render(); 1'); await s.shot('game_results.png'); await s.evalp('game.G.manual = false; 1');
    check('results screen shows a grade', await s.evalp(`!document.getElementById('results').classList.contains('hidden') && document.getElementById('rGrade').textContent.length === 1`),
      { grade: await s.evalp(`document.getElementById('rGrade').textContent`) });

    // idle: no input
    r = JSON.parse(await s.evalp(`game.start({seed: 21, diff: 'flock', skipIntro: true}); game.bot(null); game.input.override = {sx: 0, sy: 0}; JSON.stringify(game.advance(125))`));
    out.idle = r;
    check('idle player grades poorly (< 70 %)', r.pathPct < 70, { pathPct: r.pathPct, grade: r.result && r.result.grade });

    // ram bot: collisions and falling birds
    r = JSON.parse(await s.evalp(`game.input.override = null; game.start({seed: 23, diff: 'flock', skipIntro: true}); game.bot('ram'); JSON.stringify(game.advance(14))`));
    out.ram = r;
    // neighbours dodge well, so a ramming bot lands about one hit per 14 s (seed to seed); one is enough to prove it
    check('ram bot collides', r.collisions >= 1, { collisions: r.collisions });
    check('hit birds fall (falling or already in the sea)', r.falling + r.lost >= 1, { falling: r.falling, lost: r.lost });
    check('knocking birds out scores points', r.score >= r.collisions * 75 && r.collisions > 0, { score: r.score, collisions: r.collisions });
    await s.evalp('game.bot(null); game.input.override = {sx: 0, sy: 0}; game.advance(0.6); game.G.manual = true; game.render(); 1'); await s.shot('game_ram.png'); await s.evalp('game.G.manual = false; 1');
    r = JSON.parse(await s.evalp(`JSON.stringify(game.advance(6))`));
    check('falling birds reach the sea and leave the flock', r.lost >= 1, { lost: r.lost, falling: r.falling });

    // fish bot
    r = JSON.parse(await s.evalp(`game.input.override = null; game.start({seed: 23, diff: 'flock', skipIntro: true}); game.bot('fish'); JSON.stringify(game.advance(125))`));
    out.fish = r;
    check('fish bot catches flying fish', r.fish >= 3, { fish: r.fish, spawned: r.fishSpawned });
    check('chasing fish costs in-line %', r.pathPct < out.lane.pathPct, { fishBot: r.pathPct, laneBot: out.lane.pathPct });

    // keyboard input end to end (CDP key events): hold right arrow, the bird turns right
    await s.evalp(`game.input.override = null; game.bot(null); game.start({seed: 24, diff: 'storm', skipIntro: true}); game.advance(1); 1`);
    const yaw0 = await s.evalp('game.G.player.yaw');
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await s.evalp('game.advance(0.8); 1');
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
    const yaw1 = await s.evalp('game.G.player.yaw');
    check('ArrowRight turns the bird right (yaw decreases)', yaw1 < yaw0 - 0.3, { yaw0, yaw1 });

    // intro countdown and live HUD
    await s.evalp(`game.start({seed: 25, diff: 'calm'}); 1`);
    await sleep(1200);
    check('intro countdown shows', await s.evalp(`game.G.mode === 'intro' && !document.getElementById('count').classList.contains('hidden')`), {});
    await sleep(2600);
    check('play starts after the countdown', await s.evalp(`game.G.mode === 'play'`), {});
    check('HUD shows a live %', await s.evalp(`/^\\d+$/.test(document.getElementById('pct').textContent)`), { pct: await s.evalp(`document.getElementById('pct').textContent`) });

    // frame rate (headless GPU; indicative only)
    await s.evalp(`game.bot('lane'); 1`);
    await sleep(3000);
    out.fps = (await s.evalp('JSON.stringify(game.stats())'));
    console.log('fps sample', out.fps);

    // Fish Frenzy: 90 s of fish only, graded on the catch
    r = JSON.parse(await s.evalp(`game.input.override = null; game.start({seed: 26, mode: 'fish', diff: 'flock', skipIntro: true}); game.bot('fish'); JSON.stringify(game.advance(95))`));
    out.frenzy = r;
    check('Fish Frenzy runs 90 s and ends', r.mode === 'end' && Math.abs(r.t - 90) < 0.5, { t: r.t });
    check('Fish Frenzy: lots of fish leap and the bot catches some', r.fishSpawned > 120 && r.fish >= 5, { leapt: r.fishSpawned, caught: r.fish, grade: r.result && r.result.grade });
    check('Fish Frenzy results screen', await s.evalp(`document.getElementById('rTitle').textContent === 'Fish Frenzy over' && /of/.test(document.getElementById('rPct').textContent)`),
      { pct: await s.evalp(`document.getElementById('rPct').textContent`) });
    await s.evalp(`game.G.gameMode = 'murm'; 1`);

    // Sky Brawl: rivals fight, knockouts happen, the run ends with a placing
    r = JSON.parse(await s.evalp(`game.input.override = null; game.start({seed: 27, mode: 'brawl', diff: 'flock', skipIntro: true}); game.bot('brawl'); game.advance(40);
      JSON.stringify({ ...game.stats(), alive: game.brawl.alive(), out: game.brawl.birds.filter((b) => b.state !== 'fly').length, hp: game.brawl.player.hp, kos: game.brawl.player.kos })`));
    out.brawl40 = r;
    check('Sky Brawl: birds get knocked out', r.out >= 1, { out: r.out, alive: r.alive, playerHp: r.hp, playerKOs: r.kos });
    r = JSON.parse(await s.evalp(`JSON.stringify(game.advance(150))`));
    out.brawl = r;
    check('Sky Brawl ends with a placing', r.mode === 'end' && r.result && r.result.place >= 1, r.result);
    check('Sky Brawl results screen', await s.evalp(`/place|flying/.test(document.getElementById('rTitle').textContent)`), { title: await s.evalp(`document.getElementById('rTitle').textContent`) });
    // steering sensitivity scales the stick
    const sens = JSON.parse(await s.evalp(`JSON.stringify({ lowMid: game.stickCurve(0.5, 0.4), highMid: game.stickCurve(0.5, 1.2), lowFull: game.stickCurve(1, 0.4) })`));
    check('low sensitivity softens small moves but keeps the full turn', sens.lowMid < sens.highMid && Math.abs(sens.lowFull - 1) < 1e-9, sens);
    // pushing past the ring gives a hard turn: a sharper turn rate than a full normal push
    const turn = JSON.parse(await s.evalp(`(() => {
      const rate = (hard) => { game.start({ seed: 40, mode: 'brawl', diff: 'flock', skipIntro: true }); game.bot(null);
        game.input.override = { sx: 1, sy: 0, hard }; game.advance(1); const r = Math.abs(game.G.player.yawRate); game.input.override = null; return r; };
      return JSON.stringify({ normal: rate(0), hard: rate(1) }); })()`));
    check('a hard push turns much sharper', turn.hard > turn.normal * 1.5, turn);
    await s.evalp(`game.G.gameMode = 'murm'; 1`);

    // asset contract read defensively: a future rebake with variants and fewer keys still yields a usable layout
    const nm = JSON.parse(await s.evalp(`import('/game/birds.js').then((m) => JSON.stringify([
      m.normalizeMeta({ verts: 46, variants: 4, rows: 130, buffers: { index: {}, uv: { count: 92 }, vatPos: { count: 46 * 130 * 4 }, vatNrm: {} } }, 'v'),
      m.normalizeMeta({ buffers: { index: {}, uv: { count: 92 }, vatPos: { count: 46 * 34 * 4 }, vatNrm: {} } }, 'bare'),
      m.bodyCurve({ cycleFrames: 2, body: { heave_m: [0.001, -0.001], pitch_deg: [1, -1] } })]))`));
    check('asset contract: variants layout', nm[0].cycleFrames === 32 && nm[0].rowGlide === 128 && nm[0].rowBound === 129, { cycleFrames: nm[0].cycleFrames, rowGlide: nm[0].rowGlide });
    check('asset contract: bare meta falls back', nm[1].verts === 46 && nm[1].rows === 34 && nm[1].cycleFrames === 32 && nm[1].rowBound === 33, { rows: nm[1].rows, cycleFrames: nm[1].cycleFrames });
    check('asset contract: body curve read', nm[2] && nm[2].heave.length === 2 && Math.abs(nm[2].pitch[0] - Math.PI / 180) < 1e-9 && nm[2].surge[0] === 0, nm[2]);

    const er = s.errors();
    check('console is clean', er.length === 0, er.slice(0, 5));
  } finally { await s.close(); }
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ when: new Date().toISOString(), checks, runs: out }, null, 1));
  const bad = checks.filter((c) => !c.ok);
  console.log(bad.length ? `\n${bad.length} FAILED` : `\nall ${checks.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
