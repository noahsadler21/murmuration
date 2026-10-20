// trails.js: Ornitography mode (SPEC §7.1), after Xavi Bou's "Ornitographies" (reference only; no copied imagery).
//
// A virtual high-speed camera: while the shutter is open the simulation advances 1/vfps s of bird time per stamp
// (slow motion on screen), and every stamp is composited into accRT with a HARD blend, MIN (darken) or MAX
// (lighten). Each stamp is the crisp, MSAA-resolved silhouette of every tracked bird in its actual VAT wing pose,
// so the exposure builds layered chronophotography: overlapping sharp wing shapes forming sculptural ribbons.
// There is no averaging, no accumulation-buffer blur and no motion blur anywhere in this file.
//
// Optional decay (0..0.05 per stamp) pulls acc back toward the plate before each stamp:
//   acc = mix(acc, plate, decay)        (blend: src = plate with alpha = decay, SRC_ALPHA / ONE_MINUS_SRC_ALPHA;
//                                        identical to the CONSTANT_ALPHA form in the spec, but portable)
// so a stamp k frames old keeps (1 - decay)^k of its contrast.
//
// Ownership: Trails builder. Imports only three.
import * as THREE from 'three';

const VS = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FS_COPY = /* glsl */`precision highp float; uniform sampler2D tSrc; varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`;
const FS_DECAY = /* glsl */`precision highp float; uniform sampler2D tSrc; uniform float uDecay; varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, uDecay); }`;
// 'layer' blend (review fix P11, all-birds plates): every stamp multiplies the plate by a fraction of its own darkness,
// like stacking semi-transparent film frames. A single wing pass is a light graphite stroke; where many passes overlap
// the plate builds to near-black, so the flock's folds and flows become a modelled, sculptural volume instead of a
// uniformly saturated (min-blended) slab of hair.
const FS_LAYER = /* glsl */`precision highp float; uniform sampler2D tSrc; uniform sampler2D tPlate; uniform float uK; varying vec2 vUv;
void main() {
  vec3 f = texture2D(tSrc, vUv).rgb, p = max(texture2D(tPlate, vUv).rgb, vec3(1e-3));
  vec3 r = clamp(f / p, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0), r, uK), 1.0);
}`;
// Ghost of the live (untracked) flock under the exposure, for the "show untracked live" toggle.
const FS_COMPOSE = /* glsl */`precision highp float; uniform sampler2D tAcc; uniform sampler2D tPlate; uniform sampler2D tLive;
uniform float uGhost; uniform float uLighten; varying vec2 vUv;
void main() {
  vec3 a = texture2D(tAcc, vUv).rgb, p = texture2D(tPlate, vUv).rgb, l = texture2D(tLive, vUv).rgb;
  vec3 g = mix(p, l, uGhost);
  gl_FragColor = vec4(uLighten > 0.5 ? max(a, g) : min(a, g), 1.0);
}`;

function quadMat(fs, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, ...extra });
}

