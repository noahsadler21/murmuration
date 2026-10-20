// birds.js: loads the project's murm-vat-1 starlings (assets/birds/, see SPEC.md §6.2 and src/flock.js loadVat) and
// draws them as instanced vertex-animation meshes. Each LOD is one InstancedBufferGeometry whose per-instance
// attributes (position+scale, quaternion, wing phase/glide/bound) the CPU flock fills every frame.
import * as THREE from 'three';
import { BIRD_VERT, BIRD_FRAG } from './shaders.js';

export const LOD_NAMES = ['real', 'retro', 'sil', 'micro'];

export async function loadVat(base, name, texLoader) {
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
    if (!file || !texLoader) return res(null);
    texLoader.load(base + file, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, () => res(null));
  });
  [out.albedo, out.mask, out.normal] = await Promise.all([load(T.albedo, true), load(T.mask, false), load(T.normal, false)]);
  return out;
}

export async function loadStarlings(base, onProgress) {
  const texLoader = new THREE.TextureLoader();
  const out = {};
  let done = 0;
  await Promise.all(LOD_NAMES.map(async (l) => {
    out[l] = await loadVat(base, 'starling_' + l, l === 'real' || l === 'retro' ? texLoader : null);
    done++; if (onProgress) onProgress(done / LOD_NAMES.length);
  }));
  return out;
}

function vatTextures(A) {
  const v = A.meta.verts, rows = A.meta.rows || 34;
  const vp = new THREE.DataTexture(A.vatPos, v, rows, THREE.RGBAFormat, THREE.HalfFloatType);
  const vn = new THREE.DataTexture(A.vatNrm, v, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  for (const t of [vp, vn]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }
  return { vp, vn };
}

// One instanced draw of one LOD. push() writes an instance; end() uploads only the written range.
export class VatLOD {
  constructor(asset, { max, defines = {}, shared, dark = 1, transparent = false, premult = false, renderOrder = 0 }) {
    const A = asset, M = A.meta, v = M.verts;
    if (!asset._tex) asset._tex = vatTextures(A);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(A.index, 1));
    const vid = new Float32Array(v); for (let i = 0; i < v; i++) vid[i] = i;
    geo.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
    geo.setAttribute('uv', new THREE.BufferAttribute(A.uv, 2));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v * 3), 3));   // unused; three wants one
    this.max = max;
    this.pos = new Float32Array(max * 4); this.quat = new Float32Array(max * 4); this.anim = new Float32Array(max * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 4); this.aQuat = new THREE.InstancedBufferAttribute(this.quat, 4);
    this.aAnim = new THREE.InstancedBufferAttribute(this.anim, 4);
    for (const a of [this.aPos, this.aQuat, this.aAnim]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iQuat', this.aQuat); geo.setAttribute('iAnim', this.aAnim);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const d = { ...defines };
    if (d.TEXTURED && !A.albedo) delete d.TEXTURED;
    if (d.NORMALMAP && !A.normal) delete d.NORMALMAP;
    if (d.TEXTURED && !A.mask) delete d.TEXTURED;
    this.uniforms = {
      ...shared,
      tVatPos: { value: A._tex.vp }, tVatNrm: { value: A._tex.vn },
      uVat: { value: new THREE.Vector3(M.cycleFrames || 32, M.rowGlide ?? 32, M.rowBound ?? 33) },
      tAlbedo: { value: A.albedo }, tMask: { value: A.mask }, tNormal: { value: A.normal },
      uAlbBody: { value: new THREE.Vector3(...M.albedoLinear.body) }, uAlbWing: { value: new THREE.Vector3(...M.albedoLinear.wing) },
      uDark: { value: dark },
      uGhost: { value: new THREE.Color(1, 0.5, 0.2) }, uGhostA: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: BIRD_VERT, fragmentShader: BIRD_FRAG, uniforms: this.uniforms, defines: d,
      side: THREE.DoubleSide, transparent: transparent || premult, depthWrite: !transparent });
    if (premult) {
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    this.geo = geo; this.mat = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.n = 0;
  }
  begin() { this.n = 0; }
  push(px, py, pz, s, q, ph, gw, bw) {
    if (this.n >= this.max) return;
    const o = this.n * 4;
    const P = this.pos, Q = this.quat, A = this.anim;
    P[o] = px; P[o + 1] = py; P[o + 2] = pz; P[o + 3] = s;
    Q[o] = q[0]; Q[o + 1] = q[1]; Q[o + 2] = q[2]; Q[o + 3] = q[3];
    A[o] = ph; A[o + 1] = gw; A[o + 2] = bw; A[o + 3] = 0;
    this.n++;
  }
  end() {
    const n = this.n;
    for (const a of [this.aPos, this.aQuat, this.aAnim]) {
      a.clearUpdateRanges();
      if (n > 0) { a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}

// quaternion of the bird model frame (+X left wing, +Y back, +Z head) for forward f, right r, up u (unit, orthogonal)
// written into out[0..3]
export function quatFromBasis(out, fx, fy, fz, rx, ry, rz, ux, uy, uz) {
  // rotation matrix columns: X → −r, Y → u, Z → f
  const m00 = -rx, m10 = -ry, m20 = -rz;
  const m01 = ux, m11 = uy, m21 = uz;
  const m02 = fx, m12 = fy, m22 = fz;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

// forward + roll (radians, + = right wing down) → quaternion, using world up as the reference
export function quatFromFwdRoll(out, fx, fy, fz, roll) {
  // right = normalize(cross(f, +Y)) = (−fz, 0, fx): for f = +Z that is −X, and the model's +X is the left wing
  let rx = -fz, rz = fx;
  let rl = Math.hypot(rx, rz);
  if (rl < 1e-4) { rx = 1; rz = 0; rl = 1; }
  rx /= rl; rz /= rl;
  // up0 = cross(right, f)
  let ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const c = Math.cos(roll), s = Math.sin(roll);
  const Rx = rx * c - ux * s, Ry = -uy * s, Rz = rz * c - uz * s;
  const Ux = ux * c + rx * s, Uy = uy * c, Uz = uz * c + rz * s;
  return quatFromBasis(out, fx, fy, fz, Rx, Ry, Rz, Ux, Uy, Uz);
}
