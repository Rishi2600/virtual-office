import { create } from "zustand";
import type { ChatInMessage, ChatScope, PlayerStatus } from "@vo/shared";

/** Keeps memory bounded — chat is ephemeral, so old messages simply age out. */
const CHAT_HISTORY_LIMIT = 200;

/** A chat line: a relayed message, or a local note ("Bob joined your huddle")
 *  that exists only in this browser. Neither is ever stored. */
export type ChatLine =
  | ({ kind: "msg" } & ChatInMessage)
  | { kind: "sys"; id: string; scope: ChatScope; text: string; at: number };

/** Dialogs the app can show (one at a time). */
export type DialogName = "settings" | "avatar" | "finder" | null;

/** "replaced": this person opened Lamports somewhere else (newest tab wins). */
export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "replaced";

/** How the browser responded to our one and only getUserMedia prompt. */
export type MediaState = "idle" | "prompting" | "granted" | "denied" | "unavailable";

export interface Me {
  id: string;
  name: string;
  email: string;
  picture: string;
  /** The look they built, or "" if they haven't yet (first run opens the builder). */
  avatar: string;
}

export interface AppConfig {
  githubEnabled: boolean;
  devAuthEnabled: boolean;
  spaces: Array<{ slug: string; name: string }>;
}

export interface PlayerView {
  sessionId: string;
  userId: string;
  name: string;
  picture: string;
  /** Avatar look string (shared/src/avatar.ts). */
  avatar: string;
  status: PlayerStatus;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  connected: boolean;
  /** Non-empty while in a locked ("private discussion") huddle. */
  lockGroup: string;
  isSelf: boolean;
}

/** The call as the user should understand it, recovery included (see PeerManager). */
export type CallStatus = "connecting" | "connected" | "reconnecting" | "failed";

/** Rolled up from RTCPeerConnection.getStats() every couple of seconds. */
export interface CallQuality {
  level: "good" | "fair" | "poor";
  /** Round trip on the active network path, in ms. */
  rttMs: number | null;
  /** Incoming audio packets lost since the previous sample, in percent. */
  lossPct: number | null;
  /** True when traffic goes through a TURN relay instead of directly. */
  relayed: boolean;
}

export interface PeerView {
  peerId: string;
  stream: MediaStream | null;
  /** The peer's audio, in a stream created WITH its track. Chrome never starts
   *  playing an audio-only stream whose track was added after it was attached
   *  to a media element, so this can't reuse `stream`. */
  audio: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  callStatus: CallStatus;
  quality: CallQuality | null;
}

interface Store {
  me: Me | null;
  config: AppConfig | null;
  authChecked: boolean;

  connection: ConnectionState;
  connectionDetail: string;
  sessionId: string | null;

  players: Record<string, PlayerView>;
  peers: Record<string, PeerView>;

  /** Tracked per device: a machine can have a working mic and no webcam. */
  micState: MediaState;
  camState: MediaState;
  mediaError: string;
  cameraError: string;
  localStream: MediaStream | null;
  /** Set while screen sharing so the local preview shows what peers see. */
  screenStream: MediaStream | null;

  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  status: PlayerStatus;

  /** The browser refused to start remote audio without a user gesture. */
  audioBlocked: boolean;

  /** Relay-only, in-memory. Never persisted anywhere. */
  chat: ChatLine[];
  chatTab: ChatScope;
  /** Chat panel showing (docked on wide screens, a drawer on narrower ones). */
  chatVisible: boolean;
  unread: Record<ChatScope, number>;

  /** Session ids currently speaking (local audio analysis, nothing recorded). */
  speaking: Record<string, boolean>;

  dialog: DialogName;

  set: (patch: Partial<Store>) => void;
  upsertPeer: (peerId: string, patch: Partial<PeerView>) => void;
  removePeer: (peerId: string) => void;
  addChat: (line: ChatLine) => void;
  markRead: (scope: ChatScope) => void;
  reset: () => void;
}

const initial = {
  me: null,
  config: null,
  authChecked: false,
  connection: "idle" as ConnectionState,
  connectionDetail: "",
  sessionId: null,
  players: {},
  peers: {},
  micState: "idle" as MediaState,
  camState: "idle" as MediaState,
  mediaError: "",
  cameraError: "",
  localStream: null,
  screenStream: null,
  micOn: true,
  // Video is opt-in: proximity connects audio only.
  camOn: false,
  sharing: false,
  status: "available" as PlayerStatus,
  audioBlocked: false,
  chat: [] as ChatLine[],
  chatTab: "nearby" as ChatScope,
  chatVisible: true,
  unread: { nearby: 0, room: 0 } as Record<ChatScope, number>,
  speaking: {} as Record<string, boolean>,
  dialog: null as DialogName,
};

export const useStore = create<Store>((set) => ({
  ...initial,

  set: (patch) => set(patch),

  upsertPeer: (peerId, patch) =>
    set((s) => {
      const existing: PeerView = s.peers[peerId] ?? {
        peerId,
        stream: null,
        audio: null,
        connectionState: "new",
        callStatus: "connecting",
        quality: null,
      };
      return { peers: { ...s.peers, [peerId]: { ...existing, ...patch, peerId } } };
    }),

  removePeer: (peerId) =>
    set((s) => {
      if (!s.peers[peerId]) return s;
      const next = { ...s.peers };
      delete next[peerId];
      return { peers: next };
    }),

  addChat: (line) =>
    set((s) => {
      // Unread unless you're looking right at it: your own messages and local
      // notes never count.
      const seen =
        s.chatVisible && s.chatTab === line.scope && document.visibilityState === "visible";
      const counts = line.kind === "msg" && line.from !== s.sessionId && !seen;
      return {
        chat: [...s.chat, line].slice(-CHAT_HISTORY_LIMIT),
        unread: counts ? { ...s.unread, [line.scope]: s.unread[line.scope] + 1 } : s.unread,
      };
    }),

  markRead: (scope) =>
    set((s) => (s.unread[scope] ? { unread: { ...s.unread, [scope]: 0 } } : s)),

  reset: () => set({ ...initial, authChecked: true }),
}));

// Lets you inspect live call/peer state from the devtools console while
// dogfooding: __store.getState().peers
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
