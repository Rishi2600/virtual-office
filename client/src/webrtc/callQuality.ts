import type { CallQuality } from "../store.js";

/** Cumulative counters from the previous sample, to turn totals into a rate. */
export interface QualitySample {
  packetsReceived: number;
  packetsLost: number;
}

/** Thresholds for spoken conversation: beyond ~250ms round trip people start
 *  talking over each other; a few percent loss is audible as dropouts. */
const GOOD_RTT_MS = 250;
const POOR_RTT_MS = 500;
const GOOD_LOSS_PCT = 2;
const POOR_LOSS_PCT = 8;

/**
 * Rolls one getStats() report up into a quality the UI can show. Uses the
 * active candidate pair for round-trip time and route, and incoming audio for
 * packet loss (measured since `previous`, so one bad minute ages out).
 * Returns no quality until there is something to judge.
 */
export function summarize(
  report: RTCStatsReport,
  previous: QualitySample | null,
): { quality: CallQuality | null; sample: QualitySample } {
  const byId = new Map<string, RTCStats & Record<string, unknown>>();
  report.forEach((s) => byId.set(s.id, s as RTCStats & Record<string, unknown>));

  // The active path: the transport's selected pair, or failing that the
  // nominated pair that succeeded.
  let pair: (RTCStats & Record<string, unknown>) | undefined;
  for (const s of byId.values()) {
    if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") {
      pair = byId.get(s.selectedCandidatePairId);
    }
  }
  pair ??= [...byId.values()].find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");

  const rtt = typeof pair?.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null;
  const local = pair && byId.get(pair.localCandidateId as string);
  const remote = pair && byId.get(pair.remoteCandidateId as string);
  const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";

  const sample: QualitySample = { packetsReceived: 0, packetsLost: 0 };
  for (const s of byId.values()) {
    if (s.type === "inbound-rtp" && s.kind === "audio") {
      sample.packetsReceived += Number(s.packetsReceived ?? 0);
      sample.packetsLost += Math.max(0, Number(s.packetsLost ?? 0));
    }
  }
  let lossPct: number | null = null;
  if (previous) {
    const received = sample.packetsReceived - previous.packetsReceived;
    const lost = sample.packetsLost - previous.packetsLost;
    if (received + lost > 0) lossPct = Math.round((100 * lost) / (received + lost) * 10) / 10;
  }

  if (rtt === null && lossPct === null) return { quality: null, sample };
  const level =
    (rtt ?? 0) > POOR_RTT_MS || (lossPct ?? 0) > POOR_LOSS_PCT
      ? "poor"
      : (rtt ?? 0) <= GOOD_RTT_MS && (lossPct ?? 0) <= GOOD_LOSS_PCT
        ? "good"
        : "fair";
  return { quality: { level, rttMs: rtt, lossPct, relayed }, sample };
}
