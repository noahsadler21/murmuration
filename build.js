// build.js (SPEC §8): node build.js   (no dependencies)
//  * copies src/*.js → assets/js/
//  * writes index.html from template.html with %BUILD% = timestamp + short hash
//  * writes assets/manifest.json (files, bytes, sha1)
//  * checks that every asset in SPEC §6.2 and §6.4 exists (exit code 1 if any is missing)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const ASSETS = path.join(ROOT, 'assets');
const JS = path.join(ASSETS, 'js');

const REQUIRED = [
  // §6.2 starling VATs + textures + credits
  ...['real', 'retro', 'sil', 'micro'].flatMap((l) => [`birds/starling_${l}.json`, `birds/starling_${l}.bin`]),
  'birds/starling_real_albedo.png', 'birds/starling_real_mask.png', 'birds/starling_real_normal.png',
  'birds/starling_retro_albedo.png', 'birds/starling_retro_mask.png', 'birds/CREDITS.json',
  // §6.4 peregrine
  'birds/peregrine_real.glb', 'birds/peregrine_retro.glb',
  // §5.1 bundled weather samples
  'weather/sample_overcast.json', 'weather/sample_clear.json',
];

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// 1. JS
fs.mkdirSync(JS, { recursive: true });
for (const f of fs.readdirSync(JS)) if (f.endsWith('.js') && !fs.existsSync(path.join(SRC, f))) fs.unlinkSync(path.join(JS, f));
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
const h = crypto.createHash('sha1');
for (const f of srcFiles) {
  const buf = fs.readFileSync(path.join(SRC, f));
  h.update(f).update(buf);
  fs.writeFileSync(path.join(JS, f), buf);
}

// 2. asset check
const missing = REQUIRED.filter((r) => !fs.existsSync(path.join(ASSETS, r)));

// 3. manifest
const files = walk(ASSETS).filter((f) => f !== 'manifest.json').sort().map((f) => {
  const buf = fs.readFileSync(path.join(ASSETS, f));
  h.update(f).update(sha1(buf));
  return { path: f, bytes: buf.length, sha1: sha1(buf) };
});
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const BUILD = `${stamp}-${h.digest('hex').slice(0, 8)}`;
fs.writeFileSync(path.join(ASSETS, 'manifest.json'), JSON.stringify({ build: BUILD, files }, null, 1));

// 4. index.html
const tpl = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8');
fs.writeFileSync(path.join(ROOT, 'index.html'), tpl.split('%BUILD%').join(BUILD));

const total = files.reduce((a, f) => a + f.bytes, 0);
console.log(`build ${BUILD}: ${srcFiles.length} modules → assets/js/, ${files.length} asset files (${(total / 1e6).toFixed(2)} MB), index.html written`);
if (missing.length) { console.error('MISSING assets:\n  ' + missing.join('\n  ')); process.exit(1); }
console.log('all SPEC §6.2 / §6.4 assets present');
