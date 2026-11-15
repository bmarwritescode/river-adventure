import { PROP_STRIDE, type TileSign } from '../types';
import type { DressContext } from './houses';
import { jitter, pick, rgb, rng, shade, type MeshBuilder, type RGB } from './MeshBuilder';

/**
 * Street props, modelled in their own frame (local −Z = front, y up, 1 unit = 1 m) and stamped into
 * the tile's merged mesh at their placed position/rotation/scale. All low-poly, vertex-colored.
 * Collision: trunks, poles, cars etc. become small obstacles that block the dog (not the camera).
 */

const groundAt = (ctx: DressContext, x: number, z: number): number => (ctx.hm ? ctx.hm.sample(x, z) : 0);

/** Regular n-gon ring (flat x, z) for collision. */
function circleRing(x: number, z: number, r: number, n = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(x + Math.cos(a) * r, z + Math.sin(a) * r);
  }
  return out;
}

/** Rotated rectangle ring: half sizes hx (local X) × hz (local Z), rotation.y = rot. */
function rectRing(x: number, z: number, hx: number, hz: number, rot: number): number[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const out: number[] = [];
  for (const [lx, lz] of [[-hx, hz], [hx, hz], [hx, -hz], [-hx, -hz]] as const) {
    out.push(x + c * lx + s * lz, z - s * lx + c * lz);
  }
  return out;
}

/** Horizontal hexagonal prism along local X (wheels). */
function wheel(mb: MeshBuilder, cx: number, cy: number, cz: number, r: number, w: number, color: RGB, hub: RGB): void {
  const n = 6;
  const x0 = cx - w / 2, x1 = cx + w / 2;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + Math.PI / 6, a1 = ((i + 1) / n) * Math.PI * 2 + Math.PI / 6;
    const y0 = cy + Math.sin(a0) * r, z0 = cz + Math.cos(a0) * r, y1 = cy + Math.sin(a1) * r, z1 = cz + Math.cos(a1) * r;
    mb.quad([x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y0, z0], color);
    mb.tri(x1, cy, cz, x1, y0, z0, x1, y1, z1, hub);
    mb.tri(x0, cy, cz, x0, y1, z1, x0, y0, z0, hub);
  }
}

// --- Trees ------------------------------------------------------------------------------------------

/**
 * Tree crown: `n` small leaf blobs scattered inside an ellipsoid (centre y, radii rh × rv).
 * Many small facets read as foliage; a few big ones read as crystals.
 */
function crown(mb: MeshBuilder, r: () => number, cy: number, rh: number, rv: number, n: number, blobR: number,
  colors: RGB[], variation: number, ox = 0, oz = 0): void {
  for (let i = 0; i < n; i++) {
    // Even-ish spread: random direction, radius biased outward so the silhouette is full.
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(0.15 + 0.85 * r());
    const y = (r() * 2 - 1) * 0.75;
    const x = Math.cos(a) * d * rh * Math.sqrt(1 - y * y * 0.6), z = Math.sin(a) * d * rh * Math.sqrt(1 - y * y * 0.6);
    const br = blobR * (0.8 + r() * 0.4);
    const c = jitter(pick(colors, r()), r(), variation);
    mb.blob(ox + x, cy + y * rv, oz + z, br, br * 0.78, br, y > 0.2 ? shade(c, 1.06) : c, r, 0.12, 0.8);
  }
}

function treeOak(ctx: DressContext, r: () => number): void {
  // Live oak: short trunk splitting low into wide limbs; broad, low, dark crown.
  const mb = ctx.mb, S = ctx.style;
  const bark = rgb(S.bark), leaves = S.oakLeaves.map(rgb);
  const lean = (r() - 0.5) * 0.6;
  mb.cylinder(0, -0.3, 0, 0.42, lean, 2.0, lean * 0.5, 0.32, 6, bark, null);
  const limbs = 3 + Math.floor(r() * 2);
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + r() * 0.8;
    const L = 2.8 + r() * 1.6;
    mb.cylinder(lean, 1.9, lean * 0.5, 0.22, Math.cos(a) * L, 3.7 + r() * 0.8, Math.sin(a) * L, 0.09, 5, bark, null);
  }
  crown(mb, r, 4.9, 5.0, 1.4, 11, 2.0, leaves, S.leafVariation);
  crown(mb, r, 5.9, 2.8, 0.8, 4, 1.8, leaves, S.leafVariation);
}

