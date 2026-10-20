// flock.js: the GPU starling murmuration (SPEC §4). Owned by the Flock builder.
//
//   Flock.loadAssets(base)        decoded murm-vat-1 starling LODs (+ peregrine GLBs when the Blender builder ships them)
//   new Flock({renderer, state, assets, prof})
//   update(dt, camera)            ONE fixed sim step: hash → density (+opacity) → nbr → vel → state → pos; falcon AI
//   updateLOD(camera)             GPU LOD key + async readback → CPU buckets → 4 instanced VAT meshes
//
// Sim state lives in float textures (bird i at texel (i % W, i / W)); every pass is a full-screen RawShaderMaterial
// (GLSL3) except the two GL_POINTS scatters. The falcon is a CPU agent (SPEC §4.7). Nothing here touches the canvas:
// the integrator renders flock.object3d into its sceneRT.
import * as THREE from 'three';
import * as SH from './flock_shaders.js';

const V3 = THREE.Vector3;
const DEG = Math.PI / 180;
const G = 9.81;
const SPAN_M = 0.39;            // starling span used for LOD keys (SPEC §0)
const HASH_CELL = 2.5;          // m (SPEC §4.2)
const SIGMA = 0.02;             // m² per bird (SPEC §4.3 rule 3)
const SUB_N = 256;
const LOD_NAMES = ['real', 'retro', 'sil', 'micro'];
const LODVIZ_TINT = [[1, 0.15, 0.1], [0.15, 0.85, 0.2], [0.2, 0.35, 1], [1, 0.85, 0.1]];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function part1by2(n) {   // 10-bit Morton spread
  n &= 0x3ff;
  n = (n | (n << 16)) & 0x030000ff;
  n = (n | (n << 8)) & 0x0300f00f;
  n = (n | (n << 4)) & 0x030c30c3;
  n = (n | (n << 2)) & 0x09249249;
  return n;
}
const noProf = { begin() {}, end() {} };

function floatRT(w, h, extra = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...extra,
  });
}
function rawMat(vs, fs, uniforms, extra = {}) {
  return new THREE.RawShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, glslVersion: THREE.GLSL3,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, ...extra });
}

// ------------------------------------------------------------------------------------------------ assets
async function loadVat(base, name, texLoader) {
  const meta = await (await fetch(base + name + '.json')).json();
  if (meta.format !== 'murm-vat-1') throw new Error(`${name}: format ${meta.format}`);
  const buf = await (await fetch(base + name + '.bin')).arrayBuffer();
  const B = meta.buffers;
  const out = {
    meta,
    index: new Uint16Array(buf, B.index.offset, B.index.count),
    uv: new Float32Array(buf, B.uv.offset, B.uv.count),
    vatPos: new Uint16Array(buf, B.vatPos.offset, B.vatPos.count),
    vatNrm: new Uint8Array(buf, B.vatNrm.offset, B.vatNrm.count),
    albedo: null, mask: null, normal: null,
  };
  const T = meta.textures || {};
  const load = (file, srgb) => new Promise((res) => {
    if (!file) return res(null);
    texLoader.load(base + file, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, () => res(null));
  });
  [out.albedo, out.mask, out.normal] = await Promise.all([load(T.albedo, true), load(T.mask, false), load(T.normal, false)]);
  return out;
}

// A procedural flapping bird in the in-memory VAT form (§6.2), for tests before the Blender assets exist.
export function makeStandInStarling(lod = 'retro') {
  // body diamond (6 verts) + per wing: root lead, root trail, wrist, tip (4 verts, 2 tris)
  const body = [[0, 0, 0.1], [0, 0.02, 0], [0.025, 0, 0], [0, -0.02, 0], [-0.025, 0, 0], [0, 0, -0.1]];
  const idx = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4];
  const verts = body.length + 8;
  for (const s of [0, 1]) { const o = 6 + s * 4; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  const rows = 34, vatPos = new Uint16Array(rows * verts * 4), vatNrm = new Uint8Array(rows * verts * 4);
  const h = THREE.DataUtils.toHalfFloat;
  for (let r = 0; r < rows; r++) {
    const ph = r < 32 ? r / 32 : 0;
    let lift = r < 32 ? (ph < 0.57 ? Math.cos(Math.PI * ph / 0.57) : -Math.cos(Math.PI * (ph - 0.57) / 0.43)) * 0.9 : r === 32 ? 0.05 : -1.2;
    const span = r === 33 ? 0.25 : 1;
    const P = body.map((b) => [b[0], b[1], b[2], 0]);
    for (const s of [1, -1]) {
      const c = Math.cos(lift * 0.6), si = Math.sin(lift * 0.6);
      const wing = [[0.02, 0, 0.03], [0.02, 0, -0.03], [0.1 * span, 0, 0.0], [0.19 * span, 0, -0.04]];
      for (const w of wing) { const x = w[0]; P.push([s * x * c, x * si, w[2], 1]); }
    }
    P.forEach((p, v) => {
      const o = (r * verts + v) * 4;
      vatPos[o] = h(p[0]); vatPos[o + 1] = h(p[1]); vatPos[o + 2] = h(p[2]); vatPos[o + 3] = h(p[3]);
      vatNrm[o] = 128; vatNrm[o + 1] = 255; vatNrm[o + 2] = 128; vatNrm[o + 3] = p[3] * 255;
    });
  }
  const meta = { format: 'murm-vat-1', name: 'standin_' + lod, lod: LOD_NAMES.indexOf(lod), verts, tris: idx.length / 3, rows: 34,
    cycleFrames: 32, rowGlide: 32, rowBound: 33, wingbeatHz: 13.3, downstroke: 0.57, spanM: 0.39, lengthM: 0.2,
    albedoLinear: { body: [0.11, 0.09, 0.075], wing: [0.1, 0.075, 0.055] } };
  return { meta, index: new Uint16Array(idx), uv: new Float32Array(verts * 2), vatPos, vatNrm, albedo: null, mask: null, normal: null };
}

// ------------------------------------------------------------------------------------------------ Flock
export class Flock {
  static async loadAssets(base = 'assets/birds/', opts = {}) {
    const texLoader = new THREE.TextureLoader();
    const starling = {};
    await Promise.all(LOD_NAMES.map(async (l) => {
      try { starling[l] = await loadVat(base, 'starling_' + l, texLoader); }
      catch (e) { console.warn('flock: starling_' + l + ' missing, using stand-in', e.message); starling[l] = makeStandInStarling(l); }
    }));
    // Peregrine GLBs (SPEC §6.4). Only requested when known to exist (opts.files, or assets/manifest.json), so a
    // missing file never produces a console 404.
    let files = opts.files || null;
    if (!files && opts.manifest !== false) {
      try {
        const r = await fetch(base + '../manifest.json', { cache: 'no-store' });
        if (r.ok) {
          const m = await r.json();
          const list = Array.isArray(m.files) ? m.files.map((f) => (typeof f === 'string' ? f : f.path || f.file || ''))
            : Object.keys(m.files || m);
          files = list.map((f) => f.split('/').pop());
        }
      } catch (e) { /* no manifest: falcon stand-in */ }
    }
    const falcon = { real: null, retro: null };
    if (files) {
      const want = ['real', 'retro'].filter((v) => files.includes('peregrine_' + v + '.glb'));
      if (want.length) {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const gl = new GLTFLoader();
        await Promise.all(want.map(async (v) => {
          try { falcon[v] = await gl.loadAsync(base + 'peregrine_' + v + '.glb'); } catch (e) { console.warn('flock: peregrine_' + v, e.message); }
        }));
      }
    }
    return { starling, falcon };
  }

