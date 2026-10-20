// fx.js: sky dome, sea, spray, splash rings, fish shadows and loose feathers.
import * as THREE from 'three';
import * as SH from './shaders.js';
import { Sea } from './sea.js';

const srgb = (r, g, b) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);

// the look: bright overcast (about sRGB 196,197,198 — the project's signature panel) over a darker grey-blue sea
export const LOOK = {
  horizon: srgb(192, 193, 195),
  zenith: srgb(201, 202, 204),
  fog: srgb(168, 173, 179),          // sea haze toward the horizon, a little darker than the sky so the sea line reads
  deep: srgb(28, 38, 50),
  shallow: srgb(52, 64, 77),
  scatter: srgb(34, 62, 68),
  foam: srgb(186, 192, 197),
  skyUp: srgb(196, 197, 198),
  skyDown: srgb(70, 80, 90),
  accent: srgb(240, 118, 52),
  fogK: 0.0016,
};

export function sharedUniforms() {
  return {
    uSkyUp: { value: LOOK.skyUp.clone() }, uSkyDown: { value: LOOK.skyDown.clone() },
    uFogCol: { value: LOOK.fog.clone() }, uHorizon: { value: LOOK.horizon.clone() }, uZenith: { value: LOOK.zenith.clone() },
    uFogK: { value: LOOK.fogK }, uSeaHaze: { value: srgb(62, 72, 84) }, uHazeMul: { value: 0.4 },
    uPxPerM: { value: 800 }, uMinPx: { value: 2.4 }, uSpanM: { value: 0.39 }, uAlphaPow: { value: 0.8 },
    uRes: { value: new THREE.Vector2(1280, 720) }, uDilate: { value: 0.75 },
  };
}

export class World {
  constructor(scene, U) {
    this.U = U;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), new THREE.ShaderMaterial({
      vertexShader: SH.SKY_VERT, fragmentShader: SH.SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: { uHorizon: U.uHorizon, uZenith: U.uZenith, uFogCol: U.uFogCol },
    }));
    sky.renderOrder = -10; sky.frustumCulled = false;
    this.sky = sky;
    scene.add(sky);
    this.sea = new Sea(scene, U, SH.LIGHT, LOOK);
  }
  update(t, cam) {
    this.sky.position.copy(cam.position);
    this.sea.update(t, cam);
  }
}