function treePecan(ctx: DressContext, r: () => number): void {
  // Pecan: tall straight trunk, high oval crown, lighter yellow-green.
  const mb = ctx.mb, S = ctx.style;
  const bark = rgb(S.bark), leaves = S.pecanLeaves.map(rgb);
  mb.cylinder(0, -0.3, 0, 0.36, 0, 5.4, 0, 0.22, 6, shade(bark, 1.1), null);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + r();
    mb.cylinder(0, 4.8, 0, 0.15, Math.cos(a) * 1.9, 7.2, Math.sin(a) * 1.9, 0.07, 4, bark, null);
  }
  crown(mb, r, 8.4, 3.4, 2.6, 11, 1.9, leaves, S.leafVariation);
}

function treeElm(ctx: DressContext, r: () => number): void {
  const mb = ctx.mb, S = ctx.style;
  const bark = rgb(S.bark), leaves = S.elmLeaves.map(rgb);
  mb.cylinder(0, -0.3, 0, 0.28, 0, 3.6, 0, 0.18, 6, bark, null);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + r();
    mb.cylinder(0, 3.2, 0, 0.12, Math.cos(a) * 1.5, 5.0, Math.sin(a) * 1.5, 0.06, 4, bark, null);
  }
  crown(mb, r, 6.0, 3.0, 1.9, 9, 1.7, leaves, S.leafVariation);
}

function treeMyrtle(ctx: DressContext, r: () => number, variant: number): void {
  // Crepe myrtle: several smooth tan trunks, small green crown with flower clusters on top.
  const mb = ctx.mb, S = ctx.style;
  const bark = rgb(S.myrtleBark);
  const flower = rgb(S.myrtleFlowers[variant % S.myrtleFlowers.length]!);
  const leaf = rgb(S.myrtleLeaves);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r();
    mb.cylinder(Math.cos(a) * 0.12, -0.2, Math.sin(a) * 0.12, 0.07, Math.cos(a) * 0.75, 2.5 + r() * 0.4, Math.sin(a) * 0.75, 0.045, 4, bark, null);
  }
  crown(mb, r, 3.1, 1.4, 0.7, 6, 0.75, [leaf], S.leafVariation);
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2, d = r() * 1.3;
    const fr = 0.35 + r() * 0.2;
    mb.blob(Math.cos(a) * d, 3.5 + r() * 0.5, Math.sin(a) * d, fr, fr * 0.8, fr, jitter(flower, r(), 0.08), r, 0.15, 0.85);
  }
}

function shrub(ctx: DressContext, r: () => number): void {
  const mb = ctx.mb, S = ctx.style;
  const c = jitter(rgb(pick(S.shrubLeaves, r())), r(), 0.08);
  mb.blob(0, 0.45, 0, 0.6, 0.5, 0.6, c, r, 0.2, 0.7);
  if (r() < 0.6) mb.blob(0.45, 0.35, 0.1, 0.45, 0.38, 0.45, shade(c, 1.06), r, 0.2, 0.7);
}

// --- Street furniture ---------------------------------------------------------------------------

