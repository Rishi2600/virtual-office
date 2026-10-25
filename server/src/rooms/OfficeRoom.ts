import { Room, ServerError, type AuthContext, type Client } from "@colyseus/core";
import {
  C2S,
  CHAT_MAX_LENGTH,
  MAX_INPUT_DT,
  OfficeState,
  Player,
  type ChatInMessage,
  type ChatOutMessage,
  type ChatScope,
  type SetLockMessage,
  RECONNECT_WINDOW_SEC,
  S2C,
  TICK_MS,
  applyInput,
  isPolite,
  resolveLook,
  type CollisionGrid,
  type InputMessage,
  type ProximityEnterMessage,
  type ProximityExitMessage,
  type RtcFailureMessage,
  type SetMediaMessage,
  type SetStatusMessage,
  type SignalOutMessage,
} from "@vo/shared";
import { verifyToken, type Claims } from "../auth/jwt.js";
import { proximityLog, wsLog } from "../log.js";
import { loadMap } from "../maps/loadMap.js";
import { ProximityTracker, type ProximityCandidate } from "./proximity.js";
import { SignalingRelay } from "./signaling.js";

/** Simulated-time allowance per client, to bound how far one burst of input can
 *  move you. Well-behaved clients never hit this; it only binds if someone
 *  sends inputs faster than wall-clock time passes. */
const BUDGET_CAP_SEC = 0.25;

interface InputBudget {
  remaining: number;
  last: number;
}

/**
 * One Colyseus room == one virtual office space == one authoritative unit of
 * state. Everything runs in a single process today, but nothing here reaches
 * outside the room instance, so sharding rooms across processes later is a
 * matchmaker/presence change rather than a rewrite of this file.
 */
export class OfficeRoom extends Room<OfficeState> {
  maxClients = 40;

  private grid!: CollisionGrid;
  private spawns: Array<{ x: number; y: number }> = [];
  private spawnCursor = 0;
  private readonly proximity = new ProximityTracker();
  private signaling!: SignalingRelay;
  private readonly budgets = new Map<string, InputBudget>();
  private chatSeq = 0;
  private lockSeq = 0;

  // ------------------------------------------------------------------ setup
  onCreate(options: { mapKey?: string }): void {
    const mapKey = options?.mapKey ?? "office";
    const loaded = loadMap(mapKey);
    this.grid = loaded.grid;
    this.spawns = loaded.spawns;

    const state = new OfficeState();
    state.mapKey = mapKey;
    this.setState(state);

    this.setPatchRate(TICK_MS);
    this.setSimulationInterval(() => this.tick(), TICK_MS);

    this.signaling = new SignalingRelay(this, this.proximity);

    this.onMessage(C2S.Input, (client, msg: InputMessage) => this.handleInput(client, msg));
    this.onMessage(C2S.SetStatus, (client, msg: SetStatusMessage) => this.handleStatus(client, msg));
    this.onMessage(C2S.SetMedia, (client, msg: SetMediaMessage) => this.handleMedia(client, msg));
    this.onMessage(C2S.Signal, (client, msg: SignalOutMessage) => this.signaling.relay(client, msg));
    this.onMessage(C2S.RtcFailure, (client, msg: RtcFailureMessage) =>
      this.signaling.reportFailure(client, msg),
    );
    this.onMessage(C2S.Chat, (client, msg: ChatOutMessage) => this.handleChat(client, msg));
    this.onMessage(C2S.SetLock, (client, msg: SetLockMessage) => this.handleLock(client, msg));

    wsLog.info({ roomId: this.roomId, mapKey }, "room created");
  }

  /**
   * Handshake gate. This runs during the WebSocket upgrade, before the client is
   * admitted to the room — so an unauthenticated socket never reaches game
   * state, and checking auth only on the initial HTTP request is not enough.
   */
  onAuth(_client: Client, options: { token?: string }, context: AuthContext): Claims {
    const token = options?.token ?? context?.token;
    const claims = verifyToken(token, "realtime");
    if (!claims) {
      wsLog.warn({ ip: context?.ip }, "join rejected: invalid or expired realtime token");
      throw new ServerError(401, "unauthorized");
    }
    return claims;
  }