// environment map for the few standard-material things (fish, feathers): overcast above, dark sea below
export function makeEnv(renderer) {
  const s = new THREE.Scene();
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uHorizon: { value: LOOK.horizon }, uZenith: { value: LOOK.zenith }, uSea: { value: LOOK.deep.clone().lerp(LOOK.fog, 0.35) } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uHorizon, uZenith, uSea; varying vec3 vD;
      void main(){ vec3 d = normalize(vD); vec3 c = d.y > 0.0 ? mix(uHorizon, uZenith, pow(d.y, 0.7)) : mix(uHorizon * 0.8, uSea, smoothstep(0.0, 0.25, -d.y));
      gl_FragColor = vec4(c, 1.0); }`,
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), m));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0, 0.1, 100);
  pm.dispose();
  return rt.texture;
}

// ------------------------------------------------------------------------------------------------ spray droplets
export class Spray {
  constructor(scene, U, max = 900, { color = [0.82, 0.86, 0.9], gravity = 9.81, drag = 0, blend = 'normal' } = {}) {
    this.max = max; this.n = 0; this.gravity = gravity; this.drag = drag;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.life = new Float32Array(max); this.age = new Float32Array(max);
    this.a = new Float32Array(max); this.s = new Float32Array(max); this.size0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aP = new THREE.BufferAttribute(this.p, 3); this.aA = new THREE.BufferAttribute(this.a, 1); this.aS = new THREE.BufferAttribute(this.s, 1);
    for (const x of [this.aP, this.aA, this.aS]) x.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aP); g.setAttribute('aA', this.aA); g.setAttribute('aS', this.aS);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({ vertexShader: SH.SPRAY_VERT, fragmentShader: SH.SPRAY_FRAG, transparent: true, depthWrite: false,
      uniforms: { uPxPerM: U.uPxPerM, uCol: { value: new THREE.Color().setRGB(...color) } } });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = 6;
    this.geo = g;
    scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, life, size) {
    let i = this.n < this.max ? this.n++ : Math.floor(Math.random() * this.max);
    const i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z; this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.life[i] = life; this.age[i] = 0; this.size0[i] = size;
  }
  splash(x, z, strength, R) {
    const n = Math.round(26 * strength + 6);
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2, sp = (0.6 + R() * 2.2) * Math.sqrt(strength);
      this.emit(x + Math.cos(a) * 0.1, 0.05, z + Math.sin(a) * 0.1, Math.cos(a) * sp, (2.2 + R() * 3.5) * Math.sqrt(strength), Math.sin(a) * sp, 0.6 + R() * 0.7, 0.05 + 0.06 * R() * strength);
    }
  }
  update(dt) {
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      const i3 = i * 3, j3 = j * 3;
      this.v[i3 + 1] -= this.gravity * dt;
      if (this.drag) { const k = Math.exp(-this.drag * dt); this.v[i3] *= k; this.v[i3 + 1] *= k; this.v[i3 + 2] *= k; }
      const p = this.p, v = this.v;
      p[j3] = p[i3] + v[i3] * dt; p[j3 + 1] = p[i3 + 1] + v[i3 + 1] * dt; p[j3 + 2] = p[i3 + 2] + v[i3 + 2] * dt;
      v[j3] = v[i3]; v[j3 + 1] = v[i3 + 1]; v[j3 + 2] = v[i3 + 2];
      this.life[j] = this.life[i]; this.age[j] = this.age[i]; this.size0[j] = this.size0[i];
      const k = this.age[j] / this.life[j];
      this.a[j] = (1 - k) * 0.85; this.s[j] = this.size0[j] * (1 - 0.4 * k);
      if (p[j3 + 1] < -0.05) continue;
      j++;
    }
    this.n = j;
    this.geo.setDrawRange(0, j);
    for (const x of [this.aP, this.aA, this.aS]) { x.clearUpdateRanges(); x.addUpdateRange(0, j * x.itemSize); x.needsUpdate = true; }
  }
}

// ------------------------------------------------------------------------------------------------ water rings
export class Rings {
  constructor(scene, max = 48) {
    this.pool = [];
    const g = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < max; i++) {
      const m = new THREE.ShaderMaterial({ vertexShader: SH.RING_VERT, fragmentShader: SH.RING_FRAG, transparent: true, depthWrite: false,
        uniforms: { uCol: { value: new THREE.Color(1, 1, 1) }, uA: { value: 0 }, uR: { value: 0.5 }, uW: { value: 0.1 } } });
      m.depthTest = false;
      const mesh = new THREE.Mesh(g, m);
      mesh.rotation.x = -Math.PI / 2; mesh.visible = false; mesh.renderOrder = -4; mesh.frustumCulled = false;
      scene.add(mesh);
      this.pool.push({ mesh, m, age: 0, life: 0, kind: 'ring', r0: 0, r1: 1, a0: 0.5, follow: null });
    }
  }
  _get() { return this.pool.find((p) => !p.mesh.visible) || this.pool.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b)); }
  ring(x, z, r1 = 2.5, life = 1.6, a0 = 0.55) {
    const p = this._get();
    p.mesh.visible = true; p.mesh.position.set(x, 0.03, z); p.age = 0; p.life = life; p.kind = 'ring'; p.r0 = 0.15; p.r1 = r1; p.a0 = a0;
    p.m.uniforms.uCol.value.setRGB(0.86, 0.9, 0.93);
    p.follow = null;
  }
  // a dark shape under the surface, telegraphing a fish about to leap; follow() returns {x, z, a} each frame or null
  shadow(follow) {
    const p = this._get();
    p.mesh.visible = true; p.age = 0; p.life = 1e9; p.kind = 'shadow'; p.follow = follow;
    p.m.uniforms.uCol.value.setRGB(0.02, 0.05, 0.08);
    p.m.uniforms.uR.value = 0; p.m.uniforms.uW.value = 0.3;
    return p;
  }
  update(dt) {
    for (const p of this.pool) {
      if (!p.mesh.visible) continue;
      p.age += dt;
      if (p.kind === 'shadow') {
        const f = p.follow();
        if (!f) { p.mesh.visible = false; continue; }
        p.mesh.position.set(f.x, 0.02, f.z);
        p.mesh.scale.setScalar(0.9); p.m.uniforms.uA.value = f.a * 0.5;
        continue;
      }
      const k = p.age / p.life;
      if (k >= 1) { p.mesh.visible = false; continue; }
      const r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - k, 2));
      const sc = r + 0.6;
      p.mesh.scale.setScalar(sc);
      p.m.uniforms.uR.value = r / sc; p.m.uniforms.uW.value = (0.08 + 0.12 * k) / sc * 2.2;
      p.m.uniforms.uA.value = p.a0 * (1 - k) * (1 - k);
    }
  }
}

// ------------------------------------------------------------------------------------------------ feathers
function featherGeometry() {
  // a small contour feather: a curved vane on a rachis, 6.5 cm
  const L = 0.075, Wd = 0.015;
  const pts = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const s = i / n, z = (s - 0.5) * L;
    const w = Wd * Math.sin(Math.PI * Math.pow(s, 0.8)) * (s > 0.92 ? 0.6 : 1);
    const bend = 0.006 * Math.sin(Math.PI * s);
    pts.push([-w, bend, z], [w * 0.8, bend + 0.001, z]);
  }
  const pos = [], idx = [];
  pts.forEach((p) => pos.push(...p));
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Feathers {
  constructor(scene, env, max = 220) {
    this.max = max;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.1, 0.085, 0.07), roughness: 0.7, metalness: 0.0,
      side: THREE.DoubleSide, envMap: env, envMapIntensity: 1.0 });
    this.mesh = new THREE.InstancedMesh(featherGeometry(), mat, max);
    this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.list = [];
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
  }
  burst(x, y, z, vx, vy, vz, n, R) {
    for (let k = 0; k < n; k++) {
      if (this.list.length >= this.max) this.list.shift();
      this.list.push({ x, y, z, vx: vx * 0.85 + (R() - 0.5) * 3.2, vy: vy * 0.85 + (R() - 0.2) * 2.5, vz: vz * 0.85 + (R() - 0.5) * 3.2,
        rx: R() * 6, ry: R() * 6, rz: R() * 6, wr: 2 + R() * 6, ph: R() * 6, sway: 0.4 + R() * 0.8, age: 0, life: 7 + R() * 4,
        s: 0.8 + R() * 0.6, floatT: 0 });
    }
  }
  update(dt) {
    const out = [];
    for (const f of this.list) {
      f.age += dt;
      if (f.age > f.life) continue;
      if (f.y > 0.01) {
        // quadratic drag toward a ~0.6 m/s flutter descent, with a side-to-side sway
        const drag = Math.exp(-dt * 1.6);
        f.vx *= drag; f.vz *= drag; f.vy = f.vy * drag + (-0.6) * (1 - drag) - 0.4 * dt;
        const sw = Math.sin(f.age * 3.1 + f.ph) * f.sway;
        f.x += (f.vx + sw * Math.cos(f.ph)) * dt; f.y += f.vy * dt; f.z += (f.vz + sw * Math.sin(f.ph)) * dt;
        f.rx += f.wr * dt; f.rz += Math.cos(f.age * 3.1 + f.ph) * 2 * dt;
      } else { f.y = 0.01; f.floatT += dt; if (f.floatT > 2.5) continue; }
      out.push(f);
    }
    this.list = out;
    const M = this._m;
    let n = 0;
    for (const f of out) {
      this._e.set(f.rx, f.ry, f.rz); this._q.setFromEuler(this._e);
      const fade = f.y <= 0.01 ? Math.max(0.01, 1 - f.floatT / 2.5) : 1;
      this._s.setScalar(f.s * fade); this._p.set(f.x, f.y, f.z);
      M.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n++, M);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
