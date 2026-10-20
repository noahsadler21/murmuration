// sky.js: the real-weather sky backdrop (SPEC §5.2–5.5). Owner: Sky builder. ES module; imports three, ./sky_shaders.js
// and ./weather.js only.
//
//  class Sky     atmosphere LUTs (Hillaire 2020), three cloud decks drifting with the real wind at their own altitude,
//                exact coverage (inverse-CDF LUT per deck), the skyRT prepass, a hemisphere/stats pass that measures
//                Lref and the light (state.light.u, shared by reference), the bg quad and the ground.
//  class Grade   the looks: signature (pale overcast, the default and the page's identity), physical (AgX), dusk,
//                negative (internal, ornito lighten blend); present() = dither / grain / vignette to the canvas.
//  createGround  dark, desaturated, aerial-fogged ground plane; 'sea' gets a sky fresnel.
//
// Everything is gated by state.fx (sky.multiScatter, sky.cloudRaymarch, sky.cloudLightTaps, sky.silverLining,
// sky.cirrus, post.grain, post.vignette, post.dither) and timed with prof 'sky.lut' / 'sky.prepass' / 'grade' / 'present'
// (the integrator wraps grade/present; Sky wraps its own two).
import * as THREE from 'three';
import { SKY_GLSL, SKY_SHADERS as S } from './sky_shaders.js';
import { SITES, sunPosition, sunTimes, localDateOf } from './weather.js';

export { SKY_GLSL };
export const LOOK_IDS = { signature: 0, physical: 1, dusk: 2, negative: 3, raw: 4, xmap: 5 };
const NOPROF = { begin() {}, end() {} };
const V2 = THREE.Vector2, V3 = THREE.Vector3, V4 = THREE.Vector4;
const DEG = Math.PI / 180;

// deck geometry and optical depths
export const DECKS = {
  low:  { tile: 12000, thick: 500, tauMax: 24, soft: 0.06 },     // base = Espy LCL (state.clouds.baseLowM)
  mid:  { tile: 4800,  thick: 500, tauMax: 7,  soft: 0.09, base: 4000 },
  high: { tile: [64000, 19200], thick: 300, tauMax: 0.8, soft: 0.12, base: 9000 },
};
const GROUND_ALBEDO = { sea: [0.020, 0.024, 0.028], reedbed: [0.047, 0.045, 0.040], field: [0.044, 0.046, 0.040], city: [0.055, 0.055, 0.058] };
const GROUND_TYPE = { sea: 0, reedbed: 1, field: 2, city: 3 };
const GROUND_RHO = { sea: 0.06, reedbed: 0.12, field: 0.15, city: 0.14 };
const SKY_SCALE = { low: 0.5, medium: 0.5, high: 0.75 };
// signature canonical gradient g(el) = a + b·sin(el), fitted to the reference's top panel: el 5.5° → x 0.74 (190 codes),
// el 40° → x 1.135 (197 codes); its solid-angle mean is ≈ 1.03
export const SIG_GRADIENT = [0.77, 0.76];
// signature local adaptation: cloud-texture exponent k, large-scale exponent m, blur mip of skyRT
export const SIG_LOCAL = [0.4, 0.2, 5.0];
const CIRRUS_K = { signature: [0.12, 8], physical: [1, 1], dusk: [0.7, 1.6], negative: [0.12, 8] };

// ---------------------------------------------------------------------------------------------------------------
// signature tone curve (§5.5): monotone C1, f(1) = 0.765, f'(1) = SLOPE1, f(0.06) ≈ 0.18, f(0.02) ≈ 0.08;
// a short exponential shoulder above 1 caps any highlight (sun glow, bright cloud) at + ASYM.
export const SIGNATURE_CURVE = {
  knots: [[0, 0], [0.004, 0.024], [0.02, 0.08], [0.06, 0.18], [0.14, 0.38], [0.28, 0.585], [0.5, 0.708], [0.75, 0.748], [1, 0.765]],
  slope1: 0.085, asym: 0.0125,
};
export function signatureCurve(x, p = SIGNATURE_CURVE) {
  const K = p.knots, n = K.length;
  if (x >= 1) return K[n - 1][1] + p.asym * (1 - Math.exp(-p.slope1 * (x - 1) / p.asym));
  if (x <= 0) return 0;
  // Fritsch–Carlson monotone cubic with the end slope forced to slope1
  if (!p._m) {
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((K[i + 1][1] - K[i][1]) / (K[i + 1][0] - K[i][0]));
    m[0] = d[0]; m[n - 1] = p.slope1;
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); if (i + 1 < n - 1) m[i + 1] = t * b * d[i]; m[i] = t * a * d[i]; }
    }
    p._m = m;
  }
  let i = 0; while (i < n - 2 && x > K[i + 1][0]) i++;
  const x0 = K[i][0], x1 = K[i + 1][0], h = x1 - x0, t = (x - x0) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * K[i][1] + (t3 - 2 * t2 + t) * h * p._m[i] + (-2 * t3 + 3 * t2) * K[i + 1][1] + (t3 - t2) * h * p._m[i + 1];
}
function makeCurveTexture() {
  const N = 512, data = new Uint16Array(N);
  for (let i = 0; i < N; i++) data[i] = THREE.DataUtils.toHalfFloat(signatureCurve(Math.pow(2, (i / (N - 1)) * 16 - 12)));
  const t = new THREE.DataTexture(data, N, 1, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
function fsGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}
class FS {   // full-screen pass runner
  constructor(renderer) {
    this.r = renderer;
    this.scene = new THREE.Scene();
    this.cam = new THREE.Camera();
    this.mesh = new THREE.Mesh(fsGeometry(), new THREE.MeshBasicMaterial());
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  run(mat, rt) {
    const r = this.r, ac = r.autoClear;
    this.mesh.material = mat;
    r.autoClear = false;
    r.setRenderTarget(rt);
    r.render(this.scene, this.cam);
    r.autoClear = ac;
  }
  dispose() { this.mesh.geometry.dispose(); }
}
function makeRT(w, h, o = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...o,
  });
  return rt;
}
const fsMat = (frag, uniforms, defines = {}, extra = {}) => new THREE.ShaderMaterial({
  vertexShader: S.FSQ_VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, ...extra,
});
const wrap = (v, p) => ((v % p) + p) % p;

