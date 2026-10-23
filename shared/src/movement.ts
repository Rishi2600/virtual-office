/** THE shared simulation step.
 *
 *  The server calls this to produce authoritative positions; the client calls
 *  the exact same function to predict its own movement and to replay unacked
 *  inputs during reconciliation. If these two ever diverge, the local player
 *  rubber-bands — so this function must stay pure and deterministic. */
import { boxHitsSolid } from "./collision.js";
import type { CollisionGrid } from "./map.js";
import {
  MAX_INPUT_DT, PLAYER_FEET_OFFSET, PLAYER_HALF_H, PLAYER_HALF_W, PLAYER_SPEED,
} from "./config.js";

export interface InputCommand {
  seq: number;
  dx: number;   // -1, 0 or 1
  dy: number;   // -1, 0 or 1
  dt: number;   // seconds since the previous input
}

export interface Body { x: number; y: number; }

export function applyInput(body: Body, cmd: InputCommand, grid: CollisionGrid): void {
  // Sanitise: these values arrive over the network.
  const dt = Math.min(Math.max(cmd.dt, 0), MAX_INPUT_DT);
  let dx = Math.sign(cmd.dx || 0);
  let dy = Math.sign(cmd.dy || 0);
  if (dt === 0 || (dx === 0 && dy === 0)) return;

  // Normalise diagonals so holding two keys isn't ~41% faster.
  if (dx !== 0 && dy !== 0) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
  const step = PLAYER_SPEED * dt;

  // Axis-separated resolution: try X, then Y independently. This is what makes
  // you slide along a wall you walk into at an angle instead of sticking to it.
  const nx = body.x + dx * step;
  if (!boxHitsSolid(grid, nx, body.y + PLAYER_FEET_OFFSET, PLAYER_HALF_W, PLAYER_HALF_H)) {
    body.x = nx;
  }
  const ny = body.y + dy * step;
  if (!boxHitsSolid(grid, body.x, ny + PLAYER_FEET_OFFSET, PLAYER_HALF_W, PLAYER_HALF_H)) {
    body.y = ny;
  }
}
