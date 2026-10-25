import Phaser from "phaser";
import type { Room } from "colyseus.js";
import officeMap from "@vo/shared/maps/office.json";
import type { RoomRef } from "../net/session.js";
import {
  C2S,
  INTERP_DELAY_MS,
  MAX_INPUT_DT,
  PROXIMITY_ENTER,
  RECONCILE_SNAP_PX,
  TILE_SIZE,
  buildCollisionGrid,
  applyInput,
  type CollisionGrid,
  type InputCommand,
  type OfficeState,
} from "@vo/shared";
import { positionBus, type ScreenPos } from "./bus.js";
import { sceneBus, type SceneCommand } from "./sceneBus.js";
import { findPath, nearestWalkable, tileCentre, tileOf } from "./pathfind.js";
import { avatarSheet, DIRS, FRAME_H, FRAME_W, WALK_FRAMES, type Dir } from "./avatarArt.js";

interface Snapshot {
  t: number;
  x: number;
  y: number;
}

interface AvatarView {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  /** The look its texture was built from (people can change it live). */
  look: string;
  /** Last drawn position, to tell walking from standing and pick a facing. */
  lastX: number;
  lastY: number;
  dir: Dir;
  /** Time spent walking, which drives the step frames. */
  walkMs: number;
}

/** Avatars are drawn at 2x their 18x26 art, so 36x52 world px. */
const AVATAR_SCALE = 2;
/** Feet sit where the collision box is (PLAYER_FEET_OFFSET + PLAYER_HALF_H = 16
 *  below the position); the art's feet are 22 art px from the top of a frame. */
const AVATAR_ORIGIN_Y = (22 * AVATAR_SCALE - 16) / (FRAME_H * AVATAR_SCALE);
/** One step frame every this many ms while walking. */
const STEP_MS = 140;

/** Send inputs at ~30Hz rather than every rendered frame. */
const INPUT_SEND_MS = 33;
/** Above this error we stop easing and just snap — something went badly wrong. */
const HARD_SNAP_PX = 48;

/** World px the camera may scroll past the bottom of the map. */
const BOTTOM_ROOM_PX = 160;

/** Zoom steps for the buttons, wheel and +/- keys; starts at 1.75. */
const ZOOMS = [1, 1.25, 1.5, 1.75, 2, 2.5];
const DEFAULT_ZOOM = 3;
/** A waypoint counts as reached within this many px on each axis. */
const ARRIVE_PX = 3;
/** Walking to a person stops this close to them: well inside call range. */
const WALK_TO_STOP_PX = 64;
/** An automatic walk that makes no progress for this long gives up. */
const STUCK_MS = 600;

/** Where an automatic walk (click/tap on the map, or "walk to" a person) is going. */
interface AutoWalk {
  waypoints: Array<{ x: number; y: number }>;
  /** Set when walking to a person: re-planned as they move. */
  personId?: string;
  replanMs: number;
  stuckMs: number;
  lastX?: number;
  lastY?: number;
  /** The direction pressed last, per axis (-1, 0, 1). */
  prevDx: number;
  prevDy: number;
}

export class OfficeScene extends Phaser.Scene {
  private roomRef!: RoomRef;
  private grid!: CollisionGrid;
  private lastSessionId: string | null = null;

  private keys!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key[]>;

  /** Locally predicted position of our own avatar. */
  private predicted = { x: 0, y: 0 };
  private pending: InputCommand[] = [];
  private seq = 0;
  private sendAccumulator = 0;
  private lastAck = -1;

  private avatars = new Map<string, AvatarView>();
  private snapshots = new Map<string, Snapshot[]>();
  private hearingGlow?: Phaser.GameObjects.Image;
  private targetMarker?: Phaser.GameObjects.Graphics;
  private autoWalk: AutoWalk | null = null;
  private following = true;
  private zoomIndex = DEFAULT_ZOOM;
  private ready = false;

  constructor() {
    super("office");
  }

  init(data: { roomRef: RoomRef }): void {
    this.roomRef = data.roomRef;
  }

  /** Reconnecting replaces the Room object, so always read it through the ref. */
  private get room(): Room<OfficeState> | null {
    return this.roomRef.current;
  }

  preload(): void {
    this.load.image("tiles", "/assets/tiles.png");
    // The map object is imported from @vo/shared, the exact same file the server
    // builds its collision grid from.
    this.cache.tilemap.add("office", {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: officeMap,
    });
  }

