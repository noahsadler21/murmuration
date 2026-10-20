// F11 perf: GPU ms per pass (timer queries) and CPU ms per frame, per quality, in the default (watcher), near and
// inside views, plus each flock.* effect measured on/off (via ?fx=). node tests/flock/perf.js [q,q,...]
const { open } = require('./cdp.js');
const fs = require('fs'); const path = require('path');
(async () => {
  const qs = (process.argv[2] || 'low,medium,high').split(',');
  const s = await open();
  const out = { gpu: '', perf: {}, fx: {} };
  try {
    for (const q of qs) {
      const run = async (extra, views) => {
        await s.nav(`tests/flock/flock_test.html?q=${q}&paused=1&nofalcon=1&clean=1${extra}`);
        if (!out.gpu) out.gpu = await s.evalp(`(()=>{const g=T.renderer.getContext();const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):'?'})()`);
        await s.evalp('T.tick(1500)');   // 25 s: the flock has formed
        const r = {};
        for (const v of views) {
          r[v] = await s.evalp(`(async()=>{T.setView('${v}');T.snap();for(let i=0;i<10;i++)await T.frame();
            const g=await T.gpuBench(90);const c=T.cpuFrame(60);const i=T.flock.debug.info();
            return {gpu:g,cpu:c,px:[T.RW,T.RH],birds:i.N,lod:i.lodCounts,tris:i.tris}})()`);
        }
        const er = s.errors(); if (er.length) r.errors = er;
        return r;
      };
      out.perf[q] = await run('', ['default', 'near', 'inside']);
      console.log(q, JSON.stringify(out.perf[q]));
      // per-effect cost (scene pass), inside view (LOD0–2 birds; the effects are invisible at watcher range)
      const fx = ['flock.iridescence', 'flock.wingTransmit', 'flock.selfShadow', 'flock.aerial', 'flock.minPixel', 'flock.lod0', 'flock.normalMapLOD0'];
      out.fx[q] = {};
      for (const f of fx) {
        const on = await run(`&fx=${f}:1`, ['inside']), off = await run(`&fx=${f}:0`, ['inside']);
        out.fx[q][f] = { on: on.inside.gpu.perPass.scene, off: off.inside.gpu.perPass.scene, delta: +(on.inside.gpu.perPass.scene - off.inside.gpu.perPass.scene).toFixed(3) };
      }
      console.log(q, 'fx', JSON.stringify(out.fx[q]));
    }
  } finally { await s.close(); }
  const p = path.join(__dirname, 'perf.json');
  fs.writeFileSync(p, JSON.stringify({ date: new Date().toISOString(), ...out }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
