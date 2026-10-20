// Minimal headless-Chrome-over-CDP session (Node built-ins only), copied from tests/integration/cdp.js for the game.
// Starts tools/serve.js on a free port and Chrome (ANGLE D3D11, GPU on), and exposes nav / evalp / shot / close.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const ROOT = path.join(__dirname, '..', '..');   // repo root (game/tests → ../..)
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function open({ width = 1280, height = 720, dsf = 1.25 } = {}) {
  const httpPort = await freePort(), dbgPort = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(httpPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write('[serve] ' + d));
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'onebird_'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${udd}`, `--window-size=${width},${height}`,
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--no-first-run', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  let tgt;
  for (let i = 0; i < 80 && !tgt; i++) { await sleep(300); try { tgt = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page'); } catch (e) { } }
  if (!tgt) throw new Error('chrome did not start');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
    else if (m.method === 'Log.entryAdded') logs.push('log.' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 1800000 });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false });
  const nav = async (url) => {
    logs.length = 0;
    await send('Page.navigate', { url: `http://localhost:${httpPort}/${url}` });
    const t0 = Date.now();
    while (!(await evalp('!!window.ready').catch(() => false))) {
      if (Date.now() - t0 > 90000) throw new Error('page not ready: ' + logs.join(' | '));
      await sleep(250);
    }
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'captures', name), Buffer.from(r.data, 'base64'));
  };
  const errors = () => logs.filter((l) => /^(error|exception|log\.error|warning)/.test(l) && !/favicon/i.test(l));
  const close = async () => { try { ws.close(); } catch (e) { } chrome.kill(); server.kill(); await sleep(600); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { } };
  return { send, evalp, nav, shot, logs, errors, close, ROOT, httpPort };
}
module.exports = { open, sleep };

// CLI:  node tests/integration/cdp.js "<page?query>" "<js expression>" [more expressions...]
if (require.main === module) {
  (async () => {
    const [url, ...exprs] = process.argv.slice(2);
    const s = await open();
    try {
      await s.nav(url);
      for (const e of exprs) {
        const t0 = Date.now();
        const v = await s.evalp(e);
        console.log(`> ${e.slice(0, 100)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
      const er = s.errors();
      console.log('console:', er.length ? er.join('\n  ') : 'clean');
      if (process.env.ALLLOGS) console.log(s.logs.join('\n'));
    } finally { await s.close(); }
  })().catch((e) => { console.error(e); process.exit(1); });
}
