import { Client, type Room } from "colyseus.js";
import {
  C2S,
  CHAT_MAX_LENGTH,
  OfficeState,
  S2C,
  type ChatInMessage,
  type ChatScope,
  type PlayerStatus,
  type ProximityEnterMessage,
  type ProximityExitMessage,
  type SignalInMessage,
} from "@vo/shared";
import { useStore, type PlayerView } from "../store.js";
import { PeerManager } from "../webrtc/PeerManager.js";
import { ensureMicrophone } from "../webrtc/media.js";
import { fetchIceServers, fetchRealtimeToken } from "./api.js";

const WS_URL: string =
  (import.meta.env.VITE_SERVER_WS as string | undefined) ??
  (import.meta.env.DEV
    ? `ws://${location.hostname}:2567`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const RETRY_DELAYS_MS = [400, 900, 1800, 3000, 5000, 5000, 5000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mutable holder so the Phaser scene keeps working across a reconnect, which
 *  hands us a brand new Room object. */
export interface RoomRef {
  current: Room<OfficeState> | null;
}

/**
 * Module-level and deliberately stable for the lifetime of the page: the Phaser
 * game is created once against this ref, so neither a reconnect nor a React
 * remount ever needs to rebuild the WebGL context.
 */
export const roomRef: RoomRef = { current: null };

export class Session {
  peers: PeerManager | null = null;

  private client = new Client(WS_URL);
  private myRoom: Room<OfficeState> | null = null;
  private reconnectionToken: string | null = null;
  private leavingIntentionally = false;
  private iceServers: RTCIceServer[] = [];
  private iceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  get room(): Room<OfficeState> | null {
    return this.myRoom;
  }

  // ------------------------------------------------------------------ connect
  async connect(): Promise<void> {
    useStore.getState().set({ connection: "connecting", connectionDetail: "" });

    // Ask for the MICROPHONE only, and before joining, so the first proximity
    // call already has audio and the permission prompt isn't tangled up with
    // someone walking up to you. The camera is never requested here — video is
    // opt-in and only acquired when the user clicks for it.
    await ensureMicrophone();

    await this.refreshIceServers();
    const token = await fetchRealtimeToken();
    const room = await this.client.joinOrCreate<OfficeState>("office", { token }, OfficeState);
    this.adopt(room);
    this.peers?.setLocalStream(useStore.getState().localStream);
  }

  private adopt(room: Room<OfficeState>): void {
    // A connect that resolves after disconnect() (React StrictMode remounts do
    // exactly this) must not install itself over the live session.
    if (this.disposed) {
      void room.leave(true);
      return;
    }

    this.myRoom = room;
    roomRef.current = room;
    this.reconnectionToken = room.reconnectionToken;

    // A reconnect hands us a new Room, so the peer manager is rebuilt against it.
    this.peers?.closeAll();
    this.peers = new PeerManager(room, this.iceServers);
    this.peers.setLocalStream(useStore.getState().localStream);

    room.onMessage(S2C.ProximityEnter, (m: ProximityEnterMessage) => {
      if (!useStore.getState().peers[m.peerId]) this.note(m.peerId, "joined your huddle");
      this.peers?.onProximityEnter(m);
    });
    room.onMessage(S2C.ProximityExit, (m: ProximityExitMessage) => {
      if (useStore.getState().peers[m.peerId]) this.note(m.peerId, "left your huddle");
      this.peers?.onProximityExit(m.peerId);
    });
    room.onMessage(S2C.Signal, (m: SignalInMessage) => {
      void this.peers?.onSignal(m);
    });
    room.onMessage(S2C.Chat, (m: ChatInMessage) => {
      useStore.getState().addChat({ kind: "msg", ...m });
    });

    room.onStateChange(() => this.mirrorState());
    room.onError((code, message) => {
      console.error("[net] room error", code, message);
    });
    room.onLeave((code) => void this.handleLeave(code));

    useStore.getState().set({
      connection: "connected",
      connectionDetail: "",
      sessionId: room.sessionId,
    });
    this.mirrorState();

    // Re-assert our local toggles: after a fresh (non-resumed) join the server
    // has defaults, and they would otherwise disagree with the UI.
    const s = useStore.getState();
    room.send(C2S.SetStatus, { status: s.status });
    room.send(C2S.SetMedia, { micOn: s.micOn, camOn: s.camOn, sharing: s.sharing });
  }

  /** A local line in the nearby chat ("Bob joined your huddle"); never sent anywhere. */
  private note(peerId: string, what: string): void {
    const name = useStore.getState().players[peerId]?.name ?? "Someone";
    const at = Date.now();
    useStore.getState().addChat({ kind: "sys", id: `sys-${at}-${peerId}`, scope: "nearby", text: `${name} ${what}`, at });
  }

  /** Projects Colyseus state into the store for the React UI (presence list,
   *  name labels on bubbles). Phaser reads the room state directly instead. */
  private mirrorState(): void {
    const room = this.room;
    if (!room) return;

    const players: Record<string, PlayerView> = {};
    room.state.players.forEach((p, sessionId) => {
      players[sessionId] = {
        sessionId,
        userId: p.userId,
        name: p.name,
        picture: p.picture,
        avatar: p.avatar,
        status: p.status as PlayerStatus,
        micOn: p.micOn,
        camOn: p.camOn,
        sharing: p.sharing,
        connected: p.connected,
        lockGroup: p.lockGroup,
        isSelf: sessionId === room.sessionId,
      };
    });
    useStore.getState().set({ players });
  }

  /**
   * TURN credentials expire (TURN_TTL_SEC), so they're fetched on join and
   * refreshed at half their lifetime; live calls get them too, for any later
   * ICE restart. A failed refresh keeps the old ones and tries again soon.
   */
  private async refreshIceServers(): Promise<void> {
    if (this.iceRefreshTimer) clearTimeout(this.iceRefreshTimer);
    let nextMs = 60_000;
    try {
      const { iceServers, ttlSec } = await fetchIceServers();
      this.iceServers = iceServers;
      this.peers?.setIceServers(iceServers);
      nextMs = (ttlSec * 1000) / 2;
    } catch (err) {
      console.warn("[net] could not refresh ICE servers", err);
    }
    if (!this.disposed) this.iceRefreshTimer = setTimeout(() => void this.refreshIceServers(), nextMs);
  }

  // ---------------------------------------------------------------- reconnect
  private async handleLeave(code: number): Promise<void> {
    if (this.leavingIntentionally || this.disposed) return;

    console.warn("[net] connection lost", code);
    // Tear the calls down straight away — a peer whose socket dropped is not
    // coming back on the same peer connection, and a frozen tile is worse than
    // no tile.
    this.peers?.closeAll();
    useStore.getState().set({
      connection: "reconnecting",
      connectionDetail: "Connection lost. Reconnecting…",
      peers: {},
    });

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (this.disposed) return;
      await sleep(RETRY_DELAYS_MS[attempt]!);
      if (this.disposed) return;

      useStore.getState().set({
        connectionDetail: `Reconnecting… (attempt ${attempt + 1} of ${RETRY_DELAYS_MS.length})`,
      });

      // 1. Resume the same seat, which keeps our position and identity.
      if (this.reconnectionToken) {
        try {
          const room = await this.client.reconnect<OfficeState>(this.reconnectionToken, OfficeState);
          this.adopt(room);
          console.info("[net] resumed previous session");
          return;
        } catch {
          /* grace window probably expired — fall through */
        }
      }

      // 2. Otherwise start a fresh session (new spawn, same user).
      try {
        await this.refreshIceServers();
        const token = await fetchRealtimeToken();
        const room = await this.client.joinOrCreate<OfficeState>("office", { token }, OfficeState);
        this.adopt(room);
        console.info("[net] rejoined with a new session");
        return;
      } catch {
        /* keep retrying */
      }
    }

    useStore.getState().set({
      connection: "failed",
      connectionDetail: "Could not reconnect. Check your network, then reload.",
    });
  }

  // ------------------------------------------------------------------- actions
  setStatus(status: PlayerStatus): void {
    useStore.getState().set({ status });
    this.room?.send(C2S.SetStatus, { status });
  }

  sendChat(scope: ChatScope, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.room?.send(C2S.Chat, { scope, text: trimmed.slice(0, CHAT_MAX_LENGTH) });
  }

  /** Locks or unlocks the huddle you're currently in. */
  /** Shows a new (already saved) look to everyone at once. */
  setAvatar(look: string): void {
    this.room?.send(C2S.SetAvatar, { look });
  }

  setLocked(locked: boolean): void {
    this.room?.send(C2S.SetLock, { locked });
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.iceRefreshTimer) clearTimeout(this.iceRefreshTimer);
    this.leavingIntentionally = true;
    this.peers?.closeAll();
    this.peers = null;
    const mine = this.myRoom;
    this.myRoom = null;
    // Only clear the shared ref if it still points at OUR room — a newer session
    // may already have claimed it.
    if (roomRef.current === mine) roomRef.current = null;
    try {
      await mine?.leave(true);
    } catch {
      /* already gone */
    }
  }
}
