// shaders.js: GLSL for the One Bird game. The starling VAT stage is adapted from src/flock_shaders.js (BIRD_VERT /
// BIRD_FRAG): same murm-vat-1 rows (flap cycle, glide, bound), same model frame (+Z head, +Y back, +X left wing),
// same min-pixel widening for far birds. Bird pose comes from per-instance attributes the CPU flock writes each frame
// (position, orientation quaternion, wing phase / glide / bound) instead of the main page's GPU sim textures.

// shared lighting / haze chunk (colours are linear; the renderer output is sRGB via linearToOutputTexel)
const LIGHT = /* glsl */`
uniform vec3 uSkyUp, uSkyDown, uFogCol, uHorizon, uZenith;
uniform float uFogK;
vec3 hemi(vec3 n) { return mix(uSkyDown, uSkyUp, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)); }
uniform vec3 uSeaHaze; uniform float uHazeMul;
vec3 haze(vec3 col, vec3 wpos) {
  vec3 d = wpos - cameraPosition; float dist = length(d);
  float mu = d.y / max(dist, 1e-3);
  vec3 bg;
  if (mu >= 0.0) bg = mix(uHorizon, uZenith, clamp(mu, 0.0, 1.0));
  else {
    // below the horizon the bird is seen against the sea: haze toward the hazed sea behind it, never brighter
    float ds = max(cameraPosition.y, 0.5) / max(-mu, 1e-3);
    bg = mix(uSeaHaze, uFogCol, 1.0 - exp(-uFogK * 0.75 * ds));
  }
  return mix(col, bg, 1.0 - exp(-uFogK * uHazeMul * dist));
}
`;

export const BIRD_VERT = /* glsl */`
precision highp sampler2D;
uniform sampler2D tVatPos, tVatNrm;
uniform vec3 uVat;               // cycle frames, glide row, bound row
uniform float uPxPerM, uMinPx, uSpanM, uAlphaPow;
uniform vec2 uRes; uniform float uDilate;
attribute float aVid;
attribute vec4 iPos;             // xyz world position, w scale (0 = hidden)
attribute vec4 iQuat;            // model → world rotation
attribute vec4 iAnim;            // wing phase 0..1, glide weight, bound weight, spare
varying vec3 vWPos;
varying vec2 vUv;
varying float vWing;
varying float vAlpha;
varying vec3 vNrm;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  if (iPos.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int vid = int(aVid);
  int nc = int(uVat.x);
  float ph = fract(iAnim.x) * uVat.x; float r0 = floor(ph); float fr = ph - r0;
  int i0 = int(r0) % nc, i1 = (i0 + 1) % nc;
  int rg = int(uVat.y), rb = int(uVat.z);
  vec4 a = texelFetch(tVatPos, ivec2(vid, i0), 0), b = texelFetch(tVatPos, ivec2(vid, i1), 0);
  vec3 lp = mix(a.xyz, b.xyz, fr);
  lp = mix(lp, texelFetch(tVatPos, ivec2(vid, rg), 0).xyz, iAnim.y);
  lp = mix(lp, texelFetch(tVatPos, ivec2(vid, rb), 0).xyz, iAnim.z);
  vWing = a.w;
  float k = 1.0;
#ifdef MINPIXEL
  {
    float z = max(length(iPos.xyz - cameraPosition), 0.05);
    float span = uSpanM * iPos.w * uPxPerM / z;
    k = max(1.0, uMinPx / max(span, 1e-3));
  }
#endif
  vAlpha = pow(k, -uAlphaPow);
  vec3 wp = iPos.xyz + qrot(iQuat, lp * (iPos.w * k));
  vec3 na = texelFetch(tVatNrm, ivec2(vid, i0), 0).xyz * 2.0 - 1.0, nb = texelFetch(tVatNrm, ivec2(vid, i1), 0).xyz * 2.0 - 1.0;
  vec3 ln = mix(na, nb, fr);
  ln = mix(ln, texelFetch(tVatNrm, ivec2(vid, rg), 0).xyz * 2.0 - 1.0, iAnim.y);
  ln = mix(ln, texelFetch(tVatNrm, ivec2(vid, rb), 0).xyz * 2.0 - 1.0, iAnim.z);
  vNrm = qrot(iQuat, ln);
  vWPos = wp;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
#ifdef DILATE
  // far birds: push every vertex uDilate px out from the bird's centre on screen, so sub-pixel wings stay a crisp
  // dark dash instead of averaging to grey under MSAA (as the main page does)
  {
    vec4 cP = projectionMatrix * viewMatrix * vec4(iPos.xyz, 1.0);
    if (cP.w > 0.0 && gl_Position.w > 0.0) {
      vec2 h = 0.5 * uRes;
      vec2 sP = cP.xy / cP.w * h, sW = gl_Position.xy / gl_Position.w * h;
      vec2 dd = sW - sP; float l = length(dd);
      float px = uSpanM * iPos.w * k * uPxPerM / max(cP.w, 0.05);
      float dl = uDilate * (1.0 - smoothstep(10.0, 24.0, px));
      if (l > 1e-3) gl_Position.xy = (sW + dd / l * dl) / h * gl_Position.w;
    }
  }
#endif
}
`;

