// close-up sheet of the player's bird:  node game/tests/hero.js prefix
// four consecutive 60 fps frames from the chase camera, then a close 3/4 view, with and without the wing shutter
const { open, sleep } = require('./cdp.js');
(async () => {
  const pre = process.argv[2] || 'hero';
  const s = await open({ width: 960, height: 640, dsf: 1.25 });
  try {
    await s.nav('game/index.html?test=1');
    await s.evalp(`game.start({seed: 7, skipIntro: true}); game.bot('lane'); game.advance(6); game.G.manual = true; 1`);
    // wait until the bird is flapping
    await s.evalp(`(() => { for (let k = 0; k < 600 && game.G.player.wing.mode !== 0; k++) game.advance(1/60); game.G.manual = true; return 1; })()`);
    for (let k = 0; k < 4; k++) {
      await s.evalp(`game.advance(1/60); game.G.manual = true; game.render(); 1`);
      await s.shot(`${pre}_chase${k}.png`);
    }
    const close = (blur) => `(() => { const P = game.G.player, c = game.camera;
      for (const b of game.hero.blur) b.visible = ${blur};
      c.position.set(P.x - P.fz * 0.55 - P.fx * 0.5, P.y + 0.18, P.z + P.fx * 0.55 - P.fz * 0.5); c.up.set(0,1,0); c.lookAt(P.x, P.y, P.z);
      c.fov = 40; c.updateProjectionMatrix(); game.renderer.render(game.scene, c); return JSON.stringify(P.wing); })()`;
    console.log(await s.evalp(close(false))); await s.shot(`${pre}_close_noblur.png`);
    console.log(await s.evalp(close(true))); await s.shot(`${pre}_close_blur.png`);
    const er = s.errors(); console.log('console:', er.length ? er.join('\n  ') : 'clean');
  } finally { await s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
