// Behaviour probe for tuning: node tests/flock/probe.js <secs> <tag>=<query> [<tag>=<query> ...]
// For each variant: runs <secs> of sim (no rendering), plots at 1/3, 2/3 and the end, prints stats every 10 s.
const { open } = require('./cdp.js');
(async () => {
  const [secs, ...vars] = process.argv.slice(2);
  const S = +secs || 60;
  const s = await open();
  try {
    for (const v of vars) {
      const i = v.indexOf('='); const tag = v.slice(0, i), q = v.slice(i + 1);
      await s.nav(`tests/flock/flock_test.html?q=medium&paused=1&nofalcon=1&${q}`);
      const out = await s.evalp(`(async()=>{const o=[];const S=${S};
        for(let t=10;t<=S;t+=10){await T.tick(600);const f=T.state.flock;
          o.push([t,f.stats.polarization.toFixed(3),f.stats.medianSpeed.toFixed(1),f.centroid.toArray().map(v=>v.toFixed(0)).join(','),f.extent.toArray().map(v=>v.toFixed(0)).join('x'),
            (f.stats.flap*100).toFixed(0)+'/'+(f.stats.glide*100).toFixed(0)+'/'+(f.stats.bound*100).toFixed(0), 'nn '+(await T.flock.debug.nnDist()).median, 'O '+(await T.flock.debug.opacityStats(300)).meanO].join('  '));
          if(t===Math.round(S/30)*10||t===Math.round(2*S/30)*10||t===S) await T.plot('probe_${tag}_'+t+'.png');}
        return o.join('\\n')})()`);
      console.log(`== ${tag}: ${q}\n${out}`);
      const er = s.errors(); if (er.length) console.log('console:', er.join(' | '));
    }
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
