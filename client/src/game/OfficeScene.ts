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
  buildCollisionGrid,
  applyInput,
  type CollisionGrid,
  type InputCommand,
  type OfficeState,
} from "@vo/shared";
import { positionBus, type ScreenPos } from "./bus.js";

interface Snapshot {
  t: number;
  x: number;
  y: number;
}

interface AvatarView {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  badge: Phaser.GameObjects.Text;
}

/** Send inputs at ~30Hz rather than every rendered frame. */
const INPUT_SEND_MS = 33;
/** Above this error we stop easing and just snap — something went badly wrong. */
const HARD_SNAP_PX = 48;

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
  private proximityRing?: Phaser.GameObjects.Graphics;
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
    this.load.spritesheet("avatars", "/assets/avatars.png", { frameWidth: 32, frameHeight: 32 });
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

    map.createLayer("floor", tileset, 0, 0)?.setDepth(0);
    map.createLayer("solid", tileset, 0, 0)?.setDepth(1);

    this.grid = buildCollisionGrid(officeMap);

    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.setZoom(1.75);
    this.cameras.main.setRoundPixels(true);
    this.cameras.main.setBackgroundColor("#1c1f26");

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

    // A faint ring showing how close you have to be before a call starts. Makes
    // proximity legible instead of something that just happens to you.
    this.proximityRing = this.add.graphics().setDepth(2);
    this.proximityRing.lineStyle(2, 0x6fc3df, 0.35);
    this.proximityRing.strokeCircle(0, 0, PROXIMITY_ENTER);

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
    const dx = (this.down(this.keys.right) ? 1 : 0) - (this.down(this.keys.left) ? 1 : 0);
    const dy = (this.down(this.keys.down) ? 1 : 0) - (this.down(this.keys.up) ? 1 : 0);

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
      if (!view) {
        view = this.createAvatar(player.name, player.avatar);
        this.avatars.set(sessionId, view);
        if (isSelf) this.cameras.main.startFollow(view.container, true, 0.15, 0.15);
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

      view.container.setPosition(Math.round(x), Math.round(y));
      view.container.setDepth(10 + y / 1000);
      view.container.setAlpha(player.connected ? 1 : 0.35);

      const focus = player.status === "focus";
      const locked = player.lockGroup !== "";
      view.sprite.setTint(focus ? 0x9aa4b2 : locked ? 0xffd479 : 0xffffff);

      const badge = !player.connected
        ? "reconnecting"
        : locked
          ? "private"
          : focus
            ? "focus"
            : player.sharing
              ? "sharing"
              : player.camOn
                ? "video"
                : !player.micOn
                  ? "muted"
                  : "";
      if (view.badge.text !== badge) {
        view.badge.setText(badge);
        view.badge.setVisible(badge.length > 0);
      }

      if (isSelf && this.proximityRing) {
        this.proximityRing.setPosition(Math.round(x), Math.round(y));
        this.proximityRing.setVisible(!focus);
      }
    });

    for (const [id, view] of this.avatars) {
      if (live.has(id)) continue;
      view.container.destroy(true);
      this.avatars.delete(id);
      this.snapshots.delete(id);
    }
  }

  private createAvatar(name: string, frame: number): AvatarView {
    const sprite = this.add.sprite(0, 0, "avatars", frame);
    const label = this.add
      .text(0, 18, name, { fontFamily: "monospace", fontSize: "10px", color: "#f2f4f8" })
      .setOrigin(0.5, 0);
    label.setShadow(0, 1, "#11141a", 2);
    const badge = this.add
      .text(0, -22, "", { fontFamily: "monospace", fontSize: "9px", color: "#ffd479" })
      .setOrigin(0.5, 0)
      .setVisible(false);

    const container = this.add.container(0, 0, [sprite, label, badge]);
    return { container, sprite, label, badge };
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
    const out: Record<string, ScreenPos> = {};
    for (const [id, view] of this.avatars) {
      const x = (view.container.x - cam.worldView.x) * cam.zoom;
      const y = (view.container.y - cam.worldView.y) * cam.zoom;
      out[id] = {
        x,
        y,
        visible: x > -200 && y > -200 && x < cam.width + 200 && y < cam.height + 200,
      };
    }
    positionBus.emit(out);
  }
}
