// I3 / S6 on the integrated page: node tests/integration/s6.js
// Deterministic URL, default (watcher) view, 1296×716 CSS at DPR 1, UI hidden. Captures the frame with the flock and
// with the flock hidden, measures the S6 sky statistics on the flock-hidden frame, and writes captures/i3_*.png.
// tests/integration/s6_sheet.py then composes captures/signature_vs_reference.png.
const { open, sleep } = require('./cdp.js');
const fs = require('fs'); const path = require('path');
const DET = 'bench=1&seed=1&wx=sample:overcast&site=brighton&t=2025-11-20T16:05:00Z';
(async () => {
  const s = await open({ width: 1296, height: 716, dsf: 1 });
  const out = {};
  try {
    await s.nav(`index.html?${DET}&warm=2400&ui=0`);
    await sleep(2500);
    await s.evalp(`murm.hold(true)`);
    await s.evalp(`murm.capture('i3_page_flock.png')`);
    out.framing = await s.evalp('murm.framing()');
    out.view = await s.evalp(`({camPos: murm.camera.position.toArray().map(v=>+v.toFixed(1)), pitchDeg: +(Math.asin(murm.camera.getWorldDirection(new murm.THREE.Vector3()).y)*180/Math.PI).toFixed(1), fov: murm.camera.fov})`);
    // flock hidden: render the same camera without birds
    out.s6 = await s.evalp(`(async()=>{ murm.flockObj.object3d.visible=false; await murm.render(4); await murm.capture('i3_page_noflock.png');
      const gl=murm.renderer.getContext(), w=gl.drawingBufferWidth, h=gl.drawingBufferHeight;
      // re-present so the drawing buffer holds the frame, then read it
      await murm.render(1); murm.renderer.setRenderTarget(null); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
      const b=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,b);
      const px=(x,y)=>((h-1-y)*w+x)*4;   // top-down
      const band=(y0,y1)=>{let r=0,g=0,bb=0,n=0;for(let y=y0;y<y1;y++)for(let x=0;x<w;x++){const i=px(x,y);r+=b[i];g+=b[i+1];bb+=b[i+2];n++}return [r/n,g/n,bb/n].map(v=>+v.toFixed(1))};
      const hb=Math.round(h*0.03);
      let s=0,s2=0,n=0,bmr=[1e9,-1e9],spread=0; const col=new Float64Array(w);
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=px(x,y),r=b[i],g=b[i+1],B=b[i+2],l=0.2126*r+0.7152*g+0.0722*B;s+=l;s2+=l*l;n++;col[x]+=l/h;
        bmr[0]=Math.min(bmr[0],B-r);bmr[1]=Math.max(bmr[1],B-r);spread=Math.max(spread,Math.max(r,g,B)-Math.min(r,g,B));}
      let step=0; for(let x=1;x<w;x++) step=Math.max(step,Math.abs(col[x]-col[x-1]));
      const top=band(0,hb), bottom=band(h-hb,h), m=s/n;
      murm.flockObj.object3d.visible=true;
      return {w,h,top,bottom,topMinusBottom:+(((top[0]+top[1]+top[2])-(bottom[0]+bottom[1]+bottom[2]))/3).toFixed(2),mean:+m.toFixed(1),std:+Math.sqrt(s2/n-m*m).toFixed(2),bMinusR:bmr,maxChannelSpread:spread,colStep:+step.toFixed(2)};})()`);
    const t = out.s6, near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    out.pass = { top: near(t.top, [196, 197, 198], 4), bottom: near(t.bottom, [191, 192, 193], 4), gradient: t.topMinusBottom >= 3 && t.topMinusBottom <= 10,
      bMinusR: t.bMinusR[0] >= 0 && t.bMinusR[1] <= 4, spread: t.maxChannelSpread <= 5, std: t.std >= 0.8 && t.std <= 5, banding: t.colStep <= 1 };
    out.errors = s.errors();
  } finally { await s.close(); }
  fs.writeFileSync(path.join(__dirname, 's6.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
