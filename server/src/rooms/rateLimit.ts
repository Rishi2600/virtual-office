/**
 * Per-connection, per-message-type rate limits (audit SEC-7): token buckets.
 * Each type has a burst (how many at once) and a steady rate per second. A
 * well-behaved client never comes close; a buggy or hostile one can't flood
 * the room (or everyone's chat) or fill the server log.
 *
 * Messages over the limit are dropped. A connection that keeps flooding (more
 * than FLOOD_DROPS dropped within FLOOD_WINDOW_MS) is disconnected.
 */
export const LIMITS = {
  // ~30/s from the client while walking (see OfficeScene INPUT_SEND_MS).
  input: { burst: 60, perSec: 60 },
  // An offer/answer plus a burst of ICE candidates when a call starts.
  signal: { burst: 120, perSec: 40 },
  // People typing; a short burst (pasting a few lines), then about one a second.
  chat: { burst: 8, perSec: 1 },
  // Toggles: mic, camera, screen, status, lock, avatar.
  control: { burst: 20, perSec: 4 },
  // Call-failure reports go to the log; a handful is plenty.
  report: { burst: 5, perSec: 0.2 },
} as const;

export type LimitKind = keyof typeof LIMITS;

export const FLOOD_DROPS = 300;
export const FLOOD_WINDOW_MS = 10_000;

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private drops: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** True if this message may go through; false if it's over the limit. */
  allow(kind: LimitKind): boolean {
    const { burst, perSec } = LIMITS[kind];
    const t = this.now();
    const b = this.buckets.get(kind) ?? { tokens: burst, last: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * perSec);
    b.last = t;
    this.buckets.set(kind, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    this.drops.push(t);
    return false;
  }

  /** Dropped messages in the last FLOOD_WINDOW_MS: past FLOOD_DROPS, the
   *  connection is flooding and should be closed. */
  flooding(): boolean {
    const since = this.now() - FLOOD_WINDOW_MS;
    while (this.drops.length && this.drops[0]! < since) this.drops.shift();
    return this.drops.length > FLOOD_DROPS;
  }
}
