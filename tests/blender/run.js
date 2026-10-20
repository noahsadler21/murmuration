// Blender-asset tests B1-B6 in headless Chrome over CDP (Node built-ins only; harness pattern copied from
// tests/trails/run.js / monkey-school perf_quick.js). Starts tests/blender/serve.js on a free port, loads
// tests/blender/load.html at 1280x720 CSS, DPR 1.25, runs runTests(), saves captures/blender_load.png, merges the
// Blender-side reports (models/blend/*.json) and writes tests/blender/results.json; then stops server + browser.
//   node tests/blender/run.js
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const ROOT = path.join(__dirname, '..', '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const readJSON = p => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (e) { return null; } };

(async () => {
  const httpPort = await freePort(), dbgPort = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(httpPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[serve] ' + d));
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'blenderq_'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${udd}`, '--window-size=1280,720',
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let ws; const results = { date: new Date().toISOString(), browser: CHROME };
  try {
    let tgt;
    for (let i = 0; i < 60 && !tgt; i++) { await sleep(400); try { tgt = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { } }
    ws = new WebSocket(tgt.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map(); const logs = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description).join(' '));
      else if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
      else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalp = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text); return r.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1.25, mobile: false });
    await send('Page.navigate', { url: `http://localhost:${httpPort}/tests/blender/load.html` });
    const t0 = Date.now();
    while (!(await evalp('!!window.ready').catch(() => false))) { if (Date.now() - t0 > 60000) throw new Error('page not ready: ' + logs.join(' | ')); await sleep(250); }
    const r = await evalp('runTests()');
    results.gpu = await evalp(`(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; })()`);
    const png = await evalp('window.capture()');
    fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'captures', 'blender_load.png'), Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
    results.B5_load = r;
    results.consoleErrors = logs.filter(l => !/favicon/i.test(l));
    // Blender-side numbers (B1 tail, B2 VAT round trip, B4 falcon)
    results.B1_tail = { build: readJSON('models/blend/s3_meta.json'), glide: readJSON('models/preview/_tiles_peregrine/tail_measure.json') };
    results.B2_vat_blender = readJSON('models/blend/s8_vat_report.json');
    const p5 = readJSON('models/blend/p5_report.json'), p4 = readJSON('models/blend/p4_real_report.json'), p4r = readJSON('models/blend/p4_retro_report.json');
    results.B4_falcon = { rig: p5, plumage_real: p4, plumage_retro: p4r };
    const B = {};
    const vatErr = (results.B2_vat_blender || []).every(v => Object.values(v.errMm).every(e => e <= 0.3));
    B.B1 = !!(results.B1_tail.glide && results.B1_tail.glide.v3.tailBehindWingtipsCm <= 4.0 && results.B1_tail.build.TAIL_Y1 >= 0.076 && results.B1_tail.build.TAIL_Y1 <= 0.084);
    B.B2 = vatErr && r.starling.every(s => !s.errors.length && s.verts <= 4096);
    B.B3 = r.starling.every(s => s.triOK) && r.peregrine.every(s => s.triOK);
    const ok4 = p => { const d = p.dorsalMeanSRGB; return d.every(c => c >= 65 && c <= 100) && d[2] >= d[0] + 4 && p.dorsalSaturation <= 0.15 && p.underpartsMeanL >= 75 && p.underpartsBarHighpassStdCodes >= 6 && p.malarMeanL <= 20; };
    B.B4 = !!(p5 && ['real', 'retro'].every(v => p5[v].glideSpanM >= 0.95 && p5[v].glideSpanM <= 1.10 && p5[v].lengthM >= 0.38 && p5[v].lengthM <= 0.46 &&
      p5[v].stoopAreaFracOfGlide <= 0.25 && p5[v].stoop.topWidthM <= 0.16) && ok4(p4) && ok4(p4r));
    B.B5 = r.pass && !results.consoleErrors.length;
    const sheets = ['peregrine_scan_views.png', 'peregrine_lowpoly_compare.png', 'peregrine_poses.png', 'peregrine_vs_starling_scale.png', 'peregrine_colour_remap.png', 'starling_v3_tail.png'];
    B.B6 = sheets.every(s => fs.existsSync(path.join(ROOT, 'models', 'preview', s)));
    results.pass = B;
    console.log(JSON.stringify({ pass: B, gpu: results.gpu, consoleErrors: results.consoleErrors, load: r }, null, 1));
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 1));
  } finally {
    try { ws && ws.close(); } catch (e) { }
    chrome.kill(); server.kill();
    await sleep(800);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { }
  }
})().catch(e => { console.error(e); process.exit(1); });
