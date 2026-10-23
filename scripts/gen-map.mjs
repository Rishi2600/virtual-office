// Generates shared/src/maps/office.json — a Tiled-compatible orthogonal tilemap.
// Written as a generator (not hand-authored JSON) so the layout stays readable
// and the two layers can't drift out of sync. Output is committed; the file is
// plain Tiled JSON and can be opened/edited in Tiled directly if preferred.
import { writeFileSync, mkdirSync } from "node:fs";

const W = 40, H = 30, TS = 32;
const FLOOR = 1, WALL = 2, DESK = 3, PLANT = 4, CARPET = 5, WINDOW = 6;

const floor = new Array(W * H).fill(FLOOR);
const solid = new Array(W * H).fill(0);
const at = (x, y) => y * W + x;
const put = (layer, x, y, gid) => { if (x >= 0 && y >= 0 && x < W && y < H) layer[at(x, y)] = gid; };
const rect = (layer, x, y, w, h, gid) => {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(layer, x + dx, y + dy, gid);
};
const hLine = (layer, x, y, w, gid) => rect(layer, x, y, w, 1, gid);
const vLine = (layer, x, y, h, gid) => rect(layer, x, y, 1, h, gid);

// ---- perimeter -------------------------------------------------------------
hLine(solid, 0, 0, W, WALL);
hLine(solid, 0, H - 1, W, WALL);
vLine(solid, 0, 0, H, WALL);
vLine(solid, W - 1, 0, H, WALL);
// windows along the top wall for a bit of light
for (let x = 14; x < 26; x += 2) put(solid, x, 0, WINDOW);

// ---- meeting rooms (top-left and top-right, carpeted, single doorway) -------
function meetingRoom({ x0, y0, x1, y1, wallX, doorX, tableX }) {
  rect(floor, x0 + 1, y0 + 1, x1 - x0 - 1, y1 - y0 - 1, CARPET);
  vLine(solid, wallX, y0, y1 - y0 + 1, WALL);        // inner divider wall
  hLine(solid, x0, y1, x1 - x0 + 1, WALL);           // inner bottom wall
  for (const dx of [0, 1]) {                         // doorway
    put(solid, doorX + dx, y1, 0);
    put(floor, doorX + dx, y1, FLOOR);
  }
  rect(solid, tableX, y0 + 3, 4, 2, DESK);           // meeting table
}
meetingRoom({ x0: 0,  y0: 0, x1: 11, y1: 9, wallX: 11, doorX: 5,  tableX: 3  });
meetingRoom({ x0: 28, y0: 0, x1: 39, y1: 9, wallX: 28, doorX: 33, tableX: 31 });

// ---- desk pods in the open floor ------------------------------------------
for (const y of [14, 21]) {
  for (let x = 6; x <= 30; x += 6) {
    rect(solid, x, y, 3, 1, DESK);
    rect(solid, x, y + 3, 3, 1, DESK);
  }
}

// ---- plants ----------------------------------------------------------------
for (const [x, y] of [[13, 2], [26, 2], [2, 27], [37, 27], [19, 11], [20, 26]]) put(solid, x, y, PLANT);

// ---- spawn points (open floor near the middle-bottom lobby) ----------------
const spawnTiles = [[18, 26], [22, 26], [16, 27], [24, 27], [19, 19], [21, 19], [17, 19], [23, 19]];
for (const [x, y] of spawnTiles) {
  if (solid[at(x, y)] !== 0) throw new Error(`spawn (${x},${y}) is inside a solid tile`);
}

const layer = (id, name, data) => ({
  data, height: H, id, name, opacity: 1, type: "tilelayer", visible: true, width: W, x: 0, y: 0,
});

const map = {
  compressionlevel: -1,
  height: H,
  infinite: false,
  layers: [
    layer(1, "floor", floor),
    // Collision is derived from this layer: ANY non-zero tile here is solid.
    layer(2, "solid", solid),
    {
      draworder: "topdown", id: 3, name: "spawns", opacity: 1, type: "objectgroup", visible: true, x: 0, y: 0,
      objects: spawnTiles.map(([x, y], i) => ({
        id: i + 1, name: "spawn", point: true, rotation: 0, type: "", visible: true,
        width: 0, height: 0, x: x * TS + TS / 2, y: y * TS + TS / 2,
      })),
    },
  ],
  nextlayerid: 4,
  nextobjectid: spawnTiles.length + 1,
  orientation: "orthogonal",
  renderorder: "right-down",
  tiledversion: "1.10.2",
  tileheight: TS,
  tilesets: [{
    columns: 6, firstgid: 1, image: "../../../client/public/assets/tiles.png",
    imageheight: 32, imagewidth: 192, margin: 0, name: "office",
    spacing: 0, tilecount: 6, tileheight: TS, tilewidth: TS,
  }],
  tilewidth: TS,
  type: "map",
  version: "1.10",
  width: W,
};

mkdirSync(new URL("../shared/src/maps/", import.meta.url), { recursive: true });
writeFileSync(new URL("../shared/src/maps/office.json", import.meta.url), JSON.stringify(map, null, 1));

const solidCount = solid.filter((v) => v !== 0).length;
console.log(`office.json  ${W}x${H} tiles (${W * TS}x${H * TS}px)  solid=${solidCount}  spawns=${spawnTiles.length}`);
