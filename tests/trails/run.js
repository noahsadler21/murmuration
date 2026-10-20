// Trails + UI tests in headless Chrome over CDP (Node built-ins only; harness pattern copied from
// monkey-school/models/test/perf_quick.js). Starts tests/trails/serve.js on a free port, runs
// trails_test.html (T1–T6, T8) and ui_test.html (T7), writes tests/trails/results.json and captures/trails_*.png,
// captures/ui_*.png, then stops the server and the browser.
//   node tests/trails/run.js [--only trails|ui]
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const httpPort = await freePort(), dbgPort = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(httpPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[serve] ' + d));
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'trailsq_'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${udd}`, '--window-size=1280,720',
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let ws; const results = { date: new Date().toISOString() };
  const resPath = path.join(__dirname, 'results.json');
  try { Object.assign(results, JSON.parse(fs.readFileSync(resPath, 'utf8'))); results.date = new Date().toISOString(); } catch (e) { }
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
    const metrics = (w, h, dsf, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile });
    const nav = async (url) => {
      logs.length = 0;
      await send('Page.navigate', { url: `http://localhost:${httpPort}/${url}` });
      const t0 = Date.now();
      while (!(await evalp('!!window.ready').catch(() => false))) { if (Date.now() - t0 > 60000) throw new Error('page not ready: ' + logs.join(' | ')); await sleep(250); }
    };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'captures', name), Buffer.from(r.data, 'base64')); };
    const cleanLogs = () => logs.filter(l => !/favicon/i.test(l));
    await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

    if (!only || only === 'trails') {
      await metrics(1280, 720, 1.25);
      await nav('tests/trails/trails_test.html');
      const t0 = Date.now();
      const r = await evalp('runTests()');
      r.seconds = (Date.now() - t0) / 1000;
      r.consoleErrors = cleanLogs();
      results.trails = r;
      console.log(JSON.stringify(r, null, 1));
    }
    if (!only || only === 'ui') {
      await metrics(1280, 720, 1.25);
      await nav('tests/trails/ui_test.html');
      const ui = await evalp('uiChecks()');
      ui.contrast = {};
      for (const look of ['signature', 'physical', 'dusk']) {
        await evalp(`(async () => { uiState.mode = 'live'; await setLookBg('${look}'); showPanel('noise'); })()`);
        await sleep(150);
        const c1 = await evalp('contrastReport()');
        await shot(`ui_${look}.png`);
        await evalp(`showPanel('place')`); await sleep(100);
        const c2 = await evalp('contrastReport()');
        await evalp(`showPanel('credits')`); await sleep(100);
        const c3 = await evalp('contrastReport()');
        if (look === 'signature') await shot('ui_credits.png');
        await evalp(`(async () => { uiState.mode = 'ornito'; uiState.ornito.done = 150; uiState.emit('ornito:frame', {done: 150, frames: 150, finished: true}); showPanel(null); })()`);
        await sleep(100);
        const c4 = await evalp('contrastReport()');
        ui.contrast[look] = { min: Math.min(c1.min, c2.min, c3.min, c4.min), worst: [c1, c2, c3, c4].flatMap(c => c.worst).sort((a, b) => a.cr - b.cr).slice(0, 4) };
      }
      await evalp(`(async () => { uiState.mode = 'ornito'; uiState.ornito.done = 400; uiState.ornito.frames = 400; uiState.emit('ornito:frame', {done: 400, frames: 400, finished: true}); await setLookBg('signature', '/captures/trails_all_darken.png'); })()`);
      await sleep(200); await shot('ui_ornito.png');
      ui.layoutDesktop = await evalp('layoutCheck()');
      // phone
      await metrics(375, 812, 2, true);
      await nav('tests/trails/ui_test.html');
      await evalp(`(async () => { await setLookBg('signature'); })()`); await sleep(200);
      ui.layoutPhone = await evalp('layoutCheck()');
      ui.phoneQualityDefault = await evalp('uiState.quality');
      await shot('ui_phone.png');
      await evalp(`showPanel('noise')`); await sleep(100);
      ui.layoutPhoneNoise = await evalp('layoutCheck()');
      await shot('ui_phone_noise.png');
      await evalp(`(async () => { uiState.mode = 'ornito'; await setLookBg('dusk'); })()`); await sleep(150);
      ui.layoutPhoneOrnito = await evalp('layoutCheck()');
      ui.contrastPhoneDusk = await evalp('contrastReport()');
      await shot('ui_phone_ornito.png');
      await evalp(`(async () => { showPanel(null); await setLookBg('signature'); })()`); await sleep(150);
      ui.layoutPhoneOrnitoPanel = await evalp('layoutCheck()');
      await shot('ui_phone_ornito_panel.png');
      await evalp(`(async () => { uiState.ornito.running = true; uiState.emit('ornito:frame', {done: 61, frames: 150}); await setLookBg('signature', '/captures/trails_all_darken.png'); })()`); await sleep(200);
      ui.phoneFoldedWhileRunning = await evalp(`document.getElementById('ornitoPanel').classList.contains('folded')`);
      ui.layoutPhoneRunning = await evalp('layoutCheck()');
      await shot('ui_phone_running.png');
      ui.consoleErrors = cleanLogs();
      const minC = Math.min(...Object.values(ui.contrast).map(c => c.min), ui.contrastPhoneDusk.min);
      ui.contrastMin = minC;
      ui.T7pass = ui.pass && minC >= 4.5 && ui.layoutPhone.scrollW <= 375 && !ui.layoutPhone.overflow.length && !ui.layoutPhoneNoise.overflow.length && !ui.layoutPhoneOrnitoPanel.overflow.length && ui.phoneFoldedWhileRunning &&
        !ui.layoutDesktop.overCentre.length && ui.phoneQualityDefault === 'low' && !ui.consoleErrors.length;
      results.ui = ui;
      console.log(JSON.stringify(ui, null, 1));
    }
    fs.writeFileSync(resPath, JSON.stringify(results, null, 1));
  } finally {
    try { ws && ws.close(); } catch (e) { }
    chrome.kill(); server.kill();
    await sleep(800);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { }
  }
})().catch(e => { console.error(e); process.exit(1); });
