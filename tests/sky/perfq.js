// quick GPU timing per pass: node tests/sky/perfq.js "<query>" [q list]
const { start } = require('./cdp.js');
(async () => {
  const q0 = process.argv[2] || 'wx=sample:overcast&t=2025-11-20T16:05:00Z&hud=0&birds=0';
  const qs = (process.argv[3] || 'low,medium,high').split(',');
  const b = await start({ width: 1280, height: 720, dpr: 1.25 });
  try {
    for (const q of qs) {
      await b.open('tests/sky_test.html?' + q0 + '&q=' + q);
      await b.evaluate('skyTest.render(300)');
      const runs = [];
      for (let k = 0; k < 5; k++) runs.push(await b.evaluate('skyTest.gpu(120)'));
      const r = {};
      for (const key of Object.keys(runs[0])) { const a = runs.map(x => x[key]).sort((x, y) => x - y); r[key] = a[2]; }
      const sz = await b.evaluate('[skyTest.size(), [skyTest.sky.skyRT.width, skyTest.sky.skyRT.height], skyTest.renderer.capabilities.maxSamples, (() => { const gl = skyTest.renderer.getContext(); const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; })()]');
      console.log(q, JSON.stringify(r), JSON.stringify(sz));
    }
  } finally { await b.close(); }
})().catch(e => { console.error(e); process.exit(1); });
