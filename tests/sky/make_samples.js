// Writes the bundled offline samples assets/weather/sample_{overcast,clear}.json from weather.js's generator
// (SPEC §5.1: Sky-authored, Open-Meteo response format, "synthetic": true, 72 h). No dependencies:
//   node tests/sky/make_samples.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
(async () => {
  let src = fs.readFileSync(path.join(ROOT, 'src', 'weather.js'), 'utf8');
  // weather.js imports three only for MathUtils.clamp / Vector3; stub them so node can load the module
  src = src.replace("import * as THREE from 'three';",
    'const THREE = { MathUtils: { clamp: (v, a, b) => Math.min(b, Math.max(a, v)) }, Vector3: class { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } } };');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const out = path.join(ROOT, 'assets', 'weather');
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['overcast', 'clear']) {
    const j = mod.makeSyntheticSample(name, Date.parse('2025-11-19T00:00:00Z'));
    fs.writeFileSync(path.join(out, `sample_${name}.json`), JSON.stringify(j));
    console.log(`sample_${name}.json: ${j.hourly.time.length} h, low ${j.hourly.cloud_cover_low[40]} %, mid ${j.hourly.cloud_cover_mid[40]} %, high ${j.hourly.cloud_cover_high[40]} %`);
  }
})();