function pole(ctx: DressContext, variant: number): void {
  const mb = ctx.mb, S = ctx.style;
  const wood = rgb(S.pole), metal = rgb(S.metal);
  mb.cylinder(0, -0.3, 0, 0.17, 0, 10.6, 0, 0.12, 6, wood);
  mb.box(0, 9.55, 0, 0.12, 9.7, 2.4, shade(wood, 0.9), 0, { bottom: true });
  for (const z of [-1.05, 0, 1.05]) mb.box(0, 9.7, z === 0 ? 0 : z, 0.07, 9.92, 0.07, rgb('#b8c4c8'));
  if (variant === 1) {
    // Cobra-head street light reaching over the street (local −Z).
    mb.cylinder(0, 8.0, 0, 0.05, 0, 8.25, -2.3, 0.04, 4, metal);
    mb.box(0, 8.05, -2.55, 0.32, 8.28, 0.7, metal, 0, { bottom: true });
    mb.box(0, 8.02, -2.55, 0.22, 8.05, 0.5, rgb('#f4ecc8'), 0, { bottom: true });
  } else {
    // Transformer can.
    mb.cylinder(0.32, 7.6, 0.0, 0.3, 0.32, 8.6, 0.0, 0.3, 6, shade(metal, 0.9));
  }
}

function hydrant(ctx: DressContext): void {
  const mb = ctx.mb, S = ctx.style;
  const body = rgb(S.hydrant), cap = rgb(S.hydrantCap);
  mb.cylinder(0, -0.1, 0, 0.18, 0, 0.08, 0, 0.18, 8, shade(body, 0.85));
  mb.cylinder(0, 0.08, 0, 0.14, 0, 0.6, 0, 0.13, 8, body);
  mb.cylinder(0, 0.6, 0, 0.16, 0, 0.66, 0, 0.16, 8, body);
  mb.cylinder(0, 0.66, 0, 0.13, 0, 0.8, 0, 0.05, 8, cap);
  mb.box(0, 0.36, -0.16, 0.12, 0.48, 0.14, body);
  mb.box(0.16, 0.36, 0, 0.12, 0.48, 0.12, body);
  mb.box(-0.16, 0.36, 0, 0.12, 0.48, 0.12, body);
}

function cart(ctx: DressContext, color: RGB): void {
  const mb = ctx.mb;
  const lid = shade(color, 0.9);
  mb.box(0, 0.08, 0, 0.56, 1.0, 0.68, color, 0, { aoBottom: 0.25 });
  mb.box(0, 1.0, 0.02, 0.62, 1.07, 0.76, lid);
  mb.box(0, 0.88, 0.4, 0.5, 0.96, 0.06, lid); // handle (back)
  const tire = rgb(ctx.style.tire);
  wheel(mb, -0.27, 0.11, 0.3, 0.11, 0.07, tire, tire);
  wheel(mb, 0.27, 0.11, 0.3, 0.11, 0.07, tire, tire);
}

/**
 * Parked car (sedan / SUV / pickup by variant % 3), ~200 triangles. Body = a side profile extruded
 * across the width (hood, cabin base, trunk); greenhouse = a narrower frustum (tumblehome) with glass
 * sides and a painted roof and pillars; dark tires with small silver hubs. Front = local −Z.
 */
/** Car dimensions by variant (shared by the model and its collision). Front = local −Z. */
export function carDims(variant: number) {
  const type = variant % 3; // 0 sedan, 1 SUV, 2 pickup
  const W = type === 1 ? 1.9 : 1.82;
  const L = type === 0 ? 4.7 : type === 1 ? 4.8 : 5.5;
  const hl = L / 2;
  const belt = type === 0 ? 0.9 : 1.08;
  const roofY = type === 0 ? 1.44 : type === 1 ? 1.78 : 1.8;
  const cf = type === 2 ? -hl + 1.55 : -hl + (type === 0 ? 1.5 : 1.25); // windshield base
  const cb = type === 2 ? -hl + 3.05 : hl - (type === 0 ? 1.0 : 0.3);   // rear glass base
  const rf = cf + (type === 0 ? 0.8 : 0.5), rb = type === 2 ? cb - 0.08 : cb - (type === 0 ? 0.6 : 0.12);
  return { type, W, L, hl, hw: W / 2, belt, roofY, cf, cb, rf, rb };
}

