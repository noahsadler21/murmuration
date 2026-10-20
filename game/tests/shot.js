// Quick look:  node game/tests/shot.js "<query>" out.png ["js to run before the shot" ...]
// Saves a CDP screenshot to captures/<out> and prints game.stats() and console errors.
const { open, sleep } = require('./cdp.js');
(async () => {
  const [q, out, ...exprs] = process.argv.slice(2);
  const s = await open({ width: +(process.env.W || 1280), height: +(process.env.H || 720), dsf: +(process.env.DSF || 1.25) });
  try {
    await s.nav('game/index.html?' + q);
    for (const e of exprs) { const v = await s.evalp(e); if (v !== undefined) console.log('>', e.slice(0, 90), '\n ', typeof v === 'string' ? v : JSON.stringify(v)); }
    await sleep(300);
    await s.shot(out);
    console.log(JSON.stringify(await s.evalp('game.stats()')));
    const er = s.errors(); console.log('console:', er.length ? er.join('\n  ') : 'clean');
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
