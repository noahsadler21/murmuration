// Flock acceptance tests F1–F12 (SPEC §9) in headless Chrome over CDP. Starts tests/flock/serve.js on a free port,
// runs tests/flock/flock_test.html, writes tests/flock/results.json and captures/flock_*.png, then stops everything.
//   node tests/flock/run.js [--only F1,F5,...]
// Perf (F11) is in perf.js (perf.json is merged into results.json when present).
const { open } = require('./cdp.js');
const fs = require('fs'); const path = require('path');
const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1].split(',') : null; })();
const want = (k) => !only || only.includes(k);
const PAGE = 'tests/flock/flock_test.html';
const resPath = path.join(__dirname, 'results.json');

(async () => {
  const s = await open();
  const R = (() => { try { return JSON.parse(fs.readFileSync(resPath, 'utf8')); } catch (e) { return {}; } })();
  R.date = new Date().toISOString();
  const errorsAll = [];
  const nav = async (q) => { await s.nav(`${PAGE}?${q}`); };
  const done = (k, v) => { R[k] = v; console.log(k, JSON.stringify(v)); errorsAll.push(...s.errors().map((e) => k + ': ' + e)); fs.writeFileSync(resPath, JSON.stringify(R, null, 1)); };
  try {
    R.gpu = await (async () => { await nav('q=medium&paused=1'); return s.evalp(`(()=>{const g=T.renderer.getContext();const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):'?'})()`); })();

    if (want('F1')) {   // kNN accuracy vs brute force
      await nav('q=medium&paused=1&nofalcon=1');
      const a3 = await s.evalp('(async()=>{await T.tick(180);return T.flock.debug.knnAccuracy(512)})()');
      const a10 = await s.evalp('(async()=>{await T.tick(420);return T.flock.debug.knnAccuracy(512)})()');
      done('F1', { at3s: +a3.toFixed(4), at10s: +a10.toFixed(4), pass: a3 >= 0.9 && a10 >= 0.98 });
    }
    if (want('F2') || want('F3')) {   // polarisation (calm, agitated) and speed, sampled over 30–90 s
      const pol = {}, sp = {};
      for (const p of ['calm', 'agitated', 'swirling']) {
        await nav(`q=medium&paused=1&nofalcon=1&preset=${p}`);
        pol[p] = await s.evalp(`(async()=>{await T.tick(1800);const o=[];for(let k=0;k<7;k++){await T.tick(600);o.push(+(await T.flock.debug.polarization()).toFixed(3));}return o})()`);
        sp[p] = await s.evalp('T.flock.debug.speeds()');
      }
      const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
      done('F2', { samples30to90s: pol, median: { calm: med(pol.calm), agitated: med(pol.agitated), swirling: med(pol.swirling) },
        pass: med(pol.calm) >= 0.9 && med(pol.calm) <= 0.99 && med(pol.agitated) >= 0.7 && med(pol.agitated) <= 0.95 });
      done('F3', { airSpeed: sp, pass: Object.values(sp).every((v) => v.median >= 11 && v.median <= 14 && v.p01 >= 9 && v.p99 <= 20) });
    }
    if (want('F4')) {   // scale-free correlation length at 10k (low) and 30k (medium)
      const r = {};
      for (const q of ['low', 'medium']) {
        await nav(`q=${q}&paused=1&nofalcon=1`);
        const o = [];
        for (let k = 0; k < 3; k++) { await s.evalp('T.tick(900)'); o.push(await s.evalp('T.flock.debug.corrLength(2048)')); }
        r[q] = o.map((c) => ({ xi: c.xi, L: c.L, ratio: c.ratio }));
      }
      const all = [...r.low, ...r.medium].map((c) => c.ratio);
      done('F4', { ...r, pass: all.every((x) => x >= 0.25 && x <= 0.45) });
    }
    if (want('F5')) {   // agitation wave from an edge bird (spec default waveDelay, then the recommended 0.04)
      const r = {};
      for (const d of [0.07, 0.04]) {
        await nav(`q=medium&paused=1&nofalcon=1&clean=1&view=near&p=waveDelay:${d}`);
        r['waveDelay_' + d] = await s.evalp(`(async()=>{await T.tick(900);let shot=0;const w=await T.flock.debug.waveSpeed(async (dt)=>{T.flock.update(dt,T.camera);T.flock.updateLOD(T.camera);});
          return {speed:w.speed,thickness:w.thickness,excitedAtEnd:w.excitedAtEnd,curve:w.samples.filter((x,i)=>i%5==4).map(x=>[x.t,x.excited,x.frontMax])}})()`);
      }
      // a visual: the dark band in the near view, mid-wave
      await nav('q=medium&paused=1&nofalcon=1&clean=1&view=near&p=waveDelay:0.04');
      await s.evalp(`(async()=>{await T.tick(1500);T.snap();await T.capture('flock_wave_before.png');const c=T.state.flock.centroid;const o=c.clone().add(new T.THREE.Vector3(-80,0,0));T.flock.excite(o,new T.THREE.Vector3(1,0,0));await T.tick(42);await T.capture('flock_wave_0p7s.png');await T.tick(42);await T.capture('flock_wave_1p4s.png');})()`);
      const a = r.waveDelay_0_07 || r['waveDelay_0.07'], b = r['waveDelay_0.04'];
      done('F5', { ...r, passDefault: a.speed >= 18 && a.speed <= 35 && a.thickness <= 12 && a.excitedAtEnd === 0,
        passRecommended: b.speed >= 18 && b.speed <= 35 && b.thickness <= 12 && b.excitedAtEnd === 0 });
    }
    if (want('F6')) {   // bounds over 5 min with 10 m/s wind
      await nav('q=medium&paused=1&nofalcon=1&wind=10');
      const r = await s.evalp(`(async()=>{const P=T.state.flock.params;const o=[];let worst={alt:1,hor:1};
        for(let k=0;k<30;k++){await T.tick(600,1/60,4);const {pos,N}=await T.flock.debug.readAll();let inA=0,inH=0,maxH=0;
          for(let i=0;i<N;i++){const y=pos[i*4+1],h=Math.hypot(pos[i*4],pos[i*4+2]);if(y>=P.altMin-10&&y<=P.altMax+20)inA++;if(h<=P.roostRadius+150)inH++;maxH=Math.max(maxH,h);}
          worst.alt=Math.min(worst.alt,inA/N);worst.hor=Math.min(worst.hor,inH/N);if(k%5==4)o.push({t:(k+1)*10,alt:+(inA/N).toFixed(4),hor:+(inH/N).toFixed(4),maxH:+maxH.toFixed(0)});}
        return {worstAltFrac:+worst.alt.toFixed(4),worstHorFrac:+worst.hor.toFixed(4),samples:o}})()`);
      done('F6', { ...r, pass: r.worstAltFrac >= 0.99 && r.worstHorFrac >= 0.99 });
    }
    if (want('F7')) {   // flight states at cruise
      await nav('q=medium&paused=1&nofalcon=1&preset=calm');
      const r = await s.evalp(`(async()=>{await T.tick(1200);const a=[];for(let k=0;k<20;k++){await T.tick(30);a.push(await T.flock.debug.stateFractions());}
        const m=(k)=>+(a.reduce((x,y)=>x+y[k],0)/a.length).toFixed(3);return {flap:m('flap'),glide:m('glide'),bound:m('bound')}})()`);
      done('F7', { ...r, pass: r.flap >= 0.65 && r.flap <= 0.75 && r.glide >= 0.15 && r.glide <= 0.25 && r.bound >= 0.05 && r.bound <= 0.15 });
    }
    if (want('F8')) {   // falcon cycle
      await nav('q=medium&paused=1&clean=1');
      await s.evalp('window.__shot=1');
      const r = JSON.parse(await s.evalp(fs.readFileSync(path.join(__dirname, 'falcon_eval.js'), 'utf8')));
      const seq = ['select', 'stoop', 'strike', 'pullout', 'climb', 'patrol'];
      const got = r.states.map((x) => x.split('@')[0]);
      done('F8', { ...r, falconAsset: await s.evalp('Object.keys(T.flock.falconGLB).join(",")||"stand-in"'),
        pass: seq.every((x, i) => got[i] === x) && r.peak >= 40 && r.peak <= 50 && r.strike && r.strike.minBirdDist >= 4 && r.waves === 1 });
    }
    if (want('F9')) {   // LOD: none lost, caps, lodviz captures, dolly strip
      await nav('q=medium&paused=1&nofalcon=1&clean=1&lodviz=1');
      const r = await s.evalp(`(async()=>{await T.tick(1500);const out={};const Q=T.state.preset;
        for(const v of ['default','orbit-close','near','inside']){T.setView(v);T.snap();T.flock.lodReady=false;T.render();T.render();const i=T.flock.debug.info();
          out[v]={lod:i.lodCounts,inFrustum:i.inFrustum,drawn:i.lodCounts.reduce((a,b)=>a+b,0),capsOK:i.lodCounts.every((c,l)=>c<=Q.lodCap[l])};
          await T.capture('flock_lodviz_'+v+'.png');}
        return out})()`);
      // 3 s dolly from 25 m to 250 m behind the flock: 12 frames (async readbacks, live LOD hysteresis)
      await nav('q=medium&paused=1&nofalcon=1&clean=1');
      await s.evalp(`(async()=>{await T.tick(1500);T.setView('fixed');const c=T.state.flock.centroid.clone();const e=T.state.flock.extent;const d=new T.THREE.Vector3(-0.8,-0.25,0.55).normalize();
        for(let f=0;f<180;f++){const k=f/179;const dist=Math.max(e.x,e.z)*0.5+25+k*225;T.camera.position.copy(c).addScaledVector(d,dist);T.camera.lookAt(c);T.camera.updateMatrixWorld();
          T.flock.update(1/60,T.camera);await T.frame();if(f%15==14)await T.capture('dolly_'+((f+1)/15)+'.png');}})()`);
      const ok = Object.values(r).every((v) => v.drawn === v.inFrustum && v.capsOK);
      done('F9', { ...r, pass: ok });
    }
    if (want('F10')) {  // close-up, LOD0 at ~400 px
      await nav('q=medium&paused=1&nofalcon=1&clean=1');
      const r = await s.evalp(`(async()=>{await T.tick(600);const {pos}=await T.flock.debug.readAll();const c=T.state.flock.centroid;let best=0,bd=0;
        for(let i=0;i<T.flock.N;i+=7){const d=(pos[i*4]-c.x)**2+(pos[i*4+1]-c.y)**2+(pos[i*4+2]-c.z)**2;if(d>bd){bd=d;best=i}}
        await T.closeup(best,1.4,30,-55,'flock_closeup.png');const a=T.flock.debug.info().lodCounts;
        await T.closeup(best,1.4,120,25,'flock_closeup_above.png');await T.closeup(best,6,60,-20,'flock_closeup_6m.png');return {bird:best,lodAt1p4m:a}})()`);
      done('F10', { ...r, pass: r.lodAt1p4m[0] > 0 });
    }
    if (want('F12')) {  // look: bird pixel values in the default and near views (stand-in signature grade)
      const r = {};
      for (const v of ['default', 'near']) {
        await nav(`q=medium&paused=1&nofalcon=1&clean=1&view=${v}`);
        r[v] = await s.evalp(`(async()=>{await T.tick(1500);T.snap();await T.capture('flock_look_${v}.png');const px=T.pixels();
          const lum=[];for(let i=0;i<px.length;i+=4)lum.push((px[i]+px[i+1]+px[i+2])/3);const sky=lum.slice().sort((a,b)=>a-b)[Math.floor(lum.length*0.6)];
          const b=lum.filter(l=>l<sky-25).sort((a,b)=>a-b);const q=(p)=>b.length?+b[Math.floor(p*(b.length-1))].toFixed(1):null;
          return {sky:+sky.toFixed(1),birdPx:b.length,min:q(0),p5:q(0.05),p50:q(0.5),p95:q(0.95)}})()`);
      }
      done('F12', { ...r, note: 'stand-in grade (tests/flock); final values depend on Sky\'s Grade and light bag',
        pass: r.near.p5 >= 20 && r.near.p5 <= 60 && r.near.p95 <= 115 });
    }
    // perf from perf.js
    try { R.F11 = JSON.parse(fs.readFileSync(path.join(__dirname, 'perf.json'), 'utf8')); } catch (e) { }
    R.consoleErrors = errorsAll;
    fs.writeFileSync(resPath, JSON.stringify(R, null, 1));
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
