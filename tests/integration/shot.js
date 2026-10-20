// Quick look:  node tests/integration/shot.js "<query>" out.png ["js to run before the shot" ...]
// Saves a CDP screenshot (page incl. UI) to captures/<out>. Prints murm.stats() and console errors.
const { open, sleep } = require('./cdp.js');
(async () => {
  const [q, out, ...exprs] = process.argv.slice(2);
  const s = await open();
  try {
    await s.nav('index.html?' + q);
    for (const e of exprs) { const v = await s.evalp(e); if (v !== undefined) console.log('>', e.slice(0, 80), '\n ', typeof v === 'string' ? v : JSON.stringify(v)); }
    await sleep(400);
    await s.shot(out);
    console.log(JSON.stringify(await s.evalp('murm.stats()')));
    console.log('framing', JSON.stringify(await s.evalp('murm.framing()')));
    const er = s.errors(); console.log('console:', er.length ? er.join('\n  ') : 'clean');
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
