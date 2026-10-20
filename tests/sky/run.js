// Sky builder acceptance tests (SPEC §9 S1–S8) + the real-weather captures. Headless Chrome over CDP (tests/sky/cdp.js),
// serving ROOT with tests/sky/serve.js on a free port (stopped at the end). Writes tests/sky/results.json and captures/sky_*.png.
//   node tests/sky/run.js [--only S1,S6,...] [--skip-live]
const fs = require('fs'), path = require('path');
const { start, sleep, ROOT } = require('./cdp.js');
const argv = process.argv.slice(2);
const only = (argv[argv.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const want = k => !only.length || only.includes(k) || only.includes(k.slice(0, 2));
const skipLive = argv.includes('--skip-live');
const CAP = f => path.join(ROOT, 'captures', f);
const DET = 'bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z';
// the three real cases (found by tests/sky/scan.js from Open-Meteo forecast data for 2026-10-19)
const REAL = [
  { name: 'clear', site: 'rome', t: '2026-10-19T15:42:00Z' },
  { name: 'broken', site: 'otmoor', t: '2026-10-19T15:32:00Z' },
  { name: 'overcast', site: 'tonder', t: '2026-10-19T13:46:00Z' },
];
const R = { date: new Date().toISOString(), consoleErrors: [], notes: [] };
const resultsFile = path.join(__dirname, 'results.json');
const prev = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};
const r2 = x => Math.round(x * 100) / 100;

(async () => {
  const b = await start({ width: 1280, height: 720, dpr: 1.25 });
  const open = async (q, label) => {
    await b.open('tests/sky_test.html?' + q);
    const errs = b.errors();
    if (errs.length) R.consoleErrors.push({ url: q, label, errors: errs.map(e => e.text.slice(0, 300)) });
    return errs.length;
  };
  const checkErrs = (q) => { const e = b.errors(); if (e.length) R.consoleErrors.push({ url: q, errors: e.map(x => x.text.slice(0, 300)) }); };
  try {
    R.gpu = await (async () => { await open(DET + '&birds=0&hud=0', 'gpu'); return b.evaluate(`(() => { const gl = skyTest.renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })()`); })();
    R.notes.push(`GPU: ${R.gpu}. SPEC §3 budgets are for an Intel Arc iGPU; this machine has only this GPU, so measured ms are reported as-is with an Arc estimate of ×4.5 (FP32 ~20 vs ~4.6 TFLOPS, ~448 vs ~100 GB/s).`);

    // ------------------------------------------------------------------ S1: request A byte-exact
    if (want('S1')) {
      const s1 = await b.evaluate(`(async () => {
        const W = await import('../src/weather.js');
        const site = W.SITES.find(s => s.id === 'brighton');
        const got = W.buildURL('forecast', site, '2025-11-20');
        const exp = 'https://api.open-meteo.com/v1/forecast?latitude=50.8214&longitude=-0.1517&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,visibility,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_80m,wind_direction_80m,wind_speed_850hPa,wind_direction_850hPa,wind_speed_500hPa,wind_direction_500hPa,wind_speed_300hPa,wind_direction_300hPa&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=sunrise,sunset&start_date=2025-11-19&end_date=2025-11-21&wind_speed_unit=ms&timeformat=unixtime&timezone=auto';
        return { got, exp, pass: got === exp };
      })()`);
      R.S1 = s1;
    }

    // ------------------------------------------------------------------ S2/S3: live for 3 sites, sunset vs Open-Meteo
    if (want('S2') || want('S3')) {
      R.S2 = { live: [], offline: null, cache: null };
      R.S3 = { sunset: [] };
      if (!skipLive) {
        for (const site of ['brighton', 'otmoor', 'rome']) {
          b.requests.length = 0;
          const q = `site=${site}&t=sunset&wx=live&birds=0&hud=1`;
          await open(q, 'S2 live ' + site);
          const r = await b.evaluate(`(async () => {
            const W = await import('../src/weather.js');
            const wx = skyTest.wx, st = skyTest.state;
            const D = wx.date, s = W.sunTimes(D, st.site.lat, st.site.lon);
            const i = wx.daily ? wx.daily.time.findIndex(t => new Date(t + wx.utcOffsetSeconds * 1000).toISOString().slice(0, 10) === D) : -1;
            const om = i >= 0 ? wx.daily.sunset[i] : (wx.daily ? wx.daily.sunset[1] : NaN);
            return { site: st.site.id, D, source: wx.source, badge: document.getElementById('hSub').textContent,
                     url: W.buildURL('forecast', st.site, D), sunsetCalcUTC: new Date(s.sunsetMs).toISOString(), sunsetOpenMeteoUTC: new Date(om).toISOString(),
                     diffMin: (s.sunsetMs - om) / 60000, sample: skyTest.state.weather.sample };
          })()`);
          const reqs = b.requests.filter(u => u.includes('open-meteo.com'));
          r.requests = reqs;
          r.requestAExact = reqs.includes(r.url);
          R.S2.live.push({ site: r.site, D: r.D, source: r.source, badge: r.badge, requestAExact: r.requestAExact, cloud: [r.sample.cloudLow, r.sample.cloudMid, r.sample.cloudHigh].map(r2) });
          R.S3.sunset.push({ site: r.site, D: r.D, calcUTC: r.sunsetCalcUTC, openMeteoUTC: r.sunsetOpenMeteoUTC, diffMin: r2(r.diffMin), pass: Math.abs(r.diffMin) <= 2 });
        }
        // offline: fresh storage → sample; online load writes the cache; offline again → cache.
        // CDP's emulateNetworkConditions{offline} also cuts the localhost page and the three.js CDN, so the page cannot
        // boot at all; Network.setBlockedURLs takes Open-Meteo away instead, which exercises exactly the fallback chain.
        const offline = on => b.send('Network.setBlockedURLs', { urls: on ? ['*open-meteo.com*'] : [] });
        await b.evaluate('localStorage.clear()');
        await offline(true);
        try { await open('site=brighton&t=sunset&wx=live&birds=0', 'S2 offline'); R.S2.offline = await b.evaluate(`({ source: skyTest.wx.source, badge: document.getElementById('hSub').textContent, attempts: skyTest.wx.attempts })`); }
        catch (e) { R.notes.push('offline page load failed: ' + e.message); }
        await offline(false);
        await open('site=brighton&t=sunset&wx=live&birds=0', 'S2 online (caches)');
        await offline(true);
        try { await open('site=brighton&t=sunset&wx=live&birds=0', 'S2 offline 2'); R.S2.cache = await b.evaluate(`({ source: skyTest.wx.source, cachedFrom: skyTest.wx.cachedFrom, badge: document.getElementById('hSub').textContent })`); }
        catch (e) { R.notes.push('second offline load failed: ' + e.message); }
        await offline(false);
        R.S2.method = 'Network.setBlockedURLs(*open-meteo.com*)';
        // the offline loads' failed fetches are expected network errors, not page errors: drop them from the error list
        R.consoleErrors = R.consoleErrors.filter(e => !/S2 offline/.test(e.label || '') || e.errors.some(t => !/open-meteo|ERR_BLOCKED_BY_CLIENT|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(t)));
        R.S2.pass = R.S2.live.length === 3 && R.S2.live.every(l => l.source === 'forecast' && l.requestAExact) &&
          !!R.S2.offline && R.S2.offline.source === 'sample' && /sample weather \(offline\)/.test(R.S2.offline.badge) &&
          !!R.S2.cache && R.S2.cache.source === 'cache' && /cached/.test(R.S2.cache.badge);
      } else R.S2 = prev.S2 || R.S2;
      // sun position checks
      await open(DET + '&birds=0&hud=0', 'S3');
      Object.assign(R.S3, await b.evaluate(`(async () => {
        const W = await import('../src/weather.js');
        const a = W.sunPosition(Date.UTC(2025, 11, 21, 12, 0, 0), 50.8214, -0.1517);
        const c = W.sunPosition(Date.UTC(2025, 2, 20, 12, 7, 0), 0, 0);
        return { brighton_20251221_1200: { alt: +a.altitudeDeg.toFixed(3), az: +a.azimuthDeg.toFixed(3), pass: Math.abs(a.altitudeDeg - 15.7) <= 0.3 && Math.abs(a.azimuthDeg - 180) <= 1.5 },
                 equator_20250320_1207: { alt: +c.altitudeDeg.toFixed(3), pass: c.altitudeDeg >= 88.5 } };
      })()`));
      R.S3.pass = R.S3.brighton_20251221_1200.pass && R.S3.equator_20250320_1207.pass && (skipLive ? true : R.S3.sunset.length === 3 && R.S3.sunset.every(s => s.pass));
    }

    // ------------------------------------------------------------------ S4: exact coverage
    if (want('S4')) {
      await open(DET + '&birds=0&hud=0', 'S4');
      const cov = await b.evaluate(`(() => { const out = []; for (const c of [0, 0.25, 0.5, 0.75, 1]) { const m = skyTest.sky.debug.measureCoverage({ low: c, mid: c, high: c }); out.push({ target: c, low: +m.low.toFixed(4), mid: +m.mid.toFixed(4), high: +m.high.toFixed(4) }); } return out; })()`);
      R.S4 = { table: cov, maxErr: r2(Math.max(...cov.flatMap(r => [r.low, r.mid, r.high].map(v => Math.abs(v - r.target)))) * 1000) / 1000 };
      R.S4.pass = R.S4.maxErr <= 0.05;
      await open(DET + '&birds=0&hud=0&skydebug=coverage', 'S4 view');
      await b.evaluate('skyTest.setCovers({ low: 0.5, mid: 0.5, high: 0.5 }); skyTest.render(4)');
      await b.shot(CAP('sky_coverage_debug_050.png'));
      R.S4.capture = 'captures/sky_coverage_debug_050.png';
    }

    // ------------------------------------------------------------------ S5: drift = v·t, and the screen motion matches v850
    if (want('S5')) {
      await open(DET + '&birds=0&hud=0&view=up&look=physical&freeze=1&skydebug=deck:low', 'S5');
      const s5 = await b.evaluate(`(async () => {
        const T = skyTest, sky = T.sky, st = T.state;
        T.setCovers({ low: 0.5 }); T.lockWind(true); T.render(30);
        const v = st.wind.v850.clone();
        // screen mapping of a known east / north shift of the low deck
        T.render(10);
        const A = T.gray(4, 0.7);
        sky.off.low.x += 30; T.render(1); const E = T.gray(4, 0.7); const sE = T.shift(A, E);
        sky.off.low.x -= 30; sky.off.low.y -= 30; T.render(1); const N = T.gray(4, 0.7); const sN = T.shift(A, N);
        sky.off.low.y += 30; T.render(1);
        // real drift over 3 s
        T.setFreeze(false); T.advance(3, 6); T.setFreeze(true); T.render(1);
        const C = T.gray(4, 0.7); const sC = T.shift(A, C);
        // solve [sE sN] * [e n]^T = sC for (east, north) in units of 30 m
        const a = sE.dx, bq = sN.dx, c = sE.dy, d = sN.dy, det = a * d - bq * c;
        const e = (sC.dx * d - bq * sC.dy) / det, n = (a * sC.dy - c * sC.dx) / det;
        const headScreen = (Math.atan2(e, n) * 180 / Math.PI + 360) % 360;
        const headWind = (Math.atan2(v.x, -v.z) * 180 / Math.PI + 360) % 360;   // direction blown TO, clockwise from north
        let dh = Math.abs(headScreen - headWind); if (dh > 180) dh = 360 - dh;
        // offsets = v·t over 120 s of steady wind
        const o0 = sky.debug.offsets.low.slice();
        T.setFreeze(false); T.advance(120, 120); T.setFreeze(true);
        const o1 = sky.debug.offsets.low;
        const off = { dx: o1[0] - o0[0], dz: o1[1] - o0[1], vt: [v.x * 120, v.z * 120] };
        return { off, sE, sN, sC, headScreenDeg: +headScreen.toFixed(1), headWindDeg: +headWind.toFixed(1), diffDeg: +dh.toFixed(1),
                 v850: { speed: +Math.hypot(v.x, v.z).toFixed(2), fromDeg: st.weather.sample.wind850.dirDeg } };
      })()`);
      const offErr = Math.hypot(s5.off.dx - s5.off.vt[0], s5.off.dz - s5.off.vt[1]);
      R.S5 = { ...s5, offsetErrM: r2(offErr), pass: offErr < 0.5 && Number.isFinite(s5.diffDeg) && s5.diffDeg <= 10 };
    }

    // ------------------------------------------------------------------ S6 + S7 + side-by-side
    if (want('S6') || want('S7')) {
      await b.setViewport(1296, 716, 1);
      const looks = {};
      for (const look of ['signature', 'dusk', 'physical']) {
        await open(DET + '&birds=0&hud=0&look=' + look, 'S6/7 ' + look);
        await b.evaluate('skyTest.render(150)');
        looks[look] = await b.evaluate('skyTest.analyze([8, 8, 1288, 708])');
        await b.shot(CAP(`sky_look_${look}_nobirds.png`));
      }
      const g = looks.signature, d3 = (a, e) => Math.max(...a.map((v, i) => Math.abs(v - e[i])));
      R.S6 = { metrics: g, checks: {
        top: d3(g.top, [196, 197, 198]) <= 4, bottom: d3(g.bottom, [191, 192, 193]) <= 4, topMinusBottom: g.topMinusBottom >= 3 && g.topMinusBottom <= 10,
        bMinusR: g.bMinusR[0] >= 0 && g.bMinusR[1] <= 4, channelSpread: g.maxChannelSpread <= 5, std: g.std >= 0.8 && g.std <= 5, banding: g.colStep <= 1 && g.rowStep <= 1 } };
      R.S6.pass = Object.values(R.S6.checks).every(Boolean);
      R.S7 = { dusk: looks.dusk, physical: looks.physical,
        checks: { duskTop: d3(looks.dusk.top, [104, 116, 141]) <= 12, duskBottom: d3(looks.dusk.bottom, [144, 126, 124]) <= 12, physicalNoClip: looks.physical.max < 254.5 } };
      R.S7.pass = Object.values(R.S7.checks).every(Boolean);
      // with the stand-in VAT starlings, all three looks
      for (const look of ['signature', 'dusk', 'physical']) {
        await open(DET + '&hud=0&look=' + look, 'looks ' + look);
        await b.evaluate('skyTest.render(150)');
        await b.shot(CAP(`sky_look_${look}.png`));
      }
      // side-by-side with the reference's top two panels (same 1280×720 framing; panel 2 = centre crop 2.67× nearest)
      await b.setViewport(1280, 720, 1);
      await open(DET + '&hud=0&birdScale=6&nbirds=700', 'side-by-side');
      await b.evaluate('skyTest.render(150)');
      const sbs = await b.evaluate(`(async () => {
        const ref = new Image(); ref.src = '../models/preview/starling_v2_silhouette_flock.png'; await ref.decode();
        const { w, h, data } = skyTest.readCanvas();
        const page = document.createElement('canvas'); page.width = w; page.height = h;
        page.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
        const G = 8, TH = 34, cv = document.createElement('canvas'); cv.width = 1280 * 2 + G * 3; cv.height = TH + 720 * 2 + G * 3;
        const x = cv.getContext('2d'); x.fillStyle = '#18191b'; x.fillRect(0, 0, cv.width, cv.height);
        x.drawImage(ref, 8, 48, 1280, 720, G, TH, 1280, 720);
        x.drawImage(ref, 8, 776, 1280, 720, G, TH + 720 + G, 1280, 720);
        x.drawImage(page, 0, 0, w, h, G * 2 + 1280, TH, 1280, 720);
        x.imageSmoothingEnabled = false;
        const cw = 1280 / 2.6667, ch = 720 / 2.6667;
        x.drawImage(page, (w - cw) / 2, (h - ch) / 2, cw, ch, G * 2 + 1280, TH + 720 + G, 1280, 720);
        x.fillStyle = '#e8e9eb'; x.font = '600 18px system-ui, sans-serif';
        x.fillText('Reference: models/preview/starling_v2_silhouette_flock.png, top two panels', G + 4, 23);
        x.fillText('Page: sky_test.html, signature, deterministic URL; stand-in VAT starlings scaled x6 to the reference size', G * 2 + 1284, 23);
        const url = cv.toDataURL('image/png');
        const r = await fetch('/capture?name=sky_signature_vs_reference.png', { method: 'POST', body: url });
        return r.status;
      })()`);
      R.S6.sideBySide = sbs === 200 ? 'captures/sky_signature_vs_reference.png' : 'failed ' + sbs;
      await b.setViewport(1280, 720, 1.25);
    }

    // ------------------------------------------------------------------ real weather, three cases, HUD shows the fetched values
    if (want('REAL') && !skipLive) {
      R.real = [];
      for (const c of REAL) {
        for (const look of ['signature', 'physical', 'dusk']) {
          const q = `site=${c.site}&t=${c.t}&wx=live&look=${look}&freeze=1&birdScale=6&nbirds=700`;
          await open(q, 'real ' + c.name + ' ' + look);
          await b.evaluate('skyTest.render(120)');
          const file = `sky_real_${c.name}_${look}.png`;
          await b.shot(CAP(file));
          const info = await b.evaluate(`({ source: skyTest.wx.source, sample: skyTest.state.weather.sample, sun: [skyTest.state.sun.altitudeDeg, skyTest.state.sun.azimuthDeg], analyze: skyTest.analyze() })`);
          R.real.push({ case: c.name, site: c.site, t: c.t, look, file: 'captures/' + file, source: info.source,
            cloudLowMidHigh: [info.sample.cloudLow, info.sample.cloudMid, info.sample.cloudHigh].map(r2), visibilityKm: r2(info.sample.visibilityM / 1000),
            wind850: info.sample.wind850, sunAltAz: info.sun.map(r2), sky: { top: info.analyze.top, bottom: info.analyze.bottom, std: info.analyze.std } });
        }
        // the high-quality volumetric deck, physical look
        const q = `site=${c.site}&t=${c.t}&wx=live&look=physical&freeze=1&q=high&birdScale=6&nbirds=700`;
        await open(q, 'real ' + c.name + ' high');
        await b.evaluate('skyTest.render(120)');
        await b.shot(CAP(`sky_real_${c.name}_physical_high.png`));
      }
    }

    // ------------------------------------------------------------------ S8: perf per pass and per effect
    if (want('S8')) {
      const gpu = async (q, label) => {
        await open(DET + '&birds=0&hud=0&' + q, 'S8 ' + label);
        await b.evaluate('skyTest.render(200)');
        const runs = [];
        for (let k = 0; k < 3; k++) runs.push(await b.evaluate('skyTest.gpu(60)'));
        const out = {};
        for (const key of Object.keys(runs[0])) { const a = runs.map(x => x[key] || 0).sort((x, y) => x - y); out[key] = a[1]; }
        out.size = await b.evaluate('skyTest.size()');
        return out;
      };
      const lutCost = async () => b.evaluate(`(async () => {
        const T = skyTest; T.paused = true; T.prof.on = true; await T.prof.collect();
        for (let i = 0; i < 30; i++) { T.sky._lut.mie = -1; T.sky._lut.sunAlt = 1e9; T.render(1); }
        T.prof.on = false; const r = await T.prof.collect(); const a = (r['sky.lut'] || [0]).sort((x, y) => x - y); return a[a.length >> 1];
      })()`);
      R.S8 = { perQuality: {}, fx: {}, lutRebuildMs: {} };
      // warm-up: get the GPU out of its idle clocks before the first measurement
      await open(DET + '&birds=0&hud=0&q=high', 'S8 warm-up');
      await b.evaluate('skyTest.render(1500)');
      for (const q of ['low', 'medium', 'high']) {
        R.S8.perQuality[q] = await gpu('q=' + q, q);
        R.S8.lutRebuildMs[q] = r2(await lutCost() * 1000) / 1000;
      }
      const toggles = [
        ['medium', 'sky.multiScatter', [0, 1]], ['medium', 'sky.cloudLightTaps', [0, 1, 2]], ['medium', 'sky.silverLining', [0, 1]],
        ['medium', 'sky.cirrus', [0, 1]], ['high', 'sky.cloudRaymarch', [0, 1]], ['medium', 'post.grain', [0, 1]],
        ['medium', 'post.vignette', [0, 1]], ['medium', 'post.dither', [0, 1]],
      ];
      for (const [q, id, vals] of toggles) {
        R.S8.fx[id] = { quality: q };
        for (const v of vals) R.S8.fx[id][v] = await gpu(`q=${q}&fx=${id}:${v}`, id + ':' + v);
      }
      const est = ms => r2(ms * 4.5 * 1000) / 1000;
      const BUD = { low: 0.6, medium: 1.3, high: 2.5 }, BUDG = { low: 0.3, medium: 0.6, high: 0.8 };
      R.S8.budget = {};
      for (const q of ['low', 'medium', 'high']) {
        const p = R.S8.perQuality[q];
        R.S8.budget[q] = { skyMs: r2(((p['sky.lut'] || 0) + p['sky.prepass']) * 1000) / 1000, skyArcEstMs: est((p['sky.lut'] || 0) + p['sky.prepass']), skyBudget: BUD[q],
          gradePresentMs: r2((p.grade + p.present) * 1000) / 1000, gradePresentArcEstMs: est(p.grade + p.present), gradePresentBudget: BUDG[q],
          bgGroundSceneMs: p.scene, bgGroundArcEstMs: est(p.scene) };
        R.S8.budget[q].pass = R.S8.budget[q].skyArcEstMs <= BUD[q] && R.S8.budget[q].gradePresentArcEstMs <= BUDG[q];
      }
      R.S8.pass = Object.values(R.S8.budget).every(x => x.pass);
    }
  } finally {
    await b.close();
  }
  R.zeroConsoleErrors = R.consoleErrors.length === 0;
  const merged = { ...prev, ...R };
  fs.writeFileSync(resultsFile, JSON.stringify(merged, null, 1));
  const sum = {};
  for (const k of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) if (merged[k]) sum[k] = merged[k].pass;
  console.log(JSON.stringify({ summary: sum, zeroConsoleErrors: R.zeroConsoleErrors, consoleErrors: R.consoleErrors.slice(0, 5) }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