  constructor({ renderer, state, assets, prof }) {
    this.renderer = renderer;
    this.state = state;
    this.assets = assets || { starling: Object.fromEntries(LOD_NAMES.map((l) => [l, makeStandInStarling(l)])), falcon: {} };
    this.prof = prof || noProf;
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext) || !gl.getExtension('EXT_color_buffer_float')) throw new Error('This page needs WebGL2 with float render targets.');
    gl.getExtension('EXT_float_blend');

    this.t = 0;                   // sim seconds
    this.frame = 0;               // sim steps
    this.object3d = new THREE.Group();
    this.object3d.name = 'flock';
    this.stampMode = 'all';
    this.lodvizOn = false;
    this.renderW = 0; this.renderH = 0;

    // full-screen pass plumbing
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsScene = new THREE.Scene();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.fsMesh = new THREE.Mesh(tri, null);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);
    this.ptScene = new THREE.Scene();

    // light uniforms: shared by reference with Sky (SPEC §5.4); a stand-in overcast bag when Sky is absent
    if (!state.light) state.light = { u: null };
    if (!state.light.u) state.light.u = Flock.standInLight();
    this.lightU = state.light.u;

    // shared uniforms (objects shared between the sim and render materials)
    this.U = {
      uWind10: { value: new V3() }, uWind80: { value: new V3() }, uWind850: { value: new V3() }, uWindDrift: { value: 1 },
      uGustA: { value: [new THREE.Vector4(), new THREE.Vector4()] }, uGustB: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uDensOrigin: { value: new THREE.Vector4(0, 0, 0, 6) }, uDensDim: { value: new THREE.Vector4(64, 64, 32, 8) },
      uSize: { value: new THREE.Vector2(1, 1) }, uN: { value: 1 },
      // min-pixel legibility (integrator): sub-pixel birds are widened to uMinPx and drawn at alpha = k^−uAlphaPow
      // (2 = area-preserving, the physical default; < 2 = perceptual darkening of far birds)
      uMinPx: { value: 2.0 }, uAlphaPow: { value: 2.0 },
      uLead: { value: 0 }, uRes: { value: new THREE.Vector2(1280, 720) }, uDilate: { value: 0.5 },
    };
    this.uDensDimI = { value: [64, 64, 32, 8] };   // ivec4 uniforms are plain arrays in three.js
    this.uSizeI = { value: [1, 1] };

    this._buildFalconAgent();
    this._initLODMeshes();
    this.setCount();
    this.debug = this._makeDebug();
  }

  static standInLight() {
    // a bright overcast stand-in, scene radiance relative to a sky of ~1 (SPEC §5.4 units)
    return {
      uSunDir: { value: new V3(-0.6, 0.08, 0.8).normalize() }, uSunColor: { value: new V3(0.06, 0.06, 0.06) },
      uSkyUp: { value: new V3(0.93, 0.95, 0.98) }, uSkyDown: { value: new V3(0.13, 0.135, 0.14) },
      uHorizonColor: { value: new V3(0.9, 0.91, 0.93) }, uZenithColor: { value: new V3(1.0, 1.01, 1.03) },
      uExtinction: { value: 3.912 / 18000 }, uAerialMax: { value: 0.85 }, uLook: { value: 0 },
    };
  }

  // ---------------------------------------------------------------------------------------------- allocation
  setCount(n) {
    const q = this.state.preset || { birds: [256, 120] };
    let W = q.birds[0], H = q.birds[1];
    if (Array.isArray(n)) [W, H] = n;
    else if (typeof n === 'number' && n > 0) H = Math.max(1, Math.ceil(n / W));
    W = Math.max(4, W - (W % 4));
    // review fix: a quality change keeps the flight in progress (strided subset going down, jittered clones going up)
    // instead of respawning the flock as an egg. Synchronous read, once per quality change.
    let carry = null;
    if (this.rt && this.rt.pos && this.N) {
      try {
        const r = this.renderer, No = this.N, pb = new Float32Array(No * 4), vb = new Float32Array(No * 4), sb = new Float32Array(No * 4);
        r.readRenderTargetPixels(this.rt.pos[this.cur.pos], 0, 0, this.W, this.H, pb);
        r.readRenderTargetPixels(this.rt.vel[this.cur.vel], 0, 0, this.W, this.H, vb);
        r.readRenderTargetPixels(this.rt.st[this.cur.st], 0, 0, this.W, this.H, sb);
        carry = { pos: pb, vel: vb, st: sb, N: No, t: this.t, frame: this.frame, centroid: this.state.flock.centroid.clone() };
      } catch (e) { carry = null; }
    }
    this._carry = carry;
    this._disposeSim();
    this.W = W; this.H = H; this.N = W * H;
    this.U.uSize.value.set(W, H); this.uSizeI.value = [W, H]; this.U.uN.value = this.N;
    const mk = () => floatRT(W, H);
    this.rt = {
      pos: [mk(), mk()], vel: [mk(), mk()], st: [mk(), mk()],
      nbr: [floatRT(W, H, { count: 2 }), floatRT(W, H, { count: 2 })],
      lod: new THREE.WebGLRenderTarget(W / 4, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false }),
      sub: floatRT(SUB_N, 3),
      tmp: mk(),
    };
    this.cur = { pos: 0, vel: 0, st: 0, nbr: 0 };
    this._allocGrid();
    // tracked mask (R8, W×H)
    this.trackData = new Uint8Array(this.N).fill(255);
    this.trackTex = new THREE.DataTexture(this.trackData, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    this.trackTex.needsUpdate = true;
    this.trackFalcon = true;
    // scatter geometry (one point per bird; position.x = id)
    const ids = new Float32Array(this.N); for (let i = 0; i < this.N; i++) ids[i] = i;
    this.ptGeo = new THREE.BufferGeometry();
    this.ptGeo.setAttribute('position', new THREE.BufferAttribute(ids, 1));
    this.ptGeo.boundingSphere = new THREE.Sphere(new V3(), 1e6);   // ids, not positions: never computed
    this.idArray = ids;
    this._buildSimMaterials();
    this._resizeLODMeshes();
    this.lodCodes = new Uint8Array(this.N);
    this.prevLod = new Uint8Array(this.N).fill(3);
    this.lodBusy = false; this.subBusy = false; this.lodReady = false;
    this.subBuf = new Float32Array(SUB_N * 3 * 4);
    this.subData = null; this.subT = 0;
    this.reset(this.state.noise ? this.state.noise.seed : 1);
    if (this._carry) { this._restoreCarry(this._carry); this._carry = null; }
    this.state.flock.count = this.N;
  }
  _restoreCarry(C) {
    const N = this.N, W = this.W, H = this.H, No = C.N;
    if (!(C.pos[1] === C.pos[1])) return;     // NaN guard
    const rnd = mulberry32(12345);
    const pos = new Float32Array(N * 4), vel = new Float32Array(N * 4), st = new Float32Array(N * 4);
    for (let k = 0; k < N; k++) {
      const src = Math.min(No - 1, Math.floor(k * No / N)), j = N > No && (k * No) % N !== 0 ? 0.5 : 0;
      for (let c = 0; c < 4; c++) { pos[k * 4 + c] = C.pos[src * 4 + c]; vel[k * 4 + c] = C.vel[src * 4 + c]; st[k * 4 + c] = C.st[src * 4 + c]; }
      if (j) { pos[k * 4] += (rnd() - 0.5) * 2 * j; pos[k * 4 + 1] += (rnd() - 0.5) * 2 * j; pos[k * 4 + 2] += (rnd() - 0.5) * 2 * j; pos[k * 4 + 3] = rnd(); }
    }
    const up = (arr, rt) => { const t = new THREE.DataTexture(arr, W, H, THREE.RGBAFormat, THREE.FloatType); t.needsUpdate = true; this._copy(t, rt); t.dispose(); };
    for (let b = 0; b < 2; b++) { up(pos, this.rt.pos[b]); up(vel, this.rt.vel[b]); up(st, this.rt.st[b]); }
    this.t = C.t; this.frame = C.frame;
    this.state.flock.centroid.copy(C.centroid);
  }

  _allocGrid() {
    const q = this.state.preset || {};
    const hashN = q.hash || 512;
    const [nx, ny, nz, cell] = q.dens || [64, 64, 32, 6];
    const tilesX = 2 ** Math.ceil(Math.log2(Math.sqrt(nz)));
    const tY = Math.ceil(nz / tilesX);
    if (this.rt.hash) { this.rt.hash.dispose(); this.rt.dens.dispose(); this.rt.opac.dispose(); }
    this.hashN = hashN;
    this.rt.hash = new THREE.WebGLRenderTarget(hashN, hashN, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    const half = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, generateMipmaps: false };
    this.rt.dens = new THREE.WebGLRenderTarget(nx * tilesX, ny * tY, half);
    this.rt.opac = new THREE.WebGLRenderTarget(nx * tilesX, ny * tY, half);
    this.grid = { nx, ny, nz, cell, tilesX, key: hashN + ':' + [nx, ny, nz, cell].join(',') };
    this.U.uDensDim.value.set(nx, ny, nz, tilesX);
    this.uDensDimI.value = [nx, ny, nz, tilesX];
    this.U.uDensOrigin.value.w = cell;
    this.opacValid = false;
  }

  _buildSimMaterials() {
    for (const m of Object.values(this.mat || {})) m.dispose();
    const U = this.U, I = { uSize: this.uSizeI, uN: U.uN };
    const wind = { uWind10: U.uWind10, uWind80: U.uWind80, uWind850: U.uWind850, uWindDrift: U.uWindDrift, uGustA: U.uGustA, uGustB: U.uGustB };
    const atlas = { uDensOrigin: U.uDensOrigin, uDensDim: this.uDensDimI };
    const hashU = { uHashCell: { value: HASH_CELL }, uHashN: { value: this.hashN } };
    const T = () => ({ value: null });
    const dirs = [];
    for (let i = 0; i < 6; i++) {
      const y = 1 - (i + 0.5) * 2 / 6, r = Math.sqrt(1 - y * y), ph = i * Math.PI * (3 - Math.sqrt(5));
      dirs.push(new V3(Math.cos(ph) * r, y, Math.sin(ph) * r));
    }
    this.mat = {
      copy: rawMat(SH.FS_VERT, SH.COPY_FRAG, { tSrc: T() }),
      hash: rawMat(SH.HASH_VERT, SH.HASH_FRAG, { ...I, ...wind, ...hashU, tPos: T() }),
      dens: rawMat(SH.DENS_VERT, SH.DENS_FRAG, { ...I, ...wind, ...atlas, tPos: T(), tVel: T() }, {
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor }),
      opac: rawMat(SH.FS_VERT, SH.OPAC_FRAG, { ...atlas, tDens: T(), uDirs: { value: dirs }, uSigma: { value: SIGMA } }),
      nbr: rawMat(SH.FS_VERT, SH.NBR_FRAG, { ...I, ...wind, ...hashU, tPos: T(), tNbrA: T(), tNbrB: T(), tHash: T(), uFrame: { value: 0 } }),
      vel: rawMat(SH.FS_VERT, SH.VEL_FRAG, { ...I, ...wind, ...atlas, tPos: T(), tVel: T(), tState: T(), tNbrA: T(), tNbrB: T(), tOpac: T(),
        uDt: { value: 1 / 60 }, uTime: { value: 0 }, uTimeMod: { value: 0 },
        uP0: { value: new THREE.Vector4() }, uP1: { value: new THREE.Vector4() }, uP2: { value: new THREE.Vector4() },
        uP3: { value: new THREE.Vector4() }, uP4: { value: new THREE.Vector4() }, uP5: { value: new THREE.Vector4() },
        uP6: { value: new THREE.Vector4() }, uP7: { value: new THREE.Vector4() }, uCentroid: { value: new V3() },
        uNoiseOff: { value: new V3() }, uSeed: { value: 1 },
        uPred: { value: new THREE.Vector4() }, uPredVel: { value: new THREE.Vector4() }, uFlash: { value: new THREE.Vector4() },
        uFlashR: { value: 10 }, uWaveOrigin: { value: new V3() },
        uSteerA: { value: new THREE.Vector4() }, uSteerW: { value: new THREE.Vector4() }, uSteerP: { value: new THREE.Vector4() },
        uSteerX: { value: new THREE.Vector4() }, uSteerV: { value: new THREE.Vector2() } }),
      st: rawMat(SH.FS_VERT, SH.STATE_FRAG, { ...I, ...wind, tPos: T(), tVel: T(), tState: T(), tNbrA: T(), tNbrB: T(),
        uDt: { value: 1 / 60 }, uTime: { value: 0 }, uTimeMod: { value: 0 },
        uW0: { value: new THREE.Vector4() }, uF0: { value: new THREE.Vector4() }, uF1: { value: new THREE.Vector4() },
        uPred: { value: new THREE.Vector4() }, uDetect: { value: 45 }, uExRayO: { value: new THREE.Vector4() },
        uExRayD: { value: new THREE.Vector4() }, uSpont: { value: -1 } }),
      pos: rawMat(SH.FS_VERT, SH.POS_FRAG, { ...I, ...wind, tPos: T(), tVel: T(), tState: T(), uDt: { value: 1 / 60 },
        uTimeMod: { value: 0 }, uF0: { value: new THREE.Vector4() }, uExDur: { value: 0.6 } }),
      lod: rawMat(SH.FS_VERT, SH.LODKEY_FRAG, { ...I, tPos: T(), uView: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector4() },
        uPxPerM: { value: 1000 }, uSpanM: { value: SPAN_M } }),
      sub: rawMat(SH.FS_VERT, SH.SUB_FRAG, { ...I, tPos: T(), tVel: T(), tState: T(), uStride: { value: 1 }, uTarget: { value: -1 } }),
    };
    this.ptMesh = new THREE.Points(this.ptGeo, this.mat.hash);
    this.ptMesh.frustumCulled = false;
    this.ptScene.clear();
    this.ptScene.add(this.ptMesh);
  }

  // ---------------------------------------------------------------------------------------------- render meshes
  _initLODMeshes() {
    const S = this.assets.starling;
    this.lods = [];
    this.vatTex = {};
    for (let l = 0; l < 4; l++) {
      const A = S[LOD_NAMES[l]] || makeStandInStarling(LOD_NAMES[l]);
      const v = A.meta.verts;
      const vp = new THREE.DataTexture(A.vatPos, v, 34, THREE.RGBAFormat, THREE.HalfFloatType);
      const vn = new THREE.DataTexture(A.vatNrm, v, 34, THREE.RGBAFormat, THREE.UnsignedByteType);
      for (const t of [vp, vn]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; }
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(new THREE.BufferAttribute(A.index, 1));
      const vid = new Float32Array(v); for (let i = 0; i < v; i++) vid[i] = i;
      geo.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
      geo.setAttribute('uv', new THREE.BufferAttribute(A.uv, 2));
      geo.boundingSphere = new THREE.Sphere(new V3(), 1e6);
      const lodU = {
        tPos: { value: null }, tVel: { value: null }, tState: { value: null }, tTrack: { value: null },
        tVatPos: { value: vp }, tVatNrm: { value: vn },
        tAlbedo: { value: A.albedo }, tMask: { value: A.mask }, tNormal: { value: A.normal },
        uAlbBody: { value: new V3(...A.meta.albedoLinear.body) }, uAlbWing: { value: new V3(...A.meta.albedoLinear.wing) },
        uLodTint: { value: new V3(...LODVIZ_TINT[l]) },
        uTrackMode: { value: 0 }, uPxPerM: { value: 1000 }, uMinPx: this.U.uMinPx, uAlphaPow: this.U.uAlphaPow, uSpanM: { value: SPAN_M },
        uLead: this.U.uLead, uRes: this.U.uRes, uDilate: this.U.uDilate,
        tDens: { value: null }, uSigma: { value: SIGMA },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: SH.BIRD_VERT, fragmentShader: SH.BIRD_FRAG,
        uniforms: { ...this.lightU, ...lodU, uSize: this.uSizeI, uWind10: this.U.uWind10, uWind80: this.U.uWind80,
          uWind850: this.U.uWind850, uWindDrift: this.U.uWindDrift, uDensOrigin: this.U.uDensOrigin, uDensDim: this.uDensDimI },
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.name = 'starling_' + LOD_NAMES[l];
      if (l === 3) mesh.renderOrder = 10;
      this.object3d.add(mesh);
      this.lods.push({ name: LOD_NAMES[l], asset: A, geo, mat, mesh, verts: v, tris: A.meta.tris, ids: null, count: 0, defKey: '' });
    }
    // pick mesh: the silhouette LOD over every bird (ids 0..N−1), with the min-pixel widening
    const sil = this.lods[2];
    this.pickGeo = new THREE.InstancedBufferGeometry();
    this.pickGeo.setIndex(sil.geo.index);
    this.pickGeo.setAttribute('aVid', sil.geo.attributes.aVid);
    this.pickGeo.setAttribute('uv', sil.geo.attributes.uv);
    this.pickMat = new THREE.ShaderMaterial({ vertexShader: SH.BIRD_VERT, fragmentShader: SH.BIRD_FRAG, side: THREE.DoubleSide,
      uniforms: { ...sil.mat.uniforms, uMinPx: { value: 3.0 } }, defines: { LOD: 2, PICK: 1 } });
    this.pickMesh = new THREE.Mesh(this.pickGeo, this.pickMat);
    this.pickMesh.frustumCulled = false;
    this.pickScene = new THREE.Scene();
    this.pickScene.add(this.pickMesh);
    this.pickRT = new THREE.WebGLRenderTarget(5, 5, { type: THREE.UnsignedByteType, depthBuffer: true });
    this._buildFalconMeshes();
  }

  _resizeLODMeshes() {
    for (const L of this.lods) {
      L.ids = new Float32Array(this.N);
      const a = new THREE.InstancedBufferAttribute(L.ids, 1);
      a.setUsage(THREE.DynamicDrawUsage);
      if (L.geo.attributes.aBird) L.geo.deleteAttribute('aBird');
      L.geo.setAttribute('aBird', a);
      L.geo._maxInstanceCount = undefined;
      L.geo.instanceCount = 0; L.count = 0; L.mesh.visible = false;
      L.mat.uniforms.tTrack.value = this.trackTex;
    }
    if (this.pickGeo.attributes.aBird) this.pickGeo.deleteAttribute('aBird');
    this.pickGeo.setAttribute('aBird', new THREE.InstancedBufferAttribute(this.idArray, 1));
    this.pickGeo._maxInstanceCount = undefined;
    this.pickGeo.instanceCount = this.N;
    this.pickMat.uniforms.tTrack.value = this.trackTex;
  }

  _syncDefines() {
    const fx = this.state.fx || {};
    const on = (k) => !!fx[k];
    for (let l = 0; l < 4; l++) {
      const L = this.lods[l];
      const d = { LOD: l };
      if (l <= 1 && L.asset.albedo) d.TEXTURED = 1;
      if (l === 0) d.SMOOTH_NRM = 1;
      if (l === 0 && on('flock.normalMapLOD0') && L.asset.normal) d.NORMALMAP = 1;
      if (l <= 1 && on('flock.iridescence') && L.asset.mask) d.IRID = 1;
      if (on('flock.wingTransmit')) d.TRANSMIT = 1;
      if (on('flock.selfShadow')) d.SELFSHADOW = 1;
      if (on('flock.aerial')) d.AERIAL = 1;
      if (l === 3 && on('flock.minPixel')) d.MINPIXEL = 1;
      if (l === 2) d.DILATE = 1;          // silhouette LOD: thin wings dilated too (see BIRD_VERT)
      if (this.lodvizOn) d.LODVIZ = 1;
      const key = JSON.stringify(d);
      if (key === L.defKey) continue;
      L.defKey = key;
      L.mat.defines = d;
      const premul = !!d.MINPIXEL;
      L.mat.transparent = premul;
      L.mat.depthWrite = !premul;
      L.mat.blending = premul ? THREE.CustomBlending : THREE.NoBlending;
      if (premul) { L.mat.blendSrc = THREE.OneFactor; L.mat.blendDst = THREE.OneMinusSrcAlphaFactor; L.mat.blendEquation = THREE.AddEquation;
        L.mat.blendSrcAlpha = THREE.OneFactor; L.mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; }
      L.mat.needsUpdate = true;
    }
    const fd = { FALCON: 1, LOD: 1 };
    if (on('flock.aerial')) fd.AERIAL = 1;
    const fk = JSON.stringify(fd);
    if (this.falconVat && fk !== this.falconVat.defKey) {
      this.falconVat.defKey = fk; this.falconVat.mat.defines = fd; this.falconVat.mat.needsUpdate = true;
      for (const m of this.falconSkinMats) { m.defines = on('flock.aerial') ? { AERIAL: 1 } : {}; m.needsUpdate = true; }
    }
  }

  // ---------------------------------------------------------------------------------------------- spawn
  reset(seed = 1) {
    const N = this.N, W = this.W, H = this.H;
    const rnd = mulberry32((seed * 2654435761) >>> 0 || 1);
    const P = this.state.flock.params;
    const heading = rnd() * Math.PI * 2;
    const raw = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      let x, y, z;
      do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1);
      raw[i * 3] = x * 60; raw[i * 3 + 1] = 75 + y * 15; raw[i * 3 + 2] = z * 40;
    }
    // Morton-sort so that index neighbours are spatial neighbours (seeds the topological lists)
    const code = new Uint32Array(N), order = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      const qx = Math.floor((raw[i * 3] + 60) / 120 * 1023), qy = Math.floor((raw[i * 3 + 1] - 60) / 30 * 1023), qz = Math.floor((raw[i * 3 + 2] + 40) / 80 * 1023);
      code[i] = (part1by2(qx) | (part1by2(qy) << 1) | (part1by2(qz) << 2)) >>> 0;
      order[i] = i;
    }
    order.sort((a, b) => code[a] - code[b]);
    const pos = new Float32Array(N * 4), vel = new Float32Array(N * 4), st = new Float32Array(N * 4);
    const nA = new Float32Array(N * 4), nB = new Float32Array(N * 4);
    const wind = this.state.wind ? this.state.wind.v80 : new V3();
    const drift = P.windDrift;
    for (let k = 0; k < N; k++) {
      const i = order[k];
      pos[k * 4] = raw[i * 3]; pos[k * 4 + 1] = raw[i * 3 + 1]; pos[k * 4 + 2] = raw[i * 3 + 2]; pos[k * 4 + 3] = rnd();
      const h = heading + (rnd() * 2 - 1) * 20 * DEG, s = P.v0 * (0.95 + 0.1 * rnd());
      vel[k * 4] = Math.sin(h) * s + wind.x * drift; vel[k * 4 + 1] = (rnd() - 0.5) * 0.5; vel[k * 4 + 2] = -Math.cos(h) * s + wind.z * drift; vel[k * 4 + 3] = 0;
      st[k * 4] = 0; st[k * 4 + 1] = 0; st[k * 4 + 2] = (3 + 6 * rnd()) / 13.3; st[k * 4 + 3] = -1e4;
      const nb = [k - 1, k + 1, k - 2, k + 2, k - 3, k + 3, k - 4, k + 4].map((j) => (j >= 0 && j < N ? j : (j < 0 ? k + 5 - j : k - 5 - (j - N)) % N));
      for (let s2 = 0; s2 < 4; s2++) { nA[k * 4 + s2] = nb[s2]; nB[k * 4 + s2] = nb[s2 + 4]; }
    }
    const up = (arr, rt) => {
      const t = new THREE.DataTexture(arr, W, H, THREE.RGBAFormat, THREE.FloatType);
      t.needsUpdate = true;
      this._copy(t, rt);
      t.dispose();
    };
    for (let b = 0; b < 2; b++) {
      up(pos, this.rt.pos[b]); up(vel, this.rt.vel[b]); up(st, this.rt.st[b]);
    }
    // MRT: write A and B through a two-output copy
    const tA = new THREE.DataTexture(nA, W, H, THREE.RGBAFormat, THREE.FloatType); tA.needsUpdate = true;
    const tB = new THREE.DataTexture(nB, W, H, THREE.RGBAFormat, THREE.FloatType); tB.needsUpdate = true;
    if (!this.mat.copy2) this.mat.copy2 = rawMat(SH.FS_VERT, `precision highp float; uniform sampler2D tA, tB; layout(location=0) out vec4 oA; layout(location=1) out vec4 oB;
      void main(){ ivec2 c = ivec2(gl_FragCoord.xy); oA = texelFetch(tA, c, 0); oB = texelFetch(tB, c, 0); }`, { tA: { value: null }, tB: { value: null } });
    this.mat.copy2.uniforms.tA.value = tA; this.mat.copy2.uniforms.tB.value = tB;
    for (let b = 0; b < 2; b++) this._pass(this.mat.copy2, this.rt.nbr[b]);
    tA.dispose(); tB.dispose();
    this.t = 0; this.frame = 0;
    this.lodReady = false;
    this.prevLod.fill(3);
    this.opacValid = false;
    this.extentSmooth = this.state.flock.extent.length();
    this.noiseOff = new V3(seed * 13.17 % 97, seed * 7.31 % 89, seed * 3.77 % 83);
    this.gusts = [];
    this._exciteRay = null; this._spont = -1; this._flash = 0;
    this._resetFalcon(rnd);
    this.state.flock.centroid.set(0, 75, 0);
  }

  // ---------------------------------------------------------------------------------------------- GPU plumbing
  _pass(mat, rt) {
    this.fsMesh.material = mat;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.fsScene, this.fsCam);
  }
  _copy(tex, rt) { this.mat.copy.uniforms.tSrc.value = tex; this._pass(this.mat.copy, rt); }
  _begin() {
    const r = this.renderer;
    this._saved = { rt: r.getRenderTarget(), autoClear: r.autoClear, cc: r.getClearColor(new THREE.Color()), ca: r.getClearAlpha() };
    r.autoClear = false;
  }
  _end() {
    const r = this.renderer, s = this._saved;
    r.setRenderTarget(s.rt); r.autoClear = s.autoClear; r.setClearColor(s.cc, s.ca);
  }
  get texPos() { return this.rt.pos[this.cur.pos].texture; }
  get texVel() { return this.rt.vel[this.cur.vel].texture; }
  get texState() { return this.rt.st[this.cur.st].texture; }
  get texNbrA() { return this.rt.nbr[this.cur.nbr].textures[0]; }
  get texNbrB() { return this.rt.nbr[this.cur.nbr].textures[1]; }
  get texHash() { return this.rt.hash.texture; }
  get texDens() { return this.rt.dens.texture; }
  get texOpacity() { return this.rt.opac.texture; }
  get texLodKey() { return this.rt.lod.texture; }
  get texSub() { return this.rt.sub.texture; }

  // ---------------------------------------------------------------------------------------------- per-step uniforms
  _syncParams(dt) {
    const S = this.state, P = S.flock.params, nz = S.noise || {};
    const U = this.U;
    U.uWind10.value.copy(S.wind.v10); U.uWind80.value.copy(S.wind.v80); U.uWind850.value.copy(S.wind.v850);
    U.uWindDrift.value = P.windDrift;
    // pulsing preset (SPEC §4.3 rule 11)
    let opT = nz.opacityTarget ?? 0.35, curl = nz.curl ?? 1;
    if (nz.pulse) { opT *= 1 + 0.35 * Math.sin(2 * Math.PI * this.t / 9); curl *= 1 + 0.5 * Math.sin(2 * Math.PI * this.t / 13); }
    // compaction under a patrolling falcon
    let cohMul = 1;
    const F = this.falc;
    if (F.state !== 'off' && (F.state === 'patrol' || F.state === 'select') && F.pos.distanceTo(S.flock.centroid) < 80 + S.flock.extent.length() * 0.5) {
      cohMul = 1.5; opT += 0.06;
    }
    // scale-free: the noise wavelength follows the flock extent (smoothed, τ = 5 s)
    const ext = Math.max(20, S.flock.extent.length());
    this.extentSmooth += (ext - this.extentSmooth) * Math.min(1, dt / 5);
    const lambda = Math.max(25, (nz.scale ?? 0.5) * this.extentSmooth);
    // advect the noise field with the wind at the flock's height, and let it evolve
    const wy = S.flock.centroid.y;
    const w = this._windProfile(wy, this._w || (this._w = new V3()));
    this.noiseOff.addScaledVector(w, -dt / lambda);
    const ev = (nz.evolve ?? 0.05) * dt;
    this.noiseOff.x += 0.37 * ev; this.noiseOff.y += 0.61 * ev; this.noiseOff.z += 0.29 * ev;
    const mv = this.mat.vel.uniforms, ms = this.mat.st.uniforms, mp = this.mat.pos.uniforms;
    mv.uP0.value.set(P.v0, P.vMin, P.vMax, P.speedNoise);
    mv.uP1.value.set(P.wAlign, P.wCohesion * cohMul, P.rSep, P.wSep);
    mv.uP2.value.set(P.wOpacity, opT, P.wLevel, P.wRoost);
    mv.uP3.value.set(P.roostRadius, P.altMin, P.altMax, P.altK);
    mv.uP4.value.set(P.maxLatG, P.agitatedLatG, P.rollRate, P.maxBankDeg * DEG);
    mv.uP5.value.set(P.excitedDur, P.bankPulseDeg * DEG, P.speedBoost, P.fleeRadius);
    mv.uP6.value.set(curl, 1 / lambda, nz.octaves ?? 3, nz.wander ?? 0.4);
    // long-range visual attraction for birds beyond the opacity grid's reach (stand-in for seeing the main flock):
    // nominal radius ∝ N^(1/3) (40 m at 30,720 birds), so a split flock is still pulled together
    // pull only true stragglers: beyond 2.5x the flock's median radius (never a fixed 40 m, which balled the flock)
    mv.uP7.value.set(P.centrality ?? 0, P.centroidPull ?? 3, Math.max(30, 2.5 * (this.rMed || 30)), P.wFlat ?? 0.015);
    // large-scale steering (wheeling): amplitudes from noise.turn, rates from noise.turnHz, phases from the seed
    {
      const sd = nz.seed ?? 1, r = mulberry32(((sd + 977) * 2654435761) >>> 0);
      if (this._steerSeed !== sd) { this._steerSeed = sd; this._steerRnd = [r(), r(), r(), r(), r(), r(), r()]; }
      const R = this._steerRnd, A = nz.turn ?? 1.4, hz = nz.turnHz ?? 0.06, w = 2 * Math.PI * hz;
      mv.uSteerA.value.set(A * 0.6, A * 0.3, A * 0.15, (R[4] < 0.5 ? -1 : 1) * 0.35 * w);
      mv.uSteerW.value.set(w, w * 1.73, w * 2.9, w * 1.3);
      mv.uSteerP.value.set(R[0] * 6.283, R[1] * 6.283, R[2] * 6.283, R[3] * 6.283);
      const ax = R[5] * 6.283 + 0.05 * this.t;
      mv.uSteerX.value.set(Math.cos(ax), Math.sin(ax), nz.steer ?? 0.5, 14);
      mv.uSteerV.value.set(3.5, R[6] * 6.283);
    }
    mv.uCentroid.value.copy(S.flock.centroid);
    mv.uNoiseOff.value.copy(this.noiseOff);
    mv.uSeed.value = nz.seed ?? 1;
    mv.uFlashR.value = P.flashRadius;
    ms.uW0.value.set(P.waveDelay, P.excitedDur, P.refractory, P.pProp);
    ms.uF0.value.set(P.flapHz, P.flapHzPerMs, P.glideShare, P.boundShare);
    ms.uF1.value.set(P.boutBeats[0], P.boutBeats[1], P.pauseSec[0], P.pauseSec[1]);
    ms.uDetect.value = P.detectRadius;
    mp.uF0.value.copy(ms.uF0.value);
    mp.uExDur.value = P.excitedDur;
    const tm = this.t % 4096;
    for (const m of [mv, ms]) { m.uDt.value = dt; m.uTime.value = this.t; m.uTimeMod.value = tm; }
    mp.uDt.value = dt; mp.uTimeMod.value = tm;
    // gusts
    for (let i = 0; i < 2; i++) {
      const g = this.gusts[i];
      if (g) { U.uGustA.value[i].set(g.c.x, g.c.y, g.c.z, g.r); U.uGustB.value[i].set(g.v.x, g.v.y, g.v.z, Math.sin(Math.PI * Math.min(1, g.age / g.life))); }
      else { U.uGustA.value[i].set(0, 0, 0, 0); U.uGustB.value[i].set(0, 0, 0, 0); }
    }
    // falcon → sim
    const active = F.state !== 'off' ? 1 : 0;
    mv.uPred.value.set(F.pos.x, F.pos.y, F.pos.z, active);
    mv.uPredVel.value.set(F.vel.x, F.vel.y, F.vel.z, 0);
    const threat = active && (F.state === 'stoop' || F.state === 'strike' || F.state === 'pullout') ? 1 : 0;
    ms.uPred.value.set(F.pos.x, F.pos.y, F.pos.z, threat);
    mv.uFlash.value.set(F.pos.x, F.pos.y, F.pos.z, this._flash ? P.flashImpulse : 0);
    this._flash = 0;
    // seeds: excite ray, spontaneous wave
    if (this._exciteRay && this._exciteRay.steps > 0) {
      const e = this._exciteRay;
      ms.uExRayO.value.set(e.o.x, e.o.y, e.o.z, 1); ms.uExRayD.value.set(e.d.x, e.d.y, e.d.z, e.t0);
      mv.uWaveOrigin.value.copy(e.origin);
      e.steps--;
    } else ms.uExRayO.value.w = 0;
    ms.uSpont.value = this._spont; this._spont = -1;
    if (threat) mv.uWaveOrigin.value.copy(F.pos);
  }

  _windProfile(y, out) {
    const S = this.state.wind;
    y = Math.max(y, 0);
    if (y < 10) return out.copy(S.v10);
    if (y < 80) return out.copy(S.v10).lerp(S.v80, Math.log(y / 10) / Math.log(8));
    return out.copy(S.v80).lerp(S.v850, Math.min(1, (y - 80) / 1420));
  }

  _spawnGust() {
    const S = this.state, c = S.flock.centroid;
    const w = this._windProfile(c.y, new V3());
    const ws = w.length();
    const dir = ws > 0.3 ? w.clone().normalize() : new V3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    const a = (Math.random() * 2 - 1) * 30 * DEG;
    const gd = new V3(dir.x * Math.cos(a) - dir.z * Math.sin(a), 0, dir.x * Math.sin(a) + dir.z * Math.cos(a));
    const speed = 4 + 6 * Math.random();
    const start = c.clone().addScaledVector(dir, -(80 + 0.5 * S.flock.extent.x));
    start.y = c.y + (Math.random() - 0.5) * 30;
    if (this.gusts.length >= 2) this.gusts.shift();
    this.gusts.push({ c: start, v: gd.multiplyScalar(speed), move: dir.clone().multiplyScalar(Math.max(ws, 6)), r: 80, age: 0, life: 6 });
  }

  _cpuStep(dt) {
    const S = this.state, nz = S.noise || {};
    // gusts: spawn at gustRate/min, travel at the wind speed, live 6 s
    if ((nz.gustRate || 0) > 0 && Math.random() < nz.gustRate / 60 * dt) this._spawnGust();
    for (const g of this.gusts) { g.age += dt; g.c.addScaledVector(g.move, dt); }
    this.gusts = this.gusts.filter((g) => g.age < g.life);
    // spontaneous agitation waves at a peripheral bird
    if ((nz.waveRate || 0) > 0 && this.subData && Math.random() < nz.waveRate / 60 * dt) {
      const id = this._peripheralBird();
      if (id >= 0) {
        this._spont = id;
        const p = this._subPos(id === -1 ? 0 : this._lastPeriSlot);
        const c = S.flock.centroid;
        this.mat.vel.uniforms.uWaveOrigin.value.copy(p).add(p.clone().sub(c).setLength(10));
      }
    }
    this._falconStep(dt);
  }

  _peripheralBird() {
    const c = this.state.flock.centroid; let best = -1, bd = -1;
    for (let k = 0; k < 16; k++) {
      const j = Math.floor(Math.random() * 255);
      const d = this._subPos(j, this._tmpA || (this._tmpA = new V3())).distanceToSquared(c);
      if (d > bd) { bd = d; best = j; }
    }
    this._lastPeriSlot = best;
    return best < 0 ? -1 : best * this.subStride;
  }
  _subPos(j, out = new V3()) { const d = this.subData; return out.set(d[j * 4], d[j * 4 + 1], d[j * 4 + 2]); }
  _subVel(j, out = new V3()) { const d = this.subData, o = (SUB_N + j) * 4; return out.set(d[o], d[o + 1], d[o + 2]); }

  // ---------------------------------------------------------------------------------------------- the step
  update(dt, camera) {
    dt = Math.min(Math.max(dt, 1e-4), 1 / 30);
    const q = this.state.preset || {};
    const gk = (q.hash || 512) + ':' + (q.dens || [64, 64, 32, 6]).join(',');
    if (gk !== this.grid.key) { this._allocGrid(); this._buildSimMaterials(); }
    this.prof.begin('flock.sim');
    this._cpuStep(dt);
    this._syncParams(dt);
    const r = this.renderer, M = this.mat, rt = this.rt, c = this.cur;
    this._begin();
    // grid placement: centred on the centroid, snapped to the cell
    const g = this.grid, cc = this.state.flock.centroid;
    const sn = (v) => Math.round(v / g.cell) * g.cell;
    this.U.uDensOrigin.value.set(sn(cc.x) - g.nx * g.cell / 2, sn(cc.y) - g.ny * g.cell / 2, sn(cc.z) - g.nz * g.cell / 2, g.cell);
    const pos = this.texPos, vel = this.texVel;
    // 1 hash scatter (last writer wins, 0 = empty)
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(rt.hash); r.clear(true, false, false);
    M.hash.uniforms.tPos.value = pos;
    this.ptMesh.material = M.hash;
    r.render(this.ptScene, this.fsCam);
    // 2 density scatter (additive)
    r.setRenderTarget(rt.dens); r.clear(true, false, false);
    M.dens.uniforms.tPos.value = pos; M.dens.uniforms.tVel.value = vel;
    this.ptMesh.material = M.dens;
    r.render(this.ptScene, this.fsCam);
    const opEvery = q.opacityEvery || 2, nbEvery = q.nbrEvery || 1;
    if (!this.opacValid || this.frame % opEvery === 0) {
      M.opac.uniforms.tDens.value = rt.dens.texture;
      this._pass(M.opac, rt.opac);
      this.opacValid = true;
    }
    // 3 neighbours (nearest-neighbour descent)
    if (this.frame % nbEvery === 0) {
      const u = M.nbr.uniforms;
      u.tPos.value = pos; u.tNbrA.value = this.texNbrA; u.tNbrB.value = this.texNbrB; u.tHash.value = rt.hash.texture;
      u.uFrame.value = this.frame;
      this._pass(M.nbr, rt.nbr[1 - c.nbr]); c.nbr = 1 - c.nbr;
    }
    const nA = this.texNbrA, nB = this.texNbrB;
    // 4 velocity
    let u = M.vel.uniforms;
    u.tPos.value = pos; u.tVel.value = vel; u.tState.value = this.texState; u.tNbrA.value = nA; u.tNbrB.value = nB; u.tOpac.value = rt.opac.texture;
    this._pass(M.vel, rt.vel[1 - c.vel]); c.vel = 1 - c.vel;
    // 5 state
    u = M.st.uniforms;
    u.tPos.value = pos; u.tVel.value = this.texVel; u.tState.value = this.texState; u.tNbrA.value = nA; u.tNbrB.value = nB;
    this._pass(M.st, rt.st[1 - c.st]); c.st = 1 - c.st;
    // 6 position + phase
    u = M.pos.uniforms;
    u.tPos.value = pos; u.tVel.value = this.texVel; u.tState.value = this.texState;
    this._pass(M.pos, rt.pos[1 - c.pos]); c.pos = 1 - c.pos;
    this._end();
    this.t += dt; this.frame++;
    this.prof.end();
    this._falconRender(dt, camera);
  }

  // ---------------------------------------------------------------------------------------------- LOD
  setRenderSize(w, h) { this.renderW = w; this.renderH = h; this.U.uRes.value.set(w, h); }

  updateLOD(camera) {
    if (!camera) return;
    this.prof.begin('flock.lodkey');
    const r = this.renderer;
    this._syncDefines();
    camera.updateMatrixWorld();
    const h = this.renderH || r.getDrawingBufferSize(this._dbs || (this._dbs = new THREE.Vector2())).y;
    const tanY = Math.tan(camera.fov * DEG / 2), tanX = tanY * camera.aspect;
    const pxPerM = h / (2 * tanY);
    this.pxPerM = pxPerM;
    this._begin();
    const lu = this.mat.lod.uniforms;
    lu.tPos.value = this.texPos; lu.uView.value.copy(camera.matrixWorldInverse);
    lu.uCam.value.set(tanX, tanY, camera.near, camera.far); lu.uPxPerM.value = pxPerM;
    this._pass(this.mat.lod, this.rt.lod);
    const su = this.mat.sub.uniforms;
    this.subStride = Math.max(1, Math.floor(this.N / SUB_N));
    su.tPos.value = this.texPos; su.tVel.value = this.texVel; su.tState.value = this.texState;
    su.uStride.value = this.subStride; su.uTarget.value = this.falc.targetId;
    this._pass(this.mat.sub, this.rt.sub);
    this._end();
    // readbacks (async; 1–3 frames late)
    if (!this.lodReady) {
      r.readRenderTargetPixels(this.rt.lod, 0, 0, this.W / 4, this.H, this.lodCodes);
      this._bucket(this.lodCodes);
      this.lodReady = true;
    } else if (!this.lodBusy && r.readRenderTargetPixelsAsync) {
      this.lodBusy = true;
      const N = this.N, buf = this._lodBuf && this._lodBuf.length === N ? this._lodBuf : (this._lodBuf = new Uint8Array(N));
      r.readRenderTargetPixelsAsync(this.rt.lod, 0, 0, this.W / 4, this.H, buf).then(() => {
        this.lodBusy = false;
        if (N === this.N) this._bucket(buf);
      }).catch(() => { this.lodBusy = false; });
    }
    if (!this.subBusy && r.readRenderTargetPixelsAsync) {
      this.subBusy = true;
      const buf = this.subBuf, N = this.N, tI = this.t;   // stamp the sample with the sim time it was taken at
      r.readRenderTargetPixelsAsync(this.rt.sub, 0, 0, SUB_N, 3, buf).then(() => {
        this.subBusy = false;
        if (N === this.N) this._onSub(buf, tI);
      }).catch(() => { this.subBusy = false; });
    }
    // render uniforms
    const fx = this.state.fx || {};
    for (const L of this.lods) {
      const U = L.mat.uniforms;
      U.tPos.value = this.texPos; U.tVel.value = this.texVel; U.tState.value = this.texState;
      U.uPxPerM.value = pxPerM; U.tDens.value = this.rt.dens.texture;
      U.uTrackMode.value = this.stampMode === 'tracked' ? 1 : 0;
    }
    const pu = this.pickMat.uniforms;
    pu.tPos.value = this.texPos; pu.tVel.value = this.texVel; pu.tState.value = this.texState; pu.uPxPerM.value = pxPerM;
    this.prof.end();
  }

  _bucket(codes) {
    const t0 = performance.now();
    const q = this.state.preset || { lodCap: [24, 3000, Infinity, Infinity], lodPx: [160, 24, 5] };
    const fx = this.state.fx || {};
    const caps = q.lodCap.slice(), px = q.lodPx;
    if (!fx['flock.lod0']) caps[0] = 0;
    const N = this.N;
    // counting sort by code, walking from 255 down
    const hist = this._hist || (this._hist = new Uint32Array(257));
    hist.fill(0);
    for (let i = 0; i < N; i++) hist[codes[i]]++;
    // span thresholds in code units: span > T  ⇔  code > 32·log2(T+1)
    const thr = px.map((p) => 32 * Math.log2(p + 1));
    const thrH = px.map((p) => 32 * Math.log2(0.9 * p + 1));
    const cnt = [0, 0, 0, 0];
    const ids = this.lods.map((L) => L.ids);
    const prev = this.prevLod;
    // counting sort by code (255 → 1); birds too small for LOD0–2 go straight to micro
    const minFine = Math.min(thrH[2], thr[2]);
    const start = this._start || (this._start = new Uint32Array(257));
    let acc = 0;
    for (let c = 255; c >= 1; c--) { start[c] = acc; if (c > minFine) acc += hist[c]; }
    const nFine = acc;
    const order = this._order && this._order.length === N ? this._order : (this._order = new Uint32Array(N));
    for (let i = 0; i < N; i++) {
      const c = codes[i];
      if (c === 0) { prev[i] = 3; continue; }
      if (c > minFine) order[start[c]++] = i; else { ids[3][cnt[3]++] = i; prev[i] = 3; }
    }
    const inFrustum = N - hist[0];
    for (let k = 0; k < nFine; k++) {
      const i = order[k], c = codes[i], p = prev[i];
      let l = 3;
      for (let L = 0; L < 3; L++) {
        const t = p <= L ? thrH[L] : thr[L];
        if (c > t && cnt[L] < caps[L]) { l = L; break; }
      }
      ids[l][cnt[l]++] = i; prev[i] = l;
    }
    for (let l = 0; l < 4; l++) {
      const L = this.lods[l], a = L.geo.attributes.aBird;
      L.count = cnt[l];
      L.geo.instanceCount = cnt[l];
      L.mesh.visible = cnt[l] > 0;
      a.clearUpdateRanges();
      if (cnt[l]) { a.addUpdateRange(0, cnt[l]); a.needsUpdate = true; }
    }
    const st = this.state.flock.stats;
    st.lodCounts = cnt.slice();
    this.inFrustum = inFrustum;
    this.bucketMs = performance.now() - t0;
  }

  _onSub(buf, tI) {
    this.subData = buf.slice();
    this.subT = tI ?? this.t;
    const S = this.state.flock, d = this.subData;
    const n = SUB_N - 1;
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0, px = 0, py = 0, pz = 0;
    const sp = [];
    let flap = 0, glide = 0, bound = 0, exc = 0;
    const tm = this.t % 4096, exDur = S.params.excitedDur;
    for (let j = 0; j < n; j++) {
      cx += d[j * 4]; cy += d[j * 4 + 1]; cz += d[j * 4 + 2];
      const o = (SUB_N + j) * 4, x = d[o], y = d[o + 1], z = d[o + 2];
      vx += x; vy += y; vz += z;
      const s = Math.hypot(x, y, z) || 1; px += x / s; py += y / s; pz += z / s; sp.push(s);
      const so = (2 * SUB_N + j) * 4;
      if (d[so] >= 0.5) glide++; else if (d[so + 1] >= 0.5) bound++; else flap++;
      const tEx = d[so + 3];
      if (tEx > -1000) { let a = tm - tEx; if (a < -1) a += 4096; if (a >= 0 && a <= exDur) exc++; }
    }
    cx /= n; cy /= n; cz /= n;
    let sx = 0, sy = 0, sz = 0;
    for (let j = 0; j < n; j++) { sx += (d[j * 4] - cx) ** 2; sy += (d[j * 4 + 1] - cy) ** 2; sz += (d[j * 4 + 2] - cz) ** 2; }
    const k = 2 * Math.sqrt(5);   // full width of a uniform ellipsoid = 2√5 σ
    S.centroid.set(cx, cy, cz);
    S.extent.set(k * Math.sqrt(sx / n), k * Math.sqrt(sy / n), k * Math.sqrt(sz / n));
    S.velocity.set(vx / n, vy / n, vz / n);
    sp.sort((a, b) => a - b);
    const rr = [];
    for (let j = 0; j < n; j++) rr.push(Math.hypot(d[j * 4] - cx, d[j * 4 + 1] - cy, d[j * 4 + 2] - cz));
    rr.sort((a, b) => a - b);
    this.rMed = rr[n >> 1];
    S.stats.polarization = Math.hypot(px, py, pz) / n;
    S.stats.medianSpeed = sp[n >> 1];
    S.stats.flap = flap / n; S.stats.glide = glide / n; S.stats.bound = bound / n; S.stats.excited = exc / n;
    // falcon target (slot 255)
    if (this.falc.targetId >= 0) {
      this.falc.tgtPos.set(d[255 * 4], d[255 * 4 + 1], d[255 * 4 + 2]);
      const o = (SUB_N + 255) * 4; this.falc.tgtVel.set(d[o], d[o + 1], d[o + 2]);
      this.falc.tgtT = this.t;
    }
  }

  // ---------------------------------------------------------------------------------------------- modes / input
  setStampMode(m) { this.stampMode = m === 'tracked' ? 'tracked' : 'all'; this._applyFalconTrack(); }
  setTracked(ids) {
    if (ids === 'all') { this.trackData.fill(255); this.trackFalcon = true; }
    else {
      this.trackData.fill(0); this.trackFalcon = false;
      for (const id of (ids || []).slice(0, 65)) {
        if (id === -2) this.trackFalcon = true;
        else if (id >= 0 && id < this.N) this.trackData[id] = 255;
      }
    }
    this.trackTex.needsUpdate = true;
    this._applyFalconTrack();
  }
  _applyFalconTrack() { this.falconHiddenByTrack = this.stampMode === 'tracked' && !this.trackFalcon; }

  excite(origin, dir) {
    const o = origin.clone(), d = dir.clone().normalize();
    // the flock begins where the ray first passes within 15 m of a sampled bird
    let t0 = Infinity;
    if (this.subData) {
      const p = new V3();
      for (let j = 0; j < SUB_N - 1; j++) {
        this._subPos(j, p).sub(o);
        const t = p.dot(d);
        if (t > 0 && p.addScaledVector(d, -t).length() < 15) t0 = Math.min(t0, t);
      }
    }
    if (!isFinite(t0)) t0 = Math.max(0, this.state.flock.centroid.clone().sub(o).dot(d) - 30);
    t0 = Math.max(0, t0 - 10);
    this._exciteRay = { o, d, t0, steps: 2, origin: o.clone().addScaledVector(d, t0) };
  }
  gust() { this._spawnGust(); }
  attack() { if (this.falc.state !== 'off') this._falconSelect(); }

  // ---------------------------------------------------------------------------------------------- falcon agent (SPEC §4.7)
  _buildFalconAgent() {
    this.falc = { state: 'off', pos: new V3(0, 250, 0), vel: new V3(13, 0, 0), air: new V3(13, 0, 0), t: 0, phase: 0, hz: 4.5,
      bout: 0, gliding: false, nextAttack: 60, targetId: -1, tgtPos: new V3(), tgtVel: new V3(), tgtT: 0, theta: 0, alt: 115,
      roll: 0, pitch: 0, latA: new V3(), minDist: Infinity, peak: 0, stoops: 0, log: [], w: { flap: 1, glide: 0, stoop: 0, flare: 0 } };
  }
  _resetFalcon(rnd) {
    const F = this.falc, S = this.state;
    F.alt = 100 + 50 * rnd();          // review: patrol 100–150 m above the flock, so the stoop is steep
    F.theta = rnd() * Math.PI * 2;
    F.log = []; F.stoops = 0; F.targetId = -1;
    const en = S.falcon ? S.falcon.enabled !== false : true;
    const c = this._patrolCentre(new V3());
    F.pos.set(c.x + Math.cos(F.theta) * 70, c.y, c.z + Math.sin(F.theta) * 70);
    F.air.set(-Math.sin(F.theta), 0, Math.cos(F.theta)).multiplyScalar(13);
    F.vel.copy(F.air);
    this._setFalconState(en ? 'patrol' : 'off');
    F.nextAttack = this._attackDelay();
  }
  _attackDelay() { const a = (this.state.falcon && this.state.falcon.attackEverySec) || [45, 90]; return a[0] + Math.random() * (a[1] - a[0]); }
  _patrolCentre(out) {
    const S = this.state, c = S.flock.centroid;
    const w = this._windProfile(c.y, new V3());
    const up = w.lengthSq() > 0.01 ? w.normalize().negate() : new V3(1, 0, 0);
    return out.copy(c).addScaledVector(up, 60).setY(c.y + this.falc.alt);
  }
  _setFalconState(s) {
    const F = this.falc;
    if (F.state !== s) F.log.push({ s, t: +this.t.toFixed(2) });
    if (F.log.length > 64) F.log.shift();
    F.state = s; F.t = 0;
    if (this.state.falcon) this.state.falcon.state = s;
  }
  _falconSelect() {
    const F = this.falc;
    if (!this.subData) return;
    // review fix: a bird on the main body's surface (0.8–1.2 × the median radius from the centre, with neighbours
    // around it, i.e. inside the largest cluster) on the falcon's side, never a far straggler
    const p = new V3(), q = new V3();
    let best = -1, bs = Infinity;
    const c = this.state.flock.centroid, rm = Math.max(5, this.rMed || 20);
    for (let j = 0; j < SUB_N - 1; j++) {
      this._subPos(j, p);
      let dens = 0;
      for (let k = 0; k < SUB_N - 1; k += 3) if (this._subPos(k, q).distanceToSquared(p) < 15 * 15) dens++;
      const rr = p.distanceTo(c) / rm;
      const score = p.distanceTo(F.pos) + 60 * Math.max(0, Math.abs(rr - 1) - 0.2) + (dens < 3 ? 200 : 0);
      if (score < bs) { bs = score; best = j; }
    }
    F.targetId = best * this.subStride;
    this._subPos(best, F.tgtPos); this._subVel(best, F.tgtVel); F.tgtT = this.t;
    F.minDist = Infinity; F.peak = 0; F.waveSeeded = false;
    this._setFalconState('select');
  }
  _falconStep(dt) {
    const F = this.falc, S = this.state, P = S.flock.params;
    const en = S.falcon ? S.falcon.enabled !== false : true;
    if (!en) { if (F.state !== 'off') this._setFalconState('off'); this._exportFalcon(); return; }
    if (F.state === 'off') { this._resetFalcon(Math.random); }
    F.t += dt;
    const wind = this._windProfile(F.pos.y, new V3());
    const air = F.air;
    let speed = air.length() || 1;
    const fwd = air.clone().divideScalar(speed);
    const acc = new V3();
    const tgt = F.tgtPos.clone().addScaledVector(F.tgtVel, this.t - F.tgtT);
    switch (F.state) {
      case 'patrol': {
        const c = this._patrolCentre(new V3());
        const rel = F.pos.clone().sub(c);
        const rh = Math.hypot(rel.x, rel.z) || 1;
        const tang = new V3(-rel.z / rh, 0, rel.x / rh);
        const want = tang.multiplyScalar(13).addScaledVector(new V3(rel.x / rh, 0, rel.z / rh), -(rh - 70) * 0.08);
        want.y = (c.y - F.pos.y) * 0.15;
        want.setLength(13);
        acc.copy(want).sub(air).multiplyScalar(0.8);
        // flap bouts of 6–12 beats at 4.5 Hz, alternating with 2–5 s glides
        F.bout -= dt;
        if (F.bout <= 0) { F.gliding = !F.gliding; F.bout = F.gliding ? 2 + 3 * Math.random() : (6 + 6 * Math.random()) / 4.5; }
        F.hz = 4.5;
        const auto = S.falcon ? S.falcon.autoAttack !== false : true;
        if (auto) { F.nextAttack -= dt; if (F.nextAttack <= 0) { F.nextAttack = this._attackDelay(); this._falconSelect(); } }
        break;
      }
      case 'select': {
        // the tucked stoop starts only once the line to the target is steeper than 35°; until then the falcon
        // closes in level, high above (a real peregrine climbs to height and waits on)
        const r = tgt.clone().sub(F.pos), rh2 = Math.hypot(r.x, r.z);
        const dive = Math.atan2(-r.y, rh2);
        const d = new V3(r.x, 0, r.z).normalize().multiplyScalar(13);
        if (F.pos.y < tgt.y + 60) d.y = 4;
        acc.copy(d).sub(air).multiplyScalar(1.2);
        if ((F.t > 0.6 && dive > 35 * DEG) || F.t > 8) { this._setFalconState('stoop'); F.stoops++; }
        break;
      }
      case 'stoop': {
        // proportional navigation (N = 3) plus a pursuit term while the heading error is large
        const r = tgt.clone().sub(F.pos);
        const vr = F.tgtVel.clone().sub(F.vel);
        const rl = r.length();
        const om = r.clone().cross(vr).divideScalar(Math.max(rl * rl, 1));
        const vc = -r.dot(vr) / Math.max(rl, 1e-3);
        const rh = r.clone().divideScalar(Math.max(rl, 1e-3));
        acc.copy(om).cross(rh).multiplyScalar(3 * Math.max(vc, 5));
        const err = 1 - fwd.dot(rh);
        acc.addScaledVector(rh.clone().multiplyScalar(speed).sub(air), Math.min(3, err * 6));
        acc.addScaledVector(fwd, -acc.dot(fwd));
        const lim = 3 * G; if (acc.length() > lim) acc.setLength(lim);
        const dive = Math.asin(Math.max(-1, Math.min(1, -fwd.y)));
        speed = Math.min(45, speed + (8 + G * Math.sin(dive)) * dt);
        F.peak = Math.max(F.peak, speed);
        F.minDist = Math.min(F.minDist, rl);
        // within ~30 m of the flock's surface: the nearest bird panics and seeds an agitation wave across the flock
        if (!F.waveSeeded && this.subData) {
          let bj = -1, bd = Infinity; const p = new V3();
          for (let j = 0; j < SUB_N - 1; j++) { const dd = this._subPos(j, p).distanceToSquared(F.pos); if (dd < bd) { bd = dd; bj = j; } }
          if (bj >= 0 && bd < 30 * 30) {
            F.waveSeeded = true;
            this._spont = bj * this.subStride;
            this.mat.vel.uniforms.uWaveOrigin.value.copy(this._subPos(bj, p));
          }
        }
        if (rl < 3 || (vc < 0 && rl < 20) || F.t > 9) { this._setFalconState('strike'); this._flash = 1; F.strikeDist = rl; }
        break;
      }
      case 'strike': {
        F.minDist = Math.min(F.minDist, tgt.distanceTo(F.pos));
        if (F.t > 0.15) this._setFalconState('pullout');
        break;
      }
      case 'pullout': {
        const right = fwd.clone().cross(new V3(0, 1, 0)).normalize();
        const up = right.clone().cross(fwd);
        acc.copy(up).multiplyScalar(2.5 * G);
        speed += (20 - speed) * Math.min(1, dt / 0.25);
        if (F.t > 0.5) { this._setFalconState('climb'); F.targetId = -1; }
        break;
      }
      case 'climb': {
        const c = this._patrolCentre(new V3());
        const d = c.clone().sub(F.pos); d.y = 0; d.normalize();
        const want = d.multiplyScalar(Math.cos(15 * DEG) * 12); want.y = Math.sin(15 * DEG) * 12;
        acc.copy(want).sub(air).multiplyScalar(1.0);
        speed += (12 - speed) * Math.min(1, dt / 1.5);
        F.hz = 4.8;
        if (F.pos.y >= c.y - 5) { this._setFalconState('patrol'); F.gliding = false; F.bout = 2; }
        break;
      }
    }
    // integrate (air velocity, then ground = air + wind)
    if (F.state === 'patrol' || F.state === 'select' || F.state === 'climb') {
      air.addScaledVector(acc, dt);
      if (F.state !== 'climb') air.setLength(13); else air.setLength(Math.max(speed, 10));
    } else {
      air.addScaledVector(acc, dt).setLength(speed);
    }
    F.vel.copy(air).add(wind);
    F.pos.addScaledVector(F.vel, dt);
    // bank from lateral acceleration
    const nf = air.clone().normalize();
    const right = nf.clone().cross(new V3(0, 1, 0)); if (right.lengthSq() < 1e-6) right.set(1, 0, 0); right.normalize();
    const targetRoll = Math.atan(acc.dot(right) / G);
    F.roll += Math.max(-4 * dt, Math.min(4 * dt, targetRoll - F.roll));
    // pose weights (crossfade 0.25 s; 0.4 s into the stoop)
    const W = { flap: 0, glide: 0, stoop: 0, flare: 0 };
    let pitch = 0;
    if (F.state === 'patrol') { if (F.gliding) W.glide = 1; else W.flap = 1; }
    else if (F.state === 'select') W.glide = 1;
    else if (F.state === 'stoop') {
      const d = tgt.distanceTo(F.pos);
      if (d < 25) { W.stoop = 0.6; W.glide = 0.4; } else W.stoop = 1;
    } else if (F.state === 'strike' || F.state === 'pullout') { W.flare = 1; pitch = 25 * DEG; }
    else if (F.state === 'climb') W.flap = 1;
    const tau = F.state === 'stoop' ? 0.4 : 0.25;
    for (const k in W) F.w[k] += (W[k] - F.w[k]) * Math.min(1, dt / tau);
    F.pitch += (pitch - F.pitch) * Math.min(1, dt / 0.2);
    if (W.flap || F.w.flap > 0.05) F.phase = (F.phase + F.hz * dt) % 1;
    this._exportFalcon();
  }
  _exportFalcon() {
    const F = this.falc, s = this.state.falcon;
    if (!s) return;
    s.state = F.state; s.pos.copy(F.pos); s.vel.copy(F.vel); s.targetId = F.targetId; s.speed = F.air.length();
  }

  _buildFalconMeshes() {
    // stand-in: the retro starling VAT scaled to a 1.0 m span, slate flat colour (until peregrine GLBs exist)
    const A = this.lods[1];
    const mat = new THREE.ShaderMaterial({
      vertexShader: SH.BIRD_VERT, fragmentShader: SH.BIRD_FRAG, side: THREE.DoubleSide,
      uniforms: { ...this.lightU, tPos: { value: null }, tVel: { value: null }, tState: { value: null }, tTrack: { value: null },
        tVatPos: A.mat.uniforms.tVatPos, tVatNrm: A.mat.uniforms.tVatNrm, tAlbedo: { value: null }, tMask: { value: null }, tNormal: { value: null },
        uAlbBody: { value: new V3(0.075, 0.08, 0.09) }, uAlbWing: { value: new V3(0.06, 0.065, 0.075) }, uLodTint: { value: new V3(1, 0, 1) },
        uTrackMode: { value: 0 }, uPxPerM: { value: 1000 }, uMinPx: { value: 2 }, uAlphaPow: { value: 2 }, uSpanM: { value: 1.0 }, uSize: this.uSizeI,
        uWind10: this.U.uWind10, uWind80: this.U.uWind80, uWind850: this.U.uWind850, uWindDrift: this.U.uWindDrift,
        uFPos: { value: new V3() }, uFFwd: { value: new V3(0, 0, 1) }, uFRoll: { value: 0 }, uFPhase: { value: 0 }, uFGlide: { value: 0 },
        uFBound: { value: 0 }, uFScale: { value: 1.0 / 0.342 }, uFPitch: { value: 0 }, tDens: { value: null }, uSigma: { value: SIGMA },
        uDensOrigin: this.U.uDensOrigin, uDensDim: this.uDensDimI },
      defines: { FALCON: 1, LOD: 1 },
    });
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(A.geo.index); geo.setAttribute('aVid', A.geo.attributes.aVid); geo.setAttribute('uv', A.geo.attributes.uv);
    geo.instanceCount = 1;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.name = 'falcon_standin';
    this.object3d.add(mesh);
    this.falconVat = { mesh, mat, defKey: '' };
    // pick twin
    const pm = new THREE.ShaderMaterial({ vertexShader: SH.BIRD_VERT, fragmentShader: SH.BIRD_FRAG, side: THREE.DoubleSide,
      uniforms: { ...mat.uniforms, uMinPx: { value: 3 } }, defines: { FALCON: 1, LOD: 1, PICK: 1 } });
    this.falconPick = new THREE.Mesh(geo, pm); this.falconPick.frustumCulled = false;
    this.pickScene.add(this.falconPick);
    // GLB peregrines (SkinnedMesh + AnimationMixer), when present
    this.falconSkinMats = [];
    this.falconGLB = {};
    for (const v of ['real', 'retro']) {
      const g = this.assets.falcon && this.assets.falcon[v];
      if (!g) continue;
      const root = g.scene;
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        const map = o.material && o.material.map;
        const m = new THREE.ShaderMaterial({ vertexShader: SH.FALCON_SKIN_VERT, fragmentShader: SH.FALCON_SKIN_FRAG, side: THREE.DoubleSide,
          uniforms: { ...this.lightU, tAlbedo: { value: map || null }, uHasMap: { value: map ? 1 : 0 }, uAlb: { value: new V3(0.08, 0.085, 0.095) } } });
        o.material = m; this.falconSkinMats.push(m);
      });
      const holder = new THREE.Group(); holder.add(root); holder.visible = false;
      this.object3d.add(holder);
      const mixer = new THREE.AnimationMixer(root);
      const acts = {};
      for (const clip of g.animations || []) {
        const a = mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); acts[clip.name] = a;
      }
      this.falconGLB[v] = { holder, mixer, acts };
    }
  }

  _falconRender(dt, camera) {
    const F = this.falc;
    const vis = F.state !== 'off' && !this.falconHiddenByTrack;
    const fwd = F.air.clone().normalize();
    const usingGLB = this.falconGLB.real || this.falconGLB.retro;
    let span = 0;
    if (camera) span = 1.0 * (this.pxPerM || 1000) / Math.max(0.1, F.pos.distanceTo(camera.position));
    if (usingGLB) {
      const useReal = this.falconGLB.real && (this.state.fx || {})['falcon.real'] && span > 100;
      const pick = useReal ? this.falconGLB.real : (this.falconGLB.retro || this.falconGLB.real);
      for (const k of ['real', 'retro']) if (this.falconGLB[k]) this.falconGLB[k].holder.visible = vis && this.falconGLB[k] === pick;
      this.falconVat.mesh.visible = false;
      const h = pick.holder;
      h.position.copy(F.pos);
      const right = fwd.clone().cross(new V3(0, 1, 0)); if (right.lengthSq() < 1e-6) right.set(1, 0, 0); right.normalize();
      let up = right.clone().cross(fwd);
      const cp = Math.cos(F.pitch), sp = Math.sin(F.pitch);
      const f2 = fwd.clone().multiplyScalar(cp).addScaledVector(up, sp); up = up.multiplyScalar(cp).addScaledVector(fwd, -sp);
      const cr = Math.cos(F.roll), sr = Math.sin(F.roll);
      const R = right.clone().multiplyScalar(cr).addScaledVector(up, -sr), U = up.clone().multiplyScalar(cr).addScaledVector(right, sr);
      h.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(R.clone().negate(), U, f2));
      for (const k of ['real', 'retro']) {
        const G2 = this.falconGLB[k]; if (!G2) continue;
        for (const [name, a] of Object.entries(G2.acts)) a.setEffectiveWeight(F.w[name] || 0);
        if (G2.acts.flap) G2.acts.flap.timeScale = F.hz;
        G2.mixer.update(dt);
      }
    } else {
      const m = this.falconVat;
      m.mesh.visible = vis;
      const u = m.mat.uniforms;
      u.uFPos.value.copy(F.pos); u.uFFwd.value.copy(fwd); u.uFRoll.value = F.roll; u.uFPhase.value = F.phase;
      u.uFGlide.value = F.w.glide + 0.6 * F.w.flare; u.uFBound.value = F.w.stoop; u.uFPitch.value = F.pitch;
      u.uPxPerM.value = this.pxPerM || 1000;
    }
    this.falconPick.visible = vis;
  }

  // ---------------------------------------------------------------------------------------------- pick
  pick(ndcX, ndcY, camera) {
    this.prof.begin('flock.pick');
    const r = this.renderer;
    const dbs = r.getDrawingBufferSize(new THREE.Vector2());
    const W = this.renderW || dbs.x, H = this.renderH || dbs.y;
    const cam = camera.clone();
    const px = (ndcX * 0.5 + 0.5) * W, py = (0.5 - ndcY * 0.5) * H;
    cam.setViewOffset(W, H, px - 2.5, py - 2.5, 5, 5);
    cam.updateProjectionMatrix();
    const pu = this.pickMat.uniforms;
    pu.tPos.value = this.texPos; pu.tVel.value = this.texVel; pu.tState.value = this.texState;
    pu.uPxPerM.value = H / (2 * Math.tan(camera.fov * DEG / 2));
    this.falconPick.material.uniforms.uPxPerM.value = pu.uPxPerM.value;
    this._begin();
    r.setRenderTarget(this.pickRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.pickScene, cam);
    this._end();
    const buf = new Uint8Array(5 * 5 * 4);
    this.prof.end();
    const done = () => {
      let best = -1, bd = 1e9;
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
        const o = (y * 5 + x) * 4;
        const v = buf[o] + buf[o + 1] * 256 + buf[o + 2] * 65536;
        if (!v) continue;
        const d = (x - 2) ** 2 + (y - 2) ** 2;
        if (d < bd) { bd = d; best = v === 0xffffff ? -2 : v - 1; }
      }
      return best;
    };
    if (r.readRenderTargetPixelsAsync) return r.readRenderTargetPixelsAsync(this.pickRT, 0, 0, 5, 5, buf).then(done);
    r.readRenderTargetPixels(this.pickRT, 0, 0, 5, 5, buf);
    return Promise.resolve(done());
  }

  // ---------------------------------------------------------------------------------------------- debug (SPEC §4.1)
  async _read(rt, w, h, tex) {
    const r = this.renderer;
    let src = rt;
    if (tex) { this._begin(); this._copy(tex, this.rt.tmp); this._end(); src = this.rt.tmp; }
    const buf = new Float32Array(w * h * 4);
    if (r.readRenderTargetPixelsAsync) await r.readRenderTargetPixelsAsync(src, 0, 0, w, h, buf);
    else r.readRenderTargetPixels(src, 0, 0, w, h, buf);
    return buf;
  }
  _makeDebug() {
    const self = this;
    return {
      async readAll() {
        const W = self.W, H = self.H;
        const pos = await self._read(self.rt.pos[self.cur.pos], W, H);
        const vel = await self._read(self.rt.vel[self.cur.vel], W, H);
        const state = await self._read(self.rt.st[self.cur.st], W, H);
        const nA = await self._read(null, W, H, self.texNbrA);
        const nB = await self._read(null, W, H, self.texNbrB);
        const nbr = new Float32Array(self.N * 8);
        for (let i = 0; i < self.N; i++) for (let k = 0; k < 4; k++) { nbr[i * 8 + k] = nA[i * 4 + k]; nbr[i * 8 + 4 + k] = nB[i * 4 + k]; }
        return { pos, vel, state, nbr, N: self.N, t: self.t };
      },
      async knnAccuracy(n = 512) {
        const { pos, nbr, N } = await this.readAll();
        let hit = 0, tot = 0;
        const d2 = new Float64Array(N);
        for (let s = 0; s < n; s++) {
          const i = Math.floor(Math.random() * N);
          const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
          const best = [];   // 7 nearest (brute force)
          for (let j = 0; j < N; j++) {
            if (j === i) continue;
            const dx = pos[j * 4] - x, dy = pos[j * 4 + 1] - y, dz = pos[j * 4 + 2] - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (best.length < 7 || d < best[6][0]) {
              best.push([d, j]); best.sort((a, b) => a[0] - b[0]); if (best.length > 7) best.pop();
            }
          }
          const slots = new Set(Array.from(nbr.subarray(i * 8, i * 8 + 8)).map((v) => Math.round(v)));
          for (const [, j] of best) { tot++; if (slots.has(j)) hit++; }
        }
        return hit / tot;
      },
      async polarization() {
        const { vel, N } = await this.readAll();
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < N; i++) { const s = Math.hypot(vel[i * 4], vel[i * 4 + 1], vel[i * 4 + 2]) || 1; x += vel[i * 4] / s; y += vel[i * 4 + 1] / s; z += vel[i * 4 + 2] / s; }
        return Math.hypot(x, y, z) / N;
      },
      async speeds() {
        const { vel, N } = await this.readAll();
        const w = new V3(); const s = [];
        const pos = await self._read(self.rt.pos[self.cur.pos], self.W, self.H);
        for (let i = 0; i < N; i++) {
          self._windProfile(pos[i * 4 + 1], w).multiplyScalar(self.state.flock.params.windDrift);
          s.push(Math.hypot(vel[i * 4] - w.x, vel[i * 4 + 1] - w.y, vel[i * 4 + 2] - w.z));
        }
        s.sort((a, b) => a - b);
        const q = (p) => +s[Math.min(N - 1, Math.floor(p * N))].toFixed(2);
        return { p01: q(0.01), median: q(0.5), p99: q(0.99) };
      },
      async corrLength(nS = 2048) {
        const { pos, vel, N } = await this.readAll();
        const idx = []; for (let k = 0; k < nS; k++) idx.push(Math.floor(Math.random() * N));
        let mx = 0, my = 0, mz = 0;
        for (const i of idx) { mx += vel[i * 4]; my += vel[i * 4 + 1]; mz += vel[i * 4 + 2]; }
        mx /= nS; my /= nS; mz /= nS;
        const u = idx.map((i) => [vel[i * 4] - mx, vel[i * 4 + 1] - my, vel[i * 4 + 2] - mz]);
        let L = 0;
        const B = 60, sum = new Float64Array(B), cnt = new Float64Array(B);
        const pairs = [];
        for (let a = 0; a < nS; a++) for (let b = a + 1; b < nS; b++) {
          const i = idx[a], j = idx[b];
          const r = Math.hypot(pos[i * 4] - pos[j * 4], pos[i * 4 + 1] - pos[j * 4 + 1], pos[i * 4 + 2] - pos[j * 4 + 2]);
          if (r > L) L = r;
        }
        const dr = L / B;
        for (let a = 0; a < nS; a++) for (let b = a + 1; b < nS; b++) {
          const i = idx[a], j = idx[b];
          const r = Math.hypot(pos[i * 4] - pos[j * 4], pos[i * 4 + 1] - pos[j * 4 + 1], pos[i * 4 + 2] - pos[j * 4 + 2]);
          const k = Math.min(B - 1, Math.floor(r / dr));
          sum[k] += u[a][0] * u[b][0] + u[a][1] * u[b][1] + u[a][2] * u[b][2]; cnt[k]++;
        }
        const C = Array.from(sum).map((s, k) => (cnt[k] ? s / cnt[k] : 0));
        let xi = L;
        for (let k = 1; k < B; k++) if (C[k - 1] > 0 && C[k] <= 0) { xi = dr * (k - 1 + C[k - 1] / (C[k - 1] - C[k])) + dr / 2; break; }
        return { xi: +xi.toFixed(2), L: +L.toFixed(2), ratio: +(xi / L).toFixed(3), C: C.map((c) => +c.toFixed(3)) };
      },
      async stateFractions() {
        const { state, N } = await this.readAll();
        let f = 0, g = 0, b = 0, e = 0;
        const tm = self.t % 4096, dur = self.state.flock.params.excitedDur;
        for (let i = 0; i < N; i++) {
          if (state[i * 4] >= 0.5) g++; else if (state[i * 4 + 1] >= 0.5) b++; else f++;
          const t = state[i * 4 + 3]; if (t > -1000) { let a = tm - t; if (a < -1) a += 4096; if (a >= 0 && a <= dur) e++; }
        }
        return { flap: f / N, glide: g / N, bound: b / N, excited: e / N };
      },
      // Agitation wave from an edge bird: front speed, band thickness and decay. Steps the sim itself (the
      // caller must pause its own loop); `step(dt)` lets the caller run the full frame (update + updateLOD).
      async waveSpeed(step) {
        step = step || ((dt) => self.update(dt));
        const saved = self.state.noise.waveRate; self.state.noise.waveRate = 0;
        let { pos, N } = await this.readAll();
        let cx = 0, cy = 0, cz = 0; for (let i = 0; i < N; i++) { cx += pos[i * 4]; cy += pos[i * 4 + 1]; cz += pos[i * 4 + 2]; }
        cx /= N; cy /= N; cz /= N;
        let seed = 0, bd = -1;
        for (let k = 0; k < 4000; k++) { const i = Math.floor(Math.random() * N); const d = (pos[i * 4] - cx) ** 2 + (pos[i * 4 + 1] - cy) ** 2 + (pos[i * 4 + 2] - cz) ** 2; if (d > bd) { bd = d; seed = i; } }
        // the edge bird nearest the centroid direction (edge, but inside the flock)
        self._spont = seed;
        const sp = new V3(pos[seed * 4], pos[seed * 4 + 1], pos[seed * 4 + 2]);
        self.mat.vel.uniforms.uWaveOrigin.value.copy(sp).add(sp.clone().sub(new V3(cx, cy, cz)).setLength(10));
        const samples = [];
        const dt = 1 / 60;
        let t = 0;
        for (let s = 0; s < 12 * 60; s++) {
          step(dt); t += dt;
          if (s % 6 === 5) {
            const R = await this.readAll();
            const sx = R.pos[seed * 4], sy = R.pos[seed * 4 + 1], sz = R.pos[seed * 4 + 2];
            const tm = self.t % 4096, dur = self.state.flock.params.excitedDur;
            const front = [], band = [];
            for (let i = 0; i < N; i++) {
              const te = R.state[i * 4 + 3]; if (te < -1000) continue;
              let a = tm - te; if (a < -1) a += 4096;
              if (a < 0 || a > dur) continue;
              const d = Math.hypot(R.pos[i * 4] - sx, R.pos[i * 4 + 1] - sy, R.pos[i * 4 + 2] - sz);
              band.push(d); if (a < 0.1) front.push(d);
            }
            band.sort((a, b) => a - b); front.sort((a, b) => a - b);
            const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
            samples.push({ t: +t.toFixed(2), excited: band.length, front: +q(front, 0.5).toFixed(2), frontMax: +q(front, 0.9).toFixed(2),
              thick: +(q(band, 0.9) - q(band, 0.1)).toFixed(2), nFront: front.length });
          }
        }
        self.state.noise.waveRate = saved;
        // front speed: slope of the 90th-percentile front radius over the growth phase
        const g = samples.filter((s) => s.nFront > 20 && s.t <= 2.5);
        let speed = 0;
        if (g.length >= 3) {
          const n = g.length, mx = g.reduce((a, s) => a + s.t, 0) / n, my = g.reduce((a, s) => a + s.frontMax, 0) / n;
          speed = g.reduce((a, s) => a + (s.t - mx) * (s.frontMax - my), 0) / g.reduce((a, s) => a + (s.t - mx) ** 2, 0);
        }
        // band thickness: the radial thickness of the shell of birds excited within the last 0.6 s, measured
        // on the front birds (age < 0.1 s) spread plus the run of the shell; report the median over the growth phase
        const th = g.map((s) => s.thick).sort((a, b) => a - b);
        const last = samples[samples.length - 1];
        return { speed: +speed.toFixed(2), thickness: th.length ? th[th.length >> 1] : 0, excitedAtEnd: last.excited, samples };
      },
      // the marginal-opacity field seen by n sampled birds: mean Ō, and how well Σd·O(d) points at the flock centre
      async opacityStats(n = 600) {
        const { pos, N } = await this.readAll();
        const aw = self.rt.opac.width, ah = self.rt.opac.height;
        if (!self._dbgAtlas || self._dbgAtlas.width !== aw || self._dbgAtlas.height !== ah) { if (self._dbgAtlas) self._dbgAtlas.dispose(); self._dbgAtlas = floatRT(aw, ah); }
        self._begin(); self._copy(self.rt.opac.texture, self._dbgAtlas); self._end();
        const op = new Float32Array(aw * ah * 4);
        self.renderer.readRenderTargetPixels(self._dbgAtlas, 0, 0, aw, ah, op);
        self._begin(); self._copy(self.rt.dens.texture, self._dbgAtlas); self._end();
        const de = new Float32Array(aw * ah * 4);
        self.renderer.readRenderTargetPixels(self._dbgAtlas, 0, 0, aw, ah, de);
        const g = self.grid, o = self.U.uDensOrigin.value, c = self.state.flock.centroid;
        let sumO = 0, sumCos = 0, k = 0, maxCount = 0, tot = 0, outside = 0;
        for (let i = 0; i < de.length; i += 4) { maxCount = Math.max(maxCount, de[i + 3]); tot += de[i + 3]; }
        const Os = [];
        for (let s = 0; s < n; s++) {
          const i = Math.floor(Math.random() * N);
          const cx = Math.floor((pos[i * 4] - o.x) / o.w), cy = Math.floor((pos[i * 4 + 1] - o.y) / o.w), cz = Math.floor((pos[i * 4 + 2] - o.z) / o.w);
          if (cx < 0 || cy < 0 || cz < 0 || cx >= g.nx || cy >= g.ny || cz >= g.nz) { outside++; continue; }
          const tx = cx + (cz % g.tilesX) * g.nx, ty = cy + Math.floor(cz / g.tilesX) * g.ny, j = (ty * aw + tx) * 4;
          const d = new V3(op[j], op[j + 1], op[j + 2]), tc = c.clone().sub(new V3(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]));
          sumO += op[j + 3]; Os.push(op[j + 3]); if (d.length() > 1e-4 && tc.length() > 1) sumCos += d.normalize().dot(tc.normalize());
          k++;
        }
        Os.sort((a, b) => a - b);
        return { meanO: +(sumO / k).toFixed(3), p10: +Os[Math.floor(k * 0.1)].toFixed(3), p90: +Os[Math.floor(k * 0.9)].toFixed(3),
          cosToCentre: +(sumCos / k).toFixed(3), outsideGrid: outside / n, maxCellCount: maxCount, scatteredTotal: tot, N };
      },
      // nearest-neighbour distance (slot 0 of the topological list; F1 shows it is the true nearest ≥ 98 %)
      async nnDist() {
        const { pos, nbr, N } = await this.readAll();
        const d = [];
        for (let i = 0; i < N; i += 3) {
          const j = Math.round(nbr[i * 8]); if (j < 0) continue;
          d.push(Math.hypot(pos[i * 4] - pos[j * 4], pos[i * 4 + 1] - pos[j * 4 + 1], pos[i * 4 + 2] - pos[j * 4 + 2]));
        }
        d.sort((a, b) => a - b);
        const m = d[d.length >> 1];
        return { median: +m.toFixed(2), p10: +d[Math.floor(d.length * 0.1)].toFixed(2), p90: +d[Math.floor(d.length * 0.9)].toFixed(2), densityEst: +(0.0554 * 8 / (m ** 3) * 0.9).toFixed(3) };
      },
      lodviz(on) { self.lodvizOn = !!on; self._syncDefines(); },
      falcon() { const F = self.falc; return { state: F.state, log: F.log.slice(), peak: F.peak, minDist: F.minDist, strikeDist: F.strikeDist, stoops: F.stoops, pos: F.pos.toArray(), speed: F.air.length() }; },
      info() { return { N: self.N, W: self.W, H: self.H, t: self.t, frame: self.frame, lodCounts: self.lods.map((L) => L.count), inFrustum: self.inFrustum, bucketMs: self.bucketMs,
        tris: self.lods.reduce((a, L) => a + L.count * L.tris, 0) }; },
    };
  }

  // ---------------------------------------------------------------------------------------------- cleanup
  _disposeSim() {
    if (!this.rt) return;
    for (const v of Object.values(this.rt)) { if (Array.isArray(v)) v.forEach((x) => x.dispose()); else if (v) v.dispose(); }
    if (this.trackTex) this.trackTex.dispose();
    if (this.ptGeo) this.ptGeo.dispose();
    this.rt = {};
  }
  dispose() {
    this._disposeSim();
    for (const m of Object.values(this.mat || {})) m.dispose();
    for (const L of this.lods) { L.geo.dispose(); L.mat.dispose(); L.mat.uniforms.tVatPos.value.dispose(); L.mat.uniforms.tVatNrm.value.dispose(); }
    this.pickGeo.dispose(); this.pickMat.dispose(); this.pickRT.dispose();
    this.falconVat.mat.dispose();
    this.fsMesh.geometry.dispose();
    this.object3d.removeFromParent();
  }
}
