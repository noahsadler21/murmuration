// Final screenshots and screen recording → models/preview/final_*.png, final_murmuration.mp4
//   node tests/integration/final.js [wide_dusk,watcher,agitation,ornito_all,ornito_one,video] [--out DIR]
// Headless Chrome 1280×720 CSS at DPR 1.25 (1600×900 device px), deterministic URL (seeded flock, bundled sample
// weather, fixed time), the sim stepped frame by frame (murm.render) so every capture is reproducible.
const { open, sleep } = require('./cdp.js');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = oi >= 0 ? args[oi + 1] : path.join(__dirname, '..', '..', 'models', 'preview');
const DET = 'bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z';
const save = async (s, name) => {
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); console.log('  saved', name);
};
const waitFor = async (s, expr, ms = 120000) => { const t0 = Date.now(); while (!(await s.evalp(expr))) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + expr); await sleep(100); } };
// pause the wall-clock loop and step the sim n frames of 1/60 s
const step = (s, n) => s.evalp(`(async()=>{murm.state.time.paused=false; await murm.render(${n}); murm.state.time.paused=true; await murm.render(1);})()`);
const ornito = (s, o) => s.evalp(`(async()=>{const st=murm.state; st.mode='ornito'; st.emit('mode','ornito'); st.ornito.selection=[];
  Object.assign(st.ornito, ${JSON.stringify(o)});
  ${o.track === 'one' ? `const near = await murm.birdsNearCentre(80); const A = await murm.flock.readAll();
    // a bird mid flapping bout (state z = time left in the bout), so the plate shows wingbeats, not a glide
    let best = near[0], bz = -1; for (const i of near) { const S = A.state; if (S[i*4] < 0.5 && S[i*4+1] < 0.5 && S[i*4+2] > bz) { bz = S[i*4+2]; best = i; } }
    st.emit('select',{ids:[best]});` : ''}
  st.emit('ornito:start'); return 1})()`);

const SHOTS = {
  // dusk, wide: high quality (81,920 birds), dusk look, 23 minutes after sunset (sun −3.7°), from the promenade
  async wide_dusk(s) {
    await s.nav(`index.html?bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:28:00Z&look=dusk&q=high&ui=0&warm=2400`);
    await s.evalp(`murm.view('wide')`);
    for (let i = 0; i < 4; i++) { await step(s, 240); await save(s, `final_wide_dusk_${i}.png`); }
  },
  // dusk, watcher: clear sample weather, sun −4.6°, the afterglow band behind the flock
  async dusk_watcher(s) {
    await s.nav(`index.html?bench=1&seed=7&wx=sample:clear&site=brighton&t=2025-11-20T16:20:00Z&look=dusk&q=high&ui=0&warm=2400`);
    for (let i = 0; i < 4; i++) { await step(s, 240); await save(s, `final_dusk_watcher_${i}.png`); }
  },
  // the default: signature look, medium quality, the watcher
  async watcher(s) {
    await s.nav(`index.html?${DET}&warm=2400&ui=0`);
    for (let i = 0; i < 4; i++) { await step(s, 120); await save(s, `final_watcher_${i}.png`); }
    await s.evalp(`document.body.classList.remove('noui')`); await sleep(400); await save(s, 'final_watcher_ui.png');
  },
  // a falcon strike and the flock's reaction (chase camera behind the falcon, its quarry beyond): frames every 0.25 s
  async agitation(s) {
    await s.nav(`index.html?${DET}&warm=2400&ui=0&q=high`);
    await s.evalp(`murm.view('falcon')`);
    await step(s, 30);
    await s.evalp(`murm.state.emit('attack')`);
    for (let i = 0; i < 600; i++) { await step(s, 5); if (await s.evalp(`murm.flock.falcon().minDist < 40`)) break; }
    for (let i = 0; i < 10; i++) {
      await step(s, 8);
      console.log('  ', i, JSON.stringify(await s.evalp(`({f: murm.state.falcon.state, ex: +murm.state.flock.stats.excited.toFixed(3)})`)));
      await save(s, `final_agitation_${i}.png`);
    }
  },
  // Ornitography, all birds: 150 frames at 240 fps (0.625 s), layered film stack, longer lens on the flock
  async ornito_all(s) {
    await s.nav(`index.html?${DET}&warm=2400&ui=0`);
    await step(s, 30);
    await ornito(s, { frames: 150, vfps: 240, track: 'all', blend: 'layer' });
    await waitFor(s, `murm.state.ornito.done >= 150 && !murm.state.ornito.running`);
    await sleep(400); await save(s, 'final_ornito_all.png');
  },
  // Ornitography, one bird: 400 frames at 1000 fps (0.4 s), seen from below at 55°, hard darken blend
  async ornito_one(s) {
    for (const seed of [1, 4]) {
      await s.nav(`index.html?bench=1&seed=${seed}&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z&warm=2400&ui=0`);
      await step(s, 30);
      await ornito(s, { frames: 400, vfps: 1000, track: 'one', blend: 'darken' });
      await waitFor(s, `murm.state.ornito.done >= 400 && !murm.state.ornito.running`);
      await sleep(400); await save(s, `final_ornito_one_s${seed}.png`);
    }
  },
  // the agitation wave from the ground (the same run as the recording): a falcon pass at 5 s, PNG stills 6.5–8.5 s
  async wave(s) {
    await s.nav(`index.html?bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z&warm=2400&ui=0&q=high`);
    await step(s, 2);
    for (let i = 0; i < 256; i++) {
      await step(s, 2);
      if (i === 150) await s.evalp(`murm.state.emit('attack')`);
      if (i >= 195 && i % 6 === 3) await save(s, `final_wave_${i}.png`);
    }
  },
  // 12 s screen recording of the default view at 30 fps (2 sim steps per frame = real time), then a falcon pass
  async video(s) {
    const dir = path.join(OUT, '_video'); fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    await s.nav(`index.html?bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z&warm=2400&ui=0&q=high`);
    await step(s, 2);
    let k = 0;
    const grab = async () => { const r = await s.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 }); fs.writeFileSync(path.join(dir, `f${String(k++).padStart(4, '0')}.jpg`), Buffer.from(r.data, 'base64')); };
    for (let i = 0; i < 360; i++) { await step(s, 2); await grab(); if (i === 150) await s.evalp(`murm.state.emit('attack')`); }
    const out = path.join(OUT, 'final_murmuration.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(dir, 'f%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-vf', 'scale=1280:-2', out]);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
    console.log('  saved final_murmuration.mp4');
  },
};

(async () => {
  const want = (args.find((a) => !a.startsWith('--') && a !== OUT) || Object.keys(SHOTS).join(',')).split(',');
  fs.mkdirSync(OUT, { recursive: true });
  const s = await open();
  try {
    for (const k of want) {
      console.log(k);
      await SHOTS[k](s);
      const er = s.errors();
      console.log('  console:', er.length ? er.join(' | ') : 'clean');
    }
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
