// Integration perf (SPEC §3, I2): node tests/integration/perf.js [low,medium,high] [--fx]
// For each quality: GPU ms (timer queries, median of 90 frames) in the default / orbit-close / inside / falcon views,
// the ornitography stamp overhead, rAF frame p50/p95, CPU ms per frame, and console errors.
// --fx: each effect id, MSAA and render scale measured on/off at medium in the default view.
const { open, sleep } = require('./cdp.js');
const fs = require('fs'); const path = require('path');
const DET = 'bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z';
const OUT = path.join(__dirname, 'perf.json');

(async () => {
  const args = process.argv.slice(2);
  const qs = (args.find((a) => !a.startsWith('--')) || 'low,medium,high').split(',');
  const doFx = args.includes('--fx');
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const out = { ...prev, date: new Date().toISOString(), perf: prev.perf || {}, fx: prev.fx || {} };
  const s = await open();
  try {
    for (const q of qs) {
      await s.nav(`index.html?${DET}&q=${q}&warm=900&ui=0`);
      out.gpu = await s.evalp(`(()=>{const g=murm.renderer.getContext();const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):'?'})()`);
      const r = { birds: await s.evalp('murm.stats().birds'), render: await s.evalp('murm.stats().render'), msaa: await s.evalp('murm.stats().msaa'), views: {} };
      for (const v of ['default', 'orbit-close', 'inside', 'falcon']) {
        await s.evalp(`murm.view('${v}')`); await sleep(1200);
        r.views[v] = await s.evalp(`murm.gpuBench(90)`);
        r.views[v].lod = await s.evalp('murm.stats().lodCounts');
      }
      await s.evalp(`murm.view('default')`); await sleep(1500);
      r.frame = await s.evalp('murm.frameP95(5)');
      // ornitography: a long exposure running, all birds, decay on (the costlier path)
      await s.evalp(`(()=>{const st=murm.state; st.mode='ornito'; st.emit('mode','ornito'); Object.assign(st.ornito,{frames:1000,track:'all',decay:0.008}); st.emit('ornito:start'); return 1})()`);
      await sleep(600);
      r.ornito = await s.evalp(`murm.gpuBench(90)`);
      r.ornitoPlus = +(r.ornito.median - r.views.default.median).toFixed(3);
      r.errors = s.errors();
      out.perf[q] = r;
      console.log(q, JSON.stringify({ birds: r.birds, render: r.render, default: r.views.default.median, orbitClose: r.views['orbit-close'].median, inside: r.views.inside.median,
        falcon: r.views.falcon.median, ornitoPlus: r.ornitoPlus, p95: r.frame.p95, cpu: r.views.default.cpuMedian, perPass: r.views.default.perPass, errors: r.errors.length }));
    }
    if (doFx) {
      // in-page A/B: each flag is toggled at runtime (sky, flock and grade re-read state.fx every frame) and measured
      // on/off alternately over 4 rounds of 60 frames, so GPU clock drift between page loads cancels out
      const ids = ['sky.multiScatter', 'sky.cloudRaymarch', 'sky.silverLining', 'sky.cirrus', 'sky.cloudLightTaps', 'flock.lod0', 'flock.iridescence',
        'flock.wingTransmit', 'flock.selfShadow', 'flock.aerial', 'flock.minPixel', 'flock.normalMapLOD0', 'falcon.real', 'post.grain', 'post.vignette', 'post.dither'];
      const fx = {};
      for (const view of ['default', 'inside', 'falcon-side']) {
        await s.nav(`index.html?${DET}&q=medium&warm=600&ui=0`);
        await s.evalp(`murm.view('${view}')`); await sleep(1000);
        await s.evalp('murm.gpuBench(60)');   // warm the GPU clocks
        for (const id of ids) {
          if (view !== 'default' && !(id.startsWith('flock.') || id.startsWith('falcon.'))) continue;
          if (view === 'falcon-side' && !id.startsWith('falcon.')) continue;
          if (view === 'inside' && id.startsWith('falcon.')) continue;
          const r = await s.evalp(`(async()=>{const st=murm.state, orig=st.fx['${id}']; const on=[], off=[];
            for (let k=0;k<4;k++){ st.fx['${id}']=${id === 'sky.cloudLightTaps' ? 2 : 1}; await murm.render(3); on.push((await murm.gpuBench(60)).median);
              st.fx['${id}']=0; await murm.render(3); off.push((await murm.gpuBench(60)).median); }
            st.fx['${id}']=orig; const m=a=>a.sort((x,y)=>x-y)[a.length>>1]; return {on:m(on), off:m(off), d:on.map((v,i)=>+(v-off[i]).toFixed(3))}})()`);
          fx[`${id}@${view}`] = { view, on: r.on, off: r.off, delta: +(r.on - r.off).toFixed(3), rounds: r.d };
          console.log(id, view, JSON.stringify(fx[`${id}@${view}`]));
        }
      }
      for (const [k, a, b] of [['msaa 4 vs 0', '&msaa=4', '&msaa=0'], ['scale 1 vs 0.75', '&scale=1', '&scale=0.75']]) {
        const res = [];
        for (let i = 0; i < 2; i++) for (const ex of [a, b]) {
          await s.nav(`index.html?${DET}&q=medium&warm=300&ui=0${ex}`); await sleep(800);
          await s.evalp('murm.gpuBench(60)'); res.push([ex, await s.evalp('murm.gpuBench(90)')]);
        }
        const on = res.filter((x) => x[0] === a).map((x) => x[1].median), off = res.filter((x) => x[0] === b).map((x) => x[1].median);
        fx[k] = { view: 'default', on, off, delta: +((on[0] + on[1]) / 2 - (off[0] + off[1]) / 2).toFixed(3) };
        console.log(k, JSON.stringify(fx[k]));
      }
      fx.errors = s.errors();
      out.fx = fx;
    }
  } finally { await s.close(); }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('gpu:', out.gpu);
})().catch((e) => { console.error(e); process.exit(1); });
