import { createRequire } from "node:module";
import {
  buildCollisionGrid,
  getSpawnPoints,
  worldSize,
  type CollisionGrid,
  type TiledMap,
} from "@vo/shared";

const require = createRequire(import.meta.url);

export interface LoadedMap {
  key: string;
  map: TiledMap;
  grid: CollisionGrid;
  spawns: Array<{ x: number; y: number }>;
  world: { width: number; height: number };
}

/**
 * The server builds its collision grid from the exact same JSON file the client
 * renders (shared/src/maps), so "server says wall, client drew floor" is not a
 * failure mode that can occur.
 */
const SOURCES: Record<string, string> = {
  office: "@vo/shared/maps/office.json",
};

const cache = new Map<string, LoadedMap>();

export function loadMap(key: string): LoadedMap {
  const cached = cache.get(key);
  if (cached) return cached;

  const source = SOURCES[key];
  if (!source) throw new Error(`unknown map: ${key}`);

  const map = require(source) as TiledMap;
  const loaded: LoadedMap = {
    key,
    map,
    grid: buildCollisionGrid(map),
    spawns: getSpawnPoints(map),
    world: worldSize(map),
  };
  cache.set(key, loaded);
  return loaded;
}
