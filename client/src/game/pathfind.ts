import { PLAYER_FEET_OFFSET, TILE_SIZE, isSolidTile, type CollisionGrid } from "@vo/shared";

export interface Tile {
  tx: number;
  ty: number;
}

/** The tile under a player's feet (their collision box centre). */
export const tileOf = (x: number, y: number): Tile => ({
  tx: Math.floor(x / TILE_SIZE),
  ty: Math.floor((y + PLAYER_FEET_OFFSET) / TILE_SIZE),
});

/** The player position that puts their collision box in the middle of a tile. */
export const tileCentre = ({ tx, ty }: Tile) => ({
  x: tx * TILE_SIZE + TILE_SIZE / 2,
  y: ty * TILE_SIZE + TILE_SIZE / 2 - PLAYER_FEET_OFFSET,
});

/** The walkable tile closest to `t` (itself if walkable), by breadth-first search. */
export function nearestWalkable(grid: CollisionGrid, t: Tile): Tile | null {
  const seen = new Set<number>();
  const queue: Tile[] = [t];
  while (queue.length) {
    const c = queue.shift()!;
    if (c.tx < 0 || c.ty < 0 || c.tx >= grid.width || c.ty >= grid.height) continue;
    const k = c.ty * grid.width + c.tx;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!isSolidTile(grid, c.tx, c.ty)) return c;
    queue.push({ tx: c.tx + 1, ty: c.ty }, { tx: c.tx - 1, ty: c.ty }, { tx: c.tx, ty: c.ty + 1 }, { tx: c.tx, ty: c.ty - 1 });
  }
  return null;
}

const DIRS8 = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

/**
 * A* over the collision grid, 8 directions, never cutting a corner (a diagonal
 * step needs both side tiles free, or the player's box would catch on it).
 * Returns the tiles to walk through after `from`, or null when unreachable.
 * The map is 40×30, so this is a fraction of a millisecond.
 */
export function findPath(grid: CollisionGrid, from: Tile, to: Tile): Tile[] | null {
  const w = grid.width;
  const free = (tx: number, ty: number) => !isSolidTile(grid, tx, ty);
  if (!free(to.tx, to.ty)) return null;
  const start = from.ty * w + from.tx;
  const goal = to.ty * w + to.tx;
  const h = (k: number) => {
    const dx = Math.abs((k % w) - to.tx);
    const dy = Math.abs(Math.floor(k / w) - to.ty);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const open = new Map<number, number>([[start, h(start)]]);
  const closed = new Set<number>();

  while (open.size) {
    let cur = -1;
    let best = Infinity;
    for (const [k, f] of open) if (f < best) [cur, best] = [k, f];
    if (cur === goal) {
      const path: Tile[] = [];
      for (let k = goal; k !== start; k = came.get(k)!) path.push({ tx: k % w, ty: Math.floor(k / w) });
      return path.reverse();
    }
    open.delete(cur);
    closed.add(cur);
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy, cost] of DIRS8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!free(nx, ny)) continue;
      if (dx && dy && (!free(cx + dx, cy) || !free(cx, cy + dy))) continue;
      const nk = ny * w + nx;
      if (closed.has(nk)) continue;
      const ng = g.get(cur)! + cost;
      if (ng >= (g.get(nk) ?? Infinity)) continue;
      g.set(nk, ng);
      came.set(nk, cur);
      open.set(nk, ng + h(nk));
    }
  }
  return null;
}
