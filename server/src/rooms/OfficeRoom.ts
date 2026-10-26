import { Room, ServerError, type AuthContext, type Client } from "@colyseus/core";
import {
  C2S,
  MAX_INPUT_DT,
  PROXIMITY_EXIT,
  OfficeState,
  Player,
  type ChatInMessage,
  type ChatScope,
  RECONNECT_WINDOW_SEC,
  S2C,
  TICK_MS,
  applyInput,
  isPolite,
  boxHitsSolid,
  PLAYER_FEET_OFFSET,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  parseAvatarMessage,
  parseChat,
  parseInput,
  parseLock,
  parseLook,
  parseMedia,
  parseRtcFailure,
  parseSignal,
  parseStatus,
  resolveLook,
  type CollisionGrid,
  type InputMessage,
  type PlayerStatus,
  type ProximityEnterMessage,
  type ProximityExitMessage,
  type SetMediaMessage,
} from "@vo/shared";
import { verifyToken, type Claims } from "../auth/jwt.js";
import { proximityLog, wsLog } from "../log.js";
import { loadMap } from "../maps/loadMap.js";
import { ProximityTracker, type ProximityCandidate } from "./proximity.js";
import { SignalingRelay } from "./signaling.js";
import { loadSpot, saveSpots } from "./spots.js";
import { liveSessions } from "../auth/sessions.js";
import { originAllowed } from "../security.js";
import { RateLimiter, type LimitKind } from "./rateLimit.js";
import type { SpotRecord } from "../db/index.js";

/** Simulated-time allowance per client, to bound how far one burst of input can
 *  move you. Well-behaved clients never hit this; it only binds if someone
 *  sends inputs faster than wall-clock time passes. */
const BUDGET_CAP_SEC = 0.25;

interface InputBudget {
  remaining: number;
  last: number;
}

/** How often the spots of people who moved are saved (see rooms/spots.ts):
 *  a crash loses at most this much walking. */
const SPOT_SAVE_MS = 30_000;

/** How often connected people's sign-in sessions are re-checked: signing out
 *  elsewhere or being removed disconnects you within this long. */
const SESSION_CHECK_MS = 15_000;
/** The office map (and the space key its saved spots are stored under). */
const DEFAULT_MAP = "office";

/** Close code for "your session ended"; the client goes to the sign-in page. */
export const CLOSE_SIGNED_OUT = 4401;
/** Close code for a connection that kept flooding the room with messages. */
export const CLOSE_FLOODING = 4429;
/** Close code for "you opened Lamports somewhere else" (newest tab wins). */
export const CLOSE_REPLACED = 4409;

/** Only one office per map: a second one would split the team into two
 *  offices that can't see each other (audit OPS-8). */
const openOffices = new Set<string>();

