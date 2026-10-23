import type { PlayerStatus } from "./config.js";

/** client → server */
export const C2S = {
  Input: "input",
  SetStatus: "set-status",
  SetMedia: "set-media",
  Signal: "signal",
  RtcFailure: "rtc-failure",
  Chat: "chat",
  SetLock: "set-lock",
} as const;

/** server → client */
export const S2C = {
  ProximityEnter: "prox-enter",
  ProximityExit: "prox-exit",
  Signal: "signal",
  Chat: "chat",
} as const;

/** "room" reaches everyone in the space; "nearby" only your current huddle. */
export type ChatScope = "room" | "nearby";

export const CHAT_MAX_LENGTH = 500;

export interface ChatOutMessage {
  scope: ChatScope;
  text: string;
}

/**
 * Relayed to recipients. Deliberately NOT part of the Colyseus schema and never
 * written to the database: chat is relay-only and lives in browser memory, so
 * the "nothing is recorded" guarantee still holds.
 */
export interface ChatInMessage {
  id: string;
  from: string;
  name: string;
  scope: ChatScope;
  text: string;
  at: number;
}

export interface SetLockMessage {
  locked: boolean;
}

/** Structural SDP/ICE types. Deliberately NOT the DOM's RTCSessionDescriptionInit
 *  so that @vo/shared stays usable from the server, which has no DOM lib. */
export interface SdpDescription {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
export type SignalPayload =
  | { kind: "description"; description: SdpDescription }
  | { kind: "candidate"; candidate: IceCandidate | null };

export interface InputMessage { seq: number; dx: number; dy: number; dt: number; }
export interface SetStatusMessage { status: PlayerStatus; }
export interface SetMediaMessage { micOn?: boolean; camOn?: boolean; sharing?: boolean; }

/** Sent by a client; `to` is the peer's sessionId. */
export interface SignalOutMessage { to: string; payload: SignalPayload; }
/** Relayed to the recipient; `from` is the sender's sessionId. */
export interface SignalInMessage { from: string; payload: SignalPayload; }

export interface ProximityEnterMessage { peerId: string; polite: boolean; }
export interface ProximityExitMessage { peerId: string; }

/** Reported by the client so ICE failures are visible in one server-side log. */
export interface RtcFailureMessage { peerId: string; state: string; detail?: string; }
