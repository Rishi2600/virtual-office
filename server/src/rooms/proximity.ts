import { ENTER_SQ, EXIT_SQ, distanceSq, pairKey } from "@vo/shared";

export interface ProximityCandidate {
  sessionId: string;
  x: number;
  y: number;
  /** Ineligible players (disconnected, or in focus mode) never form pairs, and
   *  any pair they were in is torn down on the next tick. */
  eligible: boolean;
  /** Locked-huddle id, or "" when not in a private discussion. */
  lockGroup: string;
}

/**
 * Two people may only connect when their lock groups agree.
 *
 *   ""    + ""    -> yes, ordinary proximity
 *   "g1"  + "g1"  -> yes, they are already in the same private discussion
 *   "g1"  + ""    -> no, someone walking past a locked conversation
 *   "g1"  + "g2"  -> no, two separate private discussions
 */
function lockCompatible(a: ProximityCandidate, b: ProximityCandidate): boolean {
  return a.lockGroup === b.lockGroup;
}

export interface ProximityDelta {
  entered: Array<[string, string]>;
  exited: Array<[string, string]>;
}

const EMPTY: ProximityDelta = { entered: [], exited: [] };

/**
 * Server-authoritative proximity.
 *
 * This lives on the server rather than the client because clients render
 * interpolated positions ~100ms in the past: two clients would disagree about
 * the exact instant they overlap, and you would get half-open calls where one
 * side offered and the other never answered. Deciding here means both peers are
 * told in the same tick, and the initiator can be picked deterministically.
 *
 * O(n^2) per tick is deliberate — at the ~20-user target that is 190 distance
 * checks, far cheaper than the spatial index it would take to avoid them.
 */
export class ProximityTracker {
  private active = new Set<string>();

  update(candidates: ProximityCandidate[]): ProximityDelta {
    const eligible = candidates.filter((c) => c.eligible);

    const next = new Set<string>();
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i]!;
        const b = eligible[j]!;
        if (!lockCompatible(a, b)) continue;

        const key = pairKey(a.sessionId, b.sessionId);
        const d2 = distanceSq(a.x, a.y, b.x, b.y);

        // Hysteresis: a pair that is already talking stays together until it
        // exceeds the wider EXIT radius, so standing on the boundary does not
        // thrash peer connections up and down.
        const threshold = this.active.has(key) ? EXIT_SQ : ENTER_SQ;
        if (d2 <= threshold) next.add(key);
      }
    }

    if (next.size === 0 && this.active.size === 0) return EMPTY;

    const entered: Array<[string, string]> = [];
    const exited: Array<[string, string]> = [];
    for (const key of next) if (!this.active.has(key)) entered.push(split(key));
    for (const key of this.active) if (!next.has(key)) exited.push(split(key));

    this.active = next;
    return { entered, exited };
  }

  /** Used by the signaling relay to refuse traffic between non-adjacent peers. */
  isActive(a: string, b: string): boolean {
    return this.active.has(pairKey(a, b));
  }

  activePeersOf(sessionId: string): string[] {
    const peers: string[] = [];
    for (const key of this.active) {
      const [a, b] = split(key);
      if (a === sessionId) peers.push(b);
      else if (b === sessionId) peers.push(a);
    }
    return peers;
  }

  /**
   * Everyone reachable through active pairs, including the player themselves —
   * the "huddle". Locking and nearby-chat both operate on this rather than on
   * direct pairs, so a chain A-B-C counts as one conversation.
   */
  clusterOf(sessionId: string): Set<string> {
    const cluster = new Set<string>([sessionId]);
    const queue = [sessionId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const peer of this.activePeersOf(current)) {
        if (!cluster.has(peer)) {
          cluster.add(peer);
          queue.push(peer);
        }
      }
    }
    return cluster;
  }
}

function split(key: string): [string, string] {
  const i = key.indexOf("|");
  return [key.slice(0, i), key.slice(i + 1)];
}