/** What onAuth hands to onJoin: who you are, and where you last stood. */
type JoinAuth = Claims & { spot: { x: number; y: number } | null };

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
  /** The last spot saved per user, so only people who moved are saved again. */
  private readonly savedSpots = new Map<string, { x: number; y: number }>();
  /** Room session id -> the sign-in session it joined with. */
  private readonly sessionOf = new Map<string, string>();
  /** Disconnected on purpose (session ended): no reconnect window for them. */
  private readonly kicked = new Set<string>();
  private readonly proximity = new ProximityTracker();
  private signaling!: SignalingRelay;
  private readonly budgets = new Map<string, InputBudget>();
  private chatSeq = 0;
  private lockSeq = 0;
  private mapKey = "office";
  /** Connections in their reconnect window, so a newer tab can cancel it. */
  private readonly reconnecting = new Map<string, ReturnType<Room["allowReconnection"]>>();
  /** Per connection: rate limits for its messages. */
  private readonly limiters = new Map<string, RateLimiter>();
  /** When each (connection, type, reason) last logged a dropped message. */
  private readonly droppedLogged = new Map<string, number>();

  // ------------------------------------------------------------------ setup
  onCreate(options: { mapKey?: string }): void {
    const mapKey = options?.mapKey ?? DEFAULT_MAP;
    // Colyseus creates a new room when the current one is full. Refuse
    // instead: the client says the office is full and keeps retrying.
    if (openOffices.has(mapKey)) throw new ServerError(503, "office_full");
    openOffices.add(mapKey);
    this.mapKey = mapKey;
    const loaded = loadMap(mapKey);
    this.grid = loaded.grid;
    this.spawns = loaded.spawns;

    const state = new OfficeState();
    state.mapKey = mapKey;
    this.setState(state);

    this.setPatchRate(TICK_MS);
    this.setSimulationInterval(() => this.tick(), TICK_MS);
    this.clock.setInterval(() => this.saveMovedSpots(), SPOT_SAVE_MS);
    this.clock.setInterval(() => void this.dropEndedSessions(), SESSION_CHECK_MS);

    this.signaling = new SignalingRelay(this, this.proximity);

    // Every client message goes through `on`: rate limit, then a strict shape
    // check (shared/src/validate.ts), then the handler with a clean object.
    this.on(C2S.Input, "input", parseInput, (c, m) => this.handleInput(c, m));
    this.on(C2S.SetStatus, "control", parseStatus, (c, m) => this.handleStatus(c, m));
    this.on(C2S.SetMedia, "control", parseMedia, (c, m) => this.handleMedia(c, m));
    this.on(C2S.Signal, "signal", parseSignal, (c, m) => this.signaling.relay(c, m));
    this.on(C2S.RtcFailure, "report", parseRtcFailure, (c, m) => this.signaling.reportFailure(c, m));
    this.on(C2S.Chat, "chat", parseChat, (c, m) => this.handleChat(c, m));
    this.on(C2S.SetLock, "control", parseLock, (c, m) => this.handleLock(c, m));
    this.on(C2S.SetAvatar, "control", parseAvatarMessage, (c, m) => this.handleAvatar(c, m));
    // Anything else is dropped quietly (Colyseus would log every one).
    this.onMessage("*", (client, type) => {
      if (this.kicked.has(client.sessionId)) return;
      this.limiters.get(client.sessionId)?.allow("control");
      this.noteDropped(client, String(type).slice(0, 32), "unknown type");
    });

    wsLog.info({ roomId: this.roomId, mapKey }, "room created");
  }

  /**
   * The gate, run by the matchmaker BEFORE a seat is reserved (static onAuth;
   * an instance-level onAuth only ran at the WebSocket step, so anyone could
   * reserve seats with a made-up token and keep the office "full"). Whatever
   * it returns is handed to onJoin.
   */
  static async onAuth(bearer: string | undefined, options: { token?: string }, context: AuthContext): Promise<JoinAuth> {
    // Only our own pages may join (audit SEC-11); the matchmaker's CORS and
    // the WebSocket upgrade check this too.
    if (!originAllowed(context?.headers?.origin)) {
      wsLog.warn("join rejected: request from another site");
      throw new ServerError(403, "forbidden_origin");
    }
    const claims = verifyToken(options?.token ?? bearer, "realtime");
    if (!claims) {
      wsLog.warn("join rejected: invalid or expired realtime token");
      throw new ServerError(401, "unauthorized");
    }
    // The realtime token is short-lived, but the session behind it may have
    // been ended since it was minted (signed out, removed).
    if (!(await liveSessions([claims.sid])).has(claims.sid)) {
      wsLog.warn({ userId: claims.sub }, "join rejected: sign-in session has ended");
      throw new ServerError(401, "unauthorized");
    }
    // Looked up here (onAuth may be async; onJoin stays synchronous). There's
    // one office map, so its saved spots are under "office".
    return { ...claims, spot: await loadSpot(claims.sub, DEFAULT_MAP) };
  }

  // ------------------------------------------------------------- membership
  onJoin(client: Client, _options: unknown, auth: JoinAuth): void {
    // Newest tab wins (owner decision): the same person's older connection
    // leaves, and the new one carries on from where it stood.
    let takeover: { x: number; y: number } | null = null;
    this.state.players.forEach((p, sessionId) => {
      if (p.userId !== auth.sub || sessionId === client.sessionId) return;
      takeover ??= { x: p.x, y: p.y };
      this.replace(sessionId);
    });

    const player = new Player();
    player.userId = auth.sub;
    player.name = auth.name || auth.email;
    player.picture = auth.picture ?? "";
    player.avatar = resolveLook(auth.avatar, auth.sub);

    // Back where you last stood, always (owner decision), even if that's in
    // someone's conversation: after a restart, that's the point. Only a spot
    // that is no longer walkable (the map changed) falls back to a spawn.
    const saved = takeover ?? auth.spot;
    const spot = saved && this.isStandable(saved) ? saved : this.pickSpawn();
    player.x = spot.x;
    player.y = spot.y;
    this.savedSpots.set(auth.sub, { x: spot.x, y: spot.y });
    this.sessionOf.set(client.sessionId, auth.sid);
    this.limiters.set(client.sessionId, new RateLimiter());

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

    if (consented || this.kicked.delete(client.sessionId)) {
      this.removePlayer(client.sessionId);
      return;
    }

    const reconnection = this.allowReconnection(client, RECONNECT_WINDOW_SEC);
    this.reconnecting.set(client.sessionId, reconnection);
    try {
      await reconnection;
      const rejoined = this.state.players.get(client.sessionId);
      if (rejoined) rejoined.connected = true;
      // Reset the input budget: the client has been away, and banked wall-clock
      // time would otherwise let it move a long way in one burst.
      this.budgets.set(client.sessionId, { remaining: BUDGET_CAP_SEC, last: Date.now() });
      wsLog.info({ sessionId: client.sessionId }, "client reconnected");
    } catch {
      wsLog.info({ sessionId: client.sessionId }, "reconnect window ended");
      this.removePlayer(client.sessionId);
    } finally {
      this.reconnecting.delete(client.sessionId);
    }
  }

  /** Takes an older connection of someone out of the office because they
   *  joined again (newest tab wins). Their tab is told why (4409) and offers
   *  "Use here"; no reconnect window, so there's never a duplicate. */
  private replace(sessionId: string): void {
    wsLog.info({ sessionId }, "replaced by a newer connection of the same person");
    const old = this.clients.getById(sessionId);
    if (old) {
      this.kicked.add(sessionId);
      old.leave(CLOSE_REPLACED);
    } else {
      this.reconnecting.get(sessionId)?.reject(new Error("replaced"));
    }
    this.removePlayer(sessionId);
  }

  onDispose(): void {
    openOffices.delete(this.mapKey);
    // Anyone still here (shutdown, or a reconnect window cut short): keep their spot.
    const left: SpotRecord[] = [];
    this.state.players.forEach((p) => left.push({ userId: p.userId, x: p.x, y: p.y }));
    saveSpots(this.state.mapKey, left);
    wsLog.info({ roomId: this.roomId }, "room disposed");
  }

  /**
   * The next spawn point, in rotation, that isn't within earshot of anyone,
   * so nobody arrives inside someone else's conversation. If every spawn is
   * taken, the one furthest from everybody.
   */
  private pickSpawn(): { x: number; y: number } {
    const n = this.spawns.length;
    let best = this.spawns[this.spawnCursor % n]!;
    let bestGap = -1;
    for (let i = 0; i < n; i++) {
      const s = this.spawns[(this.spawnCursor + i) % n]!;
      let gap = Infinity;
      this.state.players.forEach((p) => {
        gap = Math.min(gap, Math.hypot(p.x - s.x, p.y - s.y));
      });
      if (gap > bestGap) [best, bestGap] = [s, gap];
      if (gap > PROXIMITY_EXIT) break;
    }
    this.spawnCursor++;
    return best;
  }

  /** A saved spot is only usable if a player can stand there on today's map. */
  private isStandable({ x, y }: { x: number; y: number }): boolean {
    return (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      !boxHitsSolid(this.grid, x, y + PLAYER_FEET_OFFSET, PLAYER_HALF_W, PLAYER_HALF_H)
    );
  }

  /** Saves the spots of everyone who moved since their last save, in one batch. */
  private saveMovedSpots(): void {
    const moved: SpotRecord[] = [];
    this.state.players.forEach((p) => {
      const saved = this.savedSpots.get(p.userId);
      if (saved && saved.x === p.x && saved.y === p.y) return;
      moved.push({ userId: p.userId, x: p.x, y: p.y });
      this.savedSpots.set(p.userId, { x: p.x, y: p.y });
    });
    saveSpots(this.state.mapKey, moved);
  }

  /** Disconnects anyone whose sign-in session has ended (signed out, removed). */
  private async dropEndedSessions(): Promise<void> {
    const ids = [...new Set(this.sessionOf.values())];
    if (ids.length === 0) return;
    let live: Set<string>;
    try {
      live = await liveSessions(ids);
    } catch (err) {
      wsLog.warn({ err: (err as Error).message }, "couldn't check sessions; trying again later");
      return;
    }
    for (const client of this.clients) {
      const sid = this.sessionOf.get(client.sessionId);
      if (sid && !live.has(sid)) {
        wsLog.info({ sessionId: client.sessionId }, "disconnecting: sign-in session ended");
        this.kicked.add(client.sessionId);
        client.leave(CLOSE_SIGNED_OUT);
      }
    }
  }

  private removePlayer(sessionId: string): void {
    this.sessionOf.delete(sessionId);
    this.limiters.delete(sessionId);
    for (const key of this.droppedLogged.keys()) if (key.startsWith(`${sessionId}|`)) this.droppedLogged.delete(key);
    const player = this.state.players.get(sessionId);
    if (player) {
      saveSpots(this.state.mapKey, [{ userId: player.userId, x: player.x, y: player.y }]);
      this.savedSpots.delete(player.userId);
    }
    this.state.players.delete(sessionId);
    this.budgets.delete(sessionId);
  }

  // ---------------------------------------------------------------- messages
  private on<T>(type: string, kind: LimitKind, parse: (raw: unknown) => T | null, handle: (client: Client, msg: T) => void): void {
    this.onMessage(type, (client, raw: unknown) => {
      const limiter = this.limiters.get(client.sessionId);
      // No limiter: not (or no longer) in the room, e.g. already told to
      // leave while its queued messages are still arriving.
      if (!limiter || this.kicked.has(client.sessionId)) return;
      if (!limiter.allow(kind)) {
        if (limiter.flooding()) {
          wsLog.warn({ sessionId: client.sessionId, type }, "disconnecting: flooding the room with messages");
          this.kicked.add(client.sessionId);
          client.leave(CLOSE_FLOODING);
          return;
        }
        this.noteDropped(client, type, "rate limit");
        return;
      }
      const msg = parse(raw);
      if (msg === null) return this.noteDropped(client, type, "invalid");
      handle(client, msg);
    });
  }

  /** Logs a dropped message at most once every 10 s per connection, type and
   *  reason, so a flood can't fill the log either. */
  private noteDropped(client: Client, type: string, reason: string): void {
    const key = `${client.sessionId}|${type}|${reason}`;
    const now = Date.now();
    if (now - (this.droppedLogged.get(key) ?? 0) < 10_000) return;
    this.droppedLogged.set(key, now);
    wsLog.warn({ sessionId: client.sessionId, type, reason }, "client message dropped");
  }

  private handleInput(client: Client, msg: InputMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const budget = this.budgets.get(client.sessionId);
    if (!budget) return;

    const now = Date.now();
    budget.remaining = Math.min(budget.remaining + (now - budget.last) / 1000, BUDGET_CAP_SEC);
    budget.last = now;

    const dt = Math.min(msg.dt, MAX_INPUT_DT, budget.remaining);
    budget.remaining -= dt;

    // Same function the client used to predict this move. If these ever
    // disagree, the local player rubber-bands.
    applyInput(player, { seq: msg.seq, dx: msg.dx, dy: msg.dy, dt }, this.grid);

    if (msg.seq > player.lastSeq) {
      player.lastSeq = msg.seq;
    }
  }

  private handleStatus(client: Client, status: PlayerStatus): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
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
  private handleChat(client: Client, { scope, text }: { scope: ChatScope; text: string }): void {
    const sender = this.state.players.get(client.sessionId);
    if (!sender) return;

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

  /** A new look from the avatar builder, shown to everyone at once. Invalid
   *  looks are ignored, so nobody can push something the client can't draw. */
  private handleAvatar(client: Client, look: string): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !parseLook(look)) return;
    player.avatar = look;
  }

  /** Locks or unlocks the sender's current huddle. */
  private handleLock(client: Client, locked: boolean): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (locked) {
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
    if (!player) return;
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
