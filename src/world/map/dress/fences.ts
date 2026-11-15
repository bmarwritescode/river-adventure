import type { TileFence } from '../types';
import type { DressContext } from './houses';
import { jitter, rgb, shade, type MeshBuilder, type RGB } from './MeshBuilder';

/**
 * Fences along polylines from the pipeline (yard fences, the vet's privacy fence, landmark patios).
 * Each panel follows the terrain from post to post. Kinds:
 *   wood    tall privacy fence, vertical cedar boards (weathered, board-to-board color variation)
 *   cedar   modern horizontal slats with gaps
 *   picket  white pickets with pointed tops and two rails
 *   chain   galvanized chain link: pipe posts, top rail, diamond wire lattice
 *   iron    black metal bars between two rails
 *   hogwire cedar posts, top rail and bottom board framing welded-wire panels
 * Collision: one thin box per segment that blocks the dog but not the camera (height 0).
 */

const POST_SPACING: Record<TileFence['t'], number> = { wood: 2.4, cedar: 2.4, picket: 2.4, chain: 3.0, iron: 2.0, hogwire: 2.4 };
const COLLIDE_HALF_WIDTH = 0.12;

type V3 = [number, number, number];

/** Double-sided vertical quad between two ground points (bottom offsets b0/b1, top offsets t0/t1). */
function sheet(mb: MeshBuilder, ax: number, az: number, ya: number, bx: number, bz: number, yb: number,
  y0: number, y1: number, nx: number, nz: number, off: number, color: RGB, back: RGB = shade(color, 0.86)): void {
  const p = (x: number, z: number, y: number, o: number): V3 => [x + nx * o, y, z + nz * o];
  mb.face([p(ax, az, ya + y0, off), p(bx, bz, yb + y0, off), p(bx, bz, yb + y1, off), p(ax, az, ya + y1, off)], color, [nx, 0, nz]);
  mb.face([p(ax, az, ya + y0, -off), p(bx, bz, yb + y0, -off), p(bx, bz, yb + y1, -off), p(ax, az, ya + y1, -off)], back, [-nx, 0, -nz]);
}

/** Horizontal rail (thin box along the segment) from y0 to y1 above the ground line. */
function rail(mb: MeshBuilder, ax: number, az: number, ya: number, bx: number, bz: number, yb: number,
  y0: number, y1: number, nx: number, nz: number, t: number, color: RGB): void {
  sheet(mb, ax, az, ya, bx, bz, yb, y0, y1, nx, nz, t / 2, color, shade(color, 0.9));
  const p = (x: number, z: number, y: number, o: number): V3 => [x + nx * o, y, z + nz * o];
  mb.face([p(ax, az, ya + y1, t / 2), p(bx, bz, yb + y1, t / 2), p(bx, bz, yb + y1, -t / 2), p(ax, az, ya + y1, -t / 2)], shade(color, 1.05), [0, 1, 0]);
}

