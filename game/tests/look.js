// Look sheet:  node game/tests/look.js [prefix]
// Title screen, a lane-following run at 12 s, a sea run at ~25 s (fish), a wide 3/4 view; screenshots to captures/.
const { open, sleep } = require('./cdp.js');
(async () => {
  const pre = process.argv[2] || 'look';
  const s = await open({ width: +(process.env.W || 1280), height: +(process.env.H || 720), dsf: +(process.env.DSF || 1.25) });
  const shot = async (n) => { await s.evalp('game.G.manual = true; game.render(); 1'); await s.shot(`${pre}_${n}.png`); await s.evalp('game.G.manual = false; 1'); };
  try {
    await s.nav('game/index.html?test=1');
    await sleep(2500);
    await shot('title');
    console.log(await s.evalp(`game.start({seed: 5, skipIntro: true}); game.bot('lane'); JSON.stringify(game.advance(12))`));
    await shot('play12');
    console.log(await s.evalp(`game.bot('fish'); JSON.stringify(game.advance(12.5))`));
    await shot('sea25');
    console.log(await s.evalp(`JSON.stringify(game.advance(1.2))`));
    await shot('sea26');
    const er = s.errors(); console.log('console:', er.length ? er.join('\n  ') : 'clean');
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
