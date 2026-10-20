// Finds real site/date/time cases for the clear / broken / overcast screenshots. The page itself makes the
// Open-Meteo calls (src/weather.js fetchWeather), exactly as the app does at runtime.
//   node tests/sky/scan.js [daysBack=10]
const { start } = require('./cdp.js');
(async () => {
  const daysBack = +(process.argv[2] || 10);
  const b = await start({ width: 800, height: 450, dpr: 1 });
  try {
    await b.open('tests/sky_test.html?wx=sample:overcast&birds=0&hud=0');
    const res = await b.evaluate(`(async () => {
      const W = await import('../src/weather.js');
      const out = [];
      const today = W.localDateOf(Date.now(), 'Europe/London');
      for (let k = 1; k <= ${daysBack}; k += 1) {
        const D = W.addDays(today, -k);
        for (const site of W.SITES) {
          try {
            const wx = await W.fetchWeather(site, D, { wx: 'live' });
            const st = W.sunTimes(D, site.lat, site.lon);
            for (const dtMin of [-150, -90, -40, -10]) {
              const t = st.sunsetMs + dtMin * 60000;
              const s = W.sampleWeather(wx, t);
              out.push({ site: site.id, D, t: new Date(t).toISOString().slice(0, 16) + ':00Z', dtMin, src: wx.source,
                low: Math.round(s.cloudLow * 100), mid: Math.round(s.cloudMid * 100), high: Math.round(s.cloudHigh * 100), total: Math.round(s.cloudCover * 100), vis: Math.round(s.visibilityM / 1000) });
            }
          } catch (e) { out.push({ site: site.id, D, error: String(e) }); }
        }
      }
      return out;
    })()`);
    const ok = res.filter(r => !r.error);
    const pick = (f, sc) => ok.filter(f).sort(sc)[0];
    const clear = pick(r => r.low <= 8 && r.mid <= 10, (a, b) => (a.low + a.mid + a.high * 0.3) - (b.low + b.mid + b.high * 0.3));
    const broken = pick(r => r.low >= 35 && r.low <= 70, (a, b) => Math.abs(a.low - 52) + a.mid * 0.2 - (Math.abs(b.low - 52) + b.mid * 0.2));
    const overcast = pick(r => r.low >= 95, (a, b) => b.low - a.low);
    console.log(JSON.stringify({ n: ok.length, errors: res.length - ok.length, clear, broken, overcast }, null, 1));
    console.log('broken candidates:', JSON.stringify(ok.filter(r => r.low >= 30 && r.low <= 75).slice(0, 12)));
    console.log('clear candidates:', JSON.stringify(ok.filter(r => r.low <= 10 && r.mid <= 15).slice(0, 12)));
  } finally { await b.close(); }
})().catch(e => { console.error(e); process.exit(1); });
