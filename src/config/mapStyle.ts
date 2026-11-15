/**
 * Map look: ground colors (painted into each tile's ground texture), the gray-box building shading
 * outside the dressed area, and the art-direction palette for dressed blocks (Step 5).
 * Changing these needs no pipeline re-run. See docs/art-direction.md for the rules behind them.
 */
export const MAP_STYLE = {
  /** Bare ground / lawns: Austin St. Augustine grass in summer, a little dry. */
  ground: '#8ea566',
  /** Large soft color variation painted over the lawn (0 = flat). */
  groundMottle: 0.07,
  layers: {
    grass: '#8bac63',
    wood: '#5f8a4c',
    pitch: '#97b964',
    bed: '#6e5a45', // mulch / bare dirt along foundations
    turf: '#5aa83c', // artificial turf (kids' area at Home Slice)
    parking: '#7d7c79',
    patio: '#a39d93', // stained concrete patio slab
    water: '#5b8fb8',
    driveway: '#c4beb1',
    walk: '#cdc8bc',
    sidewalk: '#cbc6ba',
    road: '#5e5e62',
    rail: '#6b5f55',
  },
  /** Painted canopy circles for OSM tree points outside the dressed area (3D trees come in Step 7). */
  treeCanopy: 'rgba(52, 92, 46, 0.85)',
  treeCanopyRadius: 3.0,
  /** Gray-box building wall/roof gray (0..1) and per-building random variation. */
  buildingWall: 0.82,
  buildingRoof: 0.68,
  buildingVariation: 0.07,
  /** Buildings are sunk this far below their lowest corner so slopes never show a gap. */
  buildingSink: 0.4,

  /** Dressed-area palette. Arrays are picked from by a stable per-building/prop seed. */
  dress: {
    // Hyde Park bungalows: soft painted wood siding, white trim, gray/brown shingle or metal roofs.
    houseWalls: ['#f2efe6', '#efe3c4', '#e6d6a8', '#c9d4b8', '#b8c9b1', '#bfd0dc', '#a9bccb', '#d9c2b0',
      '#e8e1d3', '#9fb3a2', '#d8d2c4', '#c7b79b'],
    trims: ['#fbfaf5', '#fbfaf5', '#fbfaf5', '#f1ead8', '#4f5a52', '#6b4e3a'],
    roofs: ['#5d6066', '#6e6b66', '#4c4f55', '#7c776f', '#8f9496', '#a7adb0', '#6b5a4c', '#556259'],
    doors: ['#7b2f2a', '#2f4a5c', '#2e5240', '#8a5a33', '#3a3a3c', '#b8892e', '#f4f1e8'],
    skirting: '#5a524a',
    glass: '#3c4e5c',
    glassVariation: 0.08,
    chimney: '#9a5b45',
    porchFloor: '#9c9488',
    garageWalls: ['#e9e4d8', '#d6cdbb', '#c4ccc0', '#b9b2a6'],
    shopWalls: ['#e4dccd', '#c8b59a', '#d5d1c8', '#b9a48b'],
    shopSign: '#2f4f3f',
    aptWalls: ['#d8c8ad', '#cdbfa8', '#e0d8c8'],
    /** Darken vertex colors toward the ground (fake ambient occlusion), 0..1. */
    wallAO: 0.22,

    // Trees: live oak (dark, wide), pecan (tall, yellow-green), cedar elm, crepe myrtle (flowers).
    oakLeaves: ['#476a32', '#52753a', '#3f602c'],
    pecanLeaves: ['#6a8a3c', '#759642', '#617f37'],
    elmLeaves: ['#557a39', '#608641', '#4e7134'],
    myrtleFlowers: ['#d76b9a', '#c25b8a', '#e7a3c0', '#f3eef2', '#a77bc4'],
    myrtleLeaves: '#557a3b',
    shrubLeaves: ['#3f6a35', '#4c7840', '#56743a'],
    bark: '#5a4a3d',
    myrtleBark: '#b59a82',
    leafVariation: 0.06,

    // Street furniture
    curb: '#d2cdc2',
    pole: '#6d5c4a',
    wire: '#2b2b2b',
    metal: '#9aa0a3',
    signalHead: '#2f3133',
    streetSign: '#1f6b45',
    stopSign: '#c62b28',
    hydrant: '#e3c13b',
    hydrantCap: '#d8d8d8',
    cartTrash: '#2c2d2f',
    cartRecycle: '#2f5fa8',
    cars: ['#c9ccd0', '#2f3236', '#f2f2f0', '#7f1d1d', '#2e4a73', '#8a8f94', '#4b5a3c', '#b5a48a'],
    carGlass: '#3f5262',
    tire: '#202022',
    marks: { yellow2: '#e3bf45', white: '#e9e8e2', stop: '#e9e8e2' },

    // Fences: weathered cedar privacy fences, white pickets, galvanized chain link, black iron.
    fenceWood: ['#9a7b5c', '#8a6c4f', '#a88a68'],
    fenceCedar: '#a0714a',
    fencePicket: '#f1efe8',
    fenceChain: '#a9aeb0',
    fenceIron: '#26282a',

    // Home Slice Pizza (501 E 53rd), from press photos: aged orange-brown brick, a black sign band
    // with gold and silver sequined letters, blue/white striped and red awnings, white tile and
    // multicolor brick wainscots, black storefront frames with brass push bars.
    homeSlice: {
      brick: '#eab58c', // the storefront faces north (always in shade): light, so it reads like the photo
      brickDark: '#c98f66',
      mortar: '#b9a08a',
      multiBrick: ['#3a3940', '#8c2f2b', '#41506e', '#b4875a', '#5b2a2a', '#2c2c30'],
      tile: '#eeeeea',
      signBand: '#1b1c1f',
      gold: '#f0d690',
      silver: '#f1f2f4',
      frame: '#17181a',
      brass: '#c7a34d',
      awningRed: '#b01f28',
      awningBlue: '#20304f',
      awningWhite: '#f2f1ec',
      roof: '#cfccc5',
      hvac: '#a9adb0',
      scaffold: '#2f4a3a', // NYC sidewalk-shed green
      metalRoof: '#b7c3c8',
      soffit: '#b9b29c', // plywood under the shed deck
      sail: '#c9ad6e',
      bar: ['#d9862c', '#e9b23a', '#7a4a2a', '#efe1c0'], // '70s t-shirt stripes on the patio bar tiles
      tableRed: '#b3262b',
      bench: '#7a5a3e',
      turf: '#5aa83c',
      tunnel: '#c9c4b8',
    },
  },
};

export type MapStyle = typeof MAP_STYLE;
export type DressStyle = MapStyle['dress'];