export const BIRD_FRAG = /* glsl */`
precision highp float;
${LIGHT}
uniform sampler2D tAlbedo, tMask, tNormal;
uniform vec3 uAlbBody, uAlbWing;
uniform float uDark;             // exposure of the bird against the bright sky (silhouette look)
uniform vec3 uGhost; uniform float uGhostA;
varying vec3 vWPos;
varying vec2 vUv;
varying float vWing;
varying float vAlpha;
varying vec3 vNrm;
void main() {
  vec3 V = normalize(cameraPosition - vWPos);
#ifdef SMOOTH_NRM
  vec3 n = normalize(vNrm);
#else
  vec3 n = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
#endif
  if (dot(n, V) < 0.0) n = -n;
#ifdef GHOST
  float rim = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 1.6);
  float al = uGhostA * (0.28 + 0.72 * rim);
  gl_FragColor = vec4(linearToOutputTexel(vec4(uGhost, 1.0)).rgb, al);
  return;
#endif
#ifdef TEXTURED
  vec3 albedo = texture2D(tAlbedo, vUv).rgb;
  vec3 mask = texture2D(tMask, vUv).rgb;
#else
  vec3 albedo = mix(uAlbBody, uAlbWing, vWing);
  vec3 mask = vec3(1.0, 0.7, 0.0);
#endif
#ifdef NORMALMAP
  {
    vec3 dp1 = dFdx(vWPos), dp2 = dFdy(vWPos); vec2 du1 = dFdx(vUv), du2 = dFdy(vUv);
    vec3 dp2p = cross(dp2, n), dp1p = cross(n, dp1);
    vec3 T = dp2p * du1.x + dp1p * du2.x, B = dp2p * du1.y + dp1p * du2.y;
    float im = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
    vec3 tn = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
    n = normalize(mat3(T * im, B * im, n) * tn);
  }
#endif
  vec3 col = albedo * hemi(n) * mask.r * uDark;
#ifdef IRID
  {
    float nv = clamp(dot(n, V), 0.0, 1.0);
    float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    vec3 film = 0.5 + 0.5 * cos(6.2831853 * (1.6 * nv + vec3(0.0, 0.42, 0.18)));   // purple ↔ green sheen
    col += mask.b * F * film * 0.22 * uSkyUp;
    // soft overcast sheen on the plumage, strongest where the back faces the sky
    col += albedo * 0.35 * uSkyUp * pow(max(n.y, 0.0), 3.0) * mask.r;
  }
#endif
  col = haze(col, vWPos);
#ifdef MINPIXEL
  gl_FragColor = vec4(linearToOutputTexel(vec4(col, 1.0)).rgb * vAlpha, vAlpha);
#else
  gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
#endif
}
`;