function car(ctx: DressContext, variant: number): void {
  const mb = ctx.mb, S = ctx.style;
  const paint = rgb(S.cars[variant % S.cars.length]!);
  const glass = rgb(S.carGlass), glassTop = shade(glass, 1.45), tire = rgb(S.tire), hub = rgb('#9a9ea1');
  const trimC = shade(paint, 0.55), bumper = rgb('#3a3b3d');
  const { type, W, hl, hw, belt, roofY, cf, cb, rf, rb } = carDims(variant);
  const sill = 0.34;
  // Side profile (z, y), front (−z) to back, convex: bumper, hood, cowl, deck/bed rail, tail.
  const prof: [number, number][] = [
    [-hl, sill], [-hl, belt - 0.26], [-hl + 0.22, belt - 0.08], [cf, belt], [type === 2 ? hl - 0.05 : cb, belt],
    [hl - (type === 0 ? 0.12 : 0.05), belt - 0.06], [hl, belt - 0.25], [hl, sill],
  ];
  const n = prof.length;
  const P = (x: number, [z, y]: [number, number]): [number, number, number] => [x, y, z];
  // Sides
  mb.face(prof.map((q) => P(hw, q)), paint, [1, 0, 0]);
  mb.face(prof.map((q) => P(-hw, q)), paint, [-1, 0, 0]);
  // Skin around the profile (front, hood, roof of the body, tail, underside skipped)
  for (let i = 0; i < n - 1; i++) {
    const a = prof[i]!, b = prof[i + 1]!;
    // The profile runs clockwise in (z, y): an edge's outward normal is (y: dz, z: −dy).
    const dz = b[0] - a[0], dy = b[1] - a[1];
    const c = dz > Math.abs(dy) ? shade(paint, 1.05) : paint;
    mb.face([P(-hw, a), P(hw, a), P(hw, b), P(-hw, b)], c, [0, dz, -dy]);
  }
  // Rocker / wheel-arch shadow band along the bottom of the sides
  for (const sx of [1, -1]) {
    mb.face([[sx * (hw + 0.005), sill, -hl + 0.1], [sx * (hw + 0.005), sill, hl - 0.1], [sx * (hw + 0.005), sill + 0.1, hl - 0.1], [sx * (hw + 0.005), sill + 0.1, -hl + 0.1]], trimC, [sx, 0, 0]);
  }
  // Bumpers
  mb.box(0, sill - 0.02, -hl - 0.04, W - 0.06, sill + 0.2, 0.1, bumper);
  mb.box(0, sill - 0.02, hl + 0.04, W - 0.06, sill + 0.2, 0.1, bumper);
  // Greenhouse: frustum from the belt to the roof, inset for tumblehome.
  const iw = hw - 0.06, rw = hw - (type === 1 ? 0.14 : 0.22);
  const V = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  mb.face([V(-iw, belt, cf), V(iw, belt, cf), V(rw, roofY, rf), V(-rw, roofY, rf)], glass, [0, 0.6, -1], [glass, glass, glassTop, glassTop]); // windshield
  mb.face([V(iw, belt, cb), V(-iw, belt, cb), V(-rw, roofY, rb), V(rw, roofY, rb)], glass, [0, 0.6, 1], [glass, glass, glassTop, glassTop]); // rear glass
  for (const sx of [1, -1]) {
    const x0 = sx * iw, x1 = sx * rw;
    mb.face([V(x0, belt, cf), V(x0, belt, cb), V(x1, roofY, rb), V(x1, roofY, rf)], glass, [sx, 0.25, 0], [glass, glass, glassTop, glassTop]);
    // A / B / C pillars in body color (thin strips over the glass)
    const bz = (cf + cb) / 2 + 0.1, bzr = (rf + rb) / 2 + 0.1;
    mb.face([V(x0 * 1.002, belt, bz - 0.06), V(x0 * 1.002, belt, bz + 0.06), V(x1 * 1.002, roofY, bzr + 0.06), V(x1 * 1.002, roofY, bzr - 0.06)], trimC, [sx, 0.25, 0]);
  }
  mb.face([V(-rw, roofY, rf), V(rw, roofY, rf), V(rw, roofY, rb), V(-rw, roofY, rb)], shade(paint, 1.06), [0, 1, 0]); // roof
  if (type === 2) {
    // Pickup bed: open box behind the cab (inner floor + inner walls darker).
    const z0 = cb + 0.12;
    mb.face([V(-hw + 0.08, belt - 0.4, z0), V(hw - 0.08, belt - 0.4, z0), V(hw - 0.08, belt - 0.4, hl - 0.1), V(-hw + 0.08, belt - 0.4, hl - 0.1)], shade(paint, 0.45), [0, 1, 0]);
    mb.box(0, belt - 0.02, cb + 0.04, W - 0.1, belt + 0.02, 0.08, shade(paint, 0.8)); // cab back lip
  }
  // Lights
  for (const x of [-hw + 0.3, hw - 0.3]) {
    mb.box(x, belt - 0.24, -hl - 0.01, 0.36, belt - 0.1, 0.04, rgb('#f2f0e6'));
    mb.box(x, belt - 0.26, hl + 0.01, 0.32, belt - 0.12, 0.04, rgb('#a3201d'));
  }
  // Wheels: dark tires, small silver hubs on the outside.
  const wz = hl - (type === 2 ? 1.05 : 0.85);
  for (const x of [-hw + 0.12, hw - 0.12]) {
    for (const z of [-wz, wz]) {
      wheel(mb, x, 0.34, z, 0.34, 0.24, tire, tire);
      wheel(mb, x + Math.sign(x) * 0.125, 0.34, z, 0.15, 0.01, hub, hub);
    }
  }
}

