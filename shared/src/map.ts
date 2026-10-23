/** Tiled JSON → collision grid. Both the server (authoritative movement) and the
 *  client (prediction) build their grid from the SAME map file, so they cannot
 *  disagree about where the walls are. */
import { TILE_SIZE } from "./config.js";

export interface TiledLayer {
  name: string;
  type: "tilelayer" | "objectgroup";
  data?: number[];
  objects?: Array<{ name: string; x: number; y: number }>;
  width?: number;
  height?: number;
}

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
}

export interface CollisionGrid {
  width: number;
  height: number;
  tileSize: number;
  /** 1 = solid. Row-major, width*height. */
  solid: Uint8Array;
}

/** The layer whose non-zero tiles block movement. */
export const SOLID_LAYER = "solid";
export const SPAWN_LAYER = "spawns";

export function buildCollisionGrid(map: TiledMap): CollisionGrid {
  const layer = map.layers.find((l) => l.name === SOLID_LAYER && l.type === "tilelayer");
  if (!layer?.data) throw new Error(`map has no "${SOLID_LAYER}" tile layer`);

  const solid = new Uint8Array(map.width * map.height);
  for (let i = 0; i < solid.length; i++) solid[i] = layer.data[i] !== 0 ? 1 : 0;

  return { width: map.width, height: map.height, tileSize: map.tilewidth || TILE_SIZE, solid };
}

export function getSpawnPoints(map: TiledMap): Array<{ x: number; y: number }> {
  const layer = map.layers.find((l) => l.name === SPAWN_LAYER && l.type === "objectgroup");
  const pts = (layer?.objects ?? []).map((o) => ({ x: o.x, y: o.y }));
  if (pts.length) return pts;
  // Fallback: dead centre of the map.
  return [{ x: (map.width * map.tilewidth) / 2, y: (map.height * map.tileheight) / 2 }];
}

export function worldSize(map: TiledMap) {
  return { width: map.width * map.tilewidth, height: map.height * map.tileheight };
}
