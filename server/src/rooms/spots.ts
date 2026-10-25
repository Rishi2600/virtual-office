import type { Repository, SpotRecord } from "../db/index.js";
import { wsLog } from "../log.js";

/**
 * Where everyone last stood, kept in the database so a server restart puts
 * people back in place (docs/persistent-spot-plan.md). Only the server ever
 * decides or saves a position; clients never send one.
 *
 * Saving is best effort: a database hiccup must never fail a join or crash
 * the room, so errors are logged and the spot is simply not restored.
 */
type SpotStore = Pick<Repository, "getSpot" | "saveSpots">;

let store: SpotStore | null = null;
const pending = new Set<Promise<void>>();

/** Called once at startup with the app's repository. */
export function setSpotStore(s: SpotStore | null): void {
  store = s;
}

export async function loadSpot(userId: string, space: string): Promise<{ x: number; y: number } | null> {
  if (!store) return null;
  try {
    return await store.getSpot(userId, space);
  } catch (err) {
    wsLog.warn({ err: (err as Error).message, userId }, "couldn't load saved spot; spawning instead");
    return null;
  }
}

export function saveSpots(space: string, spots: SpotRecord[]): void {
  if (!store || spots.length === 0) return;
  const p: Promise<void> = store
    .saveSpots(space, spots)
    .catch((err: Error) => wsLog.warn({ err: err.message, count: spots.length }, "couldn't save spots"))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Waits for saves still in flight; shutdown calls this before closing the database. */
export async function drainSpotSaves(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