function stopSign(ctx: DressContext): void {
  const mb = ctx.mb, S = ctx.style;
  const metal = rgb(S.metal), red = rgb(S.stopSign), white = rgb('#f4f4f0');
  mb.box(0, -0.2, 0, 0.06, 2.45, 0.06, metal);
  const cy = 2.15;
  const oct = (r: number, z: number, color: RGB, front: boolean): void => {
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2 + Math.PI / 8, a1 = ((i + 1) / 8) * Math.PI * 2 + Math.PI / 8;
      const x0 = Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r, x1 = Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
      // Front faces local −Z: CCW seen from −Z.
      if (front) mb.tri(0, cy, z, x1, y1, z, x0, y0, z, color);
      else mb.tri(0, cy, z, x0, y0, z, x1, y1, z, color);
    }
  };
  oct(0.4, -0.04, white, true);
  oct(0.36, -0.05, red, true);
  oct(0.4, -0.035, rgb('#8d9294'), false);
}

function signal(ctx: DressContext): void {
  const mb = ctx.mb, S = ctx.style;
  const metal = rgb(S.metal), head = rgb(S.signalHead);
  mb.cylinder(0, -0.2, 0, 0.16, 0, 6.6, 0, 0.12, 8, metal);
  mb.cylinder(0, 5.9, 0, 0.1, 0, 6.15, -7.0, 0.06, 6, metal);
  for (const z of [-3.6, -6.2]) {
    mb.box(0, 4.9, z, 0.34, 5.95, 0.3, head, 0, { bottom: true });
    // lights on both faces (±X): red lit, amber and green dim
    for (const sx of [-1, 1]) {
      mb.box(sx * 0.18, 5.55, z, 0.04, 5.8, 0.2, rgb('#e8432f'));
      mb.box(sx * 0.18, 5.3, z, 0.04, 5.5, 0.2, rgb('#6b5a1e'));
      mb.box(sx * 0.18, 5.03, z, 0.04, 5.23, 0.2, rgb('#1f4d34'));
    }
  }
}

