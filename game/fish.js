// fish.js: procedural low-poly flying fish. They show as a dark shape under the surface, burst out, climb, glide on
// spread pectoral "wings" for a second or two, and drop back in. The player grabs them in flight.
import * as THREE from 'three';

const G = 9.81;

function fishGeometry() {
  // body: rings along +Z (head), each an 8-gon squashed to a fish section; vertex colours dark blue back → silver belly
  const rings = [
    [0.19, 0.000, 0.000], [0.175, 0.016, 0.012], [0.14, 0.03, 0.022], [0.08, 0.036, 0.027], [0.01, 0.034, 0.025],
    [-0.06, 0.026, 0.019], [-0.12, 0.016, 0.011], [-0.16, 0.009, 0.006],
  ];
  const sides = 8;
  const pos = [], col = [], idx = [];
  const back = new THREE.Color().setRGB(0.09, 0.17, 0.28), mid = new THREE.Color().setRGB(0.42, 0.52, 0.6), belly = new THREE.Color().setRGB(0.86, 0.88, 0.9);
  const c = new THREE.Color();
  rings.forEach(([z, h, w]) => {
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const y = Math.cos(a) * h, x = Math.sin(a) * w;
      pos.push(x, y, z);
      const k = Math.cos(a) * 0.5 + 0.5;     // 1 = top
      if (k > 0.55) c.copy(mid).lerp(back, (k - 0.55) / 0.45); else c.copy(belly).lerp(mid, k / 0.55);
      col.push(c.r, c.g, c.b);
    }
  });
  for (let r = 0; r < rings.length - 1; r++) for (let s = 0; s < sides; s++) {
    const a = r * sides + s, b = r * sides + ((s + 1) % sides), a2 = a + sides, b2 = b + sides;
    idx.push(a, a2, b, b, a2, b2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed(); ng.computeVertexNormals();
  return ng;
}
function finGeometry(pts, color) {
  const g = new THREE.BufferGeometry();
  const p = pts.flat();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  const col = []; for (let i = 0; i < pts.length; i++) col.push(color.r, color.g, color.b);
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export class FishSchool {
  constructor(scene, env, rings, spray, max = 30) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.65, roughness: 0.28, envMap: env, envMapIntensity: 1.25, flatShading: true });
    const finMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.2, roughness: 0.45, envMap: env, envMapIntensity: 1.0,
      side: THREE.DoubleSide, transparent: true, opacity: 0.86, flatShading: true });
    const body = fishGeometry();
    const finC = new THREE.Color().setRGB(0.5, 0.6, 0.68);
    // pectoral fin (left, +X): long wing from behind the gill, three ribs as a fan
    const pect = finGeometry([
      [0, 0, 0], [0.24, 0.012, -0.05], [0.2, 0.01, -0.13],
      [0, 0, 0], [0.2, 0.01, -0.13], [0.09, 0.004, -0.15],
      [0, 0, 0], [0.09, 0.004, -0.15], [0.01, 0, -0.06],
    ], finC);
    const pelv = finGeometry([[0, 0, 0], [0.09, -0.01, -0.06], [0.04, -0.006, -0.09]], finC);
    const tail = finGeometry([
      [0, 0, 0], [0, 0.075, -0.11], [0, 0.01, -0.06],
      [0, 0, 0], [0, -0.01, -0.06], [0, -0.1, -0.12],
    ], new THREE.Color().setRGB(0.12, 0.18, 0.25));
    this.list = [];
    for (let i = 0; i < max; i++) {
      const root = new THREE.Group();
      const b = new THREE.Mesh(body, mat);
      root.add(b);
      const fins = [];
      for (const s of [1, -1]) {
        const p = new THREE.Mesh(pect, finMat); p.position.set(0.018 * s, 0.006, 0.11); p.scale.x = s; root.add(p); fins.push(p);
        const q = new THREE.Mesh(pelv, finMat); q.position.set(0.012 * s, -0.012, -0.05); q.scale.x = s; root.add(q); fins.push(q);
      }
      const t = new THREE.Mesh(tail, finMat); t.position.set(0, 0, -0.155); root.add(t);
      root.visible = false;
      root.scale.setScalar(1.6);
      scene.add(root);
      this.list.push({ root, fins, tail: t, state: 'off', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 });
    }
    this.rings = rings; this.spray = spray;
    this.seaH = () => 0;   // surface height at (x, z); the game plugs in the wave field
    this.caught = 0; this.missed = 0; this.spawned = 0;
    this._v = new THREE.Vector3(); this._m = new THREE.Matrix4(); this._up = new THREE.Vector3(0, 1, 0);
  }
  get active() { return this.list.filter((f) => f.state === 'lurk' || f.state === 'air'); }

  // schedule a fish so its apex is Q (x, h, z) at time tApex; it travels along horizontal dir (dx, dz) at vh
  spawn(now, tApex, Qx, h, Qz, dx, dz, vh, R) {
    const f = this.list.find((x) => x.state === 'off');
    if (!f) return null;
    const tUp = Math.sqrt(2 * h / G);
    const tB = tApex - tUp;
    if (tB < now + 0.4) return null;
    f.state = 'lurk'; f.t = now; f.tB = tB; f.tApex = tApex;
    f.bx = Qx - dx * vh * tUp; f.bz = Qz - dz * vh * tUp;
    f.dx = dx; f.dz = dz; f.vh = vh; f.vy0 = G * tUp; f.h = h;
    f.glide = 0.9 + 1.2 * R(); f.glideLeft = undefined; f.age = 0; f.wob = R() * 6;
    f.x = f.bx; f.y = -0.4; f.z = f.bz;
    f.lurk0 = now;
    f.shadow = this.rings.shadow(() => {
      if (f.state !== 'lurk') return null;
      const k = Math.min(1, (this._now - f.lurk0) / Math.max(0.2, f.tB - f.lurk0));
      const back = (1 - k) * 4.5;
      return { x: f.bx - dx * back, z: f.bz - dz * back, a: Math.min(1, k * 2.5) };
    });
    this.spawned++;
    return f;
  }

  update(dt, now, player, catchR, onCatch, R) {
    this._now = now;
    for (const f of this.list) {
      if (f.state === 'off') { f.root.visible = false; continue; }
      if (f.state === 'lurk') {
        f.root.visible = false;
        if (now >= f.tB) {
          f.state = 'air'; f.x = f.bx; f.y = this.seaH(f.bx, f.bz); f.z = f.bz;
          f.vx = f.dx * f.vh; f.vz = f.dz * f.vh; f.vy = f.vy0; f.age = 0;
          this.rings.ring(f.x, f.z, 1.6, 1.2, 0.6);
          this.spray.splash(f.x, f.z, 0.8, R);
        }
        continue;
      }
      if (f.state === 'air') {
        f.age += dt;
        if (f.vy < 0 && f.glideLeft === undefined) f.glideLeft = f.glide;
        const gliding = f.glideLeft !== undefined && f.glideLeft > 0;
        if (gliding) {
          f.glideLeft -= dt;
          f.vy += (-G * 0.22) * dt; f.vy *= Math.exp(-dt * 1.4);
          const k = Math.exp(-dt * 0.12); f.vx *= k; f.vz *= k;
        } else f.vy -= G * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
        if (f.vy < 0 && f.y < this.seaH(f.x, f.z)) {
          f.state = 'off'; this.missed++;
          this.rings.ring(f.x, f.z, 1.3, 1.1, 0.45);
          this.spray.splash(f.x, f.z, 0.5, R);
          continue;
        }
        if (player) {
          const ex = f.x - player.x, ey = f.y - player.y, ez = f.z - player.z;
          if (ex * ex + ey * ey + ez * ez < catchR * catchR) {
            f.state = 'caught'; f.cT = 0; this.caught++;
            if (onCatch) onCatch(f);
          }
        }
        this._pose(f, gliding);
        continue;
      }
      if (f.state === 'caught') {
        // carried in the beak for a moment, shrinking away
        f.cT += dt;
        const k = f.cT / 0.55;
        if (k >= 1 || !player) { f.state = 'off'; f.root.visible = false; continue; }
        f.x = player.x + player.fx * 0.16; f.y = player.y + player.fy * 0.16 - 0.03; f.z = player.z + player.fz * 0.16;
        f.vx = player.vx; f.vy = player.vy; f.vz = player.vz;
        this._pose(f, false);
        f.root.scale.setScalar(1.6 * (1 - k * k) * 0.75 + 0.001);
      }
    }
  }

  _pose(f, gliding) {
    const r = f.root;
    r.visible = true;
    r.position.set(f.x, f.y, f.z);
    const v = this._v.set(f.vx, f.vy, f.vz);
    if (v.lengthSq() > 1e-4) {
      v.normalize();
      this._m.lookAt(new THREE.Vector3(0, 0, 0), v.negate(), this._up);
      r.quaternion.setFromRotationMatrix(this._m);
    }
    if (f.state !== 'caught') r.scale.setScalar(1.6);
    // fins: spread wide while gliding, half-folded on the climb out; tail sculls
    const spread = gliding ? 1 : 0.55;
    const wob = Math.sin(f.age * 9 + f.wob);
    f.fins[0].rotation.set(0, 0, 0.05 + 0.04 * wob - (1 - spread) * 0.5);
    f.fins[2].rotation.set(0, 0, -0.05 - 0.04 * wob + (1 - spread) * 0.5);
    f.tail.rotation.y = Math.sin(f.age * (gliding ? 4 : 22)) * (gliding ? 0.08 : 0.35);
  }
}
