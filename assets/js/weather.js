// weather.js — real weather (Open-Meteo) for the murmuration sky, plus sun position and sunrise/sunset.
// SPEC §5.1. Owner: Sky builder. ES module; imports only three.
//
//  fetchWeather(site, D)   request A (forecast) → B (historical-forecast) → C (archive) → localStorage → bundled sample
//  sampleWeather(wx, tMs)  hourly linear interpolation (winds interpolated as vectors) → WXSample
//  applyToState(state, s)  fills state.weather.sample, state.wind.*, state.clouds.*
//  sunPosition / sunTimes  NOAA solar-calculator equations (Meeus), the same family SunCalc approximates; apparent
//                          altitude includes the NOAA refraction model. Azimuth is degrees clockwise from north.
//
// World frame (§0): +X east, +Y up, +Z south. windVector(s, d) = (-s·sin d, 0, +s·cos d) (d = direction blown FROM).
import * as THREE from 'three';

export const SITES = [   // id, name, lat, lon, tz, groundType ('sea'|'reedbed'|'field'|'city')
  { id: 'brighton', name: 'Brighton West Pier, UK',          lat: 50.8214, lon: -0.1517, tz: 'Europe/London', ground: 'sea' },   // DEFAULT
  { id: 'otmoor',   name: 'RSPB Otmoor, Oxfordshire, UK',    lat: 51.8120, lon: -1.1720, tz: 'Europe/London', ground: 'reedbed' },
  { id: 'hamwall',  name: 'RSPB Ham Wall, Somerset, UK',     lat: 51.1510, lon: -2.7880, tz: 'Europe/London', ground: 'reedbed' },
  { id: 'gretna',   name: 'Gretna Green, Scotland, UK',      lat: 54.9970, lon: -3.0650, tz: 'Europe/London', ground: 'field' },
  { id: 'aber',     name: 'Aberystwyth Pier, Wales, UK',     lat: 52.4153, lon: -4.0874, tz: 'Europe/London', ground: 'sea' },
  { id: 'rome',     name: 'Rome (Termini), Italy',           lat: 41.9010, lon: 12.5010, tz: 'Europe/Rome',   ground: 'city' },
  { id: 'tonder',   name: 'Sort Sol, Tønder Marsh, Denmark', lat: 54.9400, lon: 8.8000,  tz: 'Europe/Copenhagen', ground: 'reedbed' },
];
export const OPEN_METEO_CREDIT = 'Weather data by Open-Meteo.com (CC-BY 4.0)';
export const OPEN_METEO_URL = 'https://open-meteo.com/';

// ---------------------------------------------------------------------------------------------------------------
// URLs (S1: request A must be byte-exact)
const HOURLY_A = 'temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,visibility,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_80m,wind_direction_80m,wind_speed_850hPa,wind_direction_850hPa,wind_speed_500hPa,wind_direction_500hPa,wind_speed_300hPa,wind_direction_300hPa';
const CURRENT_A = 'temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const HOURLY_C = 'temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_100m,wind_direction_100m';

