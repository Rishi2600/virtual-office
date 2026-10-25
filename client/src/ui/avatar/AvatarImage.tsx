import { useEffect, useRef } from "react";
import { avatarSheet, DIRS, FRAME_H, FRAME_W, type Dir } from "../../game/avatarArt.js";
import "./avatar.css";

/**
 * Someone's avatar as a picture: a head-and-shoulders crop in a circle
 * (`variant="face"`), or the whole character (`variant="full"`), drawn from
 * their look with the same code as the map sprite.
 */
export function AvatarImage({
  look,
  size = 32,
  variant = "face",
  dir = "down",
  frame = 0,
  dim = false,
}: {
  look: string;
  size?: number;
  variant?: "face" | "full";
  dir?: Dir;
  frame?: number;
  dim?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const full = variant === "full";
  const w = full ? Math.round((size * FRAME_W) / FRAME_H) : size;
  const h = size;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    const sx = frame * FRAME_W;
    const sy = DIRS.indexOf(dir) * FRAME_H;
    if (full) {
      ctx.drawImage(avatarSheet(look), sx, sy, FRAME_W, FRAME_H, 0, 0, c.width, c.height);
    } else {
      // Head and shoulders: the top 15 art rows, centred in the circle.
      const crop = 15;
      const scale = c.height / crop;
      const dw = FRAME_W * scale;
      ctx.drawImage(avatarSheet(look), sx, sy, FRAME_W, crop, (c.width - dw) / 2, c.height * 0.12, dw, c.height);
    }
  }, [look, w, h, full, dir, frame]);

  return (
    <span className={`avatar-img ${full ? "full" : "face"} ${dim ? "dim" : ""}`} style={{ width: w, height: h }} aria-hidden="true">
      <canvas ref={ref} style={{ width: w, height: h }} />
    </span>
  );
}
