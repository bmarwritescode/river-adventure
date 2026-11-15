import type { TileBuilding, LandmarkInfo } from '../../types';
import { signedArea, type DressContext, type LabelRequest } from '../houses';
import { jitter, mix, rgb, rng, shade, type RGB } from '../MeshBuilder';

/**
 * Home Slice Pizza, 501 E 53rd St (SE corner of Duval & 53rd): the first hand-made hero location.
 *
 * References: press photos of the storefront (2018) and Esri World Imagery (~6 cm/px) for the site.
 * The pipeline (tools/map/landmarks.py) lays out the lot, stalls, cars, trees, fences and the patio
 * slab; this model builds the building and its fixtures in the landmark frame:
 *   a = meters along the storefront from its west corner (east = +a), b = meters out of it (north = +b).
 * Storefront, viewed from the lot (left to right = east to west):
 *   take-out door ("501") + two painted windows (N.Y. STYLE / Pizza) on white tile, blue/white striped
 *   awning | brick pier | black double doors + windows on multicolor brick, red awning
 *   ("RESTAURANT · AUTHENTIC NY-STYLE PIZZA"); "RESTAURANT BAR" on the brick; black sign band with
 *   sequined HOME SLICE (gold) PIZZA (silver) letters on top.
 * West side (Duval): corrugated metal shed roof on green scaffold pipes ("NYC sidewalk scaffolding")
 * over an outdoor bar with '70s striped tiles; tan shade sails; blue/white striped canopies over red
 * picnic tables along the patio fence; artificial-turf kids' area with mounds and a crawl tunnel.
 */

type V3 = [number, number, number];

export const HOME_SLICE = {
  wallTopAbove: 0.6, // parapet above the roof deck
  storefrontTop: 2.9,
  band: { a0: 0.3, a1: 19.75, y0: 4.12, y1: 4.75, depth: 0.2 },
  // Letters measured on the photo: they span only the east half, mounted on the band, half above it.
  letters: { y: 4.72, h: 1.0, words: [['HOME', 19.15, 16.85], ['SLICE', 15.85, 12.95], ['PIZZA', 12.55, 9.25]] as const },
  shed: { a: -6.3, b0: 0.2, b1: -14.2, yWall: 3.35, yEdge: 3.0, posts: [-0.6, -5.0, -9.4, -13.8] },
  sails: { a: -9.6, posts: [0.9, -3.6, -8.1, -12.6] },
  bar: { a0: -2.45, a1: -1.75, b0: -13.0, b1: -6.6 },
  cabanas: [0.9, -2.5, -5.9, -9.3],
  turfMounds: [[-3.4, -20.2, 1.9, 0.75], [-1.7, -25.6, 1.2, 0.5]] as const,
  tunnel: { a: -4.6, b0: -22.9, b1: -25.1, r: 0.95 },
};

