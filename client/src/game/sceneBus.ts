/**
 * Commands from the React UI to the Phaser scene (the reverse direction of
 * bus.ts): "show me Bob", "walk me to Bob", zoom, give the map keyboard focus.
 * The scene subscribes once; the UI just calls the functions.
 */
export type SceneCommand =
  | { type: "panTo"; sessionId: string }
  | { type: "panToPoint"; x: number; y: number }
  | { type: "walkTo"; sessionId: string }
  | { type: "zoom"; step: 1 | -1 }
  | { type: "recenter" };

type Listener = (cmd: SceneCommand) => void;
const listeners = new Set<Listener>();

export const sceneBus = {
  on(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  send(cmd: SceneCommand): void {
    for (const l of listeners) l(cmd);
  },
};

/** Puts keyboard focus back on the map so arrow keys / WASD move you again. */
export function focusMap(): void {
  (document.activeElement as HTMLElement | null)?.blur();
  document.querySelector<HTMLElement>("[data-map-focus]")?.focus({ preventScroll: true });
}
