// F8 falcon cycle: returns the state log, peak stoop speed, clearance at the strike, excited counts
(async () => {
  T.state.falcon.autoAttack = false;
  await T.tick(900);
  const F = T.flock;
  const out = { states: [], strike: null, peak: 0, excitedMax: 0, waves: 0 };
  F.attack();
  let lastState = '', prevEx = 0, rising = false;
  for (let s = 0; s < 60 * 80; s++) {
    await T.tick(1);
    const st = T.state.falcon.state;
    if (st !== lastState) {
      out.states.push(st + '@' + F.t.toFixed(2));
      if (st === 'strike') {
        const { pos, N } = await F.debug.readAll();
        const fp = T.state.falcon.pos; let md = 1e9, n4 = 0;
        for (let i = 0; i < N; i++) { const d = Math.hypot(pos[i * 4] - fp.x, pos[i * 4 + 1] - fp.y, pos[i * 4 + 2] - fp.z); md = Math.min(md, d); if (d < 4) n4++; }
        out.strike = { minBirdDist: +md.toFixed(2), birdsWithin4m: n4, targetDist: +(F.falc.strikeDist || 0).toFixed(2), speed: +T.state.falcon.speed.toFixed(1) };
        if (window.__shot) { T.setView('falcon'); await T.capture('falcon_strike.png'); }
      }
      if (st === 'stoop' && window.__shot) { for (let k = 0; k < 40; k++) await T.tick(1); T.setView('falcon'); await T.capture('falcon_stoop.png'); T.setView('default'); }
      lastState = st;
    }
    out.peak = Math.max(out.peak, T.state.falcon.speed);
    if (s % 6 === 0) {
      const ex = T.state.flock.stats.excited;
      out.excitedMax = Math.max(out.excitedMax, ex);
      if (ex > 0.01 && !rising) { out.waves++; rising = true; }
      if (ex < 0.002) rising = false;
    }
    if (st === 'patrol' && out.states.length > 3) break;
  }
  out.peak = +out.peak.toFixed(1);
  out.log = F.debug.falcon().log.map((l) => l.s + '@' + l.t);
  return JSON.stringify(out);
})()