export function buildHomeSlice(ctx: DressContext, b: TileBuilding, lm: LandmarkInfo): void {
  const mb = ctx.mb, S = ctx.style, H = S.homeSlice;
  mb.resetTransform();
  const ul = Math.hypot(lm.u[0], lm.u[1]) || 1;
  const [ox, oz] = lm.o, ux = lm.u[0] / ul, uz = lm.u[1] / ul;
  const nx = uz, nz = -ux; // out of the storefront
  const W = (a: number, bb: number): [number, number] => [ox + ux * a + nx * bb, oz + uz * a + nz * bb];
  const g = (x: number, z: number): number => (ctx.hm ? ctx.hm.sample(x, z) : 0);
  const outer = b.r[0]!;
  const m = outer.length / 2;
  let gMin = Infinity, gSum = 0;
  for (let k = 0; k < m; k++) {
    const y = g(outer[k * 2]!, outer[k * 2 + 1]!);
    gMin = Math.min(gMin, y);
    gSum += y;
  }
  const G = gSum / m; // storefront grade
  const base = gMin - ctx.sink;
  const roofY = G + b.h;
  const topY = roofY + HOME_SLICE.wallTopAbove;
  const r = rng(0x501);
  /** World point from (a, b, height above grade). */
  const P = (a: number, bb: number, y: number): V3 => { const [x, z] = W(a, bb); return [x, G + y, z]; };
  const N: V3 = [nx, 0, nz], S3: V3 = [-nx, 0, -nz], E: V3 = [ux, 0, uz], Wd: V3 = [-ux, 0, -uz], UP: V3 = [0, 1, 0];
  const rotU = Math.atan2(-uz, ux); // box/cylinder rotation laying local +X along a (local +Z = −b)
  // Labels on the storefront: local +X = reading direction (viewer's left -> right = toward −a),
  // local +Z = out of the storefront.
  const textRot = Math.atan2(uz, -ux);
  /** Box in the frame: centre (a, b), sizes along a / b, heights above grade. */
  const box = (a: number, bb: number, y0: number, y1: number, sa: number, sb: number, c: RGB, opts: Parameters<typeof mb.box>[8] = {}): void => {
    const [x, z] = W(a, bb);
    mb.box(x, G + y0, z, sa, G + y1, sb, c, rotU, opts);
  };
  /** Panel on the storefront plane (b = off), from a0..a1, y0..y1. */
  const front = (a0: number, a1: number, y0: number, y1: number, off: number, c: RGB, cTop?: RGB): void =>
    mb.face([P(a0, off, y0), P(a1, off, y0), P(a1, off, y1), P(a0, off, y1)], c, N, cTop ? [c, c, cTop, cTop] : undefined);
  /** Panel on the west wall plane (a = −off), from b0..b1. */
  const west = (b0: number, b1: number, y0: number, y1: number, off: number, c: RGB, cTop?: RGB): void =>
    mb.face([P(-off, b0, y0), P(-off, b1, y0), P(-off, b1, y1), P(-off, b0, y1)], c, Wd, cTop ? [c, c, cTop, cTop] : undefined);
  /** Collision (dog only). `top` = height above grade the dog can jump over / onto (default: solid). */
  const block = (a: number, bb: number, rad: number, top = Infinity, walk = false): void => {
    const [x, z] = W(a, bb);
    const out: number[] = [];
    for (let i = 0; i < 8; i++) { const t = (i / 8) * Math.PI * 2; out.push(x + Math.cos(t) * rad, z + Math.sin(t) * rad); }
    ctx.obstacles.push({ ring: out, base: G - 0.3, height: 0, top: G + top, walk });
  };
  const blockRect = (a0: number, a1: number, b0: number, b1: number, top = Infinity, walk = false): void => {
    ctx.obstacles.push({ ring: [...W(a0, b0), ...W(a1, b0), ...W(a1, b1), ...W(a0, b1)], base: G - 0.3, height: 0, top: G + top, walk });
  };

  const brick = rgb(H.brick), brickDark = rgb(H.brickDark), mortar = rgb(H.mortar);
  const frame = rgb(H.frame), glass = rgb(S.glass), brass = rgb(H.brass), tile = rgb(H.tile);
  const multi = H.multiBrick.map(rgb);

  // --- Walls: brick on the exact footprint, parapet + stone coping, darker soldier course -------------
  const sa = signedArea(outer);
  const sgn = sa >= 0 ? 1 : -1;
  for (let k = 0; k < m; k++) {
    const ax = outer[k * 2]!, az = outer[k * 2 + 1]!;
    const bx = outer[((k + 1) % m) * 2]!, bz = outer[((k + 1) % m) * 2 + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const wx = ((bz - az) / len) * sgn, wz = (-(bx - ax) / len) * sgn;
    const lowC = shade(brick, 1 - S.wallAO * 1.2);
    mb.face([[ax, base, az], [bx, base, bz], [bx, topY, bz], [ax, topY, az]], brick, [wx, 0, wz], [lowC, lowC, brick, brick]);
    // Soldier course under the coping and a base course.
    const band = (y0: number, y1: number, c: RGB): void =>
      mb.face([[ax + wx * 0.02, y0, az + wz * 0.02], [bx + wx * 0.02, y0, bz + wz * 0.02], [bx + wx * 0.02, y1, bz + wz * 0.02], [ax + wx * 0.02, y1, az + wz * 0.02]], c, [wx, 0, wz]);
    band(topY - 0.42, topY - 0.2, brickDark);
    // Coping (stone cap) + inner parapet face.
    mb.face([[ax + wx * 0.05, topY - 0.08, az + wz * 0.05], [bx + wx * 0.05, topY - 0.08, bz + wz * 0.05], [bx + wx * 0.05, topY + 0.04, bz + wz * 0.05], [ax + wx * 0.05, topY + 0.04, az + wz * 0.05]], mortar, [wx, 0, wz]);
    mb.face([[ax - wx * 0.25, topY + 0.04, az - wz * 0.25], [bx - wx * 0.25, topY + 0.04, bz - wz * 0.25], [bx + wx * 0.05, topY + 0.04, bz + wz * 0.05], [ax + wx * 0.05, topY + 0.04, az + wz * 0.05]], shade(mortar, 1.05), UP);
    mb.face([[ax - wx * 0.25, roofY, az - wz * 0.25], [bx - wx * 0.25, roofY, bz - wz * 0.25], [bx - wx * 0.25, topY + 0.04, bz - wz * 0.25], [ax - wx * 0.25, topY + 0.04, az - wz * 0.25]], shade(brick, 0.85), [-wx, 0, -wz]);
  }
  // Roof deck (light membrane) as one fan of the outer ring (the footprint is near-convex; earcut-free).
  {
    let cx = 0, cz = 0;
    for (let k = 0; k < m; k++) { cx += outer[k * 2]!; cz += outer[k * 2 + 1]!; }
    cx /= m; cz /= m;
    const roofC = rgb(H.roof);
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      mb.face([[cx, roofY, cz], [outer[k * 2]!, roofY, outer[k * 2 + 1]!], [outer[k2 * 2]!, roofY, outer[k2 * 2 + 1]!]], jitter(roofC, k / m, 0.03), UP);
    }
    // Rooftop HVAC units (seen from the street corner and from above).
    const hv = rgb(H.hvac);
    for (const [a, bb, sw, sd] of [[5, -6, 1.6, 1.1], [9.5, -9, 2.2, 1.3], [13.5, -5.5, 1.4, 1.0], [7, -14.5, 1.8, 1.2],
      [12.5, -17.5, 1.3, 1.3], [4.5, -26, 1.6, 1.1], [10, -29.5, 2.0, 1.2], [15.5, -12, 1.0, 1.0]] as const) {
      box(a, bb, b.h, b.h + 0.95, sw, sd, jitter(hv, r(), 0.06), { top: shade(hv, 1.08) });
      box(a + sw * 0.2, bb, b.h + 0.95, b.h + 1.0, sd * 0.6, sd * 0.6, rgb('#3a3d40'));
    }
  }

  // --- Storefront (b = 0), measured from the press photo (double doors = 2.1 m -> ~110 px/m) ---------
  const sf = HOME_SLICE.storefrontTop;
  const glassPanel = (a0: number, a1: number, y0: number, y1: number): void => {
    front(a0 - 0.07, a1 + 0.07, y0 - 0.07, y1 + 0.07, 0.03, frame);
    front(a0, a1, y0, y1, 0.045, jitter(glass, r(), 0.05), shade(glass, 1.3));
  };
  // Take-out bay (east end): door, two painted windows over white subway tile, striped awning.
  front(14.0, 18.3, 0, 0.95, 0.03, tile);
  for (let y = 0.16; y < 0.95; y += 0.16) front(14.0, 18.3, y - 0.012, y + 0.012, 0.035, shade(tile, 0.86)); // tile joints
  for (let a = 14.0 + 0.3; a < 18.25; a += 0.3) front(a - 0.01, a + 0.01, 0, 0.95, 0.035, shade(tile, 0.88));
  glassPanel(16.1, 18.15, 1.0, 2.62);
  glassPanel(14.4, 15.9, 1.0, 2.62);
  front(18.3, 19.45, 0, sf, 0.03, frame);
  front(18.42, 19.33, 0.05, 2.25, 0.05, rgb('#3b2a22'));
  front(18.55, 19.2, 0.9, 2.1, 0.06, jitter(glass, 0.3, 0.05));
  front(18.5, 19.25, 1.0, 1.06, 0.075, rgb('#c9ccce')); // push bar
  awning(14.3, 19.98, 'striped');
  multiPanel(15.7, 16.2, 3.42, 4.15);

  // Main entrance bay: black double doors with brass push bars, windows over multicolor brick.
  front(11.7, 13.9, 0, sf, 0.03, frame);
  for (const [d0, d1] of [[11.78, 12.78], [12.82, 13.82]] as const) {
    front(d0, d1, 0.05, 2.35, 0.05, frame);
    front(d0 + 0.1, d1 - 0.1, 0.25, 2.2, 0.06, jitter(glass, 0.6, 0.05), shade(glass, 1.25));
    front(d0 + 0.12, d1 - 0.12, 1.0, 1.08, 0.08, brass);
    front(d0 + 0.12, d1 - 0.12, 1.12, 1.2, 0.08, brass);
  }
  front(11.8, 13.8, 2.42, 2.78, 0.05, jitter(glass, 0.2, 0.05)); // transom
  for (const [a0, a1] of [[9.2, 11.62], [5.5, 9.0], [0.7, 5.1]] as const) {
    multiWainscot(a0, a1, 0, 0.95);
    const n = Math.max(1, Math.round((a1 - a0) / 1.25));
    for (let i = 0; i < n; i++) {
      const p0 = a0 + ((a1 - a0) * i) / n + 0.05, p1 = a0 + ((a1 - a0) * (i + 1)) / n - 0.05;
      glassPanel(p0, p1, 1.02, 2.62);
    }
  }
  multiPanel(12.0, 12.5, 3.42, 4.15);
  awning(0.7, 14.0, 'red');

  // Black sign band along the top of the wall; sequined HOME SLICE (gold) PIZZA (silver) letters
  // mounted on it, standing above the parapet; "RESTAURANT BAR" in white letters on the brick.
  const B = HOME_SLICE.band;
  box((B.a0 + B.a1) / 2, B.depth / 2 - 0.02, B.y0, B.y1, B.a1 - B.a0, B.depth, rgb(H.signBand));
  for (const [word, a0, a1] of HOME_SLICE.letters.words) {
    const [x, z] = W((a0 + a1) / 2, B.depth + 0.01);
    ctx.labels.push({
      text: word, x, y: G + HOME_SLICE.letters.y, z, rot: textRot,
      width: a0 - a1, height: HOME_SLICE.letters.h, background: null, foreground: word === 'PIZZA' ? H.silver : H.gold,
      font: 'block', spacing: 0.08, sequins: true, twoSided: true, rows: 2,
    });
  }
  for (const [word, a0, a1] of [['RESTAURANT', 13.8, 10.8], ['BAR', 10.3, 9.4]] as const) {
    const [x, z] = W((a0 + a1) / 2, 0.03);
    ctx.labels.push({ text: word, x, y: G + 3.84, z, rot: textRot, width: a0 - a1, height: 0.42, background: null,
      foreground: '#f4f2ee', spacing: 0.22, rows: 0.75 });
  }
  // Painted window lettering, menu strips, the address.
  const lab = (text: string, a: number, y: number, w: number, h: number, extra: Partial<LabelRequest>): void => {
    const [x, z] = W(a, 0.06);
    ctx.labels.push({ text, x, y: G + y, z, rot: textRot, width: w, height: h, background: null, ...extra });
  };
  lab('Authentic', 17.1, 2.3, 1.3, 0.3, { font: 'script', foreground: '#e2b04a', rows: 1 });
  lab('N.Y. STYLE', 17.1, 1.85, 1.9, 0.38, { foreground: '#f3e6c6', outline: '#a3261f', rows: 1 });
  lab('Pizza', 15.15, 1.92, 1.45, 0.6, { font: 'script', foreground: '#f3e6c6', outline: '#a3261f', rows: 1.5 });
  lab('BUFFALO WINGS · SUBS · SALADS', 17.1, 1.12, 1.95, 0.16, { background: '#efe6cf', foreground: '#a3261f', rows: 0.5 });
  lab('WINE · BEER · ESPRESSO', 15.15, 1.12, 1.45, 0.16, { background: '#efe6cf', foreground: '#a3261f', rows: 0.5 });
  lab('501', 18.85, 2.6, 0.5, 0.2, { foreground: '#d7b45a', rows: 0.5 });
  lab('Take Out', 18.87, 1.6, 0.45, 0.12, { font: 'script', foreground: '#d7b45a', rows: 0.5 });

  // --- West side: scaffold shed, bar, sails, canopies, tables ---------------------------------------
  const sh = HOME_SLICE.shed;
  const green = rgb(H.scaffold), metal = rgb(H.metalRoof);
  // Posts + beams.
  for (const bb of sh.posts) {
    const [x, z] = W(sh.a, bb);
    mb.cylinder(x, G - 0.1, z, 0.055, x, G + sh.yEdge, z, 0.055, 6, green, null);
    block(sh.a, bb, 0.12);
  }
  box(sh.a, (sh.b0 + sh.b1) / 2, sh.yEdge - 0.45, sh.yEdge, 0.12, sh.b0 - sh.b1, green); // fascia beam / parapet board
  // X-bracing in the end bays.
  for (const [b0, b1] of [[sh.posts[0]!, sh.posts[1]!], [sh.posts[2]!, sh.posts[3]!]] as const) {
    for (const [ya, yb] of [[0.4, sh.yEdge - 0.5], [sh.yEdge - 0.5, 0.4]] as const) {
      const p0 = P(sh.a, b0, ya), p1 = P(sh.a, b1, yb);
      mb.cylinder(p0[0], p0[1], p0[2], 0.025, p1[0], p1[1], p1[2], 0.025, 4, shade(green, 0.9), null);
    }
  }
  // Ledger + rafters against the brick, corrugated metal roof (ribs = alternating strips), soffit.
  box(-0.06, (sh.b0 + sh.b1) / 2, sh.yWall - 0.25, sh.yWall, 0.12, sh.b0 - sh.b1, green);
  const ribs = Math.round((sh.b0 - sh.b1) / 0.22);
  for (let i = 0; i < ribs; i++) {
    const b0 = sh.b0 - ((sh.b0 - sh.b1) * i) / ribs, b1 = sh.b0 - ((sh.b0 - sh.b1) * (i + 1)) / ribs;
    const c = i % 2 ? metal : shade(metal, 0.86);
    mb.face([P(0, b0, sh.yWall + 0.03), P(0, b1, sh.yWall + 0.03), P(sh.a - 0.15, b1, sh.yEdge + 0.03), P(sh.a - 0.15, b0, sh.yEdge + 0.03)], c, [0, 1, 0]);
  }
  mb.face([P(0, sh.b0, sh.yWall - 0.02), P(0, sh.b1, sh.yWall - 0.02), P(sh.a - 0.15, sh.b1, sh.yEdge - 0.02), P(sh.a - 0.15, sh.b0, sh.yEdge - 0.02)], rgb(H.soffit), [0, -1, 0]);
  for (const bb of [sh.b0, sh.b1]) {
    mb.face([P(0, bb, sh.yWall - 0.25), P(sh.a, bb, sh.yEdge - 0.45), P(sh.a, bb, sh.yEdge + 0.03), P(0, bb, sh.yWall + 0.03)], green, bb === sh.b0 ? N : S3);
  }
  // Giant ceiling fans over the bar ("giant fans and misters"): hub + six long blades.
  for (const bb of [-4.2, -10.4]) {
    const [x, z] = W(-3.3, bb);
    const yc = G + 2.72;
    mb.cylinder(x, yc + 0.08, z, 0.03, x, G + sh.yWall - 0.2, z, 0.03, 4, frame, null);
    mb.cylinder(x, yc - 0.06, z, 0.16, x, yc + 0.1, z, 0.12, 7, rgb('#2a2b2d'));
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2 + 0.3;
      mb.box(x + Math.cos(t) * 0.75, yc, z - Math.sin(t) * 0.75, 1.3, yc + 0.03, 0.16, rgb('#3a3c3e'), t);
    }
  }
  // Lamps under the deck.
  for (let bb = -1.5; bb > sh.b1 + 0.5; bb -= 3) box(-3.2, bb, sh.yEdge + 0.05, sh.yEdge + 0.15, 0.3, 0.3, rgb('#f2d79a'));
  // Patio doors in the brick under the shed.
  for (const [b0, b1] of [[-1.6, -3.4], [-14.6, -16.0]] as const) {
    west(b0 + 0.08, b1 - 0.08, 0, 2.45, 0.03, frame);
    west(b0, b1, 0.08, 2.3, 0.05, jitter(glass, 0.4, 0.05), shade(glass, 1.25));
  }
  // Outdoor bar (photo): white grid tile with '70s rainbow stripes that run along and bend down,
  // stainless top, back bar against the brick, multicolor bar chairs, brass dome pendants.
  const br = HOME_SLICE.bar;
  const len = Math.abs(br.b1 - br.b0), bMid = (br.b0 + br.b1) / 2;
  const bLo = Math.min(br.b0, br.b1), bHi = Math.max(br.b0, br.b1);
  const tileC = rgb(H.barTile), steel = rgb(H.barTop);
  box((br.a0 + br.a1) / 2, bMid, 0, 1.0, br.a1 - br.a0, len, tileC);
  const fa = br.a0 - 0.012; // the bar front (faces the patio, −a)
  for (let y = 0.12; y < 1.0; y += 0.12) mb.face([P(fa, br.b0, y - 0.006), P(fa, br.b1, y - 0.006), P(fa, br.b1, y + 0.006), P(fa, br.b0, y + 0.006)], shade(tileC, 0.82), Wd);
  for (let bb = bLo + 0.12; bb < bHi; bb += 0.12) mb.face([P(fa, bb - 0.006, 0), P(fa, bb + 0.006, 0), P(fa, bb + 0.006, 1.0), P(fa, bb - 0.006, 1.0)], shade(tileC, 0.82), Wd);
  // Rainbow stripes: run along the bar, then turn down to the floor in concentric quarter circles.
  const R0 = 0.42, bc = bHi - 1.0, yc = 0.66 - R0, f2 = fa - 0.004, t = 0.055;
  H.barStripes.map(rgb).forEach((c, k) => {
    const R = R0 - k * 0.075, y = yc + R;
    mb.face([P(f2, bLo + 0.05, y - t / 2), P(f2, bc, y - t / 2), P(f2, bc, y + t / 2), P(f2, bLo + 0.05, y + t / 2)], c, Wd);
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * (Math.PI / 2), a1 = ((i + 1) / steps) * (Math.PI / 2);
      const pt = (ang: number, r: number): V3 => P(f2, bc + Math.sin(ang) * r, yc + Math.cos(ang) * r);
      mb.face([pt(a0, R - t / 2), pt(a1, R - t / 2), pt(a1, R + t / 2), pt(a0, R + t / 2)], c, Wd);
    }
    mb.face([P(f2, bc + R - t / 2, 0.02), P(f2, bc + R + t / 2, 0.02), P(f2, bc + R + t / 2, yc), P(f2, bc + R - t / 2, yc)], c, Wd);
  });
  box((br.a0 + br.a1) / 2 - 0.06, bMid, 1.0, 1.05, br.a1 - br.a0 + 0.3, len + 0.15, steel, { top: shade(steel, 1.08) });
  box(-0.25, bMid, 0, 2.1, 0.4, len, rgb('#3e4a3e'), { top: steel }); // back bar shelving (green, as in the photo)
  blockRect(br.a0 - 0.05, br.a1, br.b0, br.b1, 1.05, true); // the dog can hop up on the bar (sorry)
  const chairs = H.chairs.map(rgb);
  let ci = 0;
  for (let bb = bLo + 0.45; bb < bHi - 0.3; bb += 0.75) {
    const c = chairs[ci++ % chairs.length]!;
    box(br.a0 - 0.42, bb, 0, 0.74, 0.04, 0.04, c); // legs (front pair stands for all four)
    box(br.a0 - 0.42, bb, 0.7, 0.76, 0.4, 0.4, c);
    box(br.a0 - 0.62, bb, 0.76, 1.15, 0.04, 0.38, c); // back
  }
  // Brass dome pendants over the bar.
  const brassC = rgb(H.brass);
  for (let bb = bLo + 0.8; bb < bHi; bb += 1.6) {
    const [x, z] = W((br.a0 + br.a1) / 2 - 0.2, bb);
    mb.cylinder(x, G + 2.35, z, 0.01, x, G + sh.yWall - 0.15, z, 0.01, 3, frame, null);
    mb.cylinder(x, G + 2.12, z, 0.3, x, G + 2.38, z, 0.06, 8, brassC, brassC, shade(brassC, 1.2));
  }

  // Queen of Pies pole sign (photo: Austinot, 2018), on the lot's corner at Duval & 53rd in front of
  // the big live oak, turned to face the intersection.
  queenSign(-8.6, 19.6);

  // Tables under the shed (red tops, black legs).
  for (const bb of [-1.0, -3.7, -6.4, -9.1, -11.8]) tableSet(-4.4, bb, 0.8, 1.6, rgb(H.tableRed), true);

  // Shade sails (tan), a zigzag of tensioned triangles between the shed edge and a row of posts.
  const sl = HOME_SLICE.sails, sail = rgb(H.sail);
  sl.posts.forEach((bb, i) => {
    const [x, z] = W(sl.a, bb);
    mb.cylinder(x, G - 0.1, z, 0.06, x, G + (i % 2 ? 3.0 : 3.6), z, 0.05, 6, rgb('#4a4a48'), null);
    block(sl.a, bb, 0.12);
  });
  const sailTri = (p0: V3, p1: V3, p2: V3, c: RGB): void => {
    const cx = (p0[0] + p1[0] + p2[0]) / 3, cy = (p0[1] + p1[1] + p2[1]) / 3 - 0.18, cz = (p0[2] + p1[2] + p2[2]) / 3;
    const C: V3 = [cx, cy, cz];
    for (const [a1, b1] of [[p0, p1], [p1, p2], [p2, p0]] as const) {
      mb.face([a1, b1, C], c, [0, 1, 0]);
      mb.face([a1, b1, C], shade(c, 0.8), [0, -1, 0]);
    }
  };
  for (let i = 0; i + 1 < sl.posts.length; i++) {
    const o0 = P(sl.a, sl.posts[i]!, i % 2 ? 2.95 : 3.55), o1 = P(sl.a, sl.posts[i + 1]!, (i + 1) % 2 ? 2.95 : 3.55);
    const e0 = P(sh.a, sh.posts[i]!, sh.yEdge - 0.05), e1 = P(sh.a, sh.posts[i + 1]!, sh.yEdge - 0.05);
    sailTri(e0, e1, o0, jitter(sail, i * 0.3, 0.05));
    sailTri(o0, o1, e1, shade(sail, 0.95));
  }

  // Blue/white striped canopies over red picnic tables along the patio fence.
  const ca = -lm.pw + 1.75;
  for (const bb of HOME_SLICE.cabanas) {
    for (const [da, db] of [[-1.0, -1.2], [1.0, -1.2], [1.0, 1.2], [-1.0, 1.2]] as const) {
      const [x, z] = W(ca + da, bb + db);
      mb.cylinder(x, G - 0.05, z, 0.03, x, G + 2.35, z, 0.03, 4, frame, null);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = ca - 1.1 + (2.2 * i) / n, a1 = ca - 1.1 + (2.2 * (i + 1)) / n;
      const c = rgb(i % 2 ? H.awningWhite : H.awningBlue);
      mb.face([P(a0, bb - 1.3, 2.4), P(a1, bb - 1.3, 2.4), P(a1, bb, 2.62), P(a0, bb, 2.62)], c, UP);
      mb.face([P(a0, bb, 2.62), P(a1, bb, 2.62), P(a1, bb + 1.3, 2.4), P(a0, bb + 1.3, 2.4)], c, UP);
      mb.face([P(a0, bb - 1.3, 2.4), P(a1, bb - 1.3, 2.4), P(a1, bb - 1.3, 2.2), P(a0, bb - 1.3, 2.2)], c, S3);
      mb.face([P(a0, bb + 1.3, 2.4), P(a1, bb + 1.3, 2.4), P(a1, bb + 1.3, 2.2), P(a0, bb + 1.3, 2.2)], c, N);
    }
    mb.face([P(ca - 1.1, bb - 1.3, 2.38), P(ca + 1.1, bb - 1.3, 2.38), P(ca + 1.1, bb, 2.6), P(ca - 1.1, bb, 2.6)], shade(rgb(H.awningWhite), 0.7), [0, -1, 0]);
    mb.face([P(ca - 1.1, bb, 2.6), P(ca + 1.1, bb, 2.6), P(ca + 1.1, bb + 1.3, 2.38), P(ca - 1.1, bb + 1.3, 2.38)], shade(rgb(H.awningWhite), 0.7), [0, -1, 0]);
    tableSet(ca, bb, 0.75, 1.8, rgb(H.tableRed), false);
  }

  // Kids' turf: soft mounds and a crawl tunnel the dog fits through.
  const turf = rgb(H.turf);
  for (const [a, bb, rad, h] of HOME_SLICE.turfMounds) {
    const [x, z] = W(a, bb);
    mb.blob(x, G - h * 0.35, z, rad, h * 1.35, rad, turf, r, 0.08, 0.85);
    block(a, bb, rad * 0.8, h, true); // stand on top of the hill
  }
  const tn = HOME_SLICE.tunnel;
  const segs = 9;
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI, t1 = ((i + 1) / segs) * Math.PI;
    for (const [rad, c, want] of [[tn.r, turf, 1], [tn.r - 0.12, rgb(H.tunnel), -1]] as const) {
      const q = (t: number, bb: number): V3 => P(tn.a + Math.cos(t) * rad, bb, Math.sin(t) * rad);
      const mid = (t0 + t1) / 2;
      const nrm: V3 = [Math.cos(mid) * ux * want, Math.sin(mid) * want, Math.cos(mid) * uz * want];
      mb.face([q(t0, tn.b0), q(t1, tn.b0), q(t1, tn.b1), q(t0, tn.b1)], i % 2 ? c : shade(c, 0.94), nrm);
    }
    // Rims
    for (const bb of [tn.b0, tn.b1]) {
      const q = (t: number, rad: number): V3 => P(tn.a + Math.cos(t) * rad, bb, Math.sin(t) * rad);
      mb.face([q(t0, tn.r - 0.12), q(t1, tn.r - 0.12), q(t1, tn.r), q(t0, tn.r)], shade(turf, 1.1), bb === tn.b0 ? N : S3);
    }
  }
  blockRect(tn.a - tn.r - 0.05, tn.a - tn.r + 0.1, tn.b0, tn.b1, tn.r);
  blockRect(tn.a + tn.r - 0.1, tn.a + tn.r + 0.05, tn.b0, tn.b1, tn.r);

  // --- Helpers that close over the frame ------------------------------------------------------------
  function awning(a0: number, a1: number, style: 'striped' | 'red'): void {
    // Red: box awning (short slope, tall lettered front, as in the photo). Striped: classic sloped awning.
    const red_ = style === 'red';
    const yWall = 3.42, yEdge = red_ ? 3.28 : 2.98, depth = red_ ? 1.05 : 1.0, val = red_ ? 0.46 : 0.2;
    const red = rgb(H.awningRed), blue = rgb(H.awningBlue), white = rgb(H.awningWhite);
    const n = style === 'striped' ? Math.round((a1 - a0) / 0.3) : 1;
    for (let i = 0; i < n; i++) {
      const s0 = a0 + ((a1 - a0) * i) / n, s1 = a0 + ((a1 - a0) * (i + 1)) / n;
      const c = style === 'red' ? red : i % 2 ? white : blue;
      mb.face([P(s0, 0.02, yWall), P(s1, 0.02, yWall), P(s1, depth, yEdge), P(s0, depth, yEdge)], c, [nx, 1, nz]);
      mb.face([P(s0, depth, yEdge), P(s1, depth, yEdge), P(s1, depth, yEdge - val), P(s0, depth, yEdge - val)], shade(c, 0.95), N);
      mb.face([P(s0, 0.02, yWall - 0.02), P(s1, 0.02, yWall - 0.02), P(s1, depth, yEdge - val), P(s0, depth, yEdge - val)], shade(c, 0.55), [0, -1, 0]);
      // Scallops along the valance bottom.
      const k = style === 'red' ? Math.max(1, Math.round((s1 - s0) / 0.3)) : 1;
      for (let j = 0; j < k; j++) {
        const q0 = s0 + ((s1 - s0) * j) / k, q1 = s0 + ((s1 - s0) * (j + 1)) / k;
        mb.face([P(q0, depth, yEdge - val), P(q1, depth, yEdge - val), P((q0 + q1) / 2, depth, yEdge - val - 0.07)], shade(c, 0.95), N);
      }
    }
    for (const a of [a0, a1]) {
      const c = style === 'red' ? red : blue;
      mb.face([P(a, 0.02, yWall), P(a, depth, yEdge), P(a, depth, yEdge - val), P(a, 0.02, yEdge - val)], shade(c, 0.85), a === a0 ? Wd : E);
    }
    if (style === 'red') {
      // Valance text (white on red).
      // Measured on the photo; the valance goes on past PIZZA ("CO…", cut off in the photo): left blank.
      for (const [text, c0, c1] of [['RESTAURANT', 13.8, 12.8], ['AUTHENTIC NY-STYLE PIZZA', 12.5, 9.4]] as const) {
        const [x, z] = W((c0 + c1) / 2, depth + 0.012);
        ctx.labels.push({ text, x, y: G + yEdge - val / 2 + 0.02, z, rot: textRot, width: c0 - c1, height: 0.3, background: null,
          foreground: '#f7f2ea', rows: 0.75 });
      }
    }
  }

  function queenSign(a: number, bb: number): void {
    const [x, z] = W(a, bb);
    const g0 = g(x, z) - G; // ground at the sign, relative to the storefront grade
    const poleC = rgb('#5a5e62'), cab = rgb('#9ea3a6');
    const QW = 2.8, QH = 4.2, bottom = g0 + 4.0;
    // Diagonal to the corner: faces look toward the intersection (n − u) and back into the lot; the
    // sign plane runs along −(u + n) (= the label's +X for that facing).
    const fx_ = (nx - ux) / Math.SQRT2, fz_ = (nz - uz) / Math.SQRT2;
    const px_ = -(ux + nx) / Math.SQRT2, pz_ = -(uz + nz) / Math.SQRT2;
    mb.cylinder(x, G + g0 - 0.2, z, 0.15, x, G + bottom + 0.6, z, 0.13, 8, poleC, null);
    block(a, bb, 0.22);
    // Gray cabinet behind the figure, an arm up to the pie, and the pie's drum (axis along u).
    const along = (t: number): [number, number] => [x + px_ * t, z + pz_ * t];
    const rotN = Math.atan2(-pz_, px_);
    const [cx0, cz0] = along((0.38 - 0.5) * QW);
    mb.box(cx0, G + bottom + 0.5, cz0, 0.5, G + bottom + 2.3, 0.26, cab, rotN, { bottom: true });
    const [cx1, cz1] = along(0.2);
    mb.box(cx1, G + bottom + 2.2, cz1, 0.35, G + bottom + 2.95, 0.26, cab, rotN);
    const pr = 0.32 * QW, pc = along((0.62 - 0.5) * QW), py = G + bottom + QH - 0.23 * QH;
    const N = 18;
    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2;
      const q = (t: number, side: number): V3 => [pc[0] + px_ * Math.cos(t) * pr + fx_ * side * 0.15, py + Math.sin(t) * pr, pc[1] + pz_ * Math.cos(t) * pr + fz_ * side * 0.15];
      const tm = (t0 + t1) / 2;
      mb.face([q(t0, -1), q(t1, -1), q(t1, 1), q(t0, 1)], cab, [px_ * Math.cos(tm), Math.sin(tm), pz_ * Math.cos(tm)]);
    }
    // The cut-out art (both faces).
    ctx.labels.push({
      text: '', art: 'queen', x, y: G + bottom + QH / 2, z, rot: Math.atan2(fx_, fz_), width: QW, height: QH,
      background: null, twoSided: true, thickness: 0.33, rows: 6,
    });
  }

  function multiPanel(a0: number, a1: number, y0: number, y1: number): void {
    const rows = Math.round((y1 - y0) / 0.075), cols = Math.max(2, Math.round((a1 - a0) / 0.2));
    for (let j = 0; j < rows; j++) {
      const off = j % 2 ? 0.5 : 0;
      for (let i = 0; i < cols; i++) {
        const p0 = a0 + ((i + off) * (a1 - a0)) / cols, p1 = Math.min(a1, p0 + (a1 - a0) / cols - 0.01);
        if (p1 - p0 < 0.03) continue;
        const c = multi[Math.floor(r() * multi.length)]!;
        front(p0, p1, y0 + j * 0.075 + 0.006, y0 + (j + 1) * 0.075, 0.025, c);
      }
    }
  }

  function multiWainscot(a0: number, a1: number, y0: number, y1: number): void {
    const rows = Math.round((y1 - y0) / 0.11);
    for (let j = 0; j < rows; j++) {
      const off = j % 2 ? 0.12 : 0;
      for (let a = a0 - off; a < a1; a += 0.24) {
        const p0 = Math.max(a0, a), p1 = Math.min(a1, a + 0.23);
        if (p1 - p0 < 0.04) continue;
        const c = mix(multi[Math.floor(r() * multi.length)]!, brickDark, 0.15);
        front(p0, p1, y0 + j * 0.11 + 0.008, y0 + (j + 1) * 0.11, 0.03, c);
      }
    }
  }

  function tableSet(a: number, bb: number, wa: number, lb: number, top: RGB, chairs: boolean): void {
    // Table top along b, benches (picnic) or chairs on both a-sides.
    box(a, bb, 0.72, 0.77, wa, lb, top, { top: shade(top, 1.05) });
    for (const db of [-lb / 2 + 0.15, lb / 2 - 0.15]) box(a, bb + db, 0, 0.72, 0.08, 0.08, frame);
    for (const s of [-1, 1]) {
      if (chairs) {
        for (const db of [-lb / 4, lb / 4]) {
          box(a + s * (wa / 2 + 0.3), bb + db, 0, 0.45, 0.42, 0.42, frame, { top: rgb(H.tableRed) });
          box(a + s * (wa / 2 + 0.49), bb + db, 0.45, 0.9, 0.05, 0.42, frame);
        }
      } else {
        box(a + s * (wa / 2 + 0.28), bb, 0.4, 0.45, 0.28, lb, rgb(H.tableRed));
        box(a + s * (wa / 2 + 0.28), bb, 0, 0.4, 0.06, lb - 0.3, frame);
      }
    }
    blockRect(a - wa / 2 - 0.45, a + wa / 2 + 0.45, bb - lb / 2, bb + lb / 2, 0.77, true);
  }
}
