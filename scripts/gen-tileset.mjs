// Generates client/public/assets/tiles.png and avatars.png.
// Committed output; re-run with `npm run gen:tileset` if you tweak the art.
import { writeFileSync, mkdirSync } from "node:fs";
import { canvas, encodePNG } from "./png.mjs";

const T = 32; // tile size
const OUT = new URL("../client/public/assets/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// deterministic per-pixel noise so tiles have subtle texture instead of flat fill
const noise = (x, y, seed = 0) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const shade = ([r, g, b], amt) => [
  Math.max(0, Math.min(255, Math.round(r + amt))),
  Math.max(0, Math.min(255, Math.round(g + amt))),
  Math.max(0, Math.min(255, Math.round(b + amt))),
  255,
];

// ---------------------------------------------------------------- tiles.png
const TILE_PAINTERS = [
  // 1: floor — warm light boards with faint plank seams
  (c, ox) => {
    const base = [216, 210, 198];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      let col = shade(base, (noise(x, y, 1) - 0.5) * 10);
      if (y % 16 === 15) col = shade(base, -18);          // plank seam
      if (x % 32 === 31) col = shade(base, -10);
      c.set(ox + x, y, col);
    }
  },
  // 2: wall — dark slate block with a lit top edge (fake height)
  (c, ox) => {
    const base = [59, 66, 82];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      let col = shade(base, (noise(x, y, 2) - 0.5) * 8);
      if (y < 5) col = shade([76, 86, 106], (noise(x, y, 3) - 0.5) * 8); // top highlight
      if (y === 5) col = shade(base, -22);
      if (y === T - 1) col = shade(base, -28);
      c.set(ox + x, y, col);
    }
  },
  // 3: desk — wood surface with border + a monitor hint
  (c, ox) => {
    const wood = [163, 116, 63];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++)
      c.set(ox + x, y, shade(wood, (noise(x, y * 3, 4) - 0.5) * 16));
    for (let x = 0; x < T; x++) { c.set(ox + x, 0, shade(wood, 26)); c.set(ox + x, T - 1, shade(wood, -34)); }
    for (let y = 0; y < T; y++) { c.set(ox, y, shade(wood, -22)); c.set(ox + T - 1, y, shade(wood, -22)); }
    c.fillRect(ox + 9, 6, 14, 9, [40, 44, 52, 255]);      // monitor
    c.fillRect(ox + 10, 7, 12, 7, [108, 153, 187, 255]);  // screen
    c.fillRect(ox + 14, 15, 4, 3, [40, 44, 52, 255]);     // stand
  },
  // 4: plant — floor with a leafy blob in a pot
  (c, ox) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++)
      c.set(ox + x, y, shade([216, 210, 198], (noise(x, y, 1) - 0.5) * 10));
    c.fillRect(ox + 12, 22, 8, 8, [140, 88, 62, 255]);    // pot
    c.fillRect(ox + 11, 21, 10, 2, [160, 104, 74, 255]);
    c.circle(ox + 16, 14, 8, [76, 132, 74, 255]);
    c.circle(ox + 12, 12, 5, [96, 158, 92, 255]);
    c.circle(ox + 20, 16, 4, [62, 112, 62, 255]);
  },
  // 5: carpet — meeting-room teal with a woven speckle
  (c, ox) => {
    const base = [74, 124, 124];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const n = noise(x, y, 5);
      c.set(ox + x, y, shade(base, (n - 0.5) * 14 + ((x + y) % 4 === 0 ? 6 : 0)));
    }
  },
  // 6: window — wall with a bright glass pane
  (c, ox) => {
    const base = [59, 66, 82];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) c.set(ox + x, y, shade(base, (noise(x, y, 2) - 0.5) * 8));
    c.fillRect(ox + 4, 6, 24, 18, [150, 194, 214, 255]);
    c.fillRect(ox + 4, 6, 24, 5, [178, 214, 230, 255]);   // glare
    for (let y = 6; y < 24; y++) c.set(ox + 15, y, [92, 122, 142, 255]);
    for (let x = 4; x < 28; x++) c.set(ox + x, 14, [92, 122, 142, 255]);
  },
];

const tiles = canvas(T * TILE_PAINTERS.length, T);
TILE_PAINTERS.forEach((paint, i) => paint(tiles, i * T));
writeFileSync(new URL("tiles.png", OUT), encodePNG(tiles));

// -------------------------------------------------------------- avatars.png
// 8 shirt colours; frame index is chosen from a hash of the user id.
const SHIRTS = [
  [214, 92, 92], [92, 142, 214], [104, 176, 108], [214, 162, 84],
  [166, 112, 200], [86, 186, 186], [226, 128, 176], [128, 136, 150],
];
const SKIN = [237, 199, 164, 255];
const HAIR = [64, 48, 42, 255];
const SHOE = [52, 52, 60, 255];

const avatars = canvas(T * SHIRTS.length, T);
SHIRTS.forEach((shirt, i) => {
  const ox = i * T;
  const c = avatars;
  c.fillRect(ox + 10, 20, 12, 8, [...shirt, 255]);        // torso
  c.fillRect(ox + 8, 21, 3, 6, [...shade(shirt, -26)]);   // arms
  c.fillRect(ox + 21, 21, 3, 6, [...shade(shirt, -26)]);
  c.fillRect(ox + 11, 28, 4, 3, SHOE);                    // feet
  c.fillRect(ox + 17, 28, 4, 3, SHOE);
  c.fillRect(ox + 11, 9, 10, 11, SKIN);                   // head
  c.fillRect(ox + 10, 7, 12, 5, HAIR);                    // hair
  c.fillRect(ox + 10, 9, 2, 4, HAIR);
  c.fillRect(ox + 20, 9, 2, 4, HAIR);
  c.fillRect(ox + 13, 14, 2, 2, [40, 36, 34, 255]);       // eyes
  c.fillRect(ox + 17, 14, 2, 2, [40, 36, 34, 255]);
});
writeFileSync(new URL("avatars.png", OUT), encodePNG(avatars));

console.log(`tiles.png    ${tiles.width}x${tiles.height} (${TILE_PAINTERS.length} tiles)`);
console.log(`avatars.png  ${avatars.width}x${avatars.height} (${SHIRTS.length} frames)`);
