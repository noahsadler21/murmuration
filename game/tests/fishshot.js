// screenshot the first moment a flying fish is close and in view:  node game/tests/fishshot.js out.png [maxDist] [seed]
const { open, sleep } = require('./cdp.js');
(async () => {
  const [out = 'fish_view.png', maxD = '9', seed = '23'] = process.argv.slice(2);
  const s = await open({ width: 1280, height: 720, dsf: 1.25 });
  try {
    await s.nav('game/index.html?test=1');
    const r = await s.evalp(`(() => {
      game.start({seed: ${seed}, diff: 'flock', skipIntro: true}); game.bot('fish');
      const THREE_V = (x, y, z) => { const v = game.camera.position.clone().set(x, y, z); return v.project(game.camera); };
      for (let k = 0; k < 9000; k++) {
        game.advance(1 / 60);
        for (const f of game.fishes.list) {
          if (f.state !== 'air') continue;
          const v = THREE_V(f.x, f.y, f.z);
          const d = game.camera.position.distanceTo(v.clone().set(f.x, f.y, f.z));
          if (v.z < 1 && Math.abs(v.x) < 0.6 && Math.abs(v.y) < 0.6 && d < ${maxD}) { game.G.manual = true; game.render(); return JSON.stringify({ t: game.G.t, d, ndc: [v.x, v.y], fish: game.G.fish }); }
        }
      }
      return 'none';
    })()`);
    console.log(r);
    await s.shot(out);
    const er = s.errors(); console.log('console:', er.length ? er.join('\n  ') : 'clean');
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
