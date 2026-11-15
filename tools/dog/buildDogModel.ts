/**
 * Generates a crude rigged dog model (public/models/dog_main.glb) from the main DogProfile.
 *   npm run dog:build
 *
 * Purpose (Step 3): prove the real-model path end to end — a skinned .glb with named clips that
 * DogVisual loads, scales, orients and animates. The art model (Step 6) replaces this file and must
 * follow the same conventions (see CLAUDE.md "Dog model conventions"):
 *   - 1 unit = 1 m, Y up, the dog faces +Z (glTF convention), origin on the ground under the body
 *   - clips: idle, walk, trot, run, sniff, jump, sit, playBow (locomotion clips = exactly one stride)
 *   - optional extras.dims = { shoulderHeight, length, headTopHeight, chestWidth } as authored
 *
 * Geometry: boxes, each rigidly skinned to one bone, merged into ONE SkinnedMesh (1 draw call).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAIN_DOG } from '../../src/config/dogProfiles';
import { DOG_CLIP_NAMES } from '../../src/dog/clips';

// --- Node polyfill: GLTFExporter uses FileReader to read its Blob output ----------------------
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  onload: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onload?.();
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.();
      this.onloadend?.();
    });
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/models/dog_main.glb');

// --- Proportions (model faces +Z) -------------------------------------------------------------
const { shoulderHeight: H, length: L, headTopHeight: HT, chestWidth: W } = MAIN_DOG.dimensions;
const noseZ = L / 2;
const tailZ = -L / 2;
const chestFront = noseZ - 0.3 * L;
const chestBottom = 0.55 * H;
const waistBottom = 0.7 * H;
const midZ = chestFront - 0.32 * L;
const hipZ = tailZ + 0.1 * L;
const frontZ = chestFront - 0.08 * L;
const legT = 0.28 * W;
const legX = W / 2 - legT / 2;
const frontTop = chestBottom + 0.04;
const hindTop = waistBottom + 0.04;
const skullH = 0.16 * L, skullL = 0.17 * L, skullW = 0.72 * W;
const skullY = HT - skullH / 2;
const skullZ = noseZ - 0.13 * L - skullL / 2;
const neckBaseY = 0.85 * H;

const color = (hex: number): THREE.Color => new THREE.Color().setHex(hex); // linear for vertex colors
const C = MAIN_DOG.colors;
const COAT = color(C.coat), WHITE = color(C.chest), BROWN = color(C.lowerLegs), NOSE = color(C.nose), EYES = color(C.eyes);

// --- Skeleton ---------------------------------------------------------------------------------
interface BoneDef { name: string; parent: string | null; at: [number, number, number] } // world rest position
const BONES: BoneDef[] = [
  { name: 'root', parent: null, at: [0, 0, 0] },
  { name: 'hips', parent: 'root', at: [0, 0.8 * H, hipZ] },
  { name: 'spine', parent: 'hips', at: [0, 0.85 * H, midZ] },
  { name: 'chest', parent: 'spine', at: [0, 0.85 * H, chestFront - 0.08] },
  { name: 'neck', parent: 'chest', at: [0, neckBaseY, chestFront] },
  { name: 'head', parent: 'neck', at: [0, HT - skullH * 0.6, skullZ - skullL / 2] },
  { name: 'tail1', parent: 'hips', at: [0, 0.9 * H, tailZ] },
  { name: 'tail2', parent: 'tail1', at: [0, 0.9 * H, tailZ - 0.12 * L] },
  { name: 'tail3', parent: 'tail2', at: [0, 0.9 * H, tailZ - 0.24 * L] },
];
for (const [s, x] of [['L', -legX], ['R', legX]] as const) {
  BONES.push(
    { name: `upperArm${s}`, parent: 'chest', at: [x, frontTop, frontZ] },
    { name: `foreArm${s}`, parent: `upperArm${s}`, at: [x, frontTop * 0.5, frontZ] },
    { name: `frontPaw${s}`, parent: `foreArm${s}`, at: [x, 0.05, frontZ] },
    { name: `thigh${s}`, parent: 'hips', at: [x, hindTop, hipZ] },
    { name: `shin${s}`, parent: `thigh${s}`, at: [x, hindTop * 0.5, hipZ] },
    { name: `hindPaw${s}`, parent: `shin${s}`, at: [x, 0.05, hipZ] },
  );
}
const boneIndex = new Map(BONES.map((b, i) => [b.name, i]));

// --- Parts: [bone, color, size, center] -------------------------------------------------------
type Part = [string, THREE.Color, [number, number, number], [number, number, number]];
const PARTS: Part[] = [
  // torso: deep chest, tucked waist (front half follows the spine bone, rear half the hips)
  ['chest', COAT, [W, H - chestBottom, chestFront - midZ], [0, (H + chestBottom) / 2, (chestFront + midZ) / 2]],
  ['spine', COAT, [0.8 * W, 0.95 * H - waistBottom, (midZ - tailZ) / 2], [0, (0.95 * H + waistBottom) / 2, midZ - (midZ - tailZ) / 4]],
  ['hips', COAT, [0.82 * W, 0.95 * H - waistBottom, (midZ - tailZ) / 2], [0, (0.95 * H + waistBottom) / 2, tailZ + (midZ - tailZ) / 4]],
  // white tuxedo: chest plate + underside strip + throat
  ['chest', WHITE, [0.78 * W, (H - chestBottom) * 0.9, 0.012], [0, chestBottom + (H - chestBottom) * 0.45, chestFront + 0.006]],
  ['chest', WHITE, [0.7 * W, 0.012, (chestFront - midZ) * 0.7], [0, chestBottom - 0.006, chestFront - (chestFront - midZ) * 0.35]],
  ['neck', COAT, [0.55 * W, HT - neckBaseY, 0.1 * L], [0, (HT + neckBaseY) / 2 - 0.03, chestFront + 0.01]],
  ['neck', WHITE, [0.4 * W, (HT - neckBaseY) * 0.8, 0.012], [0, (HT + neckBaseY) / 2 - 0.05, chestFront + 0.01 + 0.05 * L + 0.006]],
  // head: broad skull, strong snout
  ['head', COAT, [skullW, skullH, skullL], [0, skullY, skullZ]],
  ['head', COAT, [0.62 * skullW, 0.6 * skullH, 0.13 * L], [0, skullY - skullH / 2 + 0.3 * skullH, noseZ - 0.065 * L]],
  ['head', NOSE, [0.32 * skullW, 0.24 * skullH, 0.03], [0, skullY - skullH / 2 + 0.45 * skullH, noseZ + 0.005]],
  ['head', EYES, [0.022, 0.022, 0.01], [-0.28 * skullW, skullY + 0.12 * skullH, skullZ + skullL / 2 + 0.004]],
  ['head', EYES, [0.022, 0.022, 0.01], [0.28 * skullW, skullY + 0.12 * skullH, skullZ + skullL / 2 + 0.004]],
  ['head', COAT, [0.28 * skullW, 0.45 * skullH, 0.02], [-0.36 * skullW, HT + 0.12 * skullH, skullZ - 0.25 * skullL]],
  ['head', COAT, [0.28 * skullW, 0.45 * skullH, 0.02], [0.36 * skullW, HT + 0.12 * skullH, skullZ - 0.25 * skullL]],
  // tail
  ['tail1', COAT, [0.04, 0.04, 0.12 * L], [0, 0.9 * H, tailZ - 0.06 * L]],
  ['tail2', COAT, [0.035, 0.035, 0.12 * L], [0, 0.9 * H, tailZ - 0.18 * L]],
  ['tail3', COAT, [0.03, 0.03, 0.12 * L], [0, 0.9 * H, tailZ - 0.3 * L]],
];
for (const [s, x] of [['L', -legX], ['R', legX]] as const) {
  PARTS.push(
    // front leg: black upper half, brown lower half
    [`upperArm${s}`, COAT, [legT, frontTop * 0.5, legT], [x, frontTop * 0.75, frontZ]],
    [`foreArm${s}`, BROWN, [legT * 0.92, frontTop * 0.5 - 0.04, legT * 0.92], [x, frontTop * 0.25 + 0.02, frontZ]],
    [`frontPaw${s}`, BROWN, [legT * 1.1, 0.05, legT * 1.5], [x, 0.025, frontZ + 0.01]],
    // hind leg: thicker thigh
    [`thigh${s}`, COAT, [legT * 1.3, hindTop * 0.5, legT * 1.4], [x, hindTop * 0.75, hipZ]],
    [`shin${s}`, BROWN, [legT * 0.9, hindTop * 0.5 - 0.04, legT * 0.9], [x, hindTop * 0.25 + 0.02, hipZ]],
    [`hindPaw${s}`, BROWN, [legT * 1.1, 0.05, legT * 1.5], [x, 0.025, hipZ + 0.01]],
  );
}

function buildMesh(): THREE.SkinnedMesh {
  const geoms = PARTS.map(([bone, col, [w, h, d], [cx, cy, cz]]) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    const skinIndex = new Uint16Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    const bi = boneIndex.get(bone);
    if (bi === undefined) throw new Error(`unknown bone ${bone}`);
    for (let k = 0; k < n; k++) {
      colors.set([col.r, col.g, col.b], k * 3);
      skinIndex[k * 4] = bi;
      skinWeight[k * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    g.deleteAttribute('uv');
    return g;
  });
  const geometry = mergeGeometries(geoms);
  if (!geometry) throw new Error('mergeGeometries failed');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, name: 'dog' });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'dogMesh';

  const bones = BONES.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    return bone;
  });
  BONES.forEach((b, i) => {
    const bone = bones[i]!;
    const parentPos = b.parent ? BONES[boneIndex.get(b.parent)!]!.at : [0, 0, 0];
    bone.position.set(b.at[0] - parentPos[0]!, b.at[1] - parentPos[1]!, b.at[2] - parentPos[2]!);
    if (b.parent) bones[boneIndex.get(b.parent)!]!.add(bone);
  });
  mesh.add(bones[0]!);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return mesh;
}

// --- Animation --------------------------------------------------------------------------------
/** Per-bone offsets from the rest pose. Rotations in radians (XYZ euler), positions in meters. */
type Pose = Record<string, { rx?: number; ry?: number; rz?: number; py?: number; pz?: number }>;