  // ------------------------------------------------------------- membership
  onJoin(client: Client, _options: unknown, auth: Claims): void {
    const player = new Player();
    player.userId = auth.sub;
    player.name = auth.name || auth.email;
    player.picture = auth.picture ?? "";
    player.avatar = resolveLook(undefined, auth.sub);

    const spawn = this.spawns[this.spawnCursor++ % this.spawns.length]!;
    player.x = spawn.x;
    player.y = spawn.y;

    this.state.players.set(client.sessionId, player);
    this.budgets.set(client.sessionId, { remaining: BUDGET_CAP_SEC, last: Date.now() });

    wsLog.info(
      { sessionId: client.sessionId, userId: auth.sub, name: player.name, clients: this.clients.length },
      "client connected",
    );
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    wsLog.info(
      { sessionId: client.sessionId, consented: !!consented, name: player?.name },
      "client disconnected",
    );

    // Mark disconnected immediately. The tracker drops their pairs on the next
    // tick, so peers tear down their WebRTC connections instead of being left
    // staring at a frozen video tile for the whole reconnect window.
    if (player) player.connected = false;

    if (consented) {
      this.removePlayer(client.sessionId);
      return;
    }

    try {
      await this.allowReconnection(client, RECONNECT_WINDOW_SEC);
      const rejoined = this.state.players.get(client.sessionId);
      if (rejoined) rejoined.connected = true;
      // Reset the input budget: the client has been away, and banked wall-clock
      // time would otherwise let it move a long way in one burst.
      this.budgets.set(client.sessionId, { remaining: BUDGET_CAP_SEC, last: Date.now() });
      wsLog.info({ sessionId: client.sessionId }, "client reconnected");
    } catch {
      wsLog.info({ sessionId: client.sessionId }, "reconnect window expired");
      this.removePlayer(client.sessionId);
    }
  }

  onDispose(): void {
    wsLog.info({ roomId: this.roomId }, "room disposed");
  }

  private removePlayer(sessionId: string): void {
    this.state.players.delete(sessionId);
    this.budgets.delete(sessionId);
  }

  // ---------------------------------------------------------------- messages
  private handleInput(client: Client, msg: InputMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !msg) return;

    const budget = this.budgets.get(client.sessionId);
    if (!budget) return;

    const now = Date.now();
    budget.remaining = Math.min(budget.remaining + (now - budget.last) / 1000, BUDGET_CAP_SEC);
    budget.last = now;

    const dt = Math.min(Math.max(msg.dt ?? 0, 0), MAX_INPUT_DT, budget.remaining);
    budget.remaining -= dt;

    // Same function the client used to predict this move. If these ever
    // disagree, the local player rubber-bands.
    applyInput(player, { seq: msg.seq, dx: msg.dx, dy: msg.dy, dt }, this.grid);

