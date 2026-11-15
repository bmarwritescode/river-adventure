/**
 * Gray-box map colors (CSS colors, painted into each tile's ground texture) and building shading.
 * Art direction (Step 5) will replace these; changing them needs no pipeline re-run.
 */
export const MAP_STYLE = {
  ground: '#8fa77c', // bare ground / yards: muted green
  layers: {
    grass: '#86b06e',
    wood: '#5f8f55',
    pitch: '#9fc27a',
    parking: '#8c8c8c',
    water: '#4f86c6',
    sidewalk: '#c9c9c4',
    road: '#4a4a4c',
    rail: '#6b5f55',
  },
  /** Painted canopy circles for OSM tree points (3D trees come in Step 7). */
  treeCanopy: 'rgba(52, 92, 46, 0.85)',
  treeCanopyRadius: 3.0,
  /** Building wall/roof gray (0..1) and per-building random variation. */
  buildingWall: 0.82,
  buildingRoof: 0.68,
  buildingVariation: 0.07,
  /** Buildings are sunk this far below their lowest corner so slopes never show a gap. */
  buildingSink: 0.4,
};

export type MapStyle = typeof MAP_STYLE;
