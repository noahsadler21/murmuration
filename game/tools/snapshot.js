// Freeze the game into ONE self-contained HTML file:  node game/tools/snapshot.js [out.html]
// Every game module is embedded and loaded from a blob URL (the page's import map still resolves 'three' from the
// CDN), and every starling asset the game uses is embedded as base64, so the file opens on its own (double-click or
// any server) and keeps this exact version even after the assets in assets/birds/ are rebaked.
const fs = require('fs');
const path = require('path');
const GAME = path.join(__dirname, '..');
const ROOT = path.join(GAME, '..');
const out = path.resolve(process.argv[2] || path.join(GAME, 'snapshots', 'one-bird-' + new Date().toISOString().slice(0, 10) + '.html'));

// modules in dependency order (each may import only earlier ones)
const MODS = ['shaders.js', 'birds.js', 'flock.js', 'player.js', 'fx.js', 'fish.js', 'audio.js', 'main.js'];
const src = {};
for (const m of MODS) src[m] = fs.readFileSync(path.join(GAME, m), 'utf8');
// asset reads go through __A(url), which maps a file name to its embedded blob
src['birds.js'] = src['birds.js'].replace(/\b(fetch|texLoader\.load)\((base \+ [^,)]+)/g, '$1(__A($2)');
if (!/__A\(/.test(src['birds.js'])) throw new Error('asset hook not applied (birds.js changed?)');

const assets = {};
const dir = path.join(ROOT, 'assets', 'birds');
for (const l of ['real', 'retro', 'sil', 'micro']) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `starling_${l}.json`), 'utf8'));
  const files = [`starling_${l}.json`, `starling_${l}.bin`];
  if (l === 'real' || l === 'retro') for (const t of Object.values(meta.textures || {})) if (t) files.push(t);
  for (const f of files) assets[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
}
const type = (f) => (f.endsWith('.json') ? 'application/json' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream');

let html = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
const loader = `
<script id="snap-assets" type="application/json">${JSON.stringify(Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, [type(k), v]])))}</script>
${MODS.map((m) => `<script id="snap-${m}" type="text/plain">${src[m].replace(/<\/script/gi, '<\\/script')}</script>`).join('\n')}
<script type="module">
// snapshot loader: embedded assets → blob URLs; embedded modules → blob modules, imports rewritten in order
const A = JSON.parse(document.getElementById('snap-assets').textContent);
const blobs = {};
for (const [k, [t, b64]] of Object.entries(A)) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  blobs[k] = URL.createObjectURL(new Blob([u8], { type: t }));
}
window.__A = (url) => blobs[String(url).split('/').pop()] || url;
const urls = {};
for (const m of ${JSON.stringify(MODS)}) {
  let code = document.getElementById('snap-' + m).textContent;
  code = code.replace(/from '\\.\\/([\\w-]+\\.js)'/g, (s, f) => "from '" + urls[f] + "'");
  urls[m] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}
import(urls['main.js']);
</script>`;
html = html.replace(/<script type="module" src="\.\/main\.js"><\/script>/, () => loader);
if (!html.includes('snap-assets')) throw new Error('main.js script tag not found in index.html');
// the "murmuration under real weather" link points at the live site, since the snapshot may live anywhere
html = html.replace('href="../index.html"', 'href="https://noahsadler21.github.io/murmuration/"');
const ver = require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
html = html.replace('<title>One Bird</title>', `<title>One Bird</title>\n<!-- snapshot of game/ at ${ver}, ${new Date().toISOString()} -->`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(1)} MB, commit ${ver})`);
