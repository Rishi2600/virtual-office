import { PROXIMITY_ENTER, PROXIMITY_EXIT } from "./config.js";

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

export const ENTER_SQ = PROXIMITY_ENTER * PROXIMITY_ENTER;
export const EXIT_SQ = PROXIMITY_EXIT * PROXIMITY_EXIT;

/** Order-independent key for an unordered pair of session ids. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Perfect-negotiation politeness, decided deterministically from session ids so
 * both peers agree without any extra round trip. The "impolite" peer creates the
 * offer; the polite peer yields if offers cross. This is why proximity is
 * computed server-side — both sides learn their role in the same event.
 */
export function isPolite(selfId: string, peerId: string): boolean {
  return selfId > peerId;
}