/**
 * Sample a pose function into a clip. Conventions (dog faces +Z): positive rx swings a leg BACK and
 * pitches the head/body nose-DOWN; positive rx on the tail RAISES it.
 */
function makeClip(name: string, duration: number, fn: (t: number) => Pose, fps = 30): THREE.AnimationClip {
  const samples = Math.max(2, Math.round(duration * fps) + 1);
  const times: number[] = [];
  const poses: Pose[] = [];
  for (let s = 0; s < samples; s++) {
    const t = (s / (samples - 1)) * duration;
    times.push(t);
    poses.push(fn(t));
  }
  const boneNames = new Set(poses.flatMap((p) => Object.keys(p)));
  const tracks: THREE.KeyframeTrack[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const bn of boneNames) {
    const def = BONES[boneIndex.get(bn)!];
    if (!def) throw new Error(`clip ${name}: unknown bone ${bn}`);
    const quats: number[] = [];
    const pos: number[] = [];
    let hasPos = false;
    const parentPos = def.parent ? BONES[boneIndex.get(def.parent)!]!.at : [0, 0, 0];
    const rest = [def.at[0] - parentPos[0]!, def.at[1] - parentPos[1]!, def.at[2] - parentPos[2]!];
    for (const p of poses) {
      const o = p[bn] ?? {};
      e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
      q.setFromEuler(e);
      quats.push(q.x, q.y, q.z, q.w);
      if (o.py !== undefined || o.pz !== undefined) hasPos = true;
      pos.push(rest[0]!, rest[1]! + (o.py ?? 0), rest[2]! + (o.pz ?? 0));
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bn}.quaternion`, times, quats));
    if (hasPos) tracks.push(new THREE.VectorKeyframeTrack(`${bn}.position`, times, pos));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

const TAU = Math.PI * 2;
const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerpPose = (a: Pose, b: Pose, k: number): Pose => {
  const out: Pose = {};
  for (const bn of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const pa = a[bn] ?? {}, pb = b[bn] ?? {};
    out[bn] = {};
    for (const key of ['rx', 'ry', 'rz', 'py', 'pz'] as const) {
      const va = pa[key] ?? 0, vb = pb[key] ?? 0;
      if (va !== 0 || vb !== 0) out[bn]![key] = va + (vb - va) * k;
    }
  }
  return out;
};

/** One leg's swing at phase φ: upper bone swings ±A, the lower bone folds during the forward swing. */
function leg(pose: Pose, side: 'L' | 'R', front: boolean, phi: number, A: number, B: number): void {
  const upper = A * Math.sin(phi);
  const fold = B * Math.max(0, -Math.cos(phi));
  if (front) {
    pose[`upperArm${side}`] = { rx: upper };
    pose[`foreArm${side}`] = { rx: fold };
    pose[`frontPaw${side}`] = { rx: fold * 0.4 };
  } else {
    pose[`thigh${side}`] = { rx: upper };
    pose[`shin${side}`] = { rx: fold };
    pose[`hindPaw${side}`] = { rx: -fold * 0.3 };
  }
}

/** A gait: per-leg phase offsets (fractions of a stride). One clip = one stride. */
function gait(name: string, duration: number, o: { lf: number; rf: number; lh: number; rh: number },
  A: number, B: number, extra: (th: number, pose: Pose) => void): THREE.AnimationClip {
  return makeClip(name, duration, (t) => {
    const th = (t / duration) * TAU;
    const pose: Pose = {};
    leg(pose, 'L', true, th + o.lf * TAU, A, B);
    leg(pose, 'R', true, th + o.rf * TAU, A, B);
    leg(pose, 'L', false, th + o.lh * TAU, A, B);
    leg(pose, 'R', false, th + o.rh * TAU, A, B);
    extra(th, pose);
    return pose;
  });
}

const TAIL_DOWN = -0.6;

const SIT_POSE: Pose = {
  hips: { rx: -0.55, py: -0.24 }, // body tilts nose-up around the hips, rear drops
  upperArmL: { rx: 0.55 }, upperArmR: { rx: 0.55 }, // keep front legs vertical
  thighL: { rx: -1.35 }, thighR: { rx: -1.35 }, shinL: { rx: 2.0 }, shinR: { rx: 2.0 },
  hindPawL: { rx: -0.6 }, hindPawR: { rx: -0.6 },
  neck: { rx: 0.35 }, // level the head again
  tail1: { rx: 0.35 }, tail2: { rx: -0.1 },
};

const BOW_POSE: Pose = {
  hips: { rx: 0.3, py: 0.02 }, // front end down, rear up
  upperArmL: { rx: -1.15 }, upperArmR: { rx: -1.15 }, // forelegs stretched forward on the ground
  foreArmL: { rx: -0.35 }, foreArmR: { rx: -0.35 },
  thighL: { rx: -0.3 }, thighR: { rx: -0.3 }, // hind legs stay vertical
  neck: { rx: -0.65 }, head: { rx: -0.1 }, // head up, looking at you
  tail1: { rx: 0.7 }, // tail up
};

function buildClips(): THREE.AnimationClip[] {
  const clips = [
    makeClip('idle', 3.0, (t) => {
      const th = (t / 3) * TAU;
      return {
        chest: { rx: 0.015 * Math.sin(th * 2) },
        neck: { rx: -0.05 + 0.04 * Math.sin(th) },
        head: { ry: 0.25 * Math.sin(th) },
        tail1: { rx: TAIL_DOWN + 0.1, ry: 0.45 * Math.sin(th * 6) },
        tail2: { ry: 0.2 * Math.sin(th * 6 - 0.6) },
      };
    }),
    gait('walk', 1.0, { lh: 0, lf: 0.25, rh: 0.5, rf: 0.75 }, 0.32, 0.55, (th, p) => {
      p.hips = { py: 0.008 * Math.cos(th * 2) };
      p.neck = { rx: 0.05 * Math.sin(th * 2) };
      p.tail1 = { rx: TAIL_DOWN, ry: 0.25 * Math.sin(th) };
    }),
    gait('trot', 0.6, { lf: 0, rh: 0, rf: 0.5, lh: 0.5 }, 0.5, 0.8, (th, p) => {
      p.hips = { py: 0.018 * Math.cos(th * 2) };
      p.neck = { rx: 0.06 * Math.sin(th * 2) };
      p.tail1 = { rx: TAIL_DOWN + 0.2, ry: 0.2 * Math.sin(th) };
    }),
    gait('run', 0.5, { lh: 0, rh: 0.1, lf: 0.45, rf: 0.55 }, 0.85, 1.0, (th, p) => {
      p.hips = { py: 0.04 * Math.sin(th) };
      p.spine = { rx: 0.12 * Math.sin(th) }; // back flexes and extends
      p.chest = { rx: -0.08 * Math.sin(th) };
      p.neck = { rx: 0.2 - 0.1 * Math.sin(th) }; // head low and forward
      p.tail1 = { rx: -0.15, ry: 0.08 * Math.sin(th) }; // tail streams back
    }),
    makeClip('sniff', 1.2, (t) => {
      const th = (t / 1.2) * TAU;
      return {
        neck: { rx: 0.85 },
        head: { rx: 0.35 + 0.08 * Math.sin(th * 6), ry: 0.15 * Math.sin(th) },
        upperArmL: { rx: -0.1 }, upperArmR: { rx: -0.1 }, foreArmL: { rx: 0.25 }, foreArmR: { rx: 0.25 },
        hips: { py: -0.02 },
        tail1: { rx: TAIL_DOWN + 0.4, ry: 0.35 * Math.sin(th * 2) },
      };
    }),
    makeClip('jump', 0.5, (t) => {
      const crouch: Pose = {
        hips: { py: -0.06 }, upperArmL: { rx: -0.3 }, upperArmR: { rx: -0.3 }, foreArmL: { rx: 0.6 }, foreArmR: { rx: 0.6 },
        thighL: { rx: -0.4 }, thighR: { rx: -0.4 }, shinL: { rx: 0.7 }, shinR: { rx: 0.7 }, tail1: { rx: TAIL_DOWN },
      };
      const stretch: Pose = {
        upperArmL: { rx: -0.9 }, upperArmR: { rx: -0.9 }, foreArmL: { rx: 0.3 }, foreArmR: { rx: 0.3 },
        thighL: { rx: 0.9 }, thighR: { rx: 0.9 }, shinL: { rx: -0.2 }, shinR: { rx: -0.2 },
        spine: { rx: -0.1 }, neck: { rx: -0.2 }, tail1: { rx: -0.1 },
      };
      const tuck: Pose = {
        upperArmL: { rx: -0.5 }, upperArmR: { rx: -0.5 }, foreArmL: { rx: 0.9 }, foreArmR: { rx: 0.9 },
        thighL: { rx: 0.3 }, thighR: { rx: 0.3 }, shinL: { rx: 0.6 }, shinR: { rx: 0.6 }, tail1: { rx: TAIL_DOWN + 0.2 },
      };
      if (t < 0.1) return lerpPose({}, crouch, smooth(t / 0.1));
      if (t < 0.3) return lerpPose(crouch, stretch, smooth((t - 0.1) / 0.2));
      if (t < 0.42) return lerpPose(stretch, tuck, smooth((t - 0.3) / 0.12));
      return lerpPose(tuck, {}, smooth((t - 0.42) / 0.08));
    }),
    // Held poses loop with a little life in them; the game crossfades into them for the transition.
    makeClip('sit', 2.0, (t) => {
      const th = (t / 2) * TAU;
      const p = lerpPose(SIT_POSE, {}, 0);
      p.chest = { rx: 0.012 * Math.sin(th * 2) };
      p.head = { ry: 0.2 * Math.sin(th) };
      p.tail3 = { ry: 0.25 * Math.sin(th * 4) };
      return p;
    }),
    makeClip('playBow', 1.0, (t) => {
      const th = t * TAU;
      const p = lerpPose(BOW_POSE, {}, 0);
      p.tail1 = { rx: 0.7, ry: 0.6 * Math.sin(th * 4) }; // fast wag
      p.tail2 = { ry: 0.3 * Math.sin(th * 4 - 0.8) };
      p.head = { rx: -0.1, rz: 0.12 * Math.sin(th) }; // playful head tilt
      return p;
    }),
  ];
  const names = clips.map((c) => c.name);
  for (const required of DOG_CLIP_NAMES) {
    if (!names.includes(required)) throw new Error(`missing clip ${required}`);
  }
  return clips;
}

async function main(): Promise<void> {
  const mesh = buildMesh();
  const scene = new THREE.Scene();
  const model = new THREE.Group();
  model.name = 'dog';
  model.userData = {
    dims: { shoulderHeight: H, length: L, headTopHeight: HT, chestWidth: W },
    forward: '+Z',
    generator: 'tools/dog/buildDogModel.ts',
  };
  model.add(mesh);
  scene.add(model);
  const clips = buildClips();

  const exporter = new GLTFExporter();
  const glb = (await exporter.parseAsync(scene, { binary: true, animations: clips })) as ArrayBuffer;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(glb));

  // Verify the written file: read the GLB's JSON chunk back and check skin + clip names.
  const view = new DataView(glb);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen))) as {
    animations?: { name: string }[]; skins?: unknown[];
  };
  const written = (json.animations ?? []).map((a) => a.name);
  const missing = DOG_CLIP_NAMES.filter((n) => !written.includes(n));
  if (missing.length || (json.skins ?? []).length !== 1) {
    throw new Error(`bad export: missing clips ${missing.join(', ')}, skins ${(json.skins ?? []).length}`);
  }
  console.log(`[dog] wrote ${OUT} (${(glb.byteLength / 1024).toFixed(0)} KB): ${BONES.length} bones, ` +
    `${PARTS.length} parts, ${mesh.geometry.getAttribute('position').count} vertices, clips: ${written.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
