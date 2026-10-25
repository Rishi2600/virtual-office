export interface ScreenPos {
  /** Screen position of the person's feet, in CSS px relative to the map. */
  x: number;
  y: number;
  /** World position (for the minimap and distances). */
  wx: number;
  wy: number;
  visible: boolean;
}

/** What the camera shows: the world point at the map's top-left corner, and the zoom. */
export interface MapView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface MapFrame {
  people: Record<string, ScreenPos>;
  view: MapView;
}

type Listener = (frame: MapFrame) => void;

/**
 * Phaser -> React bridge for everything drawn over the map (name pills, room
 * labels, minimap).
 *
 * These fire every rendered frame, so they deliberately bypass React state:
 * subscribers write `transform` straight onto a ref'd element. Routing 60Hz
 * position updates through the store would re-render the whole UI tree.
 */
class PositionBus {
  private listeners = new Set<Listener>();
  private latest: MapFrame = { people: {}, view: { x: 0, y: 0, zoom: 1, width: 0, height: 0 } };

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.latest);
    return () => this.listeners.delete(listener);
  }

  emit(frame: MapFrame): void {
    this.latest = frame;
    for (const l of this.listeners) l(frame);
  }
}

export const positionBus = new PositionBus();
