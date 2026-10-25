// The tile catalogue shared by gen-tileset.mjs (draws them) and gen-map.mjs
// (places them). A tile's gid in the map is its index here + 1. Order matters:
// changing it means regenerating both tiles.png and the map.
export const TILES = [
  // floors (floor layer)
  "floor", "floor_b", "carpet", "rug", "kitchen", "mat",
  // structure (solid layer)
  "wall", "wall_window", "wall_side", "glass_h", "glass_v", "whiteboard", "tv",
  // desks and tables (solid)
  "desk_l", "desk_m", "desk_m2", "desk_r",
  "table_tl", "table_tm", "table_tr", "table_bl", "table_bm", "table_br",
  // lounge and kitchen (solid)
  "sofa_l", "sofa_m", "sofa_r", "coffee_table", "plant", "bookshelf",
  "counter_l", "counter_m", "counter_coffee", "counter_r", "fridge",
  // walkable furniture (decor layer)
  "chair_up", "chair_down",
];

export const gid = (name) => {
  const i = TILES.indexOf(name);
  if (i < 0) throw new Error(`unknown tile: ${name}`);
  return i + 1;
};

/** Tiles per row in tiles.png. */
export const COLUMNS = 8;
/** Art is drawn on a 16px grid and written at 2x, so tiles are 32px like the game grid. */
export const ART = 16;
export const SCALE = 2;
