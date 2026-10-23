export interface ScreenPos {
  x: number;
  y: number;
  visible: boolean;
}

type Listener = (positions: Record<string, ScreenPos>) => void;

/**
 * Phaser -> React bridge for the floating video bubbles.
 *
 * These fire every rendered frame, so they deliberately bypass React state:
 * subscribers write `transform` straight onto a ref'd element. Routing 60Hz
 * position updates through the store would re-render the whole UI tree.
 */
class PositionBus {
  private listeners = new Set<Listener>();
  private latest: Record<string, ScreenPos> = {};

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.latest);
    return () => this.listeners.delete(listener);
  }

  emit(positions: Record<string, ScreenPos>): void {
    this.latest = positions;
    for (const l of this.listeners) l(positions);
  }
}

export const positionBus = new PositionBus();
