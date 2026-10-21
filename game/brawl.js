// brawl.js: Sky Brawl, a battle royale between twelve starlings (you and eleven rivals) over the sea.
//
// Ram another bird hard enough and it loses a feather (one of three); at none it tumbles into the sea. The bird
// doing the ramming is the one flying into the other faster, so a glancing touch or being hit from behind hurts you.
// A ring closes in over the run; outside it a bird loses a feather every few seconds. Last bird flying wins.
// Rivals are simple hunters: they pick a nearby bird (you a little more often), lead it, boost in close, break off
// when hurt and chased, and head back inside the ring when it catches them.
import * as THREE from 'three';
import { quatFromFwdRoll } from './birds.js';
import { newWing, stepWing } from './wings.js';

const G = 9.81;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

export const BRAWL = { rivals: 11, hp: 3, hitR: 0.5, minClose: 2.2, invuln: 0.9, outsideEvery: 3.5, r0: 210, r1: 22, tShrink0: 8, tShrink1: 140 };
const NAMES = ['Ash', 'Wren', 'Pip', 'Sable', 'Moss', 'Flint', 'Rook', 'Ember', 'Slate', 'Quill', 'Juno', 'Sorrel', 'Dusk', 'Bramble'];

// the closing ring: a soft orange curtain standing on the sea
function ringMesh() {
  const g = new THREE.CylinderGeometry(1, 1, 1, 160, 1, true);
  g.translate(0, 0.5, 0);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uCol: { value: new THREE.Color().setRGB(0.94, 0.46, 0.2) }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uCol; uniform float uTime; varying vec2 vUv;
      void main(){ float h = vUv.y; float a = 0.28 * pow(1.0 - h, 2.2) + 0.05 * smoothstep(0.985, 1.0, fract(vUv.x * 120.0 - uTime * 0.05));
        a *= 0.6 + 0.4 * sin(vUv.x * 6.2831 * 40.0 + uTime * 1.5) * 0.5 + 0.2;
        gl_FragColor = vec4(linearToOutputTexel(vec4(uCol, 1.0)).rgb, a); }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.renderOrder = 7;
  return mesh;
}

export class Brawl {
  constructor(scene, lod) {
    this.lod = lod;                 // a VatLOD (real starling) with room for every rival
    this.ring = ringMesh();
    this.ring.visible = false;
    scene.add(this.ring);
    this.birds = [];
    this.on = false;
    this._q = [0, 0, 0, 1];
  }

  start(seed, player, diff, R) {
    this.on = true;
    this.R = R;
    this.cx = player.x; this.cz = player.z;
    this.t = 0;
    this.skill = diff === 'calm' ? 0.65 : diff === 'storm' ? 1.05 : 0.85;
    const names = [...NAMES].sort(() => R() - 0.5);
    this.birds = [];
    for (let i = 0; i < BRAWL.rivals; i++) {
      const a = (i / BRAWL.rivals) * Math.PI * 2 + R() * 0.4, d = 35 + R() * 60;
      const x = this.cx + Math.cos(a) * d, z = this.cz + Math.sin(a) * d;
      this.birds.push({
        name: names[i % names.length], x, y: 10 + R() * 14, z, yaw: a + Math.PI + (R() - 0.5), pitch: 0, speed: 13, yawRate: 0,
        vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: 1, roll: 0, energy: 1, boosting: 0,
        hp: BRAWL.hp, invuln: 0, out: 0, state: 'fly', target: null, retarget: 0, flee: 0,
        skill: this.skill * (0.8 + 0.4 * R()), wing: newWing(R), fall: null, kos: 0, place: 0,
      });
    }
    this.player = { hp: BRAWL.hp, invuln: 0, out: 0, kos: 0, hits: 0, dead: false };
    this.placeNext = BRAWL.rivals + 1;
    this.ring.visible = true;
    this.winner = null;
  }
  stop() { this.on = false; this.ring.visible = false; this.lod.begin(); this.lod.end(); }

