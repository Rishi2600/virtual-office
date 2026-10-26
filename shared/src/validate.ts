/**
 * Runtime checks for every message a client sends to the room (audit SEC-7,
 * SEC-8, PRIV-3). The TypeScript types in messages.ts describe what a well-
 * behaved client sends; these make sure that's what the server acts on, since
 * anything can arrive over a WebSocket.
 *
 * Each parser returns a NEW, clean object built field by field (or null):
 * extra fields never get through, so nothing unexpected is ever relayed to
 * other people. No library: the messages are few and small.
 */
import { CHAT_MAX_LENGTH, type ChatScope, type IceCandidate, type InputMessage, type RtcFailureMessage, type SdpDescription, type SetMediaMessage, type SignalOutMessage } from "./messages.js";
import type { PlayerStatus } from "./config.js";

/** An SDP is a few kB (10-20 kB with video and screen share); this is generous. */
export const SDP_MAX_LENGTH = 48 * 1024;
export const ICE_CANDIDATE_MAX_LENGTH = 1024;
/** Free text from clients that ends up in server logs. */
export const RTC_DETAIL_MAX_LENGTH = 200;
const ID_MAX_LENGTH = 64;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX_LENGTH;
const shortString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const optString = (v: unknown, max: number) => v === undefined || v === null || shortString(v, max);

export function parseInput(m: unknown): InputMessage | null {
  if (!isObj(m)) return null;
  const { seq, dx, dy, dt } = m;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return null;
  if (![-1, 0, 1].includes(dx as number) || ![-1, 0, 1].includes(dy as number)) return null;
  // A NaN or Infinity dt used to turn the player's position into NaN for good (SEC-8).
  if (typeof dt !== "number" || !Number.isFinite(dt) || dt < 0) return null;
  return { seq: seq as number, dx: dx as number, dy: dy as number, dt };
}

export function parseStatus(m: unknown): PlayerStatus | null {
  if (!isObj(m)) return null;
  return m.status === "available" || m.status === "focus" ? m.status : null;
}

export function parseMedia(m: unknown): SetMediaMessage | null {
  if (!isObj(m)) return null;
  const out: SetMediaMessage = {};
  for (const key of ["micOn", "camOn", "sharing"] as const) {
    if (m[key] === undefined) continue;
    if (typeof m[key] !== "boolean") return null;
    out[key] = m[key];
  }
  return out;
}

export function parseLock(m: unknown): boolean | null {
  return isObj(m) && typeof m.locked === "boolean" ? m.locked : null;
}

export function parseChat(m: unknown): { scope: ChatScope; text: string } | null {
  if (!isObj(m) || (m.scope !== "room" && m.scope !== "nearby") || typeof m.text !== "string") return null;
  // Over-long text is refused rather than cut, so nobody sends megabytes to be trimmed.
  if (m.text.length > CHAT_MAX_LENGTH * 2) return null;
  const text = m.text.trim().slice(0, CHAT_MAX_LENGTH);
  return text ? { scope: m.scope, text } : null;
}

export function parseAvatarMessage(m: unknown): string | null {
  return isObj(m) && shortString(m.look, 32) ? m.look : null;
}

const SDP_TYPES = new Set(["offer", "answer", "pranswer", "rollback"]);

function parseCandidate(c: unknown): IceCandidate | null | undefined {
  if (c === null) return null; // "end of candidates"
  if (!isObj(c)) return undefined;
  if (!optString(c.candidate, ICE_CANDIDATE_MAX_LENGTH) || !optString(c.sdpMid, 64) || !optString(c.usernameFragment, 256)) return undefined;
  const index = c.sdpMLineIndex;
  if (index !== undefined && index !== null && !(Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < 64)) return undefined;
  const out: IceCandidate = {};
  if (typeof c.candidate === "string") out.candidate = c.candidate;
  if (c.sdpMid !== undefined) out.sdpMid = c.sdpMid as string | null;
  if (index !== undefined) out.sdpMLineIndex = index as number | null;
  if (c.usernameFragment !== undefined) out.usernameFragment = c.usernameFragment as string | null;
  return out;
}

/** WebRTC signaling, rebuilt so only a real SDP or ICE candidate is ever relayed. */
export function parseSignal(m: unknown): SignalOutMessage | null {
  if (!isObj(m) || !isId(m.to) || !isObj(m.payload)) return null;
  const p = m.payload;
  if (p.kind === "description") {
    const d = p.description;
    if (!isObj(d) || typeof d.type !== "string" || !SDP_TYPES.has(d.type) || !optString(d.sdp, SDP_MAX_LENGTH)) return null;
    const description: SdpDescription = { type: d.type as SdpDescription["type"] };
    if (typeof d.sdp === "string") description.sdp = d.sdp;
    return { to: m.to, payload: { kind: "description", description } };
  }
  if (p.kind === "candidate") {
    const candidate = parseCandidate(p.candidate);
    return candidate === undefined ? null : { to: m.to, payload: { kind: "candidate", candidate } };
  }
  return null;
}

const PEER_STATES = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
/** IPv4 and IPv6 (including compressed forms like 2001:db8::1), so a careless
 *  detail string can't leak addresses into logs. Errs on the side of
 *  scrubbing (a clock time like 12:30:45 is scrubbed too). */
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/gi;

/** A client's report that a call failed; ends up in the server log, so it's
 *  allow-listed, length-capped and scrubbed of IP addresses (PRIV-3). */
export function parseRtcFailure(m: unknown): RtcFailureMessage | null {
  if (!isObj(m) || !isId(m.peerId) || typeof m.state !== "string" || !PEER_STATES.has(m.state)) return null;
  const out: RtcFailureMessage = { peerId: m.peerId, state: m.state };
  if (typeof m.detail === "string") out.detail = m.detail.slice(0, RTC_DETAIL_MAX_LENGTH).replace(IP_PATTERN, "[ip]");
  return out;
}
