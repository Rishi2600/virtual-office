// Generates shared/src/maps/office.json — Lamports' office as a Tiled-compatible
// orthogonal tilemap. Written as a generator (owner decision: keep the script)
// so the layout stays readable and the layers can't drift apart:
//   floor  — what you walk on (every tile)
//   decor  — drawn on top of the floor but walkable (chairs)
//   solid  — walls and furniture; ANY non-zero tile here blocks movement
//            (server and client both build collision from this layer only)
//   spawns — where people appear (≥128px apart, outside each other's hearing)
//   labels — room names the client shows on the map
//
// Layout guarantees the server test relies on (server/src/smoke/integration.ts):
// row 19 is a clear corridor wall to wall, row 28 is clear along the bottom
// wall, and the lobby (x 12–27, rows 20–28) is open floor.
import { writeFileSync, mkdirSync } from "node:fs";
import { COLUMNS, TILES, gid } from "./tiles.mjs";

const W = 40, H = 30, TS = 32;
const floor = new Array(W * H).fill(gid("floor"));
const decor = new Array(W * H).fill(0);
const solid = new Array(W * H).fill(0);
const at = (x, y) => y * W + x;
const put = (layer, x, y, name) => {
  if (x < 0 || y < 0 || x >= W || y >= H) throw new Error(`(${x},${y}) is outside the map`);
  layer[at(x, y)] = name ? gid(name) : 0;
};
const rect = (layer, x, y, w, h, name) => {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(layer, x + dx, y + dy, name);
};
const hLine = (layer, x, y, w, name) => rect(layer, x, y, w, 1, name);
const vLine = (layer, x, y, h, name) => rect(layer, x, y, 1, h, name);

// ---- floor texture: alternate plank rows so the open floor isn't flat
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x * 7 + y * 3) % 5 === 0) put(floor, x, y, "floor_b");

// ---- perimeter
hLine(solid, 0, 0, W, "wall");
hLine(solid, 0, H - 1, W, "wall");
vLine(solid, 0, 1, H - 2, "wall_side");
vLine(solid, W - 1, 1, H - 2, "wall_side");
for (let x = 14; x <= 25; x += 2) put(solid, x, 0, "wall_window");

// ---- desks: a bank is `groups` runs of 3 desks with a gap, chairs in front
function deskBank(x0, y, groups) {
  for (let g = 0; g < groups; g++) {
    const x = x0 + g * 4;
    put(solid, x, y, "desk_l");
    put(solid, x + 1, y, g % 2 ? "desk_m2" : "desk_m");
    put(solid, x + 2, y, "desk_r");
    for (let k = 0; k < 3; k++) put(decor, x + k, y + 1, "chair_up");
  }
}

// ---- a meeting table with chairs around it
function meetingTable(x, y, w) {
  put(solid, x, y, "table_tl"); put(solid, x + w - 1, y, "table_tr");
  put(solid, x, y + 1, "table_bl"); put(solid, x + w - 1, y + 1, "table_br");
  for (let k = 1; k < w - 1; k++) { put(solid, x + k, y, "table_tm"); put(solid, x + k, y + 1, "table_bm"); }
  for (let k = 0; k < w; k++) { put(decor, x + k, y - 1, "chair_down"); put(decor, x + k, y + 2, "chair_up"); }
}

// ---- meeting rooms: carpet, glass walls with a doorway, a table, a screen
function meetingRoom({ x0, x1, glassX, doorX, tableX, wallItem, wallItemX }) {
  rect(floor, x0, 1, x1 - x0 + 1, 7, "carpet");
  hLine(solid, Math.min(x0, glassX), 8, Math.abs(x1 - x0) + 2, "glass_h");
  vLine(solid, glassX, 1, 7, "glass_v");
  put(solid, doorX, 8, null); put(solid, doorX + 1, 8, null);
  meetingTable(tableX, 3, 5);
  put(solid, wallItemX, 0, wallItem); put(solid, wallItemX + 1, 0, wallItem);
}
meetingRoom({ x0: 1, x1: 10, glassX: 11, doorX: 5, tableX: 3, wallItem: "whiteboard", wallItemX: 2 });
meetingRoom({ x0: 29, x1: 38, glassX: 28, doorX: 33, tableX: 31, wallItem: "tv", wallItemX: 35 });

// ---- open office: three desk banks in the middle, one on the right
deskBank(13, 3, 3);
deskBank(13, 7, 3);
deskBank(13, 11, 3);
deskBank(29, 11, 2);
deskBank(29, 15, 2);
put(solid, 12, 2, "plant"); put(solid, 27, 2, "plant"); put(solid, 12, 16, "plant"); put(solid, 27, 16, "plant");

// ---- library corner on the left
vLine(solid, 1, 11, 5, "bookshelf");
put(solid, 4, 12, "coffee_table");
put(decor, 3, 12, "chair_down"); put(decor, 5, 12, "chair_down");
put(solid, 9, 10, "plant"); put(solid, 9, 16, "plant");