/** Sign post for the street-name blades (blades themselves are textured, see signs.ts). */
function signPost(ctx: DressContext): void {
  // The blades sit on top of the post, stacked crosswise (signs.ts: centres at 2.96 m and 3.2 m).
  ctx.mb.box(0, -0.2, 0, 0.07, 2.85, 0.07, rgb(ctx.style.metal));
}

// --- Dispatcher -----------------------------------------------------------------------------------

/** Collision radius / half sizes per prop kind (meters, before scale). */
const TRUNK_R: Record<string, number> = { tree_oak: 0.4, tree_pecan: 0.36, tree_elm: 0.3, tree_myrtle: 0.45 };

export function buildProps(ctx: DressContext, props: Record<string, number[]>, signs: TileSign[] | undefined): number {
  const mb = ctx.mb;
  let count = 0;
  for (const [kind, arr] of Object.entries(props)) {
    for (let k = 0; k + PROP_STRIDE - 1 < arr.length; k += PROP_STRIDE) {
      const x = arr[k]!, z = arr[k + 1]!, rot = arr[k + 2]!, sc = arr[k + 3]!, variant = arr[k + 4]!;
      const y = groundAt(ctx, x, z);
      const r = rng(Math.round(x * 100) * 73856093 ^ Math.round(z * 100) * 19349663);
      mb.setTransform(x, y, z, rot, sc);
      switch (kind) {
        case 'tree_oak': treeOak(ctx, r); break;
        case 'tree_pecan': treePecan(ctx, r); break;
        case 'tree_elm': treeElm(ctx, r); break;
        case 'tree_myrtle': treeMyrtle(ctx, r, variant); break;
        case 'shrub': shrub(ctx, r); break;
        case 'pole': pole(ctx, variant); break;
        case 'hydrant': hydrant(ctx); break;
        case 'cart_trash': cart(ctx, rgb(ctx.style.cartTrash)); break;
        case 'cart_recycle': cart(ctx, rgb(ctx.style.cartRecycle)); break;
        case 'car': car(ctx, variant); break;
        case 'stop': stopSign(ctx); break;
        case 'signal': signal(ctx); break;
        default: continue;
      }
      count++;
      // Collision (dog only).
      // Tops: the dog jumps over hydrants and carts, and onto cars (hood, then roof). Trunks, poles and
      // sign posts are always solid.
      let ring: number[] | null = null;
      let top = Infinity;
      if (kind in TRUNK_R) ring = circleRing(x, z, TRUNK_R[kind]! * sc, 8);
      else if (kind === 'pole' || kind === 'signal') ring = circleRing(x, z, 0.2, 6);
      else if (kind === 'hydrant') { ring = circleRing(x, z, 0.22, 6); top = y + 0.8; }
      else if (kind === 'car') {
        const c = carDims(variant);
        ctx.obstacles.push({ ring: rectRing(x, z, c.hw + 0.02, c.hl + 0.05, rot), base: y - 0.3, height: 0, top: y + c.belt, walk: true });
        // Cabin: from the windshield base to the rear glass, centred along local z.
        const zc = (c.cf + c.cb) / 2, cs = Math.cos(rot), sn = Math.sin(rot);
        ctx.obstacles.push({
          ring: rectRing(x + sn * zc, z + cs * zc, c.hw - 0.15, (c.cb - c.cf) / 2, rot), base: y - 0.3, height: 0,
          top: y + c.roofY, walk: true,
        });
      }
      else if (kind.startsWith('cart')) { ring = rectRing(x, z, 0.32, 0.4, rot); top = y + 1.07; }
      else if (kind === 'stop') ring = circleRing(x, z, 0.06, 4);
      if (ring) ctx.obstacles.push({ ring, base: y - 0.3, height: 0, top });
    }
  }
  for (const s of signs ?? []) {
    const y = groundAt(ctx, s.x, s.z);
    mb.setTransform(s.x, y, s.z, 0, 1);
    signPost(ctx);
    ctx.obstacles.push({ ring: circleRing(s.x, s.z, 0.06, 4), base: y - 0.3, height: 0 });
    count++;
  }
  mb.resetTransform();
  return count;
}

