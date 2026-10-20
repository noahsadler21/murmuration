// Fish Frenzy look:  node game/tests/frenzy.js prefix  → title with the game picker, mid-run, a catch moment, results
const { open, sleep } = require('./cdp.js');
(async () => {
  const pre = process.argv[2] || 'frenzy';
  const s = await open({ width: 1280, height: 720, dsf: 1.25 });
  const shot = async (n) => { await s.evalp('game.G.manual = true; game.render(); 1'); await s.shot(`${pre}_${n}.png`); await s.evalp('game.G.manual = false; 1'); };
  try {
    await s.nav('game/index.html?test=1');
    await s.evalp(`document.querySelector('[data-game="fish"]').click(); 1`);
    await sleep(2500);
    await shot('title');
    await s.evalp(`game.start({seed: 9, mode: 'fish', diff: 'flock', skipIntro: true}); game.bot('fish'); game.advance(20); 1`);
    await shot('mid');
    // the first catch after 30 s, a few frames on
    console.log(await s.evalp(`(() => { const f0 = game.G.fish; for (let k = 0; k < 3000 && game.G.fish === f0; k++) game.advance(1/60); game.advance(0.12); return JSON.stringify(game.stats()); })()`));
    await shot('catch');
    console.log(await s.evalp(`JSON.stringify(game.advance(80).result)`));
    await sleep(300);
    await shot('results');
    const er = s.errors(); console.log('console:', er.length ? er.join('\n  ') : 'clean');
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
