/** Tunables shared by client prediction and server simulation. Changing a value
 *  here changes both sides at once — that is the point of this file living in
 *  @vo/shared rather than being duplicated. */

export const TILE_SIZE = 32;

/** Server simulation + state patch rate. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

/** Movement. */
export const PLAYER_SPEED = 170;        // px per second
export const PLAYER_HALF_W = 9;         // collision box half-width
export const PLAYER_HALF_H = 7;         // collision box half-height
/** The collision box sits at the avatar's feet, not its centre, so you can
 *  stand with your head "in front of" a wall like a real top-down game. */
export const PLAYER_FEET_OFFSET = 9;

/** Largest dt a single input may claim. Clamps stalled/background tabs and puts
 *  a ceiling on how far one packet can move you. */
export const MAX_INPUT_DT = 0.05;

/** Proximity radii, in world px. Hysteresis: you must come closer than
 *  ENTER to start a call, but only need to exceed EXIT to end one. Without the
 *  gap, standing exactly on the boundary would thrash peer connections. */
export const PROXIMITY_ENTER = 120;
export const PROXIMITY_EXIT = 160;

/** Client render delay for remote avatars. Snapshots are drawn this far in the
 *  past so there is always a pair to interpolate between. */
export const INTERP_DELAY_MS = 100;

/** Reconciliation: ignore sub-pixel disagreement, correct anything larger. */
export const RECONCILE_SNAP_PX = 2;

/** How long the server holds a disconnected player's slot open for reconnect. */
export const RECONNECT_WINDOW_SEC = 30;

export type PlayerStatus = "available" | "focus";
