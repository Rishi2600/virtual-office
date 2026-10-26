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

/** Waits between reconnect attempts; after the last one it keeps trying every
 *  RETRY_EVERY_MS for as long as the page is open (a laptop waking up, a train
 *  leaving a tunnel), and straight away when the browser says it's back online. */
const RETRY_DELAYS_MS = [400, 900, 1800, 3000, 5000];
const RETRY_EVERY_MS = 10_000;

/** Must match the close codes in server/src/rooms/OfficeRoom.ts. */
const CLOSE_SIGNED_OUT = 4401;
const CLOSE_REPLACED = 4409;

const OFFICE_FULL = "The office is full right now. Try again in a little while.";

/** Back to the sign-in page, which explains "You've been signed out". */
function signedOut(): void {
  location.href = "/?error=signedout";
}

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
  /** Wakes a reconnect wait early (the browser came back online). */
  private wake: (() => void) | null = null;

  constructor() {
    window.addEventListener("online", this.onOnline);
    // Closing or reloading the tab is a deliberate leave: tell the server, so
    // others see you go now rather than after the 30 s reconnect window.
    window.addEventListener("pagehide", this.onPageHide);
  }

  private onOnline = () => this.wake?.();
  private onPageHide = (e: PageTransitionEvent) => {
    // A page kept in the back/forward cache may come back; let the normal
    // reconnect handle that instead.
    if (!e.persisted) void this.myRoom?.leave(true).catch(() => {});
  };

  /** Sleeps, unless woken early by the network coming back. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wake = done;
    });
  }

  get room(): Room<OfficeState> | null {
    return this.myRoom;
  }

  // ------------------------------------------------------------------ connect
  async connect(): Promise<void> {
    useStore.getState().set({ connection: "connecting", connectionDetail: "" });

    // Ask for the MICROPHONE only (the camera is never requested here: video
    // is opt-in), but don't wait for the answer: the browser's prompt can sit
    // there as long as the user likes, and they should be in the office
    // meanwhile. Once it's answered, the track joins any call already open,
    // the same way the "Try again" banner does.
    void ensureMicrophone().then(() => this.peers?.setLocalStream(useStore.getState().localStream));

    await this.refreshIceServers();
    const token = await fetchRealtimeToken().catch((err: Error) => {
      // Signed out meanwhile (e.g. "Use here" after another tab signed out).
      if (err.message.startsWith("401")) signedOut();
      throw err;
    });
    // Disposed meanwhile (React's development double-mount does this): don't
    // join, or this stale join would replace the live one (newest tab wins).
    if (this.disposed) return;
    const room = await this.client.joinOrCreate<OfficeState>("office", { token }, OfficeState).catch((err: Error) => {
      throw new Error(err.message === "office_full" ? OFFICE_FULL : err.message, { cause: err });
    });
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

    // Called on every state patch (20 times a second while anyone walks), but
    // positions aren't part of PlayerView: keep unchanged entries, and skip
    // the store update entirely when nothing the UI shows has changed.
    const prev = useStore.getState().players;
    let changed = Object.keys(prev).length !== room.state.players.size;
    const players: Record<string, PlayerView> = {};
    room.state.players.forEach((p, sessionId) => {
      const next: PlayerView = {
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
      const old = prev[sessionId];
      const same = !!old && (Object.keys(next) as Array<keyof PlayerView>).every((k) => old[k] === next[k]);
      players[sessionId] = same ? old : next;
      if (!same) changed = true;
    });
    if (changed) useStore.getState().set({ players });
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
    // The server ended our sign-in session (signed out elsewhere, or removed):
    // retrying can't help, so go back to the sign-in page and say why.
    if (code === CLOSE_SIGNED_OUT) return signedOut();
    // Opened somewhere else: that tab is the office now. This one offers "Use here".
    if (code === CLOSE_REPLACED) {
      void this.disconnect();
      useStore.getState().set({ connection: "replaced", connectionDetail: "", peers: {} });
      return;
    }

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

    for (let attempt = 0; ; attempt++) {
      if (this.disposed) return;
      await this.wait(RETRY_DELAYS_MS[attempt] ?? RETRY_EVERY_MS);
      if (this.disposed) return;
      // Offline: don't burn attempts; the "online" event wakes us.
      if (!navigator.onLine) {
        useStore.getState().set({ connectionDetail: "You're offline. Reconnecting when the network is back…" });
        continue;
      }

      useStore.getState().set({ connectionDetail: `Reconnecting… (attempt ${attempt + 1})` });

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
      } catch (err) {
        // Signed out meanwhile (expired or revoked): retrying can't fix that.
        if ((err as Error).message?.startsWith("401")) return signedOut();
        /* otherwise keep retrying */
      }
    }
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

  /** Shows a new (already saved) look to everyone at once. */
  setAvatar(look: string): void {
    this.room?.send(C2S.SetAvatar, { look });
  }

  /** Locks or unlocks the huddle you're currently in. */
  setLocked(locked: boolean): void {
    this.room?.send(C2S.SetLock, { locked });
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("pagehide", this.onPageHide);
    this.wake?.();
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
