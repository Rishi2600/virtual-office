import officeMap from "@vo/shared/maps/office.json";
import type { TiledMap } from "@vo/shared";

/**
 * The office map as a plain picture (no game engine): every tile layer drawn
 * from tiles.png at `tilePx` per tile. Used by the minimap and behind the
 * sign-in page, neither of which should need Phaser.
 */
export const MAP = officeMap as TiledMap;
const COLUMNS = 8; // tiles per row in tiles.png

let tiles: Promise<HTMLImageElement> | null = null;
const loadTiles = () =>
  (tiles ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = "/assets/tiles.png";
  }));

export async function drawMapPicture(tilePx: number): Promise<HTMLCanvasElement> {
  const img = await loadTiles();
  const t = MAP.tilewidth;
  const c = document.createElement("canvas");
  c.width = MAP.width * tilePx;
  c.height = MAP.height * tilePx;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = tilePx < t; // smooth when shrinking, crisp pixels when not
  for (const layer of MAP.layers) {
    if (layer.type !== "tilelayer" || !layer.data) continue;
    layer.data.forEach((gid, i) => {
      if (!gid) return;
      const n = gid - 1;
      ctx.drawImage(img, (n % COLUMNS) * t, Math.floor(n / COLUMNS) * t, t, t, (i % MAP.width) * tilePx, Math.floor(i / MAP.width) * tilePx, tilePx, tilePx);
    });
  }
  return c;
}