function localStamp(ms, tz) {
  // YYYYMMDD-HHmm in the site's time zone (falls back to the browser's).
  const d = new Date(ms || Date.now());
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
  } catch (e) {
    parts = { year: d.getFullYear(), month: String(d.getMonth() + 1).padStart(2, '0'), day: String(d.getDate()).padStart(2, '0'),
      hour: String(d.getHours()).padStart(2, '0'), minute: String(d.getMinutes()).padStart(2, '0') };
  }
  return { file: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`,
    human: `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}` };
}

export class Trails {
  constructor({ renderer, state, prof }) {
    this.renderer = renderer;
    this.state = state;
    this.prof = prof || { begin() {}, end() {} };
    this.w = 2; this.h = 2;
    const rtOpt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.accRT = new THREE.WebGLRenderTarget(2, 2, rtOpt);     // SPEC §1: RGBA16F, render size
    this.plateRT = new THREE.WebGLRenderTarget(2, 2, rtOpt);   // a private copy of the plate (the integrator may reuse its own)
    this.composeRT = null;                                     // created on first use of composite()
    this._rtOpt = rtOpt;

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);

    this.mCopy = quadMat(FS_COPY, { tSrc: { value: null } });
    this.mDecay = quadMat(FS_DECAY, { tSrc: { value: null }, uDecay: { value: 0 } }, {
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    // MIN / MAX ignore the blend factors (GL spec), so these materials are a pure per-channel min / max.
    const hard = eq => quadMat(FS_COPY, { tSrc: { value: null } }, {
      transparent: true, blending: THREE.CustomBlending, blendEquation: eq, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: eq, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
    this.mMin = hard(THREE.MinEquation);
    this.mMax = hard(THREE.MaxEquation);
    this.mLayer = quadMat(FS_LAYER, { tSrc: { value: null }, tPlate: { value: null }, uK: { value: 0.22 } }, {
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor, blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    this.mCompose = quadMat(FS_COMPOSE, { tAcc: { value: null }, tPlate: { value: null }, tLive: { value: null },
      uGhost: { value: 0.28 }, uLighten: { value: 0 } });

    this._running = false;     // shutter open
    this._active = false;      // acc holds an exposure (running or finished)
    this._done = 0;
    this._blend = 'darken';
    this._lastT = -1;
    this._liveAcc = 0;
    this._stampCount = 0;
    this._lastPlate = null;
    this._unsub = [
      state.on('ornito:stop', () => { if (this._running) this.end(); }),
      state.on('ornito:new', () => this.clear()),
      state.on('mode', m => { if (m === 'live') this.clear(); }),
    ];

    const self = this;
    this.debug = {
      get stampCount() { return self._stampCount; },
      get lastPlate() { return self._lastPlate; },
      // Pixel comparison of acc against the plate (RGBA8 copies): how much of the frame the exposure changed.
      compareToPlate() {
        const a = self.readPixels(self.accRT.texture), p = self.readPixels(self.plateRT.texture);
        let changed = 0, darker = 0, lighter = 0, maxDiff = 0, soft = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = (a[i] + a[i + 1] + a[i + 2] - p[i] - p[i + 1] - p[i + 2]) / 3;
          const ad = Math.abs(d);
          if (ad > 1) { changed++; if (d < 0) darker++; else lighter++; if (ad < 6) soft++; }
          if (ad > maxDiff) maxDiff = ad;
        }
        const n = a.length / 4;
        return { pixels: n, changedFrac: changed / n, darkerFrac: darker / n, lighterFrac: lighter / n, maxDiff, softFrac: changed ? soft / changed : 0 };
      },
      readAcc() { return self.readPixels(self.accRT.texture); },
      readPlate() { return self.readPixels(self.plateRT.texture); },
    };
  }

  setSize(w, h) {
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.accRT.setSize(w, h);
    this.plateRT.setSize(w, h);
    if (this.composeRT) this.composeRT.setSize(w, h);
    if (this._rt8) { this._rt8.dispose(); this._rt8 = null; }
    // A resize invalidates the exposure.
    if (this._active) this.clear();
  }

  // §1 step 1. Live: real-time stepping with an accumulator, 0–2 steps of 1/60 s (0 only on displays faster than
  // 60 Hz, so bird time stays real time there too). Ornito with the shutter open: skip+1 steps of 1/vfps, one stamp.
  // Ornito with the shutter closed after an exposure: frozen (0 steps) so the finished plate stays put.
  plan(state = this.state) {
    const now = performance.now();
    const real = this._lastT < 0 ? 1 / 60 : Math.min(0.1, (now - this._lastT) / 1000);
    this._lastT = now;
    if (state.mode === 'ornito' && this._running) {
      const o = state.ornito;
      return { steps: (o.skip | 0) + 1, dt: 1 / (o.vfps || 240), stamp: true };
    }
    if (state.time && state.time.paused) { this._liveAcc = 0; return { steps: 0, dt: 1 / 60, stamp: false }; }
    if (state.mode === 'ornito' && this._active) return { steps: 0, dt: 1 / 60, stamp: false };
    this._liveAcc = Math.min(this._liveAcc + real, 3 / 60);
    let steps = Math.floor(this._liveAcc * 60 + 0.25);   // small lead so 60 Hz vsync jitter never yields 0
    steps = Math.max(0, Math.min(2, steps));
    this._liveAcc = Math.max(-0.5 / 60, this._liveAcc - steps / 60);
    return { steps, dt: 1 / 60, stamp: false };
  }

  _draw(mat, target) {
    const r = this.renderer;
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    this.quad.material = mat;
    r.autoClear = false;
    r.setRenderTarget(target);
    r.render(this.scene, this.cam);
    r.autoClear = prevAuto;
    r.setRenderTarget(prevRT);
  }

  // Shutter opens. plateTex = a graded, sky-only frame (birds hidden), in the same encoding as the stamps.
  begin(plateTex) {
    const o = this.state.ornito;
    this._blend = o.blend === 'lighten' ? 'lighten' : (o.blend === 'layer' ? 'layer' : 'darken');
    this.mCopy.uniforms.tSrc.value = plateTex;
    this._draw(this.mCopy, this.plateRT);
    this._draw(this.mCopy, this.accRT);
    this._lastPlate = plateTex;
    this._done = 0;
    this._stampCount = 0;
    this._running = true;
    this._active = true;
    o.running = true;
    o.done = 0;
    this.state.emit('ornito:frame', { done: 0, frames: o.frames });
  }

  stamp(frameTex) {
    if (!this._running) return;
    const o = this.state.ornito;
    this.prof.begin('trails');
    const decay = Math.max(0, Math.min(0.05, +o.decay || 0));
    if (decay > 0) {
      this.mDecay.uniforms.tSrc.value = this.plateRT.texture;
      this.mDecay.uniforms.uDecay.value = decay;
      this._draw(this.mDecay, this.accRT);
    }
    const m = this._blend === 'lighten' ? this.mMax : (this._blend === 'layer' ? this.mLayer : this.mMin);
    m.uniforms.tSrc.value = frameTex;
    if (m === this.mLayer) { m.uniforms.tPlate.value = this.plateRT.texture; m.uniforms.uK.value = Math.max(0.015, Math.min(0.3, (o.layerK || (o.track === 'all' ? 8 : 24)) / Math.max(1, o.frames || 150))); }
    this._draw(m, this.accRT);
    this.prof.end();
    this._done++;
    this._stampCount++;
    o.done = this._done;
    this.state.emit('ornito:frame', { done: this._done, frames: o.frames });
    if (this._done >= o.frames) this.end();
  }

  end() {
    if (!this._running) return;
    this._running = false;
    this.state.ornito.running = false;
    this.state.emit('ornito:frame', { done: this._done, frames: this.state.ornito.frames, finished: true });
  }

  clear() {
    this._running = false;
    this._active = false;
    this._done = 0;
    this.state.ornito.running = false;
    this.state.ornito.done = 0;
    this.state.emit('ornito:frame', { done: 0, frames: this.state.ornito.frames, cleared: true });
  }

  get active() { return this._active; }
  get running() { return this._running; }
  get done() { return this._done; }
  get output() { return this._active ? this.accRT.texture : null; }
  get plate() { return this.plateRT.texture; }

  // Optional (state.ornito.showUntracked): the exposure with a faint ghost of the live flock under it.
  // liveTex = the current graded frame with all birds. Returns a texture to present instead of `output`.
  composite(liveTex) {
    if (!this._active) return liveTex;
    if (!this.composeRT) this.composeRT = new THREE.WebGLRenderTarget(this.w, this.h, this._rtOpt);
    const u = this.mCompose.uniforms;
    u.tAcc.value = this.accRT.texture; u.tPlate.value = this.plateRT.texture; u.tLive.value = liveTex;
    u.uLighten.value = this._blend === 'lighten' ? 1 : 0;
    this._draw(this.mCompose, this.composeRT);
    return this.composeRT.texture;
  }

  // RGBA8 readback of any texture at render size (rows bottom-up, as GL returns them).
  readPixels(tex, through) {
    if (!this._rt8) this._rt8 = new THREE.WebGLRenderTarget(this.w, this.h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    if (through && through.presentTo) through.presentTo(tex, this._rt8);
    else { this.mCopy.uniforms.tSrc.value = tex; this._draw(this.mCopy, this._rt8); }
    const buf = new Uint8Array(this.w * this.h * 4);
    this.renderer.readRenderTargetPixels(this._rt8, 0, 0, this.w, this.h, buf);
    return buf;
  }

  filename() {
    const s = this.state, o = s.ornito;
    const site = (s.site && s.site.id) || 'site';
    return `ornitography_${site}_${localStamp(s.time.nowMs, s.site && s.site.tz).file}_${o.done || this._done}f_${o.vfps}fps.png`;
  }

  // PNG of the exposure through grade.presentTo (same dither / grain / vignette as on screen), at render size.
  // opts.download = false returns the result without triggering a download (tests).
  async exportPNG(grade, opts = {}) {
    if (!this._active) return null;
    this.prof.begin('trails.export');
    const w = this.w, h = this.h;
    const px = this.readPixels(this.accRT.texture, grade);
    this.prof.end();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    const s = this.state, o = s.ornito;
    if (o.caption) {
      const t = localStamp(s.time.nowMs, s.site && s.site.tz).human;
      const txt = `${(s.site && s.site.name) || ''}  ·  ${t}  ·  ${o.done || this._done} frames at ${o.vfps} fps  ·  ${(((o.done || this._done) * ((o.skip | 0) + 1)) / o.vfps).toFixed(2)} s`;
      const fs = Math.max(11, Math.round(h / 72));
      ctx.font = `${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = this._blend === 'lighten' ? 'rgba(235,236,238,0.78)' : 'rgba(29,30,32,0.70)';
      ctx.fillText(txt, Math.round(fs * 1.6), h - Math.round(fs * 1.4));
    }
    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    const name = this.filename();
    if (opts.download !== false && blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    return { filename: name, width: w, height: h, blob, canvas: cv };
  }

  dispose() {
    this._unsub.forEach(f => f());
    for (const rt of [this.accRT, this.plateRT, this.composeRT, this._rt8]) rt && rt.dispose();
    for (const m of [this.mCopy, this.mDecay, this.mMin, this.mMax, this.mLayer, this.mCompose]) m.dispose();
    this.quad.geometry.dispose();
  }
}
