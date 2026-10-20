// Tiny static server for testing:  node tests/trails/serve.js [port]
// POST /capture?name=foo.png with a PNG data URL body saves it to captures/ (used for verification shots,
// since the preview pane stops painting when it is hidden).
// Hardened: a bad request (malformed URL, aborted upload, read error) answers with an error instead of taking the
// whole server down, and the process logs and survives anything that slips through.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');   // ROOT (tests/trails/ -> murmuration/)
const port = Number(process.argv[2] || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.webp': 'image/webp', '.css': 'text/css', '.svg': 'image/svg+xml' };
const fail = (res, code, msg) => { try { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg || String(code)); } catch (e) { /* socket gone */ } };
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/capture') {
      const name = path.basename(url.searchParams.get('name') || 'capture.png').replace(/[^\w.-]/g, '_');
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('error', () => fail(res, 400));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const b64 = body.slice(body.indexOf(',') + 1);
          const dir = path.join(root, 'captures');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('saved ' + name);
        } catch (e) { fail(res, 500, e.message); }
      });
      return;
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (e) { return fail(res, 400, 'bad url'); }
    const p = path.normalize(rel).replace(/^([\\/])+/, '');
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root)) return fail(res, 403);
    fs.readFile(file, (err, data) => {
      if (err) return fail(res, 404, 'not found');
      try {
        res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      } catch (e) { /* client went away */ }
    });
  } catch (e) {
    console.error('request error:', e.message);
    fail(res, 500);
  }
});
server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ } });
server.on('error', e => { console.error('server error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
process.on('uncaughtException', e => console.error('uncaught:', (e && e.stack) || e));
server.listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
