// Minimal headless-Chrome-over-CDP harness (Node ≥ 22 built-in WebSocket/fetch; no packages). After
// monkey-school/models/test/perf_quick.js. Starts tests/sky/serve.js on a free port and Chrome on the Arc iGPU
// (--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist), and gives you send / evaluate / screenshot / logs.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const ROOT = path.join(__dirname, '..', '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function start({ width = 1280, height = 720, dpr = 1.25 } = {}) {
  const httpPort = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(httpPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('serving')) res(); }); server.on('exit', c => rej(new Error('server exit ' + c))); });
  const cdpPort = await freePort();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'skyt_'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${udd}`, `--window-size=${width},${height}`,
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--no-first-run', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  let tgt;
  for (let i = 0; i < 60 && !tgt; i++) { await sleep(400); try { tgt = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { } }
  if (!tgt) throw new Error('chrome did not start');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const logs = []; const requests = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push({ type: m.params.type, text: m.params.args.map(a => a.value !== undefined ? a.value : a.description).join(' ') });
    else if (m.method === 'Runtime.exceptionThrown') logs.push({ type: 'exception', text: (m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text });
    else if (m.method === 'Log.entryAdded') logs.push({ type: 'log-' + m.params.entry.level, text: m.params.entry.text + ' ' + (m.params.entry.url || '') });
    else if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
  const setViewport = (w, h, d) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: d, mobile: false });
  await setViewport(width, height, dpr);
  const base = `http://localhost:${httpPort}/`;
  return {
    base, send, evaluate, logs, requests, setViewport,
    async open(rel, { timeout = 90000 } = {}) {
      logs.length = 0;
      await send('Page.navigate', { url: base + rel });
      const t0 = Date.now();
      for (;;) {
        await sleep(250);
        const ok = await evaluate('!!(window.skyTest && window.skyTest.ready) || (window.skyTest && window.skyTest.errors.length ? "err" : false)').catch(() => false);
        if (ok === true) return;
        if (ok === 'err') throw new Error('page error: ' + await evaluate('JSON.stringify(skyTest.errors)'));
        if (Date.now() - t0 > timeout) throw new Error('timeout opening ' + rel + ' logs: ' + JSON.stringify(logs.slice(-8)));
      }
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    errors() { return logs.filter(l => (l.type === 'error' || l.type === 'exception' || l.type === 'log-error') && !/favicon/i.test(l.text)); },
    async close() { try { ws.close(); } catch (e) { } chrome.kill(); server.kill(); await sleep(700); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { } },
  };
}
module.exports = { start, sleep, ROOT };