export function addDays(D, n) {
  const [y, m, d] = D.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
const dayIndex = D => Math.round(Date.parse(D + 'T00:00:00Z') / 86400000);

/** kind: 'forecast' | 'historical-forecast' | 'archive'. D = local date 'YYYY-MM-DD'. */
export function buildURL(kind, site, D) {
  const lat = site.lat, lon = site.lon, d0 = addDays(D, -1), d1 = addDays(D, 1);
  if (kind === 'forecast')
    return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${HOURLY_A}&current=${CURRENT_A}&daily=sunrise,sunset&start_date=${d0}&end_date=${d1}&wind_speed_unit=ms&timeformat=unixtime&timezone=auto`;
  if (kind === 'historical-forecast')
    return `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${HOURLY_A}&daily=sunrise,sunset&start_date=${d0}&end_date=${d1}&wind_speed_unit=ms&timeformat=unixtime&timezone=auto`;
  if (kind === 'archive')
    return `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=${HOURLY_C}&daily=sunrise,sunset&start_date=${d0}&end_date=${d1}&wind_speed_unit=ms&timeformat=unixtime&timezone=auto`;
  throw new Error('unknown kind ' + kind);
}

/** 'YYYY-MM-DD' of instant tMs in time zone tz. */
export function localDateOf(tMs, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tMs)); }
  catch (e) { return new Date(tMs).toISOString().slice(0, 10); }
}
/** 'HH:MM' local time of tMs in tz. */
export function localTimeOf(tMs, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(tMs)); }
  catch (e) { return new Date(tMs).toISOString().slice(11, 16); }
}

// Asset base for the bundled samples. After build.js this file lives in assets/js/, so samples are ../weather/;
// loaded straight from src/ (tests) they are ../assets/weather/.
const SAMPLE_BASE = (() => {
  try { return new URL(import.meta.url.includes('/assets/js/') ? '../weather/' : '../assets/weather/', import.meta.url).href; }
  catch (e) { return 'assets/weather/'; }
})();

const LS_KEY = (siteId, D) => `murm:wx:v1:${siteId}:${D}`;
const mem = new Map();   // in-memory session cache, keyed like localStorage

async function getJSON(url, timeoutMs = 8000) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : 0;
  try {
    const r = await fetch(url, ac ? { signal: ac.signal } : undefined);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || j.error) throw new Error('API error: ' + ((j && j.reason) || 'unknown'));
    if (!j.hourly || !Array.isArray(j.hourly.time) || !j.hourly.time.length) throw new Error('no hourly data');
    return j;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Fetch weather for a site and local date D. Options: { wx: 'live'|'sample:overcast'|'sample:clear', log: fn,
 * todayMs: number (for range checks; default Date.now()), skipNetwork: bool }.
 * Returns WX = { siteId, date, source, synthetic, url, fetchedAt, utcOffsetSeconds, hourly:{time(ms)[] ...},
 *               daily:{sunrise(ms)[], sunset(ms)[]}, current|null, attempts:[{step, ok, error}] }.
 */
export async function fetchWeather(site, localDate, opts = {}) {
  const log = opts.log || (() => {});
  const attempts = [];
  const D = localDate;
  const wxOpt = opts.wx || 'live';
  if (wxOpt.startsWith('sample')) return loadSample(wxOpt === 'sample:clear' ? 'clear' : 'overcast', site, D, attempts);
  const today = dayIndex(new Date(opts.todayMs || Date.now()).toISOString().slice(0, 10));
  const di = dayIndex(D);
  const steps = [];
  if (di >= today - 92 && di <= today + 15) steps.push('forecast');
  if (di >= dayIndex('2022-01-01') && di <= today + 1) steps.push('historical-forecast');
  if (di >= dayIndex('1940-01-02') && di <= today - 5) steps.push('archive');
  if (!opts.skipNetwork) {
    for (const kind of steps) {
      const url = buildURL(kind, site, D);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const j = await getJSON(url, opts.timeoutMs || 8000);
          const wx = normalise(j, kind, site, D, url);
          if (wxUsable(wx)) {
            attempts.push({ step: kind, ok: true });
            wx.attempts = attempts;
            try { localStorage.setItem(LS_KEY(site.id, D), JSON.stringify(wx)); } catch (e) { /* storage blocked */ }
            mem.set(LS_KEY(site.id, D), wx);
            return wx;
          }
          throw new Error('cloud cover missing for the date');
        } catch (e) {
          attempts.push({ step: kind, ok: false, error: String(e && e.message || e) });
          log(`weather ${kind} attempt ${attempt + 1} failed: ${e && e.message}`);
        }
      }
    }
  }
  // 3. cache
  let cached = mem.get(LS_KEY(site.id, D)) || null;
  if (!cached) { try { const s = localStorage.getItem(LS_KEY(site.id, D)); if (s) cached = JSON.parse(s); } catch (e) { cached = null; } }
  if (cached && cached.hourly && cached.hourly.time) {
    attempts.push({ step: 'cache', ok: true });
    return { ...cached, source: 'cache', cachedFrom: cached.source, attempts };
  }
  attempts.push({ step: 'cache', ok: false });
  // 4. bundled sample
  return loadSample(opts.sample || 'overcast', site, D, attempts);
}

function wxUsable(wx) {
  const c = wx.hourly.cloud_cover;
  return c && c.some(v => v != null && isFinite(v));
}

async function loadSample(name, site, D, attempts) {
  const url = SAMPLE_BASE + `sample_${name}.json`;
  let j;
  try { j = await getJSON(url, 8000); }
  catch (e) {
    attempts.push({ step: 'sample', ok: false, error: String(e.message || e) });
    j = makeSyntheticSample(name, Date.parse(D + 'T00:00:00Z') - 86400000);   // last resort: same generator as the files
  }
  // Samples are stored for a reference date. Shift their timeline so that its middle day lands on D.
  const wx = normalise(j, 'sample', site, D, url);
  const shift = (Date.parse(D + 'T00:00:00Z') - 86400000) - wx.hourly.time[0];
  wx.hourly.time = wx.hourly.time.map(t => t + shift);
  wx.sampleShiftMs = shift;
  // the real sun for this site/date (samples carry no sunrise/sunset for other sites)
  wx.daily = { time: [], sunrise: [], sunset: [] };
  for (let k = -1; k <= 1; k++) {
    const st = sunTimes(addDays(D, k), site.lat, site.lon);
    wx.daily.time.push(Date.parse(addDays(D, k) + 'T00:00:00Z')); wx.daily.sunrise.push(st.sunriseMs); wx.daily.sunset.push(st.sunsetMs);
  }
  wx.current = null;
  wx.synthetic = true;
  wx.sampleName = name;
  attempts.push({ step: 'sample', ok: true });
  wx.attempts = attempts;
  return wx;
}

const DERIVE_LOG = [];
function normalise(j, source, site, D, url) {
  const h = j.hourly, n = h.time.length;
  const arr = k => (h[k] ? h[k].slice(0, n) : new Array(n).fill(null));
  const hourly = { time: h.time.map(t => t * 1000) };
  for (const k of ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'surface_pressure', 'visibility', 'cloud_cover', 'cloud_cover_low',
    'cloud_cover_mid', 'cloud_cover_high', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'wind_speed_80m', 'wind_direction_80m',
    'wind_speed_100m', 'wind_direction_100m', 'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_500hPa', 'wind_direction_500hPa',
    'wind_speed_300hPa', 'wind_direction_300hPa']) hourly[k] = arr(k);
  const derived = new Set();
  for (let i = 0; i < n; i++) {
    // §5.1 derivation table
    if (hourly.wind_speed_80m[i] == null || hourly.wind_direction_80m[i] == null) {
      if (hourly.wind_speed_100m[i] != null) { hourly.wind_speed_80m[i] = hourly.wind_speed_100m[i] * 0.97; hourly.wind_direction_80m[i] = hourly.wind_direction_100m[i]; }
      else { hourly.wind_speed_80m[i] = (hourly.wind_speed_10m[i] ?? 5) * 1.35; hourly.wind_direction_80m[i] = (hourly.wind_direction_10m[i] ?? 225) + 5; }
      derived.add('v80');
    }
    const s80 = hourly.wind_speed_80m[i], d80 = hourly.wind_direction_80m[i];
    const der = (lvl, mul, veer) => {
      if (hourly['wind_speed_' + lvl][i] == null || hourly['wind_direction_' + lvl][i] == null) {
        hourly['wind_speed_' + lvl][i] = s80 * mul; hourly['wind_direction_' + lvl][i] = (d80 + veer) % 360; derived.add('v' + lvl.replace('hPa', ''));
      }
    };
    der('850hPa', 1.5, 15); der('500hPa', 2.4, 30); der('300hPa', 3.2, 40);
    if (hourly.visibility[i] == null) { hourly.visibility[i] = (hourly.relative_humidity_2m[i] ?? 80) > 95 ? 5000 : 20000; derived.add('visibility'); }
    if (hourly.dew_point_2m[i] == null && hourly.temperature_2m[i] != null && hourly.relative_humidity_2m[i] != null) {
      hourly.dew_point_2m[i] = dewPoint(hourly.temperature_2m[i], hourly.relative_humidity_2m[i]); derived.add('dew_point');
    }
  }
  const daily = j.daily ? { time: (j.daily.time || []).map(t => t * 1000), sunrise: (j.daily.sunrise || []).map(t => t * 1000), sunset: (j.daily.sunset || []).map(t => t * 1000) } : null;
  let current = null;
  if (j.current && j.current.time) current = { ...j.current, tMs: j.current.time * 1000 };
  return {
    siteId: site.id, date: D, source, synthetic: !!j.synthetic, url, fetchedAt: Date.now(),
    utcOffsetSeconds: j.utc_offset_seconds ?? 0, timezone: j.timezone || site.tz, latitude: j.latitude, longitude: j.longitude,
    hourly, daily, current, derived: [...derived],
  };
}

function dewPoint(T, RH) {   // Magnus
  const a = 17.62, b = 243.12, g = Math.log(Math.max(RH, 1) / 100) + a * T / (b + T);
  return b * g / (a - g);
}

// ---------------------------------------------------------------------------------------------------------------
/** WXSample at instant tMs (hourly linear; winds interpolated as vectors). */
export function sampleWeather(wx, tMs) {
  const H = wx.hourly, t = H.time, n = t.length;
  let i = 0;
  if (tMs <= t[0]) i = 0; else if (tMs >= t[n - 1]) i = n - 2; else { while (i < n - 2 && t[i + 1] < tMs) i++; }
  i = Math.max(0, Math.min(n - 2, i));
  const f = n > 1 ? THREE.MathUtils.clamp((tMs - t[i]) / (t[i + 1] - t[i]), 0, 1) : 0;
  const lerp = (k, d) => {
    const a = H[k][i], b = H[k][Math.min(i + 1, n - 1)];
    if (a == null && b == null) return d;
    if (a == null) return b; if (b == null) return a;
    return a + (b - a) * f;
  };
  const wind = (lvl, ds = 5, dd = 225) => {
    const sa = H['wind_speed_' + lvl][i] ?? ds, da = H['wind_direction_' + lvl][i] ?? dd;
    const sb = H['wind_speed_' + lvl][Math.min(i + 1, n - 1)] ?? sa, db = H['wind_direction_' + lvl][Math.min(i + 1, n - 1)] ?? da;
    const ra = da * Math.PI / 180, rb = db * Math.PI / 180;
    // interpolate the meteorological vector (components of the FROM direction × speed)
    const x = sa * Math.sin(ra) * (1 - f) + sb * Math.sin(rb) * f, z = sa * Math.cos(ra) * (1 - f) + sb * Math.cos(rb) * f;
    const speed = Math.hypot(x, z);
    let dir = Math.atan2(x, z) * 180 / Math.PI; if (dir < 0) dir += 360;
    return { speed, dirDeg: speed > 1e-6 ? dir : da };
  };
  const s = {
    tMs, source: wx.source, synthetic: !!wx.synthetic,
    cloudCover: lerp('cloud_cover', 50) / 100, cloudLow: lerp('cloud_cover_low', 30) / 100, cloudMid: lerp('cloud_cover_mid', 20) / 100, cloudHigh: lerp('cloud_cover_high', 20) / 100,
    wind10: wind('10m'), wind80: wind('80m'), wind850: wind('850hPa', 10, 240), wind500: wind('500hPa', 20, 250), wind300: wind('300hPa', 30, 260),
    gust10: lerp('wind_gusts_10m', 8),
    temperatureC: lerp('temperature_2m', 10), dewPointC: lerp('dew_point_2m', 7), humidity: lerp('relative_humidity_2m', 80) / 100,
    visibilityM: lerp('visibility', 20000), pressureHPa: lerp('surface_pressure', 1013),
  };
  // "now" mode: the current block overrides the surface fields when tMs is within 45 min of it
  const c = wx.current;
  if (c && Math.abs(tMs - c.tMs) < 45 * 60000) {
    if (c.temperature_2m != null) s.temperatureC = c.temperature_2m;
    if (c.relative_humidity_2m != null) { s.humidity = c.relative_humidity_2m / 100; s.dewPointC = dewPoint(s.temperatureC, c.relative_humidity_2m); }
    if (c.cloud_cover != null) {
      const k = s.cloudCover > 1e-3 ? (c.cloud_cover / 100) / s.cloudCover : 1;
      s.cloudCover = c.cloud_cover / 100;
      // keep the layered split, scaled to the current total (capped)
      s.cloudLow = Math.min(1, s.cloudLow * k); s.cloudMid = Math.min(1, s.cloudMid * k); s.cloudHigh = Math.min(1, s.cloudHigh * k);
    }
    if (c.wind_speed_10m != null) s.wind10 = { speed: c.wind_speed_10m, dirDeg: c.wind_direction_10m ?? s.wind10.dirDeg };
    if (c.wind_gusts_10m != null) s.gust10 = c.wind_gusts_10m;
    s.current = true;
  }
  return s;
}

/** "now" mode refetch policy (§5.1): true when wx is older than 30 min, or does not cover tMs. */
export function needsRefetch(wx, tMs, nowMode = true, nowMs = Date.now()) {
  if (!wx || !wx.hourly || !wx.hourly.time || !wx.hourly.time.length) return true;
  const t = wx.hourly.time;
  if (tMs < t[0] || tMs > t[t.length - 1]) return true;
  return !!nowMode && wx.source !== 'sample' && nowMs - (wx.fetchedAt || 0) > 30 * 60000;
}

/** World wind vector (§0): direction blown TO. dirFromDeg is meteorological (blowing FROM). */
export function windVector(speed, dirFromDeg, out = new THREE.Vector3()) {
  const r = dirFromDeg * Math.PI / 180;
  return out.set(-speed * Math.sin(r), 0, speed * Math.cos(r));
}

export function lclHeight(Tc, Tdc) { return THREE.MathUtils.clamp(125 * (Tc - Tdc), 300, 2000); }   // Espy

/** Fill state.weather.sample, state.wind.*, state.clouds.* from a WXSample. */
export function applyToState(state, s) {
  if (!s) return;
  state.weather.sample = s;
  state.weather.source = s.source;
  state.weather.status = 'ok';
  windVector(s.wind10.speed, s.wind10.dirDeg, state.wind.v10);
  windVector(s.wind80.speed, s.wind80.dirDeg, state.wind.v80);
  windVector(s.wind850.speed, s.wind850.dirDeg, state.wind.v850);
  windVector(s.wind500.speed, s.wind500.dirDeg, state.wind.v500);
  windVector(s.wind300.speed, s.wind300.dirDeg, state.wind.v300);
  state.wind.gust10 = s.gust10;
  state.clouds.low = s.cloudLow; state.clouds.mid = s.cloudMid; state.clouds.high = s.cloudHigh; state.clouds.total = s.cloudCover;
  state.clouds.baseLowM = lclHeight(s.temperatureC, s.dewPointC);
}

// ---------------------------------------------------------------------------------------------------------------
// Sun (NOAA solar calculator equations; after SunCalc by V. Agafonkin, BSD-2, re-implemented with the fuller
// NOAA/Meeus series so it is within ~0.01° of NOAA).
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
function solarGeom(tMs) {
  const jd = tMs / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan(eps * RAD / 2) ** 2;
  const L0r = L0 * RAD;
  const eot = 4 * DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));   // minutes
  return { decl, eot };
}
function refractionDeg(elev) {   // NOAA atmospheric refraction approximation
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let r;
  if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else r = -20.774 / te;
  return r / 3600;
}
/** { azimuthDeg (clockwise from north), altitudeDeg (apparent, refracted), trueAltitudeDeg, dir: world Vector3 } */
export function sunPosition(tMs, lat, lon, out) {
  const { decl, eot } = solarGeom(tMs);
  const d = new Date(tMs);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  const tst = ((minutes + eot + 4 * lon) % 1440 + 1440) % 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const latr = lat * RAD, har = ha * RAD;
  const cz = THREE.MathUtils.clamp(Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(har), -1, 1);
  const zen = Math.acos(cz);
  const elev = 90 - zen * DEG;
  // NOAA spreadsheet form: ha > 0: az = (acos(a) + 180) mod 360, else (540 − acos(a)) mod 360
  const den = Math.cos(latr) * Math.sin(zen);
  const a = Math.abs(den) > 1e-9 ? THREE.MathUtils.clamp(((Math.sin(latr) * cz) - Math.sin(decl)) / den, -1, 1) : 1;
  const ac = Math.acos(a) * DEG;
  const az = ha > 0 ? (ac + 180) % 360 : (540 - ac) % 360;
  const app = elev + refractionDeg(elev);
  const A = az * RAD, h = app * RAD;
  const dir = (out || new THREE.Vector3()).set(Math.sin(A) * Math.cos(h), Math.sin(h), -Math.cos(A) * Math.cos(h));
  return { azimuthDeg: az, altitudeDeg: app, trueAltitudeDeg: elev, dir };
}

/** { sunriseMs, sunsetMs, civilDuskMs, civilDawnMs, solarNoonMs } UTC ms for local date D at (lat, lon). h0 = −0.833°. */
export function sunTimes(localDate, lat, lon) {
  const base = Date.parse(localDate + 'T00:00:00Z');
  // solar noon: iterate on the equation of time
  let noonMin = 720 - 4 * lon;
  for (let k = 0; k < 3; k++) { const { eot } = solarGeom(base + noonMin * 60000); noonMin = 720 - 4 * lon - eot; }
  const event = (h0, sign) => {
    let tMin = noonMin + sign * 360;
    for (let k = 0; k < 5; k++) {
      const { decl, eot } = solarGeom(base + tMin * 60000);
      const latr = lat * RAD;
      const c = (Math.sin(h0 * RAD) - Math.sin(latr) * Math.sin(decl)) / (Math.cos(latr) * Math.cos(decl));
      if (c < -1 || c > 1) return NaN;
      const H = Math.acos(c) * DEG;
      const noon = 720 - 4 * lon - eot;
      tMin = noon + sign * 4 * H;
    }
    return base + tMin * 60000;
  };
  return {
    solarNoonMs: base + noonMin * 60000,
    sunriseMs: event(-0.833, -1), sunsetMs: event(-0.833, +1),
    civilDawnMs: event(-6, -1), civilDuskMs: event(-6, +1),
  };
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Synthetic sample generator (the bundled sample_*.json files are written from this by tests/sky/make_samples.js).
 * Open-Meteo response format, unixtime, 72 h hourly from t0Ms (UTC midnight), "synthetic": true.
 */
export function makeSyntheticSample(name, t0Ms = Date.parse('2025-11-19T00:00:00Z')) {
  const n = 72, time = [];
  for (let i = 0; i < n; i++) time.push(Math.round(t0Ms / 1000) + i * 3600);
  const H = { time };
  const put = (k, f) => { H[k] = time.map((t, i) => +f(i).toFixed(2)); };
  const wob = (i, a, p, ph = 0) => a * Math.sin(2 * Math.PI * i / p + ph);
  if (name === 'clear') {
    put('temperature_2m', i => 9 + wob(i, 3, 24, -2.2)); put('relative_humidity_2m', i => 70 - wob(i, 10, 24, -2.2));
    put('dew_point_2m', i => 3.5); put('surface_pressure', i => 1024 + wob(i, 0.8, 30)); put('visibility', i => 30000);
    put('cloud_cover_low', i => 5); put('cloud_cover_mid', i => 0); put('cloud_cover_high', i => 40 + wob(i, 6, 17));
    put('cloud_cover', i => 43 + wob(i, 5, 17));
    put('wind_speed_10m', i => 3.2 + wob(i, 0.8, 24)); put('wind_direction_10m', i => 268 + wob(i, 8, 30));
    put('wind_gusts_10m', i => 6.0 + wob(i, 1.2, 24)); put('wind_speed_80m', i => 5.2 + wob(i, 0.8, 24)); put('wind_direction_80m', i => 272 + wob(i, 6, 30));
    put('wind_speed_850hPa', i => 8 + wob(i, 1, 30)); put('wind_direction_850hPa', i => 280);
    put('wind_speed_500hPa', i => 16 + wob(i, 2, 36)); put('wind_direction_500hPa', i => 285);
    put('wind_speed_300hPa', i => 28 + wob(i, 3, 40)); put('wind_direction_300hPa', i => 288);
  } else {
    put('temperature_2m', i => 10 + wob(i, 1.2, 24, -2.2)); put('relative_humidity_2m', i => 85 - wob(i, 3, 24, -2.2));
    put('dew_point_2m', i => 7.6); put('surface_pressure', i => 1006 + wob(i, 1.2, 30)); put('visibility', i => 18000);
    put('cloud_cover_low', i => 95); put('cloud_cover_mid', i => 60 + wob(i, 8, 19)); put('cloud_cover_high', i => 30 + wob(i, 6, 23));
    put('cloud_cover', i => 98);
    put('wind_speed_10m', i => 6 + wob(i, 0.6, 24)); put('wind_direction_10m', i => 225 + wob(i, 5, 30));
    put('wind_gusts_10m', i => 11 + wob(i, 1, 24)); put('wind_speed_80m', i => 9 + wob(i, 0.7, 24)); put('wind_direction_80m', i => 228 + wob(i, 4, 30));
    put('wind_speed_850hPa', i => 14 + wob(i, 1, 30)); put('wind_direction_850hPa', i => 235);
    put('wind_speed_500hPa', i => 22 + wob(i, 2, 36)); put('wind_direction_500hPa', i => 250);
    put('wind_speed_300hPa', i => 35 + wob(i, 3, 40)); put('wind_direction_300hPa', i => 260);
  }
  return {
    synthetic: true,
    note: name === 'clear'
      ? 'SYNTHETIC sample (hand-made, not observed): clear evening, low 5 %, mid 0 %, high 40 % cirrus, light westerly, visibility 30 km.'
      : 'SYNTHETIC sample (hand-made, not observed): overcast, low 95 %, mid 60 %, high 30 %; 10 m 6 m/s from 225°, 80 m 9 m/s, 850 hPa 14 m/s from 235°, 500 hPa 22 m/s from 250°, 300 hPa 35 m/s from 260°; visibility 18 km; 10 °C; RH 85 %.',
    latitude: 50.82, longitude: -0.15, utc_offset_seconds: 0, timezone: 'GMT', elevation: 5,
    hourly_units: { time: 'unixtime', wind_speed_10m: 'm/s' },
    hourly: H,
  };
}