export function buildFences(ctx: DressContext, fences: TileFence[] | undefined): number {
  if (!fences?.length) return 0;
  const mb = ctx.mb, S = ctx.style;
  mb.resetTransform();
  const g = (x: number, z: number): number => (ctx.hm ? ctx.hm.sample(x, z) : 0);
  const woods = S.fenceWood.map(rgb), cedar = rgb(S.fenceCedar), picket = rgb(S.fencePicket);
  const chain = rgb(S.fenceChain), iron = rgb(S.fenceIron);
  let count = 0;

  for (const f of fences) {
    const p = f.p, h = f.h;
    count++;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k]!, az = p[k + 1]!, bx = p[k + 2]!, bz = p[k + 3]!;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      const nx = -tz, nz = tx;
      // Collision: thin box along the segment (dog only).
      const w = COLLIDE_HALF_WIDTH;
      ctx.obstacles.push({
        ring: [ax + nx * w, az + nz * w, bx + nx * w, bz + nz * w, bx - nx * w, bz - nz * w, ax - nx * w, az - nz * w],
        base: Math.min(g(ax, az), g(bx, bz)) - 0.3, height: 0,
        top: Math.max(g(ax, az), g(bx, bz)) + h, // jump over it (not onto it)
      });
      const panels = Math.max(1, Math.round(L / POST_SPACING[f.t]));
      const pl = L / panels;
      for (let i = 0; i < panels; i++) {
        const x0 = ax + tx * pl * i, z0 = az + tz * pl * i;
        const x1 = x0 + tx * pl, z1 = z0 + tz * pl;
        const y0 = g(x0, z0), y1 = g(x1, z1);
        // Post at the panel start (and at the very end of the segment).
        const post = (x: number, z: number, y: number): void => {
          if (f.t === 'chain') mb.cylinder(x, y - 0.2, z, 0.035, x, y + h + 0.04, z, 0.035, 5, chain, chain);
          else if (f.t === 'iron') mb.box(x, y - 0.2, z, 0.06, y + h + 0.06, 0.06, iron);
          else if (f.t === 'hogwire') mb.box(x, y - 0.2, z, 0.1, y + h + 0.04, 0.1, shade(cedar, 0.85));
          else if (f.t === 'picket') mb.box(x, y - 0.2, z, 0.1, y + h + 0.06, 0.1, picket, 0, { top: shade(picket, 1.04) });
          else mb.box(x, y - 0.2, z, 0.11, y + h + 0.03, 0.11, shade(f.t === 'cedar' ? cedar : woods[0]!, 0.8));
        };
        post(x0, z0, y0);
        if (i === panels - 1) post(x1, z1, y1);
        const at = (t: number): [number, number, number] => [x0 + tx * t, z0 + tz * t, y0 + (y1 - y0) * (t / pl)];

        switch (f.t) {
          case 'wood': {
            // Vertical boards, flush (a privacy fence), slightly varied in tone.
            const bw = 0.14;
            const n = Math.max(1, Math.round(pl / bw));
            for (let j = 0; j < n; j++) {
              const [qx0, qz0, qy0] = at((j / n) * pl), [qx1, qz1, qy1] = at(((j + 1) / n) * pl);
              const c = jitter(woods[(j * 7 + i * 3 + k) % woods.length]!, ((j * 37 + i * 11) % 10) / 10, 0.06);
              sheet(mb, qx0, qz0, qy0, qx1, qz1, qy1, 0.02, h, nx, nz, 0.012, c);
            }
            rail(mb, x0, z0, y0, x1, z1, y1, h - 0.02, h + 0.04, nx, nz, 0.09, shade(woods[0]!, 0.95)); // cap
            break;
          }
          case 'cedar': {
            const slats = Math.max(3, Math.round(h / 0.17));
            const sh = h / slats;
            for (let j = 0; j < slats; j++) {
              const c = jitter(cedar, (j * 0.37) % 1, 0.07);
              sheet(mb, x0, z0, y0, x1, z1, y1, j * sh + 0.03, (j + 1) * sh, nx, nz, 0.012, c);
            }
            break;
          }
          case 'picket': {
            rail(mb, x0, z0, y0, x1, z1, y1, 0.22, 0.3, nx, nz, 0.05, shade(picket, 0.92));
            rail(mb, x0, z0, y0, x1, z1, y1, h - 0.3, h - 0.22, nx, nz, 0.05, shade(picket, 0.92));
            const step = 0.16, pw = 0.09;
            const n = Math.max(1, Math.floor(pl / step));
            for (let j = 0; j < n; j++) {
              const t = (j + 0.5) * (pl / n);
              const [cx, cz, cy] = at(t);
              const lx = cx - tx * pw / 2, lz = cz - tz * pw / 2, rx = cx + tx * pw / 2, rz = cz + tz * pw / 2;
              const o = 0.035;
              sheet(mb, lx, lz, cy, rx, rz, cy, 0.04, h - 0.08, nx, nz, o, picket);
              for (const s of [1, -1]) {
                mb.face([[lx + nx * o * s, cy + h - 0.08, lz + nz * o * s], [rx + nx * o * s, cy + h - 0.08, rz + nz * o * s],
                  [cx + nx * o * s, cy + h, cz + nz * o * s]], s > 0 ? picket : shade(picket, 0.86), [nx * s, 0, nz * s]);
              }
            }
            break;
          }
          case 'chain': {
            // Top rail + diamond lattice of thin wires.
            rail(mb, x0, z0, y0, x1, z1, y1, h - 0.03, h + 0.02, nx, nz, 0.05, chain);
            const sp = 0.32, hw = 0.008;
            const wire = shade(chain, 0.85);
            for (const dir of [1, -1]) {
              // lines y = dir * t + c (slope 1 in the fence plane), clipped to [0, pl] x [0.05, h]
              for (let c = -h; c < pl + h; c += sp) {
                const tA = Math.max(0, dir > 0 ? c : c - h), tB = Math.min(pl, dir > 0 ? c + h : c);
                if (tB - tA < 0.05) continue;
                const yA = dir > 0 ? tA - c : c - tA, yB = dir > 0 ? tB - c : c - tB;
                const [qx0, qz0, qy0] = at(tA), [qx1, qz1, qy1] = at(tB);
                const a: V3 = [qx0, qy0 + Math.max(0.05, Math.min(h, yA)), qz0], b: V3 = [qx1, qy1 + Math.max(0.05, Math.min(h, yB)), qz1];
                for (const s of [1, -1]) {
                  mb.face([[a[0], a[1] - hw * 2, a[2]], [b[0], b[1] - hw * 2, b[2]], [b[0], b[1] + hw * 2, b[2]], [a[0], a[1] + hw * 2, a[2]]], wire, [nx * s, 0, nz * s]);
                }
              }
            }
            break;
          }
          case 'hogwire': {
            const wood = shade(cedar, 0.95), wire = rgb(S.fenceChain);
            rail(mb, x0, z0, y0, x1, z1, y1, h - 0.1, h, nx, nz, 0.09, wood);
            rail(mb, x0, z0, y0, x1, z1, y1, 0.0, 0.14, nx, nz, 0.05, shade(wood, 0.9));
            const hw2 = 0.007;
            for (let y = 0.25; y < h - 0.1; y += 0.15) {
              sheet(mb, x0, z0, y0, x1, z1, y1, y - hw2, y + hw2, nx, nz, 0.006, wire); // horizontal wires
            }
            const n = Math.max(1, Math.round(pl / 0.15));
            for (let j = 1; j < n; j++) {
              const [cx, cz, cy] = at((j / n) * pl);
              sheet(mb, cx - tx * hw2, cz - tz * hw2, cy, cx + tx * hw2, cz + tz * hw2, cy, 0.14, h - 0.1, nx, nz, 0.006, wire);
            }
            break;
          }
          case 'iron': {
            rail(mb, x0, z0, y0, x1, z1, y1, 0.08, 0.13, nx, nz, 0.04, iron);
            rail(mb, x0, z0, y0, x1, z1, y1, h - 0.06, h, nx, nz, 0.04, iron);
            const n = Math.max(1, Math.round(pl / 0.13));
            for (let j = 1; j < n; j++) {
              const [cx, cz, cy] = at((j / n) * pl);
              sheet(mb, cx - tx * 0.012, cz - tz * 0.012, cy, cx + tx * 0.012, cz + tz * 0.012, cy, 0.08, h, nx, nz, 0.012, iron);
            }
            break;
          }
        }
      }
    }
  }
  return count;
}
