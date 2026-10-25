import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { OfficeScene } from "./OfficeScene.js";
import { roomRef } from "../net/session.js";
import { sceneBus } from "./sceneBus.js";

/**
 * The Phaser game is created ONCE for the page, and only once its host element
 * actually has a size.
 *
 * Two failure modes are being avoided here, both of which present identically as
 * a black screen plus "Framebuffer status: Incomplete Attachment":
 *
 *  1. Booting into a 0x0 parent. Scale.RESIZE immediately sizes the canvas to
 *     the parent, so a parent that has not been laid out yet produces a
 *     zero-width framebuffer; the renderer then fails and the game loop never
 *     starts, leaving the scene stuck in the pending queue forever.
 *  2. Rebuilding the game on every remount. Browsers cap live WebGL contexts,
 *     and React StrictMode's double-mount plus HMR burns through them quickly.
 *
 * The scene reads the room through a stable module-level ref, so it survives
 * reconnects and remounts without ever needing a new context.
 */
const GAME_KEY = "__vo_phaser_game__";

interface GameWindow extends Window {
  [GAME_KEY]?: Phaser.Game | null;
}

const getGame = (): Phaser.Game | null => (window as GameWindow)[GAME_KEY] ?? null;
const setGame = (game: Phaser.Game | null): void => {
  (window as GameWindow)[GAME_KEY] = game;
};

function createGame(el: HTMLElement, width: number, height: number): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: el,
    backgroundColor: "#0b0d12",
    pixelArt: true,
    width,
    height,
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [],
  });
  // Added manually (rather than via `scene: [OfficeScene]`) so the room ref can
  // be handed to the scene as init data.
  game.scene.add("office", OfficeScene, true, { roomRef });
  return game;
}

export function GameCanvas() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const sync = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (!width || !height) return; // not laid out yet — wait for the observer

      const existing = getGame();
      if (!existing) {
        const game = createGame(el, width, height);
        setGame(game);
        if (import.meta.env.DEV) (window as unknown as { __game?: Phaser.Game }).__game = game;
        return;
      }

      // Remount: adopt the existing canvas rather than rebuilding the renderer.
      if (existing.canvas && existing.canvas.parentElement !== el) el.appendChild(existing.canvas);
      existing.scale.resize(width, height);
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);

    // Scrolling over the map zooms it (one step per notch; trackpads send
    // many small deltas, so they're added up). Not passive, so the page itself
    // doesn't scroll or pinch-zoom instead.
    let wheel = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel += e.deltaY;
      if (Math.abs(wheel) < 60) return;
      sceneBus.send({ type: "zoom", step: wheel < 0 ? 1 : -1 });
      wheel = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    // Two-finger pinch on a tablet zooms by the same steps.
    const touches = new Map<number, { x: number; y: number }>();
    let pinchFrom = 0;
    const spread = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) pinchFrom = spread();
    };
    const onMove = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2 || !pinchFrom) return;
      const ratio = spread() / pinchFrom;
      if (ratio > 1.25 || ratio < 0.8) {
        sceneBus.send({ type: "zoom", step: ratio > 1 ? 1 : -1 });
        pinchFrom = spread();
      }
    };
    const onUp = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinchFrom = 0;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div
      className="game-host"
      ref={host}
      tabIndex={0}
      data-map-focus
      // "application": the map handles its own keys (arrows walk), so screen
      // readers pass them through instead of using them to read the page.
      role="application"
      aria-roledescription="map"
      aria-label="Office map. Move with the arrow keys or W A S D."
    />
  );
}

// Without this, editing this module during dev strands the old game and leaks
// another WebGL context.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    const game = getGame();
    setGame(null);
    try {
      game?.destroy(true);
    } catch {
      /* nothing to do */
    }
  });
}
