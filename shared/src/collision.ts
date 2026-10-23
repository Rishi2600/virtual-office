import type { CollisionGrid } from "./map.js";

export function isSolidTile(grid: CollisionGrid, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return true; // out of bounds = wall
  return grid.solid[ty * grid.width + tx] === 1;
}

/** Does an axis-aligned box centred at (cx, cy) overlap any solid tile? */
export function boxHitsSolid(
  grid: CollisionGrid,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
): boolean {
  const ts = grid.tileSize;
  // Nudge the far edge inwards so a box exactly flush with a tile boundary
  // doesn't register as overlapping the next tile along.
  const x0 = Math.floor((cx - halfW) / ts);
  const x1 = Math.floor((cx + halfW - 0.0001) / ts);
  const y0 = Math.floor((cy - halfH) / ts);
  const y1 = Math.floor((cy + halfH - 0.0001) / ts);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isSolidTile(grid, tx, ty)) return true;
    }
  }
  return false;
}
