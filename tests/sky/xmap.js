// diagnostic: rows of signature x (and L/Lp, g) across the S6 framing
const { start } = require('./cdp.js');
(async () => {
  const q = process.argv[2] || 'wx=sample:overcast&t=2025-11-20T16:05:00Z&hud=0&birds=0';
  const b = await start({ width: 1296, height: 716, dpr: 1 });
  try {
    await b.open('tests/sky_test.html?' + q);
    await b.evaluate(`skyTest.state.fx['post.grain']=0; skyTest.state.fx['post.vignette']=0; skyTest.state.fx['post.dither']=0; skyTest.render(60)`);
    await b.evaluate(`skyTest.grade.setLookOverride('xmap'); skyTest.render(2)`);
    const r = await b.evaluate(`(() => { const { w, h, data } = skyTest.readCanvas(); const out = [];
      for (const fy of [0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98]) { const y = Math.floor(fy * h); let a = [0,0,0], mn = 1e9, mx = -1e9;
        for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; a[0] += data[i]; a[1] += data[i+1]; a[2] += data[i+2]; mn = Math.min(mn, data[i]); mx = Math.max(mx, data[i]); }
        out.push({ fy, x: +(a[0] / w / 127.5).toFixed(3), LLp: +(a[1] / w / 127.5).toFixed(3), g: +(a[2] / w / 127.5).toFixed(3), xmin: +(mn/127.5).toFixed(3), xmax: +(mx/127.5).toFixed(3) }); }
      return out; })()`);
    console.table(r);
    await b.evaluate(`skyTest.grade.setLookOverride(null); skyTest.render(2)`);
    console.log(JSON.stringify(await b.evaluate('skyTest.analyze()')));
    console.log(b.logs.filter(l => l.type !== 'log').map(l => l.type + ': ' + l.text.slice(0, 600)).join('\n'));
  } finally { await b.close(); }
})().catch(e => { console.error(e); process.exit(1); });
