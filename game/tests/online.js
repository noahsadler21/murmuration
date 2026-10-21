// Two-browser online Sky Brawl test over PeerJS:  node game/tests/online.js
// Browser A creates a lobby, browser B joins with the code, A starts; both fly with the brawl bot for 20 s.
// Checks: the lobby lists both players, B receives the match, each sees the other's bird move, feathers sync.
const { open, sleep } = require('./cdp.js');
const checks = [];
const check = (n, ok, info) => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${JSON.stringify(info)}`); };
(async () => {
  const A = await open({ width: 960, height: 600, dsf: 1 }), B = await open({ width: 960, height: 600, dsf: 1 });
  try {
    await A.nav('game/index.html?test=1'); await B.nav('game/index.html?test=1');
    for (const s of [A, B]) await s.evalp(`document.querySelector('[data-game="brawl"]').click(); 1`);
    await A.evalp(`document.getElementById('netName').value = 'Hosty'; document.getElementById('netCreate').click(); 1`);
    let code = '';
    for (let i = 0; i < 60 && !/^[A-Z]{5}$/.test(code); i++) { await sleep(500); code = await A.evalp(`game.net.lobby.code || ''`); }
    check('host opened a lobby', /^[A-Z]{5}$/.test(code), { code, msg: await A.evalp(`document.getElementById('netMsg').textContent`) });
    await B.evalp(`document.getElementById('netName').value = 'Guesty'; document.getElementById('netCode').value = '${code}'; document.getElementById('netJoin').click(); 1`);
    let n = 0;
    for (let i = 0; i < 40 && n < 2; i++) { await sleep(500); n = await A.evalp(`game.net.lobby.players.length`); }
    check('guest joined: host lists 2 players', n === 2, { players: await A.evalp(`JSON.stringify(game.net.lobby.players)`), guestMsg: await B.evalp(`document.getElementById('netMsg').textContent`) });
    await A.evalp(`document.getElementById('netStart').click(); 1`);
    await sleep(2500);
    check('guest received the match', await B.evalp(`game.G.mode === 'play' && game.G.online === 'client'`), { mode: await B.evalp('game.G.mode') });
    for (const s of [A, B]) await s.evalp(`game.bot('brawl'); 1`);
    await sleep(4000);
    const seeA = JSON.parse(await A.evalp(`(() => { const b = game.brawl.birds.find((x) => x.name === 'Guesty'); return JSON.stringify(b ? { x: b.x, z: b.z, st: b.state, remote: b.remote } : null); })()`));
    const seeB = JSON.parse(await B.evalp(`(() => { const b = game.brawl.birds.find((x) => x.id === 'host'); return JSON.stringify(b ? { x: b.x, z: b.z, st: b.state, n: game.brawl.birds.length } : null); })()`));
    const realB = JSON.parse(await B.evalp(`JSON.stringify({ x: game.G.player.x, z: game.G.player.z })`));
    const realA = JSON.parse(await A.evalp(`JSON.stringify({ x: game.G.player.x, z: game.G.player.z })`));
    check('host sees the guest bird where the guest is', seeA && seeA.remote && Math.hypot(seeA.x - realB.x, seeA.z - realB.z) < 6, { seeA, realB });
    check('guest sees the host bird where the host is', seeB && Math.hypot(seeB.x - realA.x, seeB.z - realA.z) < 8, { seeB, realA });
    await sleep(14000);
    const hpA = JSON.parse(await A.evalp(`(() => { const b = game.brawl.birds.find((x) => x.name === 'Guesty'); return JSON.stringify({ hostView: b && b.hp, alive: game.brawl.alive() }); })()`));
    const hpB = JSON.parse(await B.evalp(`JSON.stringify({ own: game.brawl.player.hp, alive: game.brawl.alive(), mode: game.G.mode })`));
    check('guest feathers follow the host', hpB.mode === 'end' || hpA.hostView === hpB.own || (hpA.hostView === undefined), { hpA, hpB });
    check('both see the same number of birds left', Math.abs(hpA.alive - hpB.alive) <= 1 || hpB.mode === 'end', { hpA, hpB });
    await A.shot('online_host.png'); await B.shot('online_guest.png');
    const er = [...A.errors(), ...B.errors()];
    check('consoles are clean', er.length === 0, er.slice(0, 4));
  } finally { await A.close(); await B.close(); }
  console.log(checks.every(Boolean) ? `\nall ${checks.length} online checks passed` : '\nSOME ONLINE CHECKS FAILED');
})().catch((e) => { console.error(e); process.exit(1); });