  create(): void {
    const map = this.make.tilemap({ key: "office" });
    const tileset = map.addTilesetImage("office", "tiles");
    if (!tileset) throw new Error("failed to bind tileset image");

    // Floor, then walkable decor (chairs), then walls and furniture. Avatars
    // are drawn above all three (depth 10+).
    map.createLayer("floor", tileset, 0, 0)?.setDepth(0);
    map.createLayer("decor", tileset, 0, 0)?.setDepth(1);
    map.createLayer("solid", tileset, 0, 0)?.setDepth(2);

    this.grid = buildCollisionGrid(officeMap);

    // Extra room below the map, so someone standing at the bottom edge can
    // still be centred above the dock and huddle bar instead of under them.
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels + BOTTOM_ROOM_PX);
    this.cameras.main.setZoom(ZOOMS[DEFAULT_ZOOM]!);
    this.cameras.main.setRoundPixels(true);
    this.cameras.main.setBackgroundColor("#0b0d12");

    const kb = this.input.keyboard!;
    const key = (code: number) => kb.addKey(code);
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      up: [key(K.UP), key(K.W)],
      down: [key(K.DOWN), key(K.S)],
      left: [key(K.LEFT), key(K.A)],
      right: [key(K.RIGHT), key(K.D)],
    };
    // Don't hijack browser shortcuts while the user is typing in the UI.
    kb.disableGlobalCapture();

    // A soft glow on the floor showing how close someone has to be before a
    // call starts. Makes proximity legible instead of something that just
    // happens to you.
    this.hearingGlow = this.add.image(0, 0, this.glowTexture()).setDepth(3);
    this.targetMarker = this.add.graphics().setDepth(3).setVisible(false);
    this.targetMarker.lineStyle(2, 0xb18cff, 0.9).strokeEllipse(0, 0, 18, 9);

    // Click or tap the floor to walk there (a drag of more than a few px isn't a click).
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (p.button !== 0 || p.getDistance() > 8) return;
      this.walkToPoint(p.worldX, p.worldY);
    });
    const off = sceneBus.on((cmd) => this.command(cmd));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, off);
    this.events.once(Phaser.Scenes.Events.DESTROY, off);

    const room = this.room;
    const self = room?.state.players.get(room.sessionId);
    this.predicted = { x: self?.x ?? 0, y: self?.y ?? 0 };
    this.lastSessionId = room?.sessionId ?? null;
    this.ready = true;
  }

  update(_time: number, delta: number): void {
    const room = this.room;
    if (!this.ready || !room) return;

    // A reconnect that could not resume the old seat gives us a new sessionId
    // and a new spawn point. Drop stale prediction state rather than letting
    // reconciliation fight it.
    if (room.sessionId !== this.lastSessionId) {
      this.lastSessionId = room.sessionId;
      const self = room.state.players.get(room.sessionId);
      this.predicted = { x: self?.x ?? this.predicted.x, y: self?.y ?? this.predicted.y };
      this.pending = [];
      this.seq = 0;
      this.lastAck = -1;
      this.snapshots.clear();
      for (const [, view] of this.avatars) view.container.destroy(true);
      this.avatars.clear();
    }

    const dtSec = Math.min(delta / 1000, MAX_INPUT_DT);
    this.handleInput(room, dtSec);
    this.reconcile(room);
    this.syncAvatars(room);
    this.publishScreenPositions();
  }

  // ------------------------------------------------------------------- input
  private down(keys: Phaser.Input.Keyboard.Key[]): boolean {
    return keys.some((k) => k.isDown);
  }

  private handleInput(room: Room<OfficeState>, dtSec: number): void {
    let dx = (this.down(this.keys.right) ? 1 : 0) - (this.down(this.keys.left) ? 1 : 0);
    let dy = (this.down(this.keys.down) ? 1 : 0) - (this.down(this.keys.up) ? 1 : 0);
    if (dx || dy) this.stopAutoWalk(); // the keyboard always wins
    else if (this.autoWalk) [dx, dy] = this.steer(room, dtSec);
    if ((dx || dy) && !this.following) this.followSelf();

    this.sendAccumulator += dtSec * 1000;
    if (dx === 0 && dy === 0) {
      this.sendAccumulator = 0;
      return;
    }
    if (this.sendAccumulator < INPUT_SEND_MS) return;

    const cmd: InputCommand = {
      seq: ++this.seq,
      dx,
      dy,
      dt: Math.min(this.sendAccumulator / 1000, MAX_INPUT_DT),
    };
    this.sendAccumulator = 0;

    // Predict locally right now so movement feels instant, then let the server
    // confirm. Both sides run the identical applyInput().
    applyInput(this.predicted, cmd, this.grid);
    this.pending.push(cmd);
    room.send(C2S.Input, cmd);
  }

  /** Replay unacknowledged inputs on top of the server's authoritative position. */
  private reconcile(room: Room<OfficeState>): void {
    const server = room.state.players.get(room.sessionId);
    if (!server) return;

    // Drop inputs the server has now simulated.
    if (server.lastSeq !== this.lastAck) {
      this.lastAck = server.lastSeq;
      this.pending = this.pending.filter((c) => c.seq > server.lastSeq);
    }

    // Correct EVERY frame, not only when a new ack arrives. Once the player
    // stops moving no further acks come, so gating the correction on lastSeq
    // changing would leave the avatar parked at a wrong position indefinitely.
    const replayed = { x: server.x, y: server.y };
    for (const cmd of this.pending) applyInput(replayed, cmd, this.grid);

    const error = Math.hypot(replayed.x - this.predicted.x, replayed.y - this.predicted.y);
    if (error > HARD_SNAP_PX) {
      this.predicted.x = replayed.x;
      this.predicted.y = replayed.y;
    } else if (error > RECONCILE_SNAP_PX) {
      // Ease out small disagreements instead of visibly teleporting.
      this.predicted.x += (replayed.x - this.predicted.x) * 0.25;
      this.predicted.y += (replayed.y - this.predicted.y) * 0.25;
    }
  }

  // ------------------------------------------------------------------ render
  private syncAvatars(room: Room<OfficeState>): void {
    const now = performance.now();
    const renderAt = now - INTERP_DELAY_MS;
    const live = new Set<string>();

    room.state.players.forEach((player, sessionId) => {
      live.add(sessionId);
      const isSelf = sessionId === room.sessionId;

      let view = this.avatars.get(sessionId);
      if (view && view.look !== player.avatar) this.applyLook(view, player.avatar);
      if (!view) {
        view = this.createAvatar(player.avatar);
        this.avatars.set(sessionId, view);
        if (isSelf && this.following) this.cameras.main.startFollow(view.container, true, 0.15, 0.15);
      }

      let x: number;
      let y: number;
      if (isSelf) {
        x = this.predicted.x;
        y = this.predicted.y;
      } else {
        this.recordSnapshot(sessionId, player.x, player.y, now);
        const at = this.interpolate(sessionId, renderAt, player.x, player.y);
        x = at.x;
        y = at.y;
      }

      this.animate(view, x, y);
      view.container.setPosition(Math.round(x), Math.round(y));
      view.container.setDepth(10 + y / 1000);
      view.container.setAlpha(player.connected ? 1 : 0.35);

      // Names and status icons are HTML pills over the map (ui/stage/MapOverlay).
      const focus = player.status === "focus";
      view.sprite.setTint(focus ? 0x9aa4b2 : 0xffffff);

      if (isSelf && this.hearingGlow) {
        // Centred on the feet, where proximity is measured from... close enough
        // to the position itself (the server measures from x, y).
        this.hearingGlow.setPosition(Math.round(x), Math.round(y));
        this.hearingGlow.setVisible(!focus);
      }
    });

    for (const [id, view] of this.avatars) {
      if (live.has(id)) continue;
      view.container.destroy(true);
      this.avatars.delete(id);
      this.snapshots.delete(id);
    }
  }

  private createAvatar(look: string): AvatarView {
    const sprite = this.add.sprite(0, 0, this.lookTexture(look), "down:0");
    sprite.setScale(AVATAR_SCALE).setOrigin(0.5, AVATAR_ORIGIN_Y);
    const container = this.add.container(0, 0, [sprite]);
    return { container, sprite, look, lastX: NaN, lastY: NaN, dir: "down", walkMs: 0 };
  }

  /** A radial glow the size of the call range, drawn once. */
  private glowTexture(): string {
    const key = "hearing-glow";
    if (this.textures.exists(key)) return key;
    const r = PROXIMITY_ENTER;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = r * 2;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(177,140,255,0.16)");
    g.addColorStop(0.75, "rgba(177,140,255,0.07)");
    g.addColorStop(1, "rgba(177,140,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, r * 2, r * 2);
    this.textures.addCanvas(key, canvas);
    return key;
  }

  /** A texture per look, built once from the code-drawn sprite sheet, with a
   *  named frame per direction and step ("left:2"). */
  private lookTexture(look: string): string {
    const key = `look:${look}`;
    if (this.textures.exists(key)) return key;
    const texture = this.textures.addCanvas(key, avatarSheet(look))!;
    DIRS.forEach((dir, row) => {
      for (let f = 0; f < WALK_FRAMES; f++) texture.add(`${dir}:${f}`, 0, f * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H);
    });
    return key;
  }

  private applyLook(view: AvatarView, look: string): void {
    view.look = look;
    view.sprite.setTexture(this.lookTexture(look), `${view.dir}:0`);
  }

  /** Faces the way the avatar is moving and steps while it moves. */
  private animate(view: AvatarView, x: number, y: number): void {
    const dx = x - view.lastX;
    const dy = y - view.lastY;
    view.lastX = x;
    view.lastY = y;
    const moving = Number.isFinite(dx) && Math.hypot(dx, dy) > 0.15;
    if (moving) {
      view.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      view.walkMs += this.game.loop.delta;
    } else {
      view.walkMs = 0;
    }
    const frame = moving ? Math.floor(view.walkMs / STEP_MS) % WALK_FRAMES : 0;
    view.sprite.setFrame(`${view.dir}:${frame}`);
  }

  // --------------------------------------------------- snapshot interpolation
  private recordSnapshot(id: string, x: number, y: number, now: number): void {
    let buf = this.snapshots.get(id);
    if (!buf) {
      buf = [];
      this.snapshots.set(id, buf);
    }
    const last = buf[buf.length - 1];
    if (!last || last.x !== x || last.y !== y) buf.push({ t: now, x, y });
    // Keep a little more history than the render delay needs.
    while (buf.length > 2 && buf[1]!.t < now - INTERP_DELAY_MS * 3) buf.shift();
  }

  /**
   * Draw remote avatars INTERP_DELAY_MS in the past, between the two snapshots
   * that bracket that moment. This is what turns 20Hz server patches into smooth
   * motion instead of visible stepping.
   */
  private interpolate(id: string, renderAt: number, fallbackX: number, fallbackY: number) {
    const buf = this.snapshots.get(id);
    if (!buf || buf.length === 0) return { x: fallbackX, y: fallbackY };
    if (buf.length === 1) return { x: buf[0]!.x, y: buf[0]!.y };

    for (let i = buf.length - 1; i > 0; i--) {
      const b = buf[i]!;
      const a = buf[i - 1]!;
      if (a.t <= renderAt && renderAt <= b.t) {
        const span = b.t - a.t;
        const f = span > 0 ? (renderAt - a.t) / span : 1;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    // renderAt is newer than everything we have (sender stopped moving): hold
    // at the most recent known position rather than extrapolating into a wall.
    const last = buf[buf.length - 1]!;
    return { x: last.x, y: last.y };
  }

  private publishScreenPositions(): void {
    const cam = this.cameras.main;
    const view = cam.worldView;
    const people: Record<string, ScreenPos> = {};
    for (const [id, v] of this.avatars) {
      // The feet: 16px below the position (bottom of the collision box).
      const wx = v.container.x;
      const wy = v.container.y + 16;
      const x = (wx - view.x) * cam.zoom;
      const y = (wy - view.y) * cam.zoom;
      people[id] = { x, y, wx, wy, visible: x > -200 && y > -200 && x < cam.width + 200 && y < cam.height + 200 };
    }
    positionBus.emit({ people, view: { x: view.x, y: view.y, zoom: cam.zoom, width: cam.width, height: cam.height } });
  }

  // -------------------------------------------------- commands from the UI
  private command(cmd: SceneCommand): void {
    const cam = this.cameras.main;
    const room = this.room;
    switch (cmd.type) {
      case "zoom":
        this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + cmd.step));
        cam.zoomTo(ZOOMS[this.zoomIndex]!, 150);
        break;
      case "recenter":
        this.followSelf();
        break;
      case "panTo": {
        if (cmd.sessionId === room?.sessionId) return this.followSelf();
        const view = this.avatars.get(cmd.sessionId);
        if (view) this.panTo(view.container.x, view.container.y);
        break;
      }
      case "panToPoint":
        this.panTo(cmd.x, cmd.y);
        break;
      case "walkTo":
        if (room && cmd.sessionId !== room.sessionId) this.walkToPerson(cmd.sessionId);
        break;
    }
  }

  private panTo(x: number, y: number): void {
    const cam = this.cameras.main;
    cam.stopFollow();
    this.following = false;
    cam.pan(x, y, 450, "Sine.easeInOut");
  }

  private followSelf(): void {
    const room = this.room;
    const self = room && this.avatars.get(room.sessionId);
    if (!self) return;
    this.following = true;
    this.cameras.main.startFollow(self.container, true, 0.15, 0.15);
  }

  // ---------------------------------------------------------- auto walking
  private planTo(wx: number, wy: number): Array<{ x: number; y: number }> | null {
    const goal = nearestWalkable(this.grid, { tx: Math.floor(wx / TILE_SIZE), ty: Math.floor(wy / TILE_SIZE) });
    if (!goal) return null;
    const from = tileOf(this.predicted.x, this.predicted.y);
    const tiles = findPath(this.grid, from, goal);
    if (!tiles) return null;
    const points = tiles.map(tileCentre);
    // Off-centre, a first diagonal step can clip a corner: line up first.
    const first = tiles[0];
    if (first && first.tx !== from.tx && first.ty !== from.ty) points.unshift(tileCentre(from));
    return points;
  }

  private walkToPoint(wx: number, wy: number): void {
    const waypoints = this.planTo(wx, wy);
    if (!waypoints?.length) return;
    this.autoWalk = { waypoints, replanMs: 0, stuckMs: 0, prevDx: 0, prevDy: 0 };
    const end = waypoints[waypoints.length - 1]!;
    this.targetMarker?.setPosition(end.x, end.y + 16).setVisible(true);
  }

  private walkToPerson(personId: string): void {
    const target = this.room?.state.players.get(personId);
    if (!target) return;
    this.autoWalk = { waypoints: this.planTo(target.x, target.y + 16) ?? [], personId, replanMs: 0, stuckMs: 0, prevDx: 0, prevDy: 0 };
    this.targetMarker?.setVisible(false);
  }

  private stopAutoWalk(): void {
    this.autoWalk = null;
    this.targetMarker?.setVisible(false);
  }

  /** The direction to press this frame to follow the planned path. */
  private steer(room: Room<OfficeState>, dtSec: number): [number, number] {
    const walk = this.autoWalk!;
    const me = this.predicted;

    if (walk.personId) {
      const target = room.state.players.get(walk.personId);
      if (!target) {
        this.stopAutoWalk();
        return [0, 0];
      }
      if (Math.hypot(target.x - me.x, target.y - me.y) <= WALK_TO_STOP_PX) {
        this.stopAutoWalk();
        return [0, 0];
      }
      // They may be moving: re-plan a couple of times a second.
      walk.replanMs += dtSec * 1000;
      if (walk.replanMs > 500) {
        walk.replanMs = 0;
        walk.waypoints = this.planTo(target.x, target.y + 16) ?? walk.waypoints;
      }
    }

    while (walk.waypoints.length) {
      const next = walk.waypoints[0]!;
      // One input step can be ~10px, more than the arrival window, so an axis
      // also counts as reached once we've passed it (the direction flips);
      // otherwise the avatar jitters back and forth around the waypoint.
      const axis = (d: number, prev: number) => (Math.abs(d) <= ARRIVE_PX || Math.sign(d) === -prev ? 0 : Math.sign(d));
      const dx = axis(next.x - me.x, walk.prevDx);
      const dy = axis(next.y - me.y, walk.prevDy);
      if (dx || dy) {
        walk.prevDx = dx;
        walk.prevDy = dy;
        // Walls stop the predicted body; if it isn't getting anywhere, give up.
        const moved = Math.hypot(me.x - (walk.lastX ?? NaN), me.y - (walk.lastY ?? NaN));
        walk.stuckMs = moved > 0.5 || !Number.isFinite(moved) ? 0 : walk.stuckMs + dtSec * 1000;
        walk.lastX = me.x;
        walk.lastY = me.y;
        if (walk.stuckMs > STUCK_MS) break;
        return [dx, dy];
      }
      walk.waypoints.shift();
      walk.prevDx = walk.prevDy = 0;
    }
    this.stopAutoWalk();
    return [0, 0];
  }
}