// ---------------------------------------------------------------------------------------------------------------
export class Sky {
  constructor({ renderer, state, prof }) {
    this.renderer = renderer;
    this.state = state;
    this.prof = prof || NOPROF;
    this.fs = new FS(renderer);
    this.frozen = false;
    this.w = 1280; this.h = 720;
    this.quality = state.quality || 'medium';
    this.skyScale = (state.preset && state.preset.skyScale) || SKY_SCALE[this.quality] || 0.5;

    // §5.4 shared light uniforms, by reference
    this.u = state.light.u = {
      uSunDir: { value: new V3(0, 1, 0) }, uSunColor: { value: new V3(0.2, 0.2, 0.2) },
      uSkyUp: { value: new V3(1, 1, 1) }, uSkyDown: { value: new V3(0.1, 0.1, 0.1) },
      uHorizonColor: { value: new V3(0.8, 0.8, 0.8) }, uZenithColor: { value: new V3(1, 1, 1) },
      uExtinction: { value: 3.912 / 20000 }, uAerialMax: { value: 0.85 }, uLook: { value: 0 },
    };
    // atmosphere + cloud uniforms, shared by every sky material
    this.au = {
      uMieScale: { value: 1 }, uTransLUT: { value: null }, uMSLUT: { value: null }, uSkyViewLUT: { value: null },
      uSunIrr: { value: new V3(1, 1, 1) }, uSunW: { value: new V3(0, 1, 0) },
    };
    this.cu = {
      uNoise2D: { value: null }, uDeckLow: { value: new V4(1200, 500, 2, DECKS.low.tauMax) },
      uDeckMid: { value: new V4(4000, 500, 2, DECKS.mid.tauMax) }, uDeckHigh: { value: new V4(9000, 300, 2, DECKS.high.tauMax) },
      uSoft: { value: new V3(DECKS.low.soft, DECKS.mid.soft, DECKS.high.soft) },
      uOffLM: { value: new V4() }, uOffH: { value: new V2() }, uEvo: { value: new V4() },
      uCirDir: { value: new V2(1, 0) }, uCamM: { value: new V3(0, 1.7, 0) }, uCover: { value: new V4() },
      uSigLost: { value: Array.from({ length: 15 }, () => new V3()) },
      uNoise3D: { value: null }, uJitter: { value: 0 }, uLowB: { value: new V2(2, 0.2) },
      uCirK: { value: new V2(1, 1) },   // cirrus contrast, blur (set per look)
    };
    // grade-side shared bits (Grade reads them through state.light.gradeU)
    this.gu = state.light.gradeU = { uStats: { value: null }, uClipToDir: { value: new THREE.Matrix4() }, uSkyTex: { value: null } };
    state.light.sky = this;

    this.scale = 1;            // auto-exposure prescale of the sun irradiance
    this.off = { low: new V2(), mid: new V2(), high: new V2() };   // unwrapped world offsets, m (= Σ v·dt)
    this.evoT = 0;
    this.cirAngle = null;
    this._lastNow = null;
    this._lut = { mie: -1, sunAlt: 1e9, ms: -1 };
    this._statsReset = true;
    this._epoch = 0;
    this._rb = { busy: false, buf: new Float32Array(16 * 2 * 4), epoch: 0 };
    this.statsCPU = null;
    this._debug = 0; this._deckOnly = null;
    this._fxKey = '';
    this._build();
  }