  radius(t) { return BRAWL.r0 + (BRAWL.r1 - BRAWL.r0) * smooth(BRAWL.tShrink0, BRAWL.tShrink1, t); }
  alive() { return this.birds.filter((b) => b.state === 'fly').length + (this.player.dead ? 0 : 1); }

  // one bird's flight toward an aim point (same feel as the player's bird)
  _fly(b, dt, ax, ay, az, boost) {
    const dx = ax - b.x, dy = ay - b.y, dz = az - b.z;
    const yawT = Math.atan2(dx, dz), pitchT = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.7, 0.6);
    const maxYR = 1.5 * b.skill + 0.3;
    const yrCmd = clamp(wrapPi(yawT - b.yaw) * 2.2, -maxYR, maxYR);
    b.yawRate += (yrCmd - b.yawRate) * (1 - Math.exp(-dt / 0.18));
    b.yaw += b.yawRate * dt;
    b.pitch += (pitchT - b.pitch) * (1 - Math.exp(-dt / 0.3));
    const on = boost && b.energy > 0.05;
    b.boosting += ((on ? 1 : 0) - b.boosting) * (1 - Math.exp(-dt / 0.15));
    b.energy = on ? Math.max(0, b.energy - dt * 0.4) : Math.min(1, b.energy + dt * 0.14);
    const vT = 13 + b.boosting * 6.5 * (0.8 + 0.3 * b.skill);
    b.speed += -G * Math.sin(b.pitch) * 0.45 * dt + (vT - b.speed) * (1 - Math.exp(-dt / 0.8));
    b.speed = clamp(b.speed, 6, 25);
    const cp = Math.cos(b.pitch);
    b.fx = Math.sin(b.yaw) * cp; b.fy = Math.sin(b.pitch); b.fz = Math.cos(b.yaw) * cp;
    b.vx = b.fx * b.speed; b.vy = b.fy * b.speed; b.vz = b.fz * b.speed;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    if (b.y < 1.4) { b.y = 1.4; b.pitch = Math.max(b.pitch, 0.2); }
    if (b.y > 45) { b.y = 45; b.pitch = Math.min(b.pitch, 0); }
    const rollT = clamp(-Math.atan(b.speed * b.yawRate / G), -1.2, 1.2);
    b.roll += (rollT - b.roll) * (1 - Math.exp(-dt / 0.12));
    stepWing(b.wing, dt, Math.sin(b.pitch), this.R, b.boosting > 0.5 ? 'flap' : b.pitch < -0.55 ? 'tuck' : null);
  }

  // hooks: { onHit(attacker, victim, x, y, z), onKO(victim, byPlayer), onPlayerHit(), onPlayerOut(), seaH(x, z) }
  update(dt, t, P, hooks) {
    if (!this.on || dt <= 0) return;
    this.t = t;
    const R = this.R, rad = this.radius(t);
    const me = this.player;
    me.invuln = Math.max(0, me.invuln - dt);
    // everyone who can be fought: the player first
    const fighters = [];
    if (!me.dead) fighters.push({ who: 'player', x: P.x, y: P.y, z: P.z, vx: P.vx, vy: P.vy, vz: P.vz, ref: me });
    for (const b of this.birds) if (b.state === 'fly') fighters.push({ who: 'rival', x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, ref: b });

    for (const b of this.birds) {
      if (b.state === 'fall') { this._fall(b, dt, hooks); continue; }
      if (b.state !== 'fly') continue;
      b.invuln = Math.max(0, b.invuln - dt);
      b.retarget -= dt; b.flee = Math.max(0, b.flee - dt);
      const dc = Math.hypot(b.x - this.cx, b.z - this.cz);
      let ax, ay, az, boost = false;
      if (dc > rad - 6) {
        // the ring: head back toward the middle
        ax = this.cx; ay = 12; az = this.cz; boost = dc > rad;
      } else {
        if (b.retarget <= 0 || !b.target || b.target.ref.state === 'fall' || b.target.ref.dead) {
          let best = null, bd = 1e9;
          for (const f of fighters) {
            if (f.ref === b) continue;
            const d = Math.hypot(f.x - b.x, f.y - b.y, f.z - b.z) * (f.who === 'player' ? 0.75 : 1) * (0.8 + 0.4 * R());
            if (d < bd) { bd = d; best = f; }
          }
          b.target = best; b.retarget = 2 + R() * 3;
        }
        const tg = b.target && fighters.find((f) => f.ref === b.target.ref);
        if (tg) {
          const d = Math.hypot(tg.x - b.x, tg.y - b.y, tg.z - b.z);
          if (b.hp === 1 && d < 12 && b.flee <= 0 && R() < dt * 0.6) b.flee = 1.5 + R();
          if (b.flee > 0) { ax = b.x + (b.x - tg.x) * 2; ay = b.y + 3; az = b.z + (b.z - tg.z) * 2; boost = true; }
          else {
            const lead = Math.min(0.9, d / 14) * b.skill;
            ax = tg.x + tg.vx * lead; ay = tg.y + tg.vy * lead; az = tg.z + tg.vz * lead;
            boost = d < 16;
          }
        } else { ax = this.cx + Math.sin(t * 0.2 + b.skill * 9) * rad * 0.5; ay = 14; az = this.cz + Math.cos(t * 0.2 + b.skill * 9) * rad * 0.5; }
      }
      this._fly(b, dt, ax, ay, az, boost);
      // outside the ring: lose a feather every few seconds
      if (Math.hypot(b.x - this.cx, b.z - this.cz) > rad) {
        b.out += dt;
        if (b.out > BRAWL.outsideEvery) { b.out = 0; this._damage(b, null, hooks); }
      } else b.out = 0;
    }

    // the player outside the ring
    if (!me.dead) {
      if (Math.hypot(P.x - this.cx, P.z - this.cz) > rad) {
        me.out += dt;
        if (me.out > BRAWL.outsideEvery) { me.out = 0; this._damagePlayer(null, P, hooks); }
      } else me.out = 0;
    }

    // contacts between every pair of fighters
    const live = [];
    if (!me.dead) live.push({ p: P, ref: me, player: true });
    for (const b of this.birds) if (b.state === 'fly') live.push({ p: b, ref: b, player: false });
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const A = live[i], B = live[j], a = A.p, c = B.p;
      const dx = c.x - a.x, dy = c.y - a.y, dz = c.z - a.z, d = Math.hypot(dx, dy, dz);
      if (d > BRAWL.hitR || d < 1e-4) continue;
      const nx = dx / d, ny = dy / d, nz = dz / d;
      const va = a.vx * nx + a.vy * ny + a.vz * nz;        // A flying into B
      const vb = -(c.vx * nx + c.vy * ny + c.vz * nz);     // B flying into A
      if (va + vb < BRAWL.minClose) continue;
      // push apart
      a.x -= nx * 0.3; a.y -= ny * 0.3; a.z -= nz * 0.3; c.x += nx * 0.3; c.y += ny * 0.3; c.z += nz * 0.3;
      const hitB = va > vb - 1.5, hitA = vb > va - 1.5;     // nearly head-on: both lose a feather
      const x = (a.x + c.x) / 2, y = (a.y + c.y) / 2, z = (a.z + c.z) / 2;
      if (hitB) B.player ? this._damagePlayer(A.ref, P, hooks, x, y, z) : this._damage(B.ref, A, hooks, x, y, z);
      if (hitA) A.player ? this._damagePlayer(B.ref, P, hooks, x, y, z) : this._damage(A.ref, B, hooks, x, y, z);
    }

    if (!this.winner) {
      const left = this.alive();
      if (me.dead) this.winner = 'rival';
      else if (left === 1) this.winner = 'player';
    }
  }

  _damage(b, by, hooks, x = b.x, y = b.y, z = b.z) {
    if (b.invuln > 0 || b.state !== 'fly') return;
    b.hp--; b.invuln = BRAWL.invuln;
    b.yawRate += (this.R() - 0.5) * 3; b.speed *= 0.8;
    const byPlayer = !!(by && by.player);
    if (byPlayer) this.player.hits++;
    if (hooks.onHit) hooks.onHit(by ? by.ref : null, b, x, y, z, byPlayer);
    if (b.hp <= 0) {
      b.state = 'fall'; b.place = this.placeNext--;
      const R = this.R, sp = 9 + 9 * R();
      let ax = R() - 0.5, ay = R() - 0.5, az = R() - 0.5; const al = Math.hypot(ax, ay, az) || 1;
      b.fall = { vx: b.vx * 0.6, vy: b.vy * 0.6 + 2, vz: b.vz * 0.6, wx: ax / al * sp, wy: ay / al * sp, wz: az / al * sp, q: quatFromFwdRoll([0, 0, 0, 1], b.fx, b.fy, b.fz, b.roll), ph: 0 };
      if (byPlayer) this.player.kos++; else if (by && by.ref && by.ref.kos !== undefined) by.ref.kos++;
      if (hooks.onKO) hooks.onKO(b, byPlayer);
    }
  }
  _damagePlayer(by, P, hooks, x = P.x, y = P.y, z = P.z) {
    const me = this.player;
    if (me.invuln > 0 || me.dead) return;
    me.hp--; me.invuln = BRAWL.invuln;
    if (hooks.onPlayerHit) hooks.onPlayerHit(by, x, y, z);
    if (me.hp <= 0) { me.dead = true; me.place = this.placeNext--; if (hooks.onPlayerOut) hooks.onPlayerOut(by); }
  }
  _fall(b, dt, hooks) {
    const F = b.fall;
    F.vy -= G * dt;
    const k = Math.exp(-0.35 * dt); F.vx *= k; F.vy *= k; F.vz *= k;
    b.x += F.vx * dt; b.y += F.vy * dt; b.z += F.vz * dt;
    const Q = F.q, hd = 0.5 * dt, qx = Q[0], qy = Q[1], qz = Q[2], qw = Q[3];
    Q[0] += hd * (F.wx * qw + F.wy * qz - F.wz * qy); Q[1] += hd * (F.wy * qw + F.wz * qx - F.wx * qz);
    Q[2] += hd * (F.wz * qw + F.wx * qy - F.wy * qx); Q[3] += hd * (-F.wx * qx - F.wy * qy - F.wz * qz);
    const l = Math.hypot(Q[0], Q[1], Q[2], Q[3]); Q[0] /= l; Q[1] /= l; Q[2] /= l; Q[3] /= l;
    F.ph = (F.ph + dt * 14) % 1;
    if (b.y < (hooks.seaH ? hooks.seaH(b.x, b.z) : 0)) { b.state = 'gone'; if (hooks.onSplash) hooks.onSplash(b.x, b.z); }
  }

  render(t) {
    const L = this.lod, q = this._q;
    L.begin();
    if (this.on) {
      for (const b of this.birds) {
        if (b.state === 'fly') {
          quatFromFwdRoll(q, b.fx, b.fy, b.fz, b.roll);
          // flicker while briefly invulnerable after a hit
          if (b.invuln > 0 && Math.floor(b.invuln * 12) % 2) continue;
          L.push(b.x, b.y + b.wing.sinkY, b.z, 1, q, b.wing.p, b.wing.gw, b.wing.bw);
        } else if (b.state === 'fall') L.push(b.x, b.y, b.z, 1, b.fall.q, b.fall.ph, 0, 0.5);
      }
      const r = this.radius(t);
      this.ring.position.set(this.cx, -0.5, this.cz);
      this.ring.scale.set(r, 70, r);
      this.ring.material.uniforms.uTime.value = t;
    }
    L.end();
  }
}
