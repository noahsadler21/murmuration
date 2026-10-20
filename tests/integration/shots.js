// Integration screenshots → models/preview/page_*.png (headless Chrome, 1280×720 CSS at DPR 1.25 = 1600×900 device px).
//   node tests/integration/shots.js [name,name,...]
// Each shot loads the built index.html fresh, so they are independent. Every load's console is checked.
const { open, sleep } = require('./cdp.js');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'models', 'preview');
const DET = 'bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z';

async function save(s, name) {
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  saved', name);
}
const waitFor = async (s, expr, ms = 60000) => { const t0 = Date.now(); while (!(await s.evalp(expr))) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + expr); await sleep(100); } };

const SHOTS = {
  // the wide murmuration at dusk (high quality: 81,920 birds), from the promenade
  async wide_dusk(s) {
    await s.nav(`index.html?bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:28:00Z&look=dusk&ui=0&warm=3000`);
    await s.evalp(`murm.view('wide')`); await sleep(3000);
    await save(s, 'page_wide_dusk.png');
  },
  // the default watcher view (signature look, medium), with the UI
  async watcher(s) {
    await s.nav(`index.html?${DET}&warm=2400`);
    await sleep(3000);
    await save(s, 'page_watcher.png');
    await s.evalp(`document.body.classList.add('noui')`); await sleep(300);
    await save(s, 'page_watcher_clean.png');
  },
  // a falcon pass and the agitation wave it sets off (watcher view), 3 moments after the strike
  async agitation(s) {
    await s.nav(`index.html?${DET}&warm=2400&ui=0`);
    await sleep(1500);
    await s.evalp(`murm.state.emit('attack')`);
    await waitFor(s, `['strike','pullout','climb'].includes(murm.state.falcon.state)`, 20000);
    const info = [];
    for (const [dt, nm] of [[0, 'a'], [600, 'b'], [900, 'c']]) {
      if (dt) await sleep(dt);
      info.push(await s.evalp(`({falcon: murm.state.falcon.state, excited: +murm.state.flock.stats.excited.toFixed(3)})`));
      await save(s, `page_agitation_wave_${nm}.png`);
    }
    console.log('  ', JSON.stringify(info));
  },
  // live weather readout (real Open-Meteo request) with the place panel open
  async weather(s) {
    await s.nav(`index.html?warm=600`);
    await waitFor(s, `murm.state.weather.status === 'ok'`, 30000);
    await s.evalp(`document.getElementById('placeBtn').click()`);
    await sleep(2500);
    console.log('  ', JSON.stringify(await s.evalp(`({src: murm.wx && murm.wx.source, sample: murm.state.weather.sample && {low: murm.state.weather.sample.cloudLow, w10: murm.state.weather.sample.wind10}, sun: murm.state.sun.altitudeDeg})`)));
    await save(s, 'page_weather_readout.png');
  },
  // Ornitography: 300 frames at 240 fps, all birds, darken
  async ornito_all(s) {
    await s.nav(`index.html?${DET}&warm=2400`);
    await sleep(1500);
    await s.evalp(`(()=>{const st=murm.state; st.mode='ornito'; st.emit('mode','ornito'); Object.assign(st.ornito,{frames:300,vfps:240,track:'all',blend:'darken',decay:0.008}); st.emit('ornito:start'); return 1})()`);
    await waitFor(s, `murm.state.ornito.done >= 300 && !murm.state.ornito.running`, 60000);
    await sleep(500);
    await save(s, 'page_ornito_all.png');
    await s.evalp(`document.body.classList.add('noui')`); await sleep(300);
    await save(s, 'page_ornito_all_clean.png');
  },
  // Ornitography: all birds from near the flock's edge ('orbit-close' view), 300 frames at 240 fps
  async ornito_all_close(s) {
    await s.nav(`index.html?${DET}&warm=2400&ui=0`);
    await s.evalp(`murm.view('orbit-close')`); await sleep(1500);
    await s.evalp(`(()=>{const st=murm.state; st.mode='ornito'; st.emit('mode','ornito'); Object.assign(st.ornito,{frames:300,vfps:240,track:'all',blend:'darken',decay:0.008}); st.emit('ornito:start'); return 1})()`);
    await waitFor(s, `murm.state.ornito.done >= 300 && !murm.state.ornito.running`, 60000);
    await sleep(500);
    await save(s, 'page_ornito_all_close.png');
  },
  // Ornitography: one bird, framed side-on from 10 m (from below), 300 frames at 240 fps
  async ornito_one(s) {
    await s.nav(`index.html?${DET}&warm=2400`);
    await sleep(1500);
    const r = await s.evalp(`(async()=>{const st=murm.state; st.mode='ornito'; st.emit('mode','ornito');
      const ids = await murm.birdsNearCentre(1); const id = ids[0];
      const fr = await murm.frameBird(id, 10, 0.62, -28);
      Object.assign(st.ornito,{frames:300,vfps:240,track:'one',blend:'darken',decay:0}); st.emit('select',{ids:[id]});
      st.emit('ornito:start'); return {id, fr}})()`);
    console.log('  ', JSON.stringify(r));
    await waitFor(s, `murm.state.ornito.done >= 300 && !murm.state.ornito.running`, 60000);
    await sleep(500);
    await save(s, 'page_ornito_one.png');
    await s.evalp(`document.body.classList.add('noui')`); await sleep(300);
    await save(s, 'page_ornito_one_clean.png');
  },
  // two noise presets, same seed and view, after 45 s of flight
  async noise(s) {
    for (const p of ['calm', 'agitated']) {
      await s.nav(`index.html?${DET}&preset=${p}&warm=2700&ui=0`);
      await sleep(2500);
      console.log('  ', p, JSON.stringify(await s.evalp(`({phi: murm.state.flock.stats.polarization, ext: murm.state.flock.extent.toArray().map(Math.round), framing: murm.framing()})`)));
      await save(s, `page_noise_${p}.png`);
    }
  },
};

(async () => {
  const want = (process.argv[2] || Object.keys(SHOTS).join(',')).split(',');
  fs.mkdirSync(OUT, { recursive: true });
  const s = await open();
  const report = {};
  try {
    for (const k of want) {
      console.log(k);
      await SHOTS[k](s);
      const er = s.errors();
      report[k] = er.length ? er : 'clean';
      console.log('  console:', er.length ? er.join(' | ') : 'clean');
    }
  } finally { await s.close(); }
  fs.writeFileSync(path.join(__dirname, 'shots.json'), JSON.stringify({ date: new Date().toISOString(), console: report }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