/** Overhead wires between pole tops: three sagging lines per span (two on the crossarm, one telecom). */
export function buildWires(ctx: DressContext, wires: number[]): void {
  const mb = ctx.mb;
  mb.resetTransform();
  const c = rgb(ctx.style.wire);
  const SEG = 8, HW = 0.025;
  for (let k = 0; k + 3 < wires.length; k += 4) {
    const x0 = wires[k]!, z0 = wires[k + 1]!, x1 = wires[k + 2]!, z1 = wires[k + 3]!;
    const g0 = groundAt(ctx, x0, z0), g1 = groundAt(ctx, x1, z1);
    const dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz);
    if (L < 1) continue;
    const px = -dz / L, pz = dx / L; // across the span
    for (const [off, h, sag] of [[-1.05, 9.85, 0.55], [1.05, 9.85, 0.55], [0, 7.2, 0.35]] as const) {
      let prev: [number, number, number] | null = null;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const y = g0 + (g1 - g0) * t + h - sag * 4 * t * (1 - t);
        const p: [number, number, number] = [x0 + dx * t + px * off, y, z0 + dz * t + pz * off];
        if (prev) {
          // two crossed thin quads, visible from any side
          mb.quad([prev[0], prev[1] - HW, prev[2]], [p[0], p[1] - HW, p[2]], [p[0], p[1] + HW, p[2]], [prev[0], prev[1] + HW, prev[2]], c);
          mb.quad([prev[0], prev[1] + HW, prev[2]], [p[0], p[1] + HW, p[2]], [p[0], p[1] - HW, p[2]], [prev[0], prev[1] - HW, prev[2]], c);
          mb.quad([prev[0] - px * HW, prev[1], prev[2] - pz * HW], [p[0] - px * HW, p[1], p[2] - pz * HW], [p[0] + px * HW, p[1], p[2] + pz * HW], [prev[0] + px * HW, prev[1], prev[2] + pz * HW], c);
          mb.quad([prev[0] + px * HW, prev[1], prev[2] + pz * HW], [p[0] + px * HW, p[1], p[2] + pz * HW], [p[0] - px * HW, p[1], p[2] - pz * HW], [prev[0] - px * HW, prev[1], prev[2] - pz * HW], c);
        }
        prev = p;
      }
    }
  }
}

/** Curbs: a low concrete lip along the road edge, following the terrain. */
export function buildCurbs(ctx: DressContext, curbs: number[][]): void {
  const mb = ctx.mb;
  mb.resetTransform();
  const c = rgb(ctx.style.curb);
  const top = shade(c, 1.04), side = shade(c, 0.9);
  const HW = 0.08, H = 0.13, MAXSEG = 2.5;
  for (const line of curbs) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const ax = line[k]!, az = line[k + 1]!, bx = line[k + 2]!, bz = line[k + 3]!;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const n = Math.max(1, Math.ceil(L / MAXSEG));
      const px = (-(bz - az) / L) * HW, pz = ((bx - ax) / L) * HW;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        const y0 = groundAt(ctx, x0, z0), y1 = groundAt(ctx, x1, z1);
        mb.face([[x0 - px, y0 + H, z0 - pz], [x0 + px, y0 + H, z0 + pz], [x1 + px, y1 + H, z1 + pz], [x1 - px, y1 + H, z1 - pz]], top, [0, 1, 0]);
        for (const sgn of [1, -1]) {
          const ox = px * sgn, oz = pz * sgn;
          mb.face([[x0 + ox, y0 - 0.1, z0 + oz], [x1 + ox, y1 - 0.1, z1 + oz], [x1 + ox, y1 + H, z1 + oz], [x0 + ox, y0 + H, z0 + oz]], side, [ox, 0, oz]);
        }
      }
    }
  }
}