  // ------------------------------------------------------------------------------------------------- build
  _defines() {
    const fx = this.state.fx || {};
    return {
      MULTI_SCATTER: fx['sky.multiScatter'] ? 1 : 0,
      LIGHT_TAPS: Math.max(0, Math.min(2, fx['sky.cloudLightTaps'] ?? 2)) | 0,
      SILVER: fx['sky.silverLining'] === 0 ? 0 : 1,
      CIRRUS: fx['sky.cirrus'] === 0 ? 0 : 1,
      RAYMARCH: fx['sky.cloudRaymarch'] ? 1 : 0,
    };
  }
  _build() {
    const r = this.renderer;
    const D = this._defines();
    this._fxKey = JSON.stringify(D);
    if (D.RAYMARCH) this._ensureNoise3D();
    // LUTs
    this.transRT = makeRT(256, 64);
    this.msRT = makeRT(32, 32);
    this.skyViewRT = makeRT(192, 108);
    this.au.uTransLUT.value = this.transRT.texture;
    this.au.uMSLUT.value = this.msRT.texture;
    this.au.uSkyViewLUT.value = this.skyViewRT.texture;
    const A = this.au, C = this.cu;
    this.matTrans = fsMat(S.TRANS_FRAG, { ...A }, D);
    this.matMS = fsMat(S.MS_FRAG, { ...A });
    this.matSkyView = fsMat(S.SKYVIEW_FRAG, { ...A, uSunMu: { value: 0 } }, D);
    // noise2D
    this.noiseRT = new THREE.WebGLRenderTarget(512, 512, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: Math.min(8, r.capabilities.getMaxAnisotropy()),
    });
    const prevRT = r.getRenderTarget();
    this.fs.run(fsMat(S.NOISE2D_FRAG, {}), this.noiseRT);
    C.uNoise2D.value = this.noiseRT.texture;
    // field pass → inverse-CDF LUTs (exact coverage)
    this.matField = fsMat(S.FIELD_FRAG, { ...A, ...C, uMode: { value: 0 }, uFP: { value: 0 }, uPixAng: { value: 0 } }, D);
    this._buildCDF();
    // skyRT, hemisphere, stats
    // skyRT ping-pongs (temporal accumulation of the raymarched deck); its mips are the signature grade's local sky
    const sw = Math.max(16, Math.floor(this.w * this.skyScale)), sh = Math.max(16, Math.floor(this.h * this.skyScale));
    this.skyRTs = [0, 1].map(() => makeRT(sw, sh, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }));
    this.skyRT = this.skyRTs[0];
    this.gu.uSkyTex.value = this.skyRT.texture;
    this._prevVP = new THREE.Matrix4();
    this._history = false;
    this.hemiRT = makeRT(64, 32, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const fopt = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.statsA = makeRT(16, 2, fopt); this.statsB = makeRT(16, 2, fopt);
    this.matPrepass = fsMat(S.PREPASS_FRAG, { ...A, ...C, uPixAng: { value: 0.001 }, uClipToDir: this.gu.uClipToDir,
      uPrevSky: { value: null }, uPrevVP: { value: this._prevVP }, uHistory: { value: 0 } }, D);
    this.matHemi = fsMat(S.HEMI_FRAG, { ...A, ...C, uPixAng: { value: 0.004 } }, D);
    this.rowsRT = makeRT(32, 1, fopt);
    this.matRows = fsMat(S.ROWS_FRAG, { uHemi: { value: this.hemiRT.texture } });
    this.matStats = fsMat(S.STATS_FRAG, { ...A, ...C, uPixAng: { value: 0.004 }, uRows: { value: this.rowsRT.texture }, uPrev: { value: null },
      uAlpha: { value: 1 }, uGroundAlbedo: { value: 0.06 }, uFlockPos: { value: new V3(0, 110, 0) } }, D);
    this.gu.uStats.value = this.statsA.texture;
    // scene objects: bg quad + ground
    this.object3d = new THREE.Group();
    this.object3d.name = 'sky';
    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: S.BG_VERT, fragmentShader: S.BG_FRAG, defines: D, depthTest: false, depthWrite: false,
      uniforms: { ...A, ...C, uPixAng: { value: 0 }, uSkyTex: { value: this.skyRT.texture }, uRes: { value: new V2(this.w, this.h) },
        uClipToDir: this.gu.uClipToDir, uSunDisc: { value: 0 }, uDebug: { value: 0 }, uFrame: { value: 0 } },
    });
    this.bg = new THREE.Mesh(fsGeometry(), this.bgMat);
    this.bg.frustumCulled = false; this.bg.renderOrder = -1000; this.bg.name = 'skyBg';
    this.object3d.add(this.bg);
    this.ground = createGround(this.state, { sky: this });
    this.object3d.add(this.ground);
    r.setRenderTarget(prevRT);
  }

  _buildCDF() {
    // 1. each deck's field over one full tile at full resolution → inverse-CDF LUT (exact coverage)
    // 2. the field's standard deviation at footprints 2^k m → the variance a pre-filter removes (sigLost)
    const r = this.renderer;
    const N = 256, rt = makeRT(N, N, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.cu.uEvo.value.set(0, 0, 0, 0);
    const U = this.matField.uniforms;
    U.uMode.value = 0;
    const buf = new Float32Array(N * N * 4);
    const sd = [];
    for (let k = -1; k < 15; k++) {
      U.uFP.value = k < 0 ? 0 : Math.pow(2, k);
      this.fs.run(this.matField, rt);
      r.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      if (k < 0) {
        const cdf = {};
        ['low', 'mid', 'high'].forEach((name, c) => {
          const v = new Float32Array(N * N);
          for (let i = 0; i < N * N; i++) v[i] = buf[i * 4 + c];
          v.sort();
          const lut = new Float32Array(256);
          const soft = DECKS[name].soft;
          for (let j = 0; j < 256; j++) {
            const cover = j / 255;
            if (j === 0) lut[j] = v[v.length - 1] + 1e-3;
            else if (j === 255) lut[j] = v[0] - soft - 1e-3;
            else lut[j] = v[Math.min(v.length - 1, Math.max(0, Math.floor((1 - cover) * v.length)))];
          }
          let m = 0, m2 = 0; for (let i = 0; i < v.length; i++) { m += v[i]; m2 += v[i] * v[i]; }
          m /= v.length;
          cdf[name] = { lut, min: v[0], max: v[v.length - 1], median: v[v.length >> 1], mean: m, std: Math.sqrt(Math.max(0, m2 / v.length - m * m)) };
        });
        this.cdf = cdf;
        sd.push([cdf.low.std, cdf.mid.std, cdf.high.std]);
      } else {
        if (k === 8) {   // the 256 m field: its own inverse CDF for the volumetric low deck
          const v = new Float32Array(N * N);
          for (let i = 0; i < N * N; i++) v[i] = buf[i * 4];
          v.sort();
          const lut = new Float32Array(256);
          for (let j = 0; j < 256; j++) lut[j] = j === 0 ? v[v.length - 1] + 1e-3 : (j === 255 ? v[0] - 0.08 : v[Math.floor((1 - j / 255) * v.length)]);
          this.cdfLowB = { lut, max: v[v.length - 1] };
        }
        const out = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          let m = 0, m2 = 0;
          for (let i = 0; i < N * N; i++) { const x = buf[i * 4 + c]; m += x; m2 += x * x; }
          m /= N * N; out[c] = Math.sqrt(Math.max(0, m2 / (N * N) - m * m));
        }
        sd.push(out);
      }
    }
    rt.dispose();
    U.uFP.value = 0;
    const s0 = sd[0];
    this.sigLost = [];
    for (let k = 0; k < 15; k++) {
      const s = sd[k + 1], v = [0, 1, 2].map(c => Math.sqrt(Math.max(0, s0[c] * s0[c] - s[c] * s[c])));
      this.cu.uSigLost.value[k].fromArray(v);
      this.sigLost.push(v.map(x => +x.toFixed(4)));
    }
  }
  /** threshold for a deck so its covered area fraction equals cover (0..1) */
  threshold(deck, cover) {
    const lut = this.cdf[deck].lut;
    const x = Math.max(0, Math.min(1, cover)) * 255, i = Math.min(254, Math.floor(x)), f = x - i;
    return lut[i] + (lut[i + 1] - lut[i]) * f;
  }

  // ------------------------------------------------------------------------------------------------- per frame
  update(dtReal, camera) {
    const st = this.state, r = this.renderer;
    const prevRT = r.getRenderTarget();
    this._checkFx();
    if (st.look !== this._look) this.setLook(st.look);
    // sun
    const site = st.site || SITES[0];
    const tMs = st.time && st.time.nowMs ? st.time.nowMs : Date.now();
    const sp = sunPosition(tMs, site.lat, site.lon, st.sun.dir);
    st.sun.azimuthDeg = sp.azimuthDeg; st.sun.altitudeDeg = sp.altitudeDeg;
    const D = localDateOf(tMs, site.tz);
    if (this._sunKey !== site.id + D) {
      this._sunKey = site.id + D;
      const t = sunTimes(D, site.lat, site.lon);
      st.sun.sunriseMs = t.sunriseMs; st.sun.sunsetMs = t.sunsetMs; st.sun.civilDuskMs = t.civilDuskMs; st.sun.solarNoonMs = t.solarNoonMs;
    }
    this.u.uSunDir.value.copy(st.sun.dir);
    this.au.uSunW.value.copy(st.sun.dir);
    // weather
    const s = st.weather && st.weather.sample;
    const vis = s && isFinite(s.visibilityM) && s.visibilityM > 0 ? s.visibilityM : 20000;
    const mie = THREE.MathUtils.clamp(20000 / vis, 0.5, 8);
    this.au.uMieScale.value = mie;
    this.u.uExtinction.value = 3.912 / vis;
    // LUTs
    this.prof.begin('sky.lut');
    const ms = this.au && this._defines().MULTI_SCATTER;
    const hazeChanged = this._lut.mie < 0 || Math.abs(Math.log(mie / this._lut.mie)) > 0.02;
    if (hazeChanged) {
      this.fs.run(this.matTrans, this.transRT);
      if (ms) this.fs.run(this.matMS, this.msRT);
      this._lut.mie = mie;
    }
    if (hazeChanged || this._lut.ms !== ms || Math.abs(sp.altitudeDeg - this._lut.sunAlt) > 0.1) {
      this.matSkyView.uniforms.uSunMu.value = st.sun.dir.y;
      this.fs.run(this.matSkyView, this.skyViewRT);
      this._lut.sunAlt = sp.altitudeDeg; this._lut.ms = ms;
      this.lutUpdates = (this.lutUpdates || 0) + 1;
    }
    this.prof.end();
    // clouds: coverage, thresholds, decks, wind drift
    let dtw;
    if (st.time && st.time.nowMs) {
      dtw = this._lastNow == null ? 0 : (st.time.nowMs - this._lastNow) / 1000;
      this._lastNow = st.time.nowMs;
      if (!(dtw >= 0 && dtw < 900)) dtw = 0;      // a time jump (new site/time): keep the clouds where they are
    } else dtw = Math.max(0, dtReal || 0);
    if (this.frozen) dtw = 0;
    this._updateDecks(dtw);
    // ground type and waves
    this._updateGround(site, dtw);
    // camera
    if (camera) {
      camera.updateMatrixWorld();
      this.cu.uCamM.value.setFromMatrixPosition(camera.matrixWorld);
      this.gu.uClipToDir.value.copy(camera.matrixWorld).setPosition(0, 0, 0).multiply(camera.projectionMatrixInverse);
      // angular size of one skyRT pixel (vertical), for the explicit cloud mip selection
      const fovY = camera.isPerspectiveCamera ? camera.getEffectiveFOV() * DEG : 1;
      this.matPrepass.uniforms.uPixAng.value = fovY / this.skyRT.height;
      this.ground.material.uniforms.uPixAng.value = fovY / this.h;
    }
    this.cu.uCamM.value.y = Math.max(0.5, this.cu.uCamM.value.y);
    // prepass + stats
    if (!this.frozen) {
      this.prof.begin('sky.prepass');
      this._prepass(camera);
      this._runStats(dtReal);
      this.prof.end();
      if (!this.statsCPU) {                          // first frame: synchronous, then settle the prescale
        for (let k = 0; k < 3; k++) {
          this.renderer.readRenderTargetPixels(this._statsCur, 0, 0, 16, 2, this._rb.buf);
          const rescaled = this._applyStats(this._rb.buf, this._epoch);
          if (!rescaled) break;
          this._history = false;
          this._prepass(camera);
          this._runStats(dtReal);
        }
      } else this._readback();
    }
    this.bgMat.uniforms.uFrame.value = (this.bgMat.uniforms.uFrame.value + 1) % 4096;
    this.cu.uJitter.value = this.frozen ? this.cu.uJitter.value : (this.cu.uJitter.value + 0.618034) % 1;
    r.setRenderTarget(prevRT);
  }

  _prepass(camera) {
    const U = this.matPrepass.uniforms;
    const prev = this.skyRT, next = this.skyRTs[0] === prev ? this.skyRTs[1] : this.skyRTs[0];
    U.uPrevSky.value = prev.texture;
    U.uHistory.value = this._history && !this._statsReset ? 0.82 : 0;
    this.fs.run(this.matPrepass, next);
    this.skyRT = next;
    this._history = true;
    if (camera) this._prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.gu.uSkyTex.value = next.texture;
    this.bgMat.uniforms.uSkyTex.value = next.texture;
    this.ground.material.uniforms.uSkyTex.value = next.texture;
  }

  _updateDecks(dtw) {
    const st = this.state, C = this.cu, w = st.wind, cl = st.clouds;
    const fx = this.state.fx || {};
    const cirrusOn = fx['sky.cirrus'] !== 0;
    let low = cl.low || 0, mid = cl.mid || 0, high = cirrusOn ? (cl.high || 0) : 0;
    if (this._deckOnly) { low = this._deckOnly === 'low' ? low : 0; mid = this._deckOnly === 'mid' ? mid : 0; high = this._deckOnly === 'high' ? high : 0; }
    if (this.coverOverride) ({ low, mid, high } = { low, mid, high, ...this.coverOverride });
    const base = THREE.MathUtils.clamp(cl.baseLowM || 1200, 300, 2000);
    C.uDeckLow.value.set(base, DECKS.low.thick, this.threshold('low', low), DECKS.low.tauMax);
    C.uDeckMid.value.set(Math.max(DECKS.mid.base, base + 1200), DECKS.mid.thick, this.threshold('mid', mid), DECKS.mid.tauMax);
    C.uDeckHigh.value.set(DECKS.high.base, DECKS.high.thick, high > 0 ? this.threshold('high', high) : 2, DECKS.high.tauMax);
    // a jump in coverage (new site/time, a test override) re-seeds the light/Lref average instead of easing over ~1 s
    const lc = this._lastCover;
    if (lc && (Math.abs(lc[0] - low) > 0.05 || Math.abs(lc[1] - mid) > 0.05 || Math.abs(lc[2] - high) > 0.05)) this._statsReset = true;
    this._lastCover = [low, mid, high];
    C.uCover.value.set(low, mid, high, cl.total || Math.max(low, mid, high));
    if (this.cdfLowB) {   // volumetric low deck: threshold of the 256 m field, and the field range above it
      const lut = this.cdfLowB.lut, x = THREE.MathUtils.clamp(low, 0, 1) * 255, i = Math.min(254, Math.floor(x)), f = x - i;
      const thr = lut[i] + (lut[i + 1] - lut[i]) * f;
      C.uLowB.value.set(thr, Math.max(0.04, (this.cdfLowB.max - thr) * 0.6));
    }
    // drift: offset = ∫ v_layer dt (SPEC §5.3; = v·t for a steady wind). Low = v850, mid = v500, high = v300.
    if (dtw > 0) {
      this.off.low.x += w.v850.x * dtw; this.off.low.y += w.v850.z * dtw;
      this.off.mid.x += w.v500.x * dtw; this.off.mid.y += w.v500.z * dtw;
      this.off.high.x += w.v300.x * dtw; this.off.high.y += w.v300.z * dtw;
      this.evoT += dtw;
    }
    // cirrus streaks lie along v300; the frame re-snaps only when the wind veers > 25°
    const a = Math.atan2(w.v300.z, w.v300.x);
    if (this.cirAngle == null || (Math.hypot(w.v300.x, w.v300.z) > 1 && Math.abs(Math.atan2(Math.sin(a - this.cirAngle), Math.cos(a - this.cirAngle))) > 25 * DEG)) {
      this.cirAngle = Math.hypot(w.v300.x, w.v300.z) > 1e-3 ? a : 0;
    }
    const cx = Math.cos(this.cirAngle), cz = Math.sin(this.cirAngle);
    C.uCirDir.value.set(cx, cz);
    const TL = DECKS.low.tile, TM = DECKS.mid.tile, TH = DECKS.high.tile;
    C.uOffLM.value.set(wrap(this.off.low.x, TL), wrap(this.off.low.y, TL), wrap(this.off.mid.x, TM), wrap(this.off.mid.y, TM));
    const ox = this.off.high.x, oz = this.off.high.y;
    C.uOffH.value.set(wrap(ox * cx + oz * cz, TH[0]), wrap(-ox * cz + oz * cx, TH[1]));
    C.uEvo.value.set(wrap(this.evoT * 6.0e-4, 1), wrap(this.evoT * 3.5e-4, 1), wrap(this.evoT * 6.5e-4, 1), wrap(-this.evoT * 4.0e-4, 1));
  }

  _updateGround(site, dtw) {
    const g = this.ground, type = site.ground || 'sea';
    if (g.userData.type !== type) {
      g.userData.type = type;
      g.material.uniforms.uAlbedo.value.fromArray(GROUND_ALBEDO[type] || GROUND_ALBEDO.field);
      g.material.uniforms.uType.value = GROUND_TYPE[type] ?? 2;
      this.matStats.uniforms.uGroundAlbedo.value = GROUND_RHO[type] || 0.12;
    }
    const w = this.state.wind.v10, wv = g.material.uniforms.uWave.value;
    wv.set(wrap(wv.x + w.x * dtw * 0.06 / 180, 1), wrap(wv.y + w.z * dtw * 0.06 / 180, 1));
  }

  _runStats(dtReal) {
    this.fs.run(this.matHemi, this.hemiRT);
    this.fs.run(this.matRows, this.rowsRT);
    const prev = this._statsCur || this.statsA, next = prev === this.statsA ? this.statsB : this.statsA;
    this.matStats.uniforms.uPrev.value = prev.texture;
    this.matStats.uniforms.uAlpha.value = this._statsReset ? 1 : 1 - Math.exp(-Math.max(dtReal || 0.016, 0.001) / 1.2);
    const fp = this.state.flock && this.state.flock.centroid;
    if (fp) this.matStats.uniforms.uFlockPos.value.set(fp.x, Math.max(2, fp.y), fp.z);
    this.fs.run(this.matStats, next);
    this._statsCur = next;
    this._statsReset = false;
    this.gu.uStats.value = next.texture;
    this.ground.material.uniforms.uStats.value = next.texture;
  }

  _readback() {
    const rb = this._rb, r = this.renderer;
    if (rb.busy || !r.readRenderTargetPixelsAsync) {
      if (!r.readRenderTargetPixelsAsync && (this._syncCount = (this._syncCount || 0) + 1) % 30 === 0) {
        r.readRenderTargetPixels(this._statsCur, 0, 0, 16, 2, rb.buf); this._applyStats(rb.buf, this._epoch);
      }
      return;
    }
    rb.busy = true;
    const epoch = this._epoch;
    r.readRenderTargetPixelsAsync(this._statsCur, 0, 0, 16, 2, rb.buf)
      .then(() => { rb.busy = false; this._applyStats(rb.buf, epoch); })
      .catch(() => { rb.busy = false; });
    // three r170 leaves its PBO bound to PIXEL_PACK_BUFFER while the fence is pending, which breaks every
    // synchronous readPixels in the meantime (trails' PNG export, tests). It rebinds the PBO itself before reading.
    const gl = r.getContext();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  /** copy the measured light into the shared uniforms; returns true if the prescale changed */
  _applyStats(b, epoch) {
    if (epoch !== this._epoch) return false;
    const px = (x, y) => (y * 16 + x) * 4;
    const v3 = (x, y, out) => out.set(b[px(x, y)], b[px(x, y) + 1], b[px(x, y) + 2]);
    const Lref = b[px(0, 1) + 3];
    if (!(Lref > 0) || !isFinite(Lref)) return false;
    const U = this.u;
    v3(1, 1, U.uSkyUp.value); v3(2, 1, U.uSunColor.value); v3(3, 1, U.uSkyDown.value);
    v3(4, 1, U.uHorizonColor.value); v3(5, 1, U.uZenithColor.value);
    const profile = [];
    for (let i = 0; i < 16; i++) profile.push(b[px(i, 0) + 3]);
    this.statsCPU = {
      Lref, LrefPhysical: Lref / this.scale, scale: this.scale, profile,
      skyUp: U.uSkyUp.value.toArray(), sun: U.uSunColor.value.toArray(), skyDown: U.uSkyDown.value.toArray(),
      horizon: U.uHorizonColor.value.toArray(), zenith: U.uZenithColor.value.toArray(),
      sunCloudT: b[px(2, 1) + 3], hemiViewT: b[px(6, 1)],
    };
    // auto-exposure prescale: keep Lref within a factor 2 of 1 so half floats stay healthy at any sun altitude
    if (Math.abs(Math.log2(Lref)) > 1) {
      this.scale = THREE.MathUtils.clamp(this.scale / Lref, 1e-3, 1e9);
      this.au.uSunIrr.value.setScalar(this.scale);
      this._statsReset = true;
      this._epoch++;
      return true;
    }
    return false;
  }

  _ensureNoise3D() {
    if (this.noise3D) return;
    const r = this.renderer, prev = r.getRenderTarget();
    const rt = new THREE.WebGL3DRenderTarget(64, 64, 64, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
    const t = rt.texture;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    const m = fsMat(S.NOISE3D_FRAG, { uSlice: { value: 0 } });
    const ac = r.autoClear; r.autoClear = false;
    this.fs.mesh.material = m;
    for (let z = 0; z < 64; z++) { m.uniforms.uSlice.value = z; r.setRenderTarget(rt, z); r.render(this.fs.scene, this.fs.cam); }
    r.autoClear = ac;
    r.setRenderTarget(prev);
    m.dispose();
    this.noise3D = rt;
    this.cu.uNoise3D.value = t;
  }
  _checkFx() {
    const D = this._defines(), key = JSON.stringify(D);
    if (D.RAYMARCH) this._ensureNoise3D();
    if (key === this._fxKey) return;
    this._fxKey = key;
    for (const m of [this.matTrans, this.matSkyView, this.matField, this.matPrepass, this.matHemi, this.matStats, this.bgMat]) {
      m.defines = { ...D }; m.needsUpdate = true;
    }
    this._lut.mie = -1;     // rebuild the LUTs with the new multi-scatter path
    this._statsReset = true;
  }

  // ------------------------------------------------------------------------------------------------- API
  setLook(look) {
    if (!(look in LOOK_IDS)) look = 'signature';
    this._look = look;
    if (look !== 'negative') this.state.look = look;
    this.u.uLook.value = LOOK_IDS[look];
    this.bgMat.uniforms.uSunDisc.value = look === 'physical' ? 1 : 0;
    // signature: cirrus only as a faint, wide tonal drift in the grey (1–3 codes); dusk: softened; physical: as is
    this.cu.uCirK.value.set(...(CIRRUS_K[look] || CIRRUS_K.physical));
  }
  setQuality(q) {
    this.quality = q;
    this.skyScale = (this.state.preset && this.state.preset.skyScale) || SKY_SCALE[q] || 0.5;
    this._checkFx();
    this.setSize(this.w, this.h);
  }
  setFrozen(b) { this.frozen = !!b; }
  setSize(w, h) {
    this.w = Math.max(1, w | 0); this.h = Math.max(1, h | 0);
    for (const t of this.skyRTs) t.setSize(Math.max(16, Math.floor(this.w * this.skyScale)), Math.max(16, Math.floor(this.h * this.skyScale)));
    this._history = false;
    this.bgMat.uniforms.uRes.value.set(this.w, this.h);
    this.ground.material.uniforms.uRes.value.set(this.w, this.h);
  }
  get skyTexture() { return this.skyRT.texture; }
  /** reset the drift integration (new site/time) */
  resetClouds() { this.off.low.set(0, 0); this.off.mid.set(0, 0); this.off.high.set(0, 0); this.evoT = 0; this._lastNow = null; this.cirAngle = null; this._statsReset = true; }

  get debug() {
    const self = this;
    return {
      view(name) {
        const m = { off: 0, none: 0, coverage: 1, lut: 2, trans: 3 };
        self._deckOnly = null;
        if (name && name.startsWith('deck:')) { self._deckOnly = name.slice(5); self.bgMat.uniforms.uDebug.value = 0; }
        else self.bgMat.uniforms.uDebug.value = m[name] || 0;
        self.state.light.debugRaw = self.bgMat.uniforms.uDebug.value > 0;
        self._statsReset = true;
        return name;
      },
      meanSky() { return self.statsCPU; },
      get Lref() { return self.statsCPU ? self.statsCPU.Lref : null; },
      get offsets() { return { low: self.off.low.toArray(), mid: self.off.mid.toArray(), high: self.off.high.toArray(), evoT: self.evoT }; },
      get thresholds() { const c = self.cu; return { low: c.uDeckLow.value.z, mid: c.uDeckMid.value.z, high: c.uDeckHigh.value.z }; },
      get cdf() { const f = k => ({ min: self.cdf[k].min, max: self.cdf[k].max, mean: self.cdf[k].mean, std: self.cdf[k].std }); return { low: f('low'), mid: f('mid'), high: f('high'), sigLost: self.sigLost }; },
      get decks() { const c = self.cu; return { low: c.uDeckLow.value.toArray(), mid: c.uDeckMid.value.toArray(), high: c.uDeckHigh.value.toArray(), cover: c.uCover.value.toArray() }; },
      get lutUpdates() { return self.lutUpdates || 0; },
      /** covered fraction of each deck over one full tile at the given covers (S4). Sync readback; tests only. */
      measureCoverage(covers) {
        const N = 256, rt = makeRT(N, N, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        const C = self.cu, keep = [C.uDeckLow.value.z, C.uDeckMid.value.z, C.uDeckHigh.value.z];
        const evo = C.uEvo.value.clone();
        C.uDeckLow.value.z = self.threshold('low', covers.low); C.uDeckMid.value.z = self.threshold('mid', covers.mid); C.uDeckHigh.value.z = self.threshold('high', covers.high);
        self.matField.uniforms.uMode.value = 1;
        const prev = self.renderer.getRenderTarget();
        self.fs.run(self.matField, rt);
        const buf = new Uint8Array(N * N * 4);
        self.renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
        self.renderer.setRenderTarget(prev);
        rt.dispose();
        self.matField.uniforms.uMode.value = 0;
        C.uDeckLow.value.z = keep[0]; C.uDeckMid.value.z = keep[1]; C.uDeckHigh.value.z = keep[2]; C.uEvo.value.copy(evo);
        let l = 0, m = 0, h = 0;
        for (let i = 0; i < N * N; i++) { l += buf[i * 4] > 127; m += buf[i * 4 + 1] > 127; h += buf[i * 4 + 2] > 127; }
        return { low: l / (N * N), mid: m / (N * N), high: h / (N * N) };
      },
      readSkyRT() {
        const w = self.skyRT.width, h = self.skyRT.height, buf = new Uint16Array(w * h * 4);
        self.renderer.readRenderTargetPixels(self.skyRT, 0, 0, w, h, buf);
        return { w, h, buf };
      },
    };
  }

  dispose() {
    for (const t of [this.transRT, this.msRT, this.skyViewRT, this.noiseRT, ...this.skyRTs, this.hemiRT, this.rowsRT, this.statsA, this.statsB, this.noise3D]) t && t.dispose();
    for (const m of [this.matTrans, this.matMS, this.matSkyView, this.matField, this.matPrepass, this.matHemi, this.matRows, this.matStats, this.bgMat]) m && m.dispose();
    this.bg.geometry.dispose();
    this.ground.geometry.dispose(); this.ground.material.dispose();
    this.fs.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------
export function createGround(state, opts = {}) {
  const sky = opts.sky || (state.light && state.light.sky) || null;
  const site = state.site || SITES[0];
  const type = site.ground || 'sea';
  const R = 60000;
  const geo = new THREE.CircleGeometry(R, 128);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: S.GROUND_VERT, fragmentShader: S.GROUND_FRAG,
    uniforms: {
      ...state.light.u,
      uSkyTex: { value: sky ? sky.skyRT.texture : null }, uStats: { value: sky ? sky.gu.uStats.value : null },
      uNoise2D: { value: sky ? sky.noiseRT.texture : null }, uRes: { value: new V2(1280, 720) },
      uAlbedo: { value: new V3().fromArray(GROUND_ALBEDO[type] || GROUND_ALBEDO.field) }, uType: { value: GROUND_TYPE[type] ?? 2 }, uPixAng: { value: 0.001 },
      uRadius: { value: R }, uWave: { value: new V2() },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ground';
  mesh.renderOrder = -900;
  mesh.frustumCulled = false;
  mesh.userData.type = type;
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
export class Grade {
  constructor({ renderer, state }) {
    this.renderer = renderer;
    this.state = state;
    this.fs = new FS(renderer);
    this.override = null;
    this.frame = 0;
    this.ev = 0;
    const tint = new V3(0.990, 0.995, 1.000);
    tint.multiplyScalar(1 / (0.2126 * tint.x + 0.7152 * tint.y + 0.0722 * tint.z));
    // fallback stats (no Sky): Lref = 1, flat profile
    const fb = new Float32Array(16 * 2 * 4).fill(1);
    this._fbStats = new THREE.DataTexture(fb, 16, 2, THREE.RGBAFormat, THREE.FloatType);
    this._fbStats.needsUpdate = true;
    this._fbSky = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this._fbSky.needsUpdate = true;
    this.curveTex = makeCurveTexture();
    this.mat = fsMat(S.GRADE_FRAG, {
      tSrc: { value: null }, uStats: { value: this._fbStats }, uCurve: { value: this.curveTex },
      uClipToDir: { value: new THREE.Matrix4() }, uGLook: { value: 0 }, uEV: { value: 0 },
      uTint: { value: tint }, uChroma: { value: 0.08 }, uSigGrad: { value: new V2(SIG_GRADIENT[0], SIG_GRADIENT[1]) },
      uSigK: { value: new V3(...SIG_LOCAL) }, uSkyTex: { value: null }, uSunG: { value: new V4(0, 1, 0, 45) },
    });
    this.presentMat = fsMat(S.PRESENT_FRAG, { tSrc: { value: null }, uFrame: { value: 0 }, uSize: { value: new V2(1280, 720) } }, this._postDefines());
    this._postKey = JSON.stringify(this._postDefines());
  }
  _postDefines() {
    const fx = this.state.fx || {};
    return { DITHER: fx['post.dither'] === 0 ? 0 : 1, GRAIN: fx['post.grain'] ? 1 : 0, VIGNETTE: fx['post.vignette'] === 0 ? 0 : 1 };
  }
  /** 'negative' for the ornito lighten blend, or null to follow state.look */
  setLookOverride(look) { this.override = look || null; }
  get negative() { return this.override === 'negative'; }
  set negative(v) { this.override = v ? 'negative' : null; }
  get look() { const l = this.state.light; return this.override || (l && l.debugRaw ? 'raw' : this.state.look || 'signature'); }

  render(srcTex, dstRT) {
    const U = this.mat.uniforms, g = this.state.light && this.state.light.gradeU;
    if (g) { U.uStats.value = g.uStats.value || this._fbStats; U.uClipToDir.value.copy(g.uClipToDir.value); U.uSkyTex.value = g.uSkyTex.value; }
    if (!U.uSkyTex.value) U.uSkyTex.value = this._fbSky;
    U.tSrc.value = srcTex;
    U.uGLook.value = LOOK_IDS[this.look] ?? 0;
    U.uEV.value = this.ev;
    const sun = this.state.sun;
    if (sun && sun.dir) U.uSunG.value.set(sun.dir.x, sun.dir.y, sun.dir.z, sun.altitudeDeg ?? 45);
    const prev = this.renderer.getRenderTarget();
    this.fs.run(this.mat, dstRT);
    this.renderer.setRenderTarget(prev);
  }
  _present(srcTex, rt) {
    const key = JSON.stringify(this._postDefines());
    if (key !== this._postKey) { this._postKey = key; this.presentMat.defines = this._postDefines(); this.presentMat.needsUpdate = true; }
    const U = this.presentMat.uniforms;
    U.tSrc.value = srcTex;
    U.uFrame.value = this.frame;
    this.fs.run(this.presentMat, rt);
  }
  present(srcTex) { this.frame = (this.frame + 1) % 100000; this._present(srcTex, null); }
  presentTo(srcTex, rt8) { this._present(srcTex, rt8); }
  setSize(w, h) { this.presentMat.uniforms.uSize.value.set(w, h); }
  dispose() { this.mat.dispose(); this.presentMat.dispose(); this.curveTex.dispose(); this._fbStats.dispose(); this.fs.dispose(); }
}
