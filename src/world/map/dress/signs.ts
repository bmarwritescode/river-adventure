import type { MeshArrays } from '../buildTile';
import type { TileSign } from '../types';
import type { DressContext, LabelRequest } from './houses';

/**
 * Text signs: street-name blades, STOP text, shop fronts. Each sign is a textured quad; all of a
 * tile's sign texts are painted into one small atlas (one texture + one draw call per tile).
 */

const ROW = 64; // atlas row height, px
const ATLAS_W = 512;

export interface SignMeshResult {
  mesh: MeshArrays & { uvs: Float32Array };
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface SignPainter {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

interface Quad extends LabelRequest { twoSided: boolean; foreground: string; border: boolean }

/** Street-name blades for each sign post (two blades, both sides readable). */
export function streetSignLabels(ctx: DressContext, signs: TileSign[] | undefined): Quad[] {
  const out: Quad[] = [];
  for (const s of signs ?? []) {
    const y = ctx.hm ? ctx.hm.sample(s.x, s.z) : 0;
    for (const [text, rot, h] of [[s.a, s.ar, 2.96], [s.b, s.br, 3.2]] as const) {
      // Blade rot lays local +X along the street; its face (local +Z) is perpendicular to it.
      out.push({
        text, x: s.x, y: y + h, z: s.z, rot, width: Math.max(0.9, 0.105 * text.length + 0.25), height: 0.22,
        background: ctx.style.streetSign, foreground: '#f6f6f2', border: true, twoSided: true,
      });
    }
  }
  return out;
}

export function buildSignMesh(labels: LabelRequest[], blades: Quad[], newCanvas: (w: number, h: number) => SignPainter | null): SignMeshResult | null {
  const quads: Quad[] = [
    ...labels.map((l) => ({ ...l, twoSided: false, foreground: '#f7f4ea', border: false })),
    ...blades,
  ];
  if (!quads.length) return null;
  const H = quads.length * ROW;
  const g = newCanvas(ATLAS_W, H);
  if (!g) return null;

  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  quads.forEach((q, i) => {
    const pw = Math.min(ATLAS_W, Math.round((ROW * q.width) / q.height));
    const y0 = i * ROW;
    g.fillStyle = q.background;
    g.fillRect(0, y0, pw, ROW);
    if (q.border) {
      g.strokeStyle = q.foreground;
      g.lineWidth = 3;
      g.strokeRect(4, y0 + 4, pw - 8, ROW - 8);
    }
    g.fillStyle = q.foreground;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 40;
    g.font = `bold ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const maxW = pw - 18;
    const w = g.measureText(q.text).width;
    if (w > maxW) {
      size = Math.max(14, Math.floor((size * maxW) / w));
      g.font = `bold ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    }
    g.fillText(q.text, pw / 2, y0 + ROW / 2 + 2);

    const u0 = 0, u1 = pw / ATLAS_W, v0 = y0 / H, v1 = (y0 + ROW) / H; // v0 = top row (flipY off)
    const rx = Math.cos(q.rot), rz = -Math.sin(q.rot); // local +X (text direction)
    const nx = Math.sin(q.rot), nz = Math.cos(q.rot); // local +Z (facing)
    const hw = q.width / 2, hh = q.height / 2;
    const addFace = (sx: number, off: number, n: number): void => {
      const base = pos.length / 3;
      const cx = q.x + nx * off, cz = q.z + nz * off;
      // BL, BR, TR, TL as seen by the viewer of this face (sx = +1 front, −1 back: mirrored X)
      const corners: [number, number, number, number][] = [[-hw, -hh, u0, v1], [hw, -hh, u1, v1], [hw, hh, u1, v0], [-hw, hh, u0, v0]];
      for (const [a, b, u, v] of corners) {
        pos.push(cx + rx * a * sx, q.y + b, cz + rz * a * sx);
        nor.push(nx * n, 0, nz * n);
        uv.push(u, v);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    addFace(1, 0.006, 1);
    if (q.twoSided) addFace(-1, -0.006, -1);
  });
  const pixels = new Uint8Array(g.getImageData(0, 0, ATLAS_W, H).data.buffer);
  return {
    mesh: { positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), indices: new Uint32Array(idx) },
    pixels, width: ATLAS_W, height: H,
  };
}
