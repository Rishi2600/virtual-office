// Generates client/public/assets/tiles.png: Lamports' office tileset, drawn in
// code (owner decision: we make our own art). Each tile is painted on a 16px
// pixel grid and written at 2x, giving 32px tiles with crisp "fat" pixels.
// Avatars are not here: the client draws them from code (avatarArt.ts).
//
// Re-run with `npm run gen:tileset` after changing a painter, then
// `node scripts/gen-map.mjs` if the catalogue in tiles.mjs changed.
import { writeFileSync, mkdirSync } from "node:fs";
import { canvas, encodePNG } from "./png.mjs";
import { ART, COLUMNS, SCALE, TILES } from "./tiles.mjs";

const OUT = new URL("../client/public/assets/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ colours
const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const C = {
  floor: hex("#3a3f4a"), floorSeam: hex("#353a44"), floorAlt: hex("#363b45"),
  carpet: hex("#2c3550"), carpetAlt: hex("#2a324b"),
  rug: hex("#4b3d5e"), rugEdge: hex("#3b3348"), rugAlt: hex("#55466b"),
  tileA: hex("#3c4350"), tileB: hex("#343a46"), tileLine: hex("#2e333e"),
  mat: hex("#2d2f39"), matEdge: hex("#9945ff"),
  wallTop: hex("#5c6577"), wallTopHi: hex("#6d778b"), wallFace: hex("#262b35"), wallLine: hex("#1d2129"),
  glass: hex("#96beff", 90), glassHi: hex("#c8dcff", 160),
  wood: hex("#6d5a47"), woodHi: hex("#8a7660"), woodDark: hex("#4a3d31"), woodGrain: hex("#655343"),
  screenFrame: hex("#15181f"), screenA: hex("#3f7ae0"), screenB: hex("#9945ff"), screenC: hex("#2f8f88"), screenGlint: hex("#c9d6ff"),
  fabric: hex("#5b4b7a"), fabricHi: hex("#6c5a91"), fabricDark: hex("#4d3f68"),
  leaf: hex("#2f8f5b"), leafHi: hex("#3fb877"), leafLight: hex("#57d08e"), pot: hex("#8a5a3c"), potHi: hex("#a8724f"),
  counterTop: hex("#7d8696"), counterHi: hex("#99a2b1"), counterFront: hex("#4f5766"), handle: hex("#2f3540"),
  steel: hex("#a9b1be"), steelHi: hex("#c4cad4"), steelDark: hex("#7c8594"),
  chair: hex("#262a33"), chairHi: hex("#343945"), chairLeg: hex("#1b1e25"),
  board: hex("#e9edf3"), ink1: hex("#9945ff"), ink2: hex("#14b87a"), tv: hex("#11151c"), tvGlow: hex("#2b4b7a"),
  bookA: hex("#9945ff"), bookB: hex("#14b87a"), bookC: hex("#ef6b6b"), bookD: hex("#f2b13b"),
};

// deterministic per-pixel noise so surfaces have a little texture
const noise = (x, y, seed = 0) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

// ------------------------------------------------------------------ painters
// Each painter gets a pen p(x, y, w, h, colour) in 16px art space.
const floorLike = (p, base, alt, seed, seams = true) => {
  for (let y = 0; y < ART; y++) for (let x = 0; x < ART; x++) {
    let c = base;
    if (seams && y === 15) c = C.floorSeam;
    else if (noise(x, y, seed) > 0.93) c = alt;
    p(x, y, 1, 1, c);
  }
};
const wallBlock = (p) => {
  p(0, 0, 16, 5, C.wallTop); p(0, 0, 16, 1, C.wallTopHi);
  p(0, 5, 16, 11, C.wallFace); p(0, 5, 16, 1, C.wallLine);
};
const deskBase = (p, edge) => {
  p(0, 5, 16, 8, C.wood); p(0, 5, 16, 1, C.woodHi); p(0, 13, 16, 3, C.woodDark);
  for (let x = 0; x < 16; x += 5) p(x + 2, 8, 3, 1, C.woodGrain);
  if (edge === "l") { p(0, 5, 1, 11, C.woodDark); }
  if (edge === "r") { p(15, 5, 1, 11, C.woodDark); }
};
const monitor = (p, x, screen) => {
  p(x, 0, 8, 6, C.screenFrame); p(x + 1, 1, 6, 4, screen); p(x + 2, 1, 2, 1, C.screenGlint); p(x + 3, 6, 2, 2, C.screenFrame);
};
const table = (p, row, edge) => {
  if (row === "t") { p(0, 4, 16, 12, C.wood); p(0, 4, 16, 1, C.woodHi); }
  else { p(0, 0, 16, 10, C.wood); p(0, 10, 16, 3, C.woodDark); }
  for (let x = 1; x < 16; x += 6) p(x, row === "t" ? 9 : 5, 4, 1, C.woodGrain);
  if (edge === "l") p(0, row === "t" ? 4 : 0, 1, row === "t" ? 12 : 13, C.woodDark);
  if (edge === "r") p(15, row === "t" ? 4 : 0, 1, row === "t" ? 12 : 13, C.woodDark);
};
const sofa = (p, part) => {
  p(0, 2, 16, 6, C.fabricHi); p(0, 7, 16, 7, C.fabric); p(0, 14, 16, 1, C.fabricDark);
  if (part === "l") { p(0, 3, 3, 12, C.fabricDark); }
  if (part === "r") { p(13, 3, 3, 12, C.fabricDark); }
  if (part === "m") { p(7, 8, 1, 6, C.fabricDark); }
};
const counter = (p, part) => {
  p(0, 3, 16, 6, C.counterTop); p(0, 3, 16, 1, C.counterHi); p(0, 9, 16, 7, C.counterFront);
  p(3, 11, 3, 1, C.handle); p(10, 11, 3, 1, C.handle);
  if (part === "l") p(0, 3, 1, 13, C.handle);
  if (part === "r") p(15, 3, 1, 13, C.handle);
};
const chair = (p, facing) => {
  p(3, 4, 10, 8, C.chair); p(4, 5, 8, 5, C.chairHi);
  if (facing === "up") p(3, 11, 10, 3, C.chair); // backrest towards the viewer
  else p(3, 2, 10, 3, C.chair);
  p(4, 14, 2, 2, C.chairLeg); p(10, 14, 2, 2, C.chairLeg);
};

const PAINT = {
  floor: (p) => floorLike(p, C.floor, C.floorAlt, 1),
  floor_b: (p) => { floorLike(p, C.floor, C.floorAlt, 7); p(0, 7, 16, 1, C.floorSeam); },
  carpet: (p) => floorLike(p, C.carpet, C.carpetAlt, 3, false),
  rug: (p) => floorLike(p, C.rug, C.rugAlt, 4, false),
  kitchen: (p) => { p(0, 0, 8, 8, C.tileA); p(8, 8, 8, 8, C.tileA); p(8, 0, 8, 8, C.tileB); p(0, 8, 8, 8, C.tileB); p(0, 15, 16, 1, C.tileLine); p(15, 0, 1, 16, C.tileLine); },
  mat: (p) => { p(0, 2, 16, 12, C.mat); p(0, 2, 16, 1, C.matEdge); p(0, 13, 16, 1, C.matEdge); },

  wall: (p) => wallBlock(p),
  wall_window: (p) => { wallBlock(p); p(3, 6, 10, 7, hex("#3e5a7a")); p(4, 7, 3, 1, hex("#7aa7d6")); p(8, 6, 1, 7, C.wallFace); },
  wall_side: (p) => { p(5, 0, 6, 16, C.wallTop); p(5, 0, 1, 16, C.wallTopHi); p(11, 0, 1, 16, C.wallLine); },
  glass_h: (p) => { p(0, 6, 16, 3, C.glass); p(0, 6, 16, 1, C.glassHi); },
  glass_v: (p) => { p(6, 0, 3, 16, C.glass); p(6, 0, 1, 16, C.glassHi); },
  whiteboard: (p) => { wallBlock(p); p(1, 6, 14, 8, C.board); p(3, 8, 8, 1, C.ink1); p(3, 10, 6, 1, C.ink2); },
  tv: (p) => { wallBlock(p); p(1, 6, 14, 8, C.tv); p(2, 7, 12, 6, C.tvGlow); p(3, 8, 4, 1, C.screenGlint); },

  desk_l: (p) => { deskBase(p, "l"); monitor(p, 4, C.screenA); },
  desk_m: (p) => { deskBase(p); monitor(p, 4, C.screenC); },
  desk_m2: (p) => { deskBase(p); monitor(p, 4, C.screenB); },
  desk_r: (p) => { deskBase(p, "r"); monitor(p, 4, C.screenA); },
  table_tl: (p) => table(p, "t", "l"), table_tm: (p) => table(p, "t"), table_tr: (p) => table(p, "t", "r"),
  table_bl: (p) => table(p, "b", "l"), table_bm: (p) => table(p, "b"), table_br: (p) => table(p, "b", "r"),

  sofa_l: (p) => sofa(p, "l"), sofa_m: (p) => sofa(p, "m"), sofa_r: (p) => sofa(p, "r"),
  coffee_table: (p) => { p(2, 5, 12, 7, C.wood); p(2, 5, 12, 1, C.woodHi); p(2, 12, 12, 2, C.woodDark); p(6, 7, 3, 2, hex("#e9edf3")); },
  plant: (p) => { p(4, 10, 8, 6, C.pot); p(4, 10, 8, 1, C.potHi); p(2, 2, 12, 9, C.leaf); p(4, 0, 8, 5, C.leafHi); p(6, 3, 3, 3, C.leafLight); },
  bookshelf: (p) => {
    p(1, 0, 14, 16, C.woodDark); p(2, 1, 12, 14, C.wood);
    for (const y of [1, 6, 11]) { [C.bookA, C.bookB, C.bookC, C.bookD].forEach((c, i) => p(3 + i * 3, y, 2, 4, c)); p(2, y + 4, 12, 1, C.woodDark); }
  },
  counter_l: (p) => counter(p, "l"), counter_m: (p) => counter(p, "m"), counter_r: (p) => counter(p, "r"),
  counter_coffee: (p) => { counter(p, "m"); p(4, 0, 8, 7, C.screenFrame); p(5, 1, 2, 2, hex("#14f195")); p(8, 4, 3, 2, C.steel); },
  fridge: (p) => { p(2, 0, 12, 16, C.steel); p(2, 0, 12, 1, C.steelHi); p(2, 6, 12, 1, C.steelDark); p(11, 2, 1, 3, C.steelDark); p(11, 8, 1, 5, C.steelDark); },

  chair_up: (p) => chair(p, "up"),
  chair_down: (p) => chair(p, "down"),
};

// ------------------------------------------------------------------- output
const T = ART * SCALE;
const rows = Math.ceil(TILES.length / COLUMNS);
const sheet = canvas(COLUMNS * T, rows * T);
TILES.forEach((name, i) => {
  const paint = PAINT[name];
  if (!paint) throw new Error(`no painter for tile "${name}"`);
  const ox = (i % COLUMNS) * T, oy = Math.floor(i / COLUMNS) * T;
  // the pen draws 16px art pixels as SCALE x SCALE blocks
  const pen = (x, y, w, h, colour) => sheet.fillRect(ox + x * SCALE, oy + y * SCALE, w * SCALE, h * SCALE, colour);
  paint(pen);
});
writeFileSync(new URL("tiles.png", OUT), encodePNG(sheet));
console.log(`tiles.png  ${sheet.width}x${sheet.height} (${TILES.length} tiles, ${COLUMNS} per row)`);
