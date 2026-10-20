// Quick look: node tests/sky/shot.js "<query>" out.png [settleFrames] [w h dpr]
// Opens tests/sky_test.html?<query>, renders settleFrames frames, screenshots, prints console errors and sky stats.
const path = require('path');
const { start, ROOT } = require('./cdp.js');
(async () => {
  const [query = 'wx=sample:overcast&t=2025-11-20T16:05:00Z', out = 'captures/_sky_quick.png', settle = '90', w = '1280', h = '720', d = '1.25'] = process.argv.slice(2);
  const b = await start({ width: +w, height: +h, dpr: +d });
  try {
    await b.open('tests/sky_test.html?' + query);
    await b.evaluate(`skyTest.render(${+settle}, 1/60)`);
    const st = await b.evaluate(`JSON.stringify({ size: skyTest.size(), stats: skyTest.sky.debug.meanSky(), decks: skyTest.sky.debug.decks, src: skyTest.wx.source, sun: [skyTest.state.sun.altitudeDeg, skyTest.state.sun.azimuthDeg], errors: skyTest.errors })`);
    console.log(st);
    console.log("analyze:", JSON.stringify(await b.evaluate("skyTest.analyze()")));
    await b.shot(path.join(ROOT, out));
    const errs = b.errors();
    console.log(errs.length ? 'console errors:\n' + errs.map(e => '  ' + e.text).join('\n') : 'console: clean');
    const warns = b.logs.filter(l => l.type === 'warning');
    if (warns.length) console.log('warnings:\n' + warns.slice(0, 10).map(e => '  ' + e.text.slice(0, 400)).join('\n'));
  } finally { await b.close(); }
})().catch(e => { console.error(e); process.exit(1); });
