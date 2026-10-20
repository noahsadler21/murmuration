// ui.js: the page's controls (SPEC §7.2). Builds no WebGL. Reads `state`, writes only UI-owned fields
// (state.noise.* sliders, state.ornito.* settings, state.time.scale) and emits the §2 events.
// Markup lives in template.html (pinned ids); this module wires it, fills the dynamic parts and keeps every
// aria-pressed / readout in sync from `state` on a 4 Hz tick, so changes made elsewhere (URL params, keys,
// the integrator) always show.
//
// Events beyond the §2 table (payload extensions, all optional for the integrator):
//   'select' {auto: 24}  from #ofAuto  (the integrator picks the 24 tracked birds nearest the screen centre)
//   'clock'  n           after state.time.scale was set from #clockSel (1, 10 or 60)
// Ownership: Trails builder.

export const CREDIT_LINES = [
  { text: 'European starling scan: Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0' },
  { text: 'Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0',
    href: 'https://sketchfab.com/3d-models/peregrine-falcon-falco-peregrinus-49cb0ef2fa2847b0aca92ab6deecf919' },
  { text: 'Weather data by Open-Meteo.com (CC-BY 4.0)', href: 'https://open-meteo.com/' },
  { text: 'three.js r170 (MIT)' },
  { text: 'Sun position after SunCalc (V. Agafonkin, BSD-2)' },
  { html: 'Ornitography mode inspired by Xavi Bou’s <i>Ornitographies</i>' },
];
export const SCIENCE_REFS = [
  'Ballerini et al. 2008, PNAS 105: 1232 (topological interaction, k ≈ 7)',
  'Cavagna et al. 2010, PNAS 107: 11865 (scale-free correlations)',
  'Pearce et al. 2014, PNAS 111: 10422 (marginal opacity)',
  'Hemelrijk & Hildenbrandt 2011, PLoS ONE 6: e22479 (StarDisplay, banking)',
  'Procaccini et al. 2011, Anim. Behav. 82: 759 (propagating waves)',
  'Hemelrijk et al. 2015, Behav. Ecol. Sociobiol. 69: 755 (agitation waves)',
  'Carere et al. 2009, Anim. Behav. 77: 101 (predator-induced patterns)',
  'Tobalske 1995, J. Exp. Biol. 198: 1259 (flap / glide / bound)',
  'Ben-Gida et al. 2013, PLoS ONE 8: e80086 (13.3 Hz wingbeat)',
  'Hillaire 2020, EGSR (sky LUTs)',
];

const NOISE_FIELDS = [   // id, state key, decimals
  ['nzCurl', 'curl', 2], ['nzScale', 'scale', 2], ['nzOct', 'octaves', 0], ['nzWander', 'wander', 2],
  ['nzEvolve', 'evolve', 2], ['nzGustRate', 'gustRate', 1], ['nzWaveRate', 'waveRate', 1],
];
const LOOKS = ['signature', 'physical', 'dusk'];
const CAMS = ['watcher', 'orbit', 'falcon'];
const SRC_LABEL = { forecast: 'live', 'historical-forecast': 'historical', archive: 'historical', cache: 'cached', sample: 'sample weather (offline)', none: 'loading' };
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

// Wall-clock parts of a UTC instant in a time zone.
function zoned(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: p.weekday };
}
// UTC ms of a wall-clock time in a time zone (two-pass offset fix, DST-safe away from the gap hour).
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const z = zoned(t, tz);
    t += want - Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi);
  }
  return t;
}

