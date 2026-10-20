// audio.js: a few synthesized sounds (no files): wind that follows speed, the rush of nearby wings, a bright pluck
// for a caught fish, a soft thump for a collision, splashes. Muted state is remembered.
export class Sound {
  constructor() {
    this.ctx = null; this.muted = false;
    try { this.muted = localStorage.getItem('onebird.muted') === '1'; } catch (_) { /* storage blocked */ }
  }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.8; this.master.connect(c.destination);
    // one shared noise buffer
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.985 * b + 0.015 * w; d[i] = w * 0.35 + b * 3.2; }
    this.noise = buf;
    const loop = (freq, q, type = 'bandpass') => {
      const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(this.master); s.start();
      return { f, g };
    };
    this.wind = loop(500, 0.6, 'lowpass');
    this.wings = loop(1400, 0.9);
    this.sea = loop(220, 0.4, 'lowpass');
  }
  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem('onebird.muted', m ? '1' : '0'); } catch (_) { /* ignore */ }
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }
  // per frame: speed m/s, nearby bird count, altitude
  update(speed, near, alt, playing) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = playing ? 1 : 0.5;
    this.wind.g.gain.setTargetAtTime(on * Math.min(0.5, 0.06 + (speed / 26) ** 2 * 0.5), t, 0.15);
    this.wind.f.frequency.setTargetAtTime(300 + speed * 45, t, 0.2);
    this.wings.g.gain.setTargetAtTime(on * Math.min(0.22, near * 0.012), t, 0.1);
    this.sea.g.gain.setTargetAtTime(0.12 * Math.max(0, 1 - alt / 40), t, 0.3);
  }
  _env(node, t, a, peak, dec) {
    node.gain.setValueAtTime(0.0001, t); node.gain.exponentialRampToValueAtTime(peak, t + a); node.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }
  fish(combo = 1) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const base = 660 * Math.pow(1.122, Math.min(combo - 1, 6));
    [0, 0.07].forEach((dt, k) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(base * (k ? 1.5 : 1), t + dt);
      o.frequency.exponentialRampToValueAtTime(base * (k ? 1.52 : 1.01), t + dt + 0.3);
      this._env(g, t + dt, 0.005, 0.22, 0.35);
      o.connect(g); g.connect(this.master); o.start(t + dt); o.stop(t + dt + 0.5);
    });
  }
  hit() {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    this._env(g, t, 0.004, 0.5, 0.22);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.3);
    const s = c.createBufferSource(); s.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 0.8;
    const g2 = c.createGain(); this._env(g2, t, 0.003, 0.35, 0.35);
    s.connect(f); f.connect(g2); g2.connect(this.master); s.start(t, Math.random()); s.stop(t + 0.45);
  }
  splash(v = 0.5) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 900;
    const g = c.createGain(); this._env(g, t, 0.01, 0.25 * v, 0.5);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t, Math.random()); s.stop(t + 0.6);
  }
  chime(up = true) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(up ? 440 : 330, t); o.frequency.exponentialRampToValueAtTime(up ? 880 : 220, t + 0.4);
    this._env(g, t, 0.02, 0.12, 0.5);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.6);
  }
}