    if (typeof msg.seq === "number" && msg.seq > player.lastSeq) {
      player.lastSeq = msg.seq;
    }
  }

  private handleStatus(client: Client, msg: SetStatusMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const status = msg?.status === "focus" ? "focus" : "available";
    if (player.status === status) return;
    player.status = status;
    proximityLog.info({ sessionId: client.sessionId, status }, "status changed");
    // Entering focus makes the player ineligible, so the next tick emits exits
    // for every call they were in. Suppression is authoritative here — a patched
    // client cannot force a call on someone who is in focus mode.
  }

  /**
   * Chat is RELAY ONLY. Messages are never written to the database, never put
   * into the Colyseus schema, and never kept on the server after the send
   * returns — they exist only in recipients' browser memory. That is what keeps
   * the "no conversation data is recorded" guarantee true for text as well.
   */
  private handleChat(client: Client, msg: ChatOutMessage): void {
    const sender = this.state.players.get(client.sessionId);
    if (!sender || typeof msg?.text !== "string") return;

    const text = msg.text.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;

    const scope: ChatScope = msg.scope === "room" ? "room" : "nearby";
    const payload: ChatInMessage = {
      id: `${client.sessionId}-${++this.chatSeq}`,
      from: client.sessionId,
      name: sender.name,
      scope,
      text,
      at: Date.now(),
    };

    if (scope === "room") {
      this.broadcast(S2C.Chat, payload);
      return;
    }

    // "nearby" reaches the whole huddle, so a chain A-B-C is one conversation
    // rather than two disconnected pairs.
    for (const sessionId of this.proximity.clusterOf(client.sessionId)) {
      this.sendTo(sessionId, S2C.Chat, payload);
    }
  }

  /** Locks or unlocks the sender's current huddle. */
  private handleLock(client: Client, msg: SetLockMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (msg?.locked) {
      const cluster = this.proximity.clusterOf(client.sessionId);
      // Locking alone would just be Focus mode; require someone to lock WITH.
      if (cluster.size < 2) return;

      const group = `lock-${this.roomId}-${++this.lockSeq}`;
      for (const sessionId of cluster) {
        const member = this.state.players.get(sessionId);
        if (member) member.lockGroup = group;
      }
      proximityLog.info({ group, members: [...cluster] }, "huddle locked");
    } else {
      const group = player.lockGroup;
      if (!group) return;
      this.clearLockGroup(group);
      proximityLog.info({ group }, "huddle unlocked");
    }
  }

  private clearLockGroup(group: string): void {
    this.state.players.forEach((p) => {
      if (p.lockGroup === group) p.lockGroup = "";
    });
  }

  /**
   * A lock only means anything while the people holding it are still together.
   *
   * Counting members isn't enough: two locked people who walk to opposite ends
   * of the office would both keep the lock forever and be silently un-callable.
   * So a member who is no longer in proximity with ANY other member of their
   * group is dropped from it, and a group that falls below two is dissolved.
   */
  private reconcileLocks(): void {
    const groups = new Map<string, string[]>();
    this.state.players.forEach((player, sessionId) => {
      if (!player.lockGroup || !player.connected) return;
      const members = groups.get(player.lockGroup) ?? [];
      members.push(sessionId);
      groups.set(player.lockGroup, members);
    });

    for (const [group, members] of groups) {
      if (members.length < 2) {
        this.clearLockGroup(group);
        proximityLog.info({ group }, "huddle lock released: nobody left to hold it");
        continue;
      }

      const memberSet = new Set(members);
      const stranded = members.filter((sessionId) => {
        for (const other of this.proximity.clusterOf(sessionId)) {
          if (other !== sessionId && memberSet.has(other)) return false;
        }
        return true; // no fellow member still within reach
      });

      for (const sessionId of stranded) {
        const player = this.state.players.get(sessionId);
        if (player) player.lockGroup = "";
      }
      if (stranded.length) {
        proximityLog.info({ group, stranded }, "huddle lock released for members who walked away");
      }
      if (members.length - stranded.length < 2) this.clearLockGroup(group);
    }
  }

  private handleMedia(client: Client, msg: SetMediaMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !msg) return;
    if (typeof msg.micOn === "boolean") player.micOn = msg.micOn;
    if (typeof msg.camOn === "boolean") player.camOn = msg.camOn;
    if (typeof msg.sharing === "boolean") player.sharing = msg.sharing;
  }

  // -------------------------------------------------------------------- tick
  private tick(): void {
    // Before pairing, so a lock nobody is still holding can't block anyone.
    this.reconcileLocks();

    const candidates: ProximityCandidate[] = [];
    this.state.players.forEach((player, sessionId) => {
      candidates.push({
        sessionId,
        x: player.x,
        y: player.y,
        eligible: player.connected && player.status !== "focus",
        lockGroup: player.lockGroup,
      });
    });

    const { entered, exited } = this.proximity.update(candidates);

    for (const [a, b] of entered) {
      this.sendTo(a, S2C.ProximityEnter, { peerId: b, polite: isPolite(a, b) } as ProximityEnterMessage);
      this.sendTo(b, S2C.ProximityEnter, { peerId: a, polite: isPolite(b, a) } as ProximityEnterMessage);
      proximityLog.info({ a, b, offerer: isPolite(a, b) ? b : a }, "proximity enter");
    }

    for (const [a, b] of exited) {
      this.sendTo(a, S2C.ProximityExit, { peerId: b } as ProximityExitMessage);
      this.sendTo(b, S2C.ProximityExit, { peerId: a } as ProximityExitMessage);
      proximityLog.info({ a, b }, "proximity exit");
    }
  }

  private sendTo(sessionId: string, type: string, payload: unknown): void {
    this.clients.getById(sessionId)?.send(type, payload);
  }
}