// sky dome: nearly uniform bright overcast (the project's signature panel), a touch lighter toward the zenith
export const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}
`;
export const SKY_FRAG = /* glsl */`
precision highp float;
uniform vec3 uHorizon, uZenith, uFogCol;
varying vec3 vDir;
float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  vec3 col = d.y >= 0.0 ? mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.7)) : uFogCol;
  vec3 o = linearToOutputTexel(vec4(col, 1.0)).rgb;
  o += (h12(gl_FragCoord.xy) - 0.5) / 255.0;     // dither: the sky is a near-flat field
  gl_FragColor = vec4(o, 1.0);
}
`;

// sea: dark grey-blue water reflecting the overcast, with analytic wind waves fading out with distance
export const SEA_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
export const SEA_FRAG = /* glsl */`
precision highp float;
${LIGHT}
uniform vec3 uDeep, uShallow;
uniform float uTime;
varying vec3 vW;
float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
uniform float uPxPerM;
// wind sea: a dozen directional waves around the wind, each faded once a pixel covers more than a third of its length
// (a cheap mip that keeps the far sea from shimmering into rings)
vec2 waveGrad(vec2 p, float t, float fp) {
  vec2 g = vec2(0.0);
  float lam = 46.0, amp = 0.55, ang = 0.35;
  for (int i = 0; i < 12; i++) {
    vec2 dir = vec2(cos(ang), sin(ang));
    float k = 6.2831853 / lam; float w = sqrt(9.81 * k);
    float f = clamp(1.0 - fp * 3.0 / lam, 0.0, 1.0);
    g += dir * (amp * k * cos(k * dot(dir, p) - w * t + float(i) * 2.399)) * f;
    lam *= 0.68; amp *= 0.66;
    ang += 2.399 * (0.35 + 0.1 * float(i % 3));      // golden-angle spread, biased around the wind
  }
  return g;
}
void main() {
  vec3 dv = vW - cameraPosition;
  float dist = length(dv);
  float graze = max(abs(cameraPosition.y - vW.y) / max(dist, 1e-3), 0.035);
  float fp = dist / uPxPerM / graze;
  vec2 g = waveGrad(vW.xz, uTime, fp);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 V = -dv / max(dist, 1e-3);
  float nv = clamp(dot(n, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = R.y >= 0.0 ? mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.7)) : uHorizon * 0.7;
  // body colour: a little lighter on the wave faces turned toward the sky (overcast upwelling)
  vec3 body = mix(uDeep, uShallow, clamp(0.5 + dot(n.xz, normalize(vec2(0.6, 0.8))) * 4.0, 0.0, 1.0));
  vec3 col = mix(body, sky, fres);
  // aerial haze toward a slightly darker horizon band than the sky, so the sea line reads crisp but soft
  float f = 1.0 - exp(-uFogK * 0.75 * dist);
  col = mix(col, uFogCol, f);
  vec3 o = linearToOutputTexel(vec4(col, 1.0)).rgb;
  o += (h12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(o, 1.0);
}
`;

// guide dots: billboarded round dots along the slot's future path, size in metres
export const DOT_VERT = /* glsl */`
attribute float aA;
attribute float aS;
varying float vA;
uniform float uPxPerM;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(2.0, aS * uPxPerM / max(-mv.z, 0.1));
  vA = aA * smoothstep(1.5, 3.5, gl_PointSize);
}
`;
export const DOT_FRAG = /* glsl */`
precision highp float;
uniform vec3 uCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r = length(c);
  float a = (1.0 - smoothstep(0.62, 1.0, r)) * vA;
  if (a < 0.01) discard;
  // a thin darker rim keeps the dot readable over the pale sky
  vec3 col = mix(uCol, uCol * 0.55, smoothstep(0.45, 0.8, r));
  gl_FragColor = vec4(linearToOutputTexel(vec4(col, 1.0)).rgb, a);
}
`;

// spray droplets (and dust of feather down): soft round points
export const SPRAY_VERT = /* glsl */`
attribute float aA;
attribute float aS;
varying float vA;
uniform float uPxPerM;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aS * uPxPerM / max(-mv.z, 0.1);
  gl_PointSize = clamp(px, 1.5, 12.0);
  // a droplet at the lens would be a huge soft disc: fade those out instead
  vA = aA * clamp(px / 1.5, 0.25, 1.0) * (1.0 - smoothstep(12.0, 30.0, px));
}
`;
export const SPRAY_FRAG = /* glsl */`
precision highp float;
uniform vec3 uCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r = dot(c, c);
  float a = (1.0 - smoothstep(0.3, 1.0, r)) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(linearToOutputTexel(vec4(uCol, 1.0)).rgb, a);
}
`;

// splash / fish-ripple ring on the water: a flat annulus drawn with a soft profile
export const RING_VERT = /* glsl */`
varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
export const RING_FRAG = /* glsl */`
precision highp float;
uniform vec3 uCol; uniform float uA, uR, uW;
varying vec2 vP;
void main() {
  float r = length(vP);
  float a = uA * exp(-pow((r - uR) / uW, 2.0));
  if (a < 0.004) discard;
  gl_FragColor = vec4(linearToOutputTexel(vec4(uCol, 1.0)).rgb, a);
}
`;
