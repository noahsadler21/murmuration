// hero.js: the player's feathered starling (starling_hero.glb from the bird realism pass): a skinned glTF with
// moving flight feathers and tail, clips 'flap' (one wingbeat), 'glide' (looping, with feather flutter) and
// 'bound' (wings tucked, looping).
// The flap clip is driven directly by the game's wing phase, so it stays in step with the flap / glide / bound bursts
// (wings.js) and the wing-blur copies; the glide and bound clips run on their own and blend in by their weights
// (an older file without 'bound' uses the glide clip for bounds too).
// Root heave and pitch are not in the clips: the game adds them (bodyAt). Falls back to the VAT hero if it fails.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadHero(url, env) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      // overcast light only, held dark like the flock birds (a starling is near-black against a bright sky)
      m.envMap = env; m.envMapIntensity = 0.5;
      if (m.map) m.map.anisotropy = 16;
      m.needsUpdate = true;
    }
  });
  const mixer = new THREE.AnimationMixer(root);
  const clip = (n) => gltf.animations.find((a) => a.name === n);
  const flapClip = clip('flap'), glideClip = clip('glide'), boundClip = clip('bound');
  if (!flapClip) throw new Error('starling_hero.glb has no flap clip');
  const flap = mixer.clipAction(flapClip); flap.play(); flap.paused = true;
  const glide = glideClip ? mixer.clipAction(glideClip) : null;
  if (glide) glide.play();
  const bound = boundClip ? mixer.clipAction(boundClip) : null;
  if (bound) bound.play();
  return {
    root, mixer, flap, glide, bound, dur: flapClip.duration,
    // place and pose: q is the model → world quaternion (glTF +Z head, +Y back, +X left wing, as the VAT birds)
    update(x, y, z, q, phase, glideW, boundW, dt) {
      root.position.set(x, y, z);
      root.quaternion.set(q[0], q[1], q[2], q[3]);
      const c = (v) => Math.min(1, Math.max(0, v));
      let g = c(glideW), b = c(boundW);
      if (!bound) { g = c(g + b); b = 0; }
      if (!glide) g = 0;
      flap.time = (((phase % 1) + 1) % 1) * this.dur * 0.9999;
      flap.setEffectiveWeight(c(1 - g - b));
      if (glide) glide.setEffectiveWeight(g);
      if (bound) bound.setEffectiveWeight(b);
      mixer.update(dt);
    },
  };
}
