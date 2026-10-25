import { useEffect, useRef } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
import { useStore } from "../../store.js";
import { positionBus, type MapFrame } from "../../game/bus.js";
import { sceneBus } from "../../game/sceneBus.js";
import { MAP, drawMapPicture } from "../../game/mapPicture.js";
import { isTyping } from "./Dock.js";
import "./map.css";

const TILE = MAP.tilewidth;
/** Minimap px per tile. */
const MINI = 4;
const W = MAP.width * MINI;
const H = MAP.height * MINI;
/** The minimap redraws at most this often; it doesn't need 60fps. */
const MINI_FRAME_MS = 100;

/**
 * Zoom in/out, back to me, and a minimap (click it to look somewhere). The
 * + / - keys zoom and 0 recentres, except while typing.
 */
export function MapTools() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let base: HTMLCanvasElement | null = null;
    void drawMapPicture(MINI).then((c) => (base = c));

    let last = 0;
    let latest: MapFrame | null = null;
    const draw = () => {
      const ctx = canvas.current?.getContext("2d");
      if (!ctx || !latest) return;
      const { people, view } = latest;
      const k = MINI / TILE;
      ctx.clearRect(0, 0, W, H);
      if (base) ctx.drawImage(base, 0, 0);
      ctx.fillStyle = "rgba(11,13,18,0.35)";
      ctx.fillRect(0, 0, W, H);
      const s = useStore.getState();
      for (const [id, p] of Object.entries(people)) {
        const self = id === s.sessionId;
        ctx.fillStyle = self ? "#b18cff" : s.peers[id] ? "#14f195" : "#e9edf3";
        ctx.beginPath();
        ctx.arc(p.wx * k, p.wy * k, self ? 3 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(233,237,243,0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(view.x * k + 0.5, view.y * k + 0.5, (view.width / view.zoom) * k, (view.height / view.zoom) * k);
    };
    const off = positionBus.on((frame) => {
      latest = frame;
      const now = performance.now();
      if (now - last < MINI_FRAME_MS) return;
      last = now;
      draw();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || useStore.getState().dialog) return;
      if (e.key === "+" || e.key === "=") sceneBus.send({ type: "zoom", step: 1 });
      else if (e.key === "-" || e.key === "_") sceneBus.send({ type: "zoom", step: -1 });
      else if (e.key === "0") sceneBus.send({ type: "recenter" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const lookAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * MAP.width * TILE;
    const y = ((e.clientY - r.top) / r.height) * MAP.height * TILE;
    sceneBus.send({ type: "panToPoint", x, y });
  };

  return (
    <div className="map-tools">
      <div className="minimap">
        <canvas ref={canvas} width={W} height={H} onClick={lookAt} aria-label="Minimap: click to look there" role="img" />
      </div>
      <div className="zoom" role="group" aria-label="Map zoom">
        <button type="button" aria-label="Zoom in (+)" title="Zoom in (+)" onClick={() => sceneBus.send({ type: "zoom", step: 1 })}>
          <Plus size={16} />
        </button>
        <button type="button" aria-label="Zoom out (−)" title="Zoom out (−)" onClick={() => sceneBus.send({ type: "zoom", step: -1 })}>
          <Minus size={16} />
        </button>
        <button type="button" aria-label="Back to me (0)" title="Back to me (0)" onClick={() => sceneBus.send({ type: "recenter" })}>
          <LocateFixed size={16} />
        </button>
      </div>
    </div>
  );
}