export function initUI({ state, sites = [], credits = null, presets = null } = {}) {
  const emit = (ev, p) => state.emit(ev, p);
  const bar = $('bar');
  const panels = { noise: $('noisePanel'), place: $('placePanel'), credits: $('credits') };
  const panelBtn = { noise: $('noiseBtn'), place: $('placeBtn'), credits: $('creditsBtn') };
  const params = new URLSearchParams(location.search);

  // ---------- credits ----------
  const req = document.querySelector('#credits [data-c="required"]');
  req.innerHTML = '';
  for (const c of credits || CREDIT_LINES) {
    const li = document.createElement('li');
    if (c.html) li.innerHTML = c.html;
    else if (c.href) { const a = document.createElement('a'); a.href = c.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.text; li.appendChild(a); }
    else li.textContent = c.text || String(c);
    req.appendChild(li);
  }
  const refs = document.querySelector('#credits [data-c="refs"]');
  refs.innerHTML = '';
  for (const r of SCIENCE_REFS) { const li = document.createElement('li'); li.textContent = r; refs.appendChild(li); }

  // ---------- panels ----------
  let openPanel = null;
  function togglePanel(name, force) {
    const on = force !== undefined ? force : openPanel !== name;
    for (const k in panels) { panels[k].classList.toggle('hidden', !(on && k === name)); panelBtn[k].setAttribute('aria-pressed', String(on && k === name)); }
    openPanel = on ? name : null;
    document.body.classList.toggle('pop-open', !!openPanel);   // phones: a popover replaces the ornito panel
    layoutVars();
  }
  for (const k in panelBtn) panelBtn[k].addEventListener('click', () => togglePanel(k));

  // ---------- main bar ----------
  const setMode = m => { if (state.mode === m) return; state.mode = m; emit('mode', m); sync(); };
  const setLook = l => { if (state.look === l) return; state.look = l; emit('look', l); sync(); };
  const setCam = c => { if (state.camera.mode === c) return; state.camera.mode = c; emit('camera', c); sync(); };
  const setQ = q => { if (state.quality === q) return; emit('quality', q); state.quality = q; sync(); };
  bar.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  bar.querySelectorAll('[data-look]').forEach(b => b.addEventListener('click', () => setLook(b.dataset.look)));
  bar.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => setCam(b.dataset.cam)));
  bar.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => setQ(b.dataset.q)));
  $('falconToggle').addEventListener('click', () => { state.falcon.enabled = !state.falcon.enabled; emit('falcon', state.falcon.enabled); sync(); });
  $('attackBtn').addEventListener('click', () => emit('attack'));
  $('gustBtn').addEventListener('click', () => emit('gust'));

  // ---------- noise ----------
  const nzPreset = $('nzPreset'), nzSeed = $('nzSeed');
  for (const [id, key, dec] of NOISE_FIELDS) {
    const el = $(id);
    el.addEventListener('input', () => {
      const v = dec === 0 ? Math.round(+el.value) : +el.value;
      state.noise[key] = v;
      emit('noise', { [key]: v });
      syncNoise();
    });
  }
  nzPreset.addEventListener('change', () => {
    const name = nzPreset.value;
    if (presets && presets[name]) Object.assign(state.noise, presets[name]);
    state.noise.preset = name;
    emit('preset', name);
    syncNoise();
  });
  nzSeed.addEventListener('change', () => {
    const v = Math.max(0, Math.floor(+nzSeed.value || 0));
    state.noise.seed = v;
    emit('noise', { seed: v });
    syncNoise();
  });
  const randomise = () => { emit('randomise'); syncNoise(); };
  $('nzRandom').addEventListener('click', randomise);

  // ---------- place & time ----------
  const siteSel = $('siteSel'), dateIn = $('dateIn'), timeIn = $('timeIn'), clockSel = $('clockSel');
  siteSel.innerHTML = '';
  for (const s of sites) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; siteSel.appendChild(o); }
  siteSel.addEventListener('change', () => emit('site', siteSel.value));
  const tz = () => (state.site && state.site.tz) || undefined;
  const emitTime = () => {
    if (!dateIn.value) return;
    const ms = zonedToUtc(dateIn.value, timeIn.value || '16:00', tz());
    emit('time', { iso: new Date(ms).toISOString() });
  };
  dateIn.addEventListener('change', emitTime);
  timeIn.addEventListener('change', emitTime);
  $('nowBtn').addEventListener('click', () => emit('time', 'now'));
  $('sunsetBtn').addEventListener('click', () => emit('time', 'sunset'));
  clockSel.addEventListener('change', () => { state.time.scale = +clockSel.value; emit('clock', state.time.scale); });
  let placeFocus = false;
  for (const el of [dateIn, timeIn]) { el.addEventListener('focus', () => placeFocus = true); el.addEventListener('blur', () => placeFocus = false); }

  // ---------- ornitography ----------
  const o = state.ornito;
  const of = id => $(id);
  const ofNum = [['ofFrames', 'frames', v => Math.round(v)], ['ofSkip', 'skip', v => Math.round(v)], ['ofDecay', 'decay', v => +v]];
  for (const [id, key, f] of ofNum) of(id).addEventListener('input', () => { if (o.running) return; o[key] = f(+of(id).value); syncOrnito(); });
  of('ofVfps').addEventListener('change', () => { o.vfps = +of('ofVfps').value; syncOrnito(); });
  of('ofBlend').addEventListener('change', () => { o.blend = of('ofBlend').value; syncOrnito(); });
  of('ofTrack').addEventListener('change', () => {
    o.track = of('ofTrack').value;
    if (o.track === 'all') { o.selection = []; emit('select', { ids: 'all' }); }
    syncOrnito();
  });
  of('ofUntracked').addEventListener('change', () => { o.showUntracked = of('ofUntracked').checked; });
  of('ofCaption').addEventListener('change', () => { o.caption = of('ofCaption').checked; });
  const shutter = () => {
    if (state.mode !== 'ornito') return;
    if (o.running) emit('ornito:stop');
    else { if (o.done > 0) emit('ornito:new'); emit('ornito:start'); }
    syncOrnito();
  };
  of('ofStart').addEventListener('click', shutter);
  of('ofNew').addEventListener('click', () => { emit('ornito:new'); syncOrnito(); });
  of('ofExport').addEventListener('click', () => emit('ornito:export'));
  // fold: the settings collapse to the shutter buttons (auto on narrow screens while the shutter is open)
  const oPanel = $('ornitoPanel'), fold = $('ofFold');
  let userFold = null;
  const setFold = f => { oPanel.classList.toggle('folded', f); fold.setAttribute('aria-expanded', String(!f)); fold.textContent = f ? '+' : '–';
    fold.title = f ? 'Show settings' : 'Fold settings'; layoutVars(); };
  fold.addEventListener('click', () => { userFold = !oPanel.classList.contains('folded'); setFold(userFold); });
  let wasRunning = false;
  function autoFold() {
    if (o.running === wasRunning) return;
    wasRunning = !!o.running;
    if (matchMedia('(max-width: 720px)').matches) setFold(wasRunning ? true : (userFold ?? false));
  }
  of('ofAuto').addEventListener('click', () => { if (o.track === 'all') { o.track = 'selection'; } emit('select', { auto: 24 }); syncOrnito(); });

  // ---------- shutter indicator ----------
  const sh = $('shutter'), ring = sh.querySelector('.ring');
  const sDone = sh.querySelector('[data-s="done"]'), sFrames = sh.querySelector('[data-s="frames"]'), sExp = sh.querySelector('[data-s="exp"]');
  const CIRC = 2 * Math.PI * 12;
  let lastFrame = { done: 0, frames: o.frames };
  function drawShutter() {
    const N = lastFrame.frames || o.frames, d = Math.min(lastFrame.done || 0, N);
    sDone.textContent = d; sFrames.textContent = N;
    ring.setAttribute('stroke-dashoffset', (CIRC * (1 - d / N)).toFixed(2));
    const exp = N * ((o.skip | 0) + 1) / o.vfps;
    sExp.textContent = `${exp.toFixed(exp < 1 ? 3 : 2)} s bird time`;
    sh.classList.toggle('open', !!o.running);
    sh.classList.toggle('done', !o.running && d > 0 && d >= N);
  }
  state.on('ornito:frame', p => { lastFrame = p || lastFrame; drawShutter(); if (!o.running || (p && (p.finished || p.cleared))) syncOrnito(); });

  // ---------- weather readout ----------
  const R = k => document.querySelector(`#readout [data-r="${k}"]`);
  const arrow = (dirFrom) => `<span class="arrow" style="transform:rotate(${(dirFrom + 180) % 360}deg)" aria-hidden="true">↑</span>`;
  const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
  function readout() {
    const w = state.weather && state.weather.sample;
    const src = (state.weather && state.weather.source) || (w && w.source) || 'none';
    const badge = R('src');
    badge.textContent = state.weather && state.weather.status === 'error' && src === 'none' ? 'no weather' : (SRC_LABEL[src] || src);
    badge.dataset.src = src;
    if (w) {
      const pc = v => Math.round(100 * (v || 0));
      R('cloud').textContent = `low ${pc(w.cloudLow)} · mid ${pc(w.cloudMid)} · high ${pc(w.cloudHigh)} %`;
      const wind = x => x ? `${arrow(x.dirDeg)} ${x.speed.toFixed(1)} m/s from ${compass(x.dirDeg)}` : '—';
      R('w10').innerHTML = wind(w.wind10) + (w.gust10 ? ` <span style="color:var(--dim)">g ${w.gust10.toFixed(0)}</span>` : '');
      R('w80').innerHTML = wind(w.wind80);
      const vis = w.visibilityM >= 10000 ? `${(w.visibilityM / 1000).toFixed(0)} km` : `${(w.visibilityM / 1000).toFixed(1)} km`;
      R('air').textContent = `${w.temperatureC != null ? w.temperatureC.toFixed(1) + ' °C' : '—'} · vis ${w.visibilityM != null ? vis : '—'}`;
    }
    const s = state.sun;
    if (s) R('sun').textContent = `alt ${s.altitudeDeg.toFixed(1)}° · az ${s.azimuthDeg.toFixed(0)}° ${compass(s.azimuthDeg)}`;
  }
  state.on('weather', () => { readout(); syncTitle(); });

  // ---------- title ----------
  const title = $('title'), sub = title.querySelector('.sub');
  function syncTitle() {
    const s = state.site;
    const ms = state.time.nowMs || Date.now();
    let when = '';
    try {
      const z = zoned(ms, s && s.tz);
      when = `${z.wd} ${z.d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][z.mo - 1]} ${z.y} · ${pad(z.h)}:${pad(z.mi)}`;
      if (!placeFocus && s) {
        const dv = `${z.y}-${pad(z.mo)}-${pad(z.d)}`, tv = `${pad(z.h)}:${pad(z.mi)}`;
        if (dateIn.value !== dv) dateIn.value = dv;
        if (timeIn.value !== tv) timeIn.value = tv;
      }
    } catch (e) { /* bad tz */ }
    sub.textContent = s ? `${s.name} · ${when} local` : when;
  }
  $('hudToggle').addEventListener('click', () => {
    const h = $('hud'), on = !h.classList.contains('open');
    h.classList.toggle('open', on); $('hudToggle').setAttribute('aria-expanded', String(on));
    layoutVars();
  });

  // ---------- sync from state ----------
  const press = (sel, val) => bar.querySelectorAll(sel).forEach(b => b.setAttribute('aria-pressed', String(Object.values(b.dataset)[0] === val)));
  function syncNoise() {
    const n = state.noise;
    if (nzPreset.value !== n.preset && [...nzPreset.options].some(x => x.value === n.preset)) nzPreset.value = n.preset;
    for (const [id, key, dec] of NOISE_FIELDS) {
      const el = $(id), out = document.querySelector(`output[for="${id}"]`);
      if (n[key] == null) continue;
      if (document.activeElement !== el) el.value = n[key];
      out.textContent = (+n[key]).toFixed(dec);
    }
    if (document.activeElement !== nzSeed) nzSeed.value = n.seed;
  }
  function syncOrnito() {
    const orn = state.mode === 'ornito';
    $('ornitoPanel').classList.toggle('hidden', !orn);
    sh.classList.toggle('hidden', !orn);
    of('ofFrames').value = o.frames; document.querySelector('output[for="ofFrames"]').textContent = o.frames;
    of('ofSkip').value = o.skip; document.querySelector('output[for="ofSkip"]').textContent = o.skip;
    of('ofDecay').value = o.decay; document.querySelector('output[for="ofDecay"]').textContent = (+o.decay).toFixed(3);
    of('ofVfps').value = String(o.vfps); of('ofBlend').value = o.blend; of('ofTrack').value = o.track;
    of('ofUntracked').checked = !!o.showUntracked; of('ofCaption').checked = !!o.caption;
    for (const id of ['ofFrames', 'ofSkip', 'ofDecay', 'ofVfps', 'ofBlend', 'ofTrack']) of(id).disabled = !!o.running;
    autoFold();
    const st = of('ofStart');
    st.textContent = o.running ? 'Close shutter' : (o.done > 0 ? 'New exposure' : 'Open shutter');
    st.classList.toggle('rec', !!o.running);
    st.setAttribute('aria-pressed', String(!!o.running));
    of('ofExport').disabled = o.running || !(o.done > 0);
    of('ofAuto').disabled = !!o.running;
    of('ofNew').disabled = !!o.running;
    const ms = 1000 / o.vfps;
    const trackTxt = o.track === 'all' ? 'all birds' : o.track === 'one' ? (o.selection.length ? `bird #${o.selection[0]}` : 'click a bird') :
      `${o.selection.length} selected (shift-click, ≤ 64)`;
    of('ofTrack').closest('.pop').querySelector('[data-o="info"]').textContent =
      `${trackTxt} · one frame every ${(ms * ((o.skip | 0) + 1)).toFixed(1)} ms of bird time; a 13.3 Hz wingbeat spans ${(o.vfps / 13.3 / ((o.skip | 0) + 1)).toFixed(1)} frames.`;
    drawShutter();
  }
  function sync() {
    press('[data-mode]', state.mode);
    press('[data-look]', state.look);
    press('[data-cam]', state.camera.mode);
    press('[data-q]', state.quality);
    $('falconToggle').setAttribute('aria-pressed', String(!!state.falcon.enabled));
    $('attackBtn').disabled = !state.falcon.enabled;
    if (state.site && siteSel.value !== state.site.id) siteSel.value = state.site.id;
    if (clockSel.value !== String(state.time.scale) && [1, 10, 60].includes(state.time.scale)) clockSel.value = String(state.time.scale);
    syncOrnito();
  }
  state.on('select', p => { if (p && Array.isArray(p.ids)) { o.selection = p.ids.slice(0, 64); syncOrnito(); } });

  // ---------- keys ----------
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'o') setMode(state.mode === 'live' ? 'ornito' : 'live');
    else if (k === '1' || k === '2' || k === '3') setLook(LOOKS[+k - 1]);
    else if (k === 'c') setCam(CAMS[(CAMS.indexOf(state.camera.mode) + 1) % 3]);
    else if (k === 'f') { if (state.falcon.enabled) emit('attack'); }
    else if (k === 'g') emit('gust');
    else if (k === 'r') randomise();
    else if (k === ' ' || e.code === 'Space') { if (state.mode !== 'ornito') return; e.preventDefault(); shutter(); }
    else if (k === 'escape') togglePanel(null, false);
    else return;
  });

  // ---------- device defaults ----------
  const narrow = matchMedia('(max-width: 720px)').matches || matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
  if (narrow && !params.has('q') && state.quality !== 'low') setQ('low');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.falcon.autoAttack = false;
    state.camera.autoOrbit = false;
  }

  // ---------- 4 Hz tick ----------
  const fpsEl = $('fps');
  function tick() {
    const st = window.murm && typeof window.murm.stats === 'function' ? safe(() => window.murm.stats()) : null;
    if (st && isFinite(st.fps)) fpsEl.textContent = `${Math.round(st.fps)} fps`;
    sync(); syncNoise(); readout(); syncTitle();
    layoutVars();
  }
  // Panel stacking reads the live heights of the bar, the HUD and the ornito panel (CSS vars, set only on change).
  const varCache = {};
  function layoutVars() {
    const h = el => (el && !el.classList.contains('hidden') ? Math.round(el.getBoundingClientRect().height) : 0);
    const v = { '--barH': h(bar), '--hudH': h($('hud')), '--ornH': h($('ornitoPanel')) };
    for (const k in v) if (varCache[k] !== v[k]) { varCache[k] = v[k]; document.documentElement.style.setProperty(k, v[k] + 'px'); }
  }
  addEventListener('resize', layoutVars);
  const safe = f => { try { return f(); } catch (e) { return null; } };
  tick();
  const timer = setInterval(tick, 250);

  return { sync: tick, togglePanel, dispose() { clearInterval(timer); } };
}
