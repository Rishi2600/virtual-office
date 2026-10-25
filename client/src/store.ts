import { create } from "zustand";
import type { ChatInMessage, PlayerStatus } from "@vo/shared";

/** Keeps memory bounded — chat is ephemeral, so old messages simply age out. */
const CHAT_HISTORY_LIMIT = 200;

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

/** How the browser responded to our one and only getUserMedia prompt. */
export type MediaState = "idle" | "prompting" | "granted" | "denied" | "unavailable";

export interface Me {
  id: string;
  name: string;
  email: string;
  picture: string;
}

export interface AppConfig {
  microsoftEnabled: boolean;
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
  chat: ChatInMessage[];
  chatOpen: boolean;
  unreadChat: number;

  set: (patch: Partial<Store>) => void;
  upsertPeer: (peerId: string, patch: Partial<PeerView>) => void;
  removePeer: (peerId: string) => void;
  addChat: (message: ChatInMessage) => void;
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
  chat: [] as ChatInMessage[],
  chatOpen: false,
  unreadChat: 0,
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

  addChat: (message) =>
    set((s) => ({
      chat: [...s.chat, message].slice(-CHAT_HISTORY_LIMIT),
      unreadChat: s.chatOpen ? 0 : s.unreadChat + 1,
    })),

  reset: () => set({ ...initial, authChecked: true }),
}));

// Lets you inspect live call/peer state from the devtools console while
// dogfooding: __store.getState().peers
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