// ---- lounge (bottom left): rug, two sofas, a coffee table, plants
rect(floor, 2, 21, 8, 6, "rug");
put(solid, 3, 22, "sofa_l"); hLine(solid, 4, 22, 3, "sofa_m"); put(solid, 7, 22, "sofa_r");
put(solid, 5, 24, "coffee_table");
put(solid, 3, 26, "sofa_l"); hLine(solid, 4, 26, 3, "sofa_m"); put(solid, 7, 26, "sofa_r");
put(solid, 1, 21, "plant"); put(solid, 10, 21, "plant"); put(solid, 10, 27, "plant");

// ---- kitchen (bottom right): tiles, counter, coffee, fridge, a table
rect(floor, 29, 21, 10, 7, "kitchen");
put(solid, 30, 21, "counter_l"); hLine(solid, 31, 21, 2, "counter_m");
put(solid, 33, 21, "counter_coffee"); hLine(solid, 34, 21, 2, "counter_m"); put(solid, 36, 21, "counter_r");
put(solid, 38, 21, "fridge");
meetingTable(32, 24, 4);
put(solid, 29, 27, "plant");

// ---- lobby (bottom middle): open floor, an entrance mat, a few plants
hLine(floor, 19, 28, 2, "mat");
put(solid, 12, 21, "plant"); put(solid, 27, 21, "plant");

// ---- spawn points: lobby, ≥128px apart so nobody arrives inside a call
const spawnTiles = [[14, 21], [19, 21], [24, 21], [16.5, 25], [21.5, 25], [13, 28], [26, 28]];
for (const [x, y] of spawnTiles) {
  if (solid[at(Math.floor(x), Math.floor(y))] !== 0) throw new Error(`spawn (${x},${y}) is inside a solid tile`);
}
for (let i = 0; i < spawnTiles.length; i++)
  for (let j = i + 1; j < spawnTiles.length; j++) {
    const [ax, ay] = spawnTiles[i], [bx, by] = spawnTiles[j];
    if (Math.hypot(ax - bx, ay - by) * TS < 128) throw new Error(`spawns ${i} and ${j} are closer than 128px`);
  }

// ---- guarantees the server test relies on
for (let x = 1; x < W - 1; x++) {
  if (solid[at(x, 19)]) throw new Error(`row 19 must be a clear corridor (blocked at x=${x})`);
  if (solid[at(x, 28)]) throw new Error(`row 28 must be clear (blocked at x=${x})`);
}

// ---- room labels (shown by the client; the server ignores this layer)
const labels = [
  ["Meeting A", 6, 8.6], ["Meeting B", 33.5, 8.6], ["Library", 4.5, 17.2],
  ["Lounge", 6, 27.6], ["Kitchen", 34, 27.6], ["Lobby", 19.5, 27.6],
];

const layer = (id, name, data) => ({ data, height: H, id, name, opacity: 1, type: "tilelayer", visible: true, width: W, x: 0, y: 0 });
const objects = (id, name, list) => ({ draworder: "topdown", id, name, opacity: 1, type: "objectgroup", visible: true, x: 0, y: 0, objects: list });

const map = {
  compressionlevel: -1,
  height: H,
  infinite: false,
  layers: [
    layer(1, "floor", floor),
    layer(2, "decor", decor),
    layer(3, "solid", solid),
    objects(4, "spawns", spawnTiles.map(([x, y], i) => ({
      id: i + 1, name: "spawn", point: true, rotation: 0, type: "", visible: true,
      width: 0, height: 0, x: x * TS + TS / 2, y: y * TS + TS / 2,
    }))),
    objects(5, "labels", labels.map(([text, x, y], i) => ({
      id: 100 + i, name: text, point: true, rotation: 0, type: "label", visible: true,
      width: 0, height: 0, x: x * TS, y: y * TS,
    }))),
  ],
  nextlayerid: 6,
  nextobjectid: 100 + labels.length,
  orientation: "orthogonal",
  renderorder: "right-down",
  tiledversion: "1.10.2",
  tileheight: TS,
  tilesets: [{
    columns: COLUMNS, firstgid: 1, image: "../../../client/public/assets/tiles.png",
    imageheight: Math.ceil(TILES.length / COLUMNS) * TS, imagewidth: COLUMNS * TS, margin: 0, name: "office",
    spacing: 0, tilecount: TILES.length, tileheight: TS, tilewidth: TS,
  }],
  tilewidth: TS,
  type: "map",
  version: "1.10",
  width: W,
};

mkdirSync(new URL("../shared/src/maps/", import.meta.url), { recursive: true });
writeFileSync(new URL("../shared/src/maps/office.json", import.meta.url), JSON.stringify(map, null, 1));
const solidCount = solid.filter((v) => v !== 0).length;
console.log(`office.json  ${W}x${H} tiles (${W * TS}x${H * TS}px)  solid=${solidCount}  spawns=${spawnTiles.length}  labels=${labels.length}`);
