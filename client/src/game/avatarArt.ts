import { AVATAR_PARTS, defaultLook, parseLook, type AvatarLook } from "@vo/shared";

/**
 * Avatar art, drawn in code (owner decision: we make our own art). A
 * character is 16x24 "art pixels", built from layers (skin, hair, top,
 * bottom, extra), seen from 4 directions with a 4-frame walk cycle, and given
 * a 1px dark outline so it reads on any floor. The game draws it at 2x.
 *
 * Palette sizes must match AVATAR_PARTS in shared/src/avatar.ts.
 */
export const SKINS = ["#f6d1b5", "#e2b08d", "#c38a63", "#9a6646", "#6b4430"];
export const HAIR_STYLES = ["Short", "Long", "Bun", "Buzz", "Curly"];
export const HAIR_COLORS = ["#2b1d16", "#5a3a24", "#a8642f", "#d9b65f", "#c9ccd3", "#7c4dff"];
export const TOPS = ["#9945ff", "#14b87a", "#3b82f6", "#ef6b6b", "#f2b13b", "#e6e8ee", "#2f3542"];
export const BOTTOMS = ["#2a3140", "#3b4e7a", "#5b4636", "#1f2937"];
export const EXTRAS = ["None", "Glasses", "Headphones", "Cap"];

if (
  SKINS.length !== AVATAR_PARTS.skin || HAIR_STYLES.length !== AVATAR_PARTS.hairStyle ||
  HAIR_COLORS.length !== AVATAR_PARTS.hairColor || TOPS.length !== AVATAR_PARTS.top ||
  BOTTOMS.length !== AVATAR_PARTS.bottom || EXTRAS.length !== AVATAR_PARTS.extra
) {
  throw new Error("avatarArt palettes don't match AVATAR_PARTS");
}

export type Dir = "down" | "left" | "right" | "up";
export const DIRS: Dir[] = ["down", "left", "right", "up"];
/** Frames per direction: stand, step, stand, other step. */
export const WALK_FRAMES = 4;
/** One outlined frame, in art pixels. */
export const FRAME_W = 18;
export const FRAME_H = 26;

const shade = (hex: string, f: number) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.min(255, Math.round(v * f));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

/** Draws the un-outlined 16x24 character with its top-left at (ox, oy). */
function drawRaw(ctx: CanvasRenderingContext2D, a: AvatarLook, dir: Dir, frame: number, ox: number, oy: number) {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x, oy + y, w, h);
  };
  const skin = SKINS[a.skin]!, hair = HAIR_COLORS[a.hairColor]!, top = TOPS[a.top]!, bot = BOTTOMS[a.bottom]!;
  const step = frame % 2 === 1; // frames 1 and 3 are mid-step
  const lead = frame === 1 ? 1 : -1;

  // legs + shoes: on a step one leg lifts (front/back) or splits (sideways)
  const leg = (x: number, lift: number, c: string) => {
    px(x, 17 + lift, 3, 4 - lift, c);
    px(x, 21, 3, 1, "#151820");
  };
  if (!step) {
    leg(5, 0, bot);
    leg(8, 0, shade(bot, 0.85));
  } else if (dir === "left" || dir === "right") {
    leg(4 + (lead > 0 ? 0 : 1), 0, bot);
    leg(8 + (lead > 0 ? 1 : 0), 1, shade(bot, 0.85));
  } else {
    leg(5, lead > 0 ? 1 : 0, bot);
    leg(8, lead > 0 ? 0 : 1, shade(bot, 0.85));
  }

  // body bobs down a pixel mid-step
  const b = step ? 1 : 0;
  px(4, 11 + b, 8, 6 - b, top);
  px(4, 16, 8, 1, shade(top, 0.75));
  if (dir === "down") px(7, 11 + b, 2, 1, shade(top, 0.8));
  // arms swing on a step
  const swing = step ? lead : 0;
  if (dir === "left") {
    px(6 + swing, 12 + b, 2, 4, shade(top, 0.85));
    px(6 + swing, 16 + b, 2, 1, skin);
  } else if (dir === "right") {
    px(8 - swing, 12 + b, 2, 4, shade(top, 0.85));
    px(8 - swing, 16 + b, 2, 1, skin);
  } else {
    px(2, 12 + b + (swing > 0 ? 1 : 0), 2, 4, shade(top, 0.85));
    px(12, 12 + b + (swing < 0 ? 1 : 0), 2, 4, shade(top, 0.85));
    px(2, 16 + b, 2, 1, skin);
    px(12, 16 + b, 2, 1, skin);
  }

  // head
  const h = b; // head bobs with the body
  px(4, 3 + h, 8, 8, skin);
  px(4, 10 + h, 8, 1, shade(skin, 0.85));
  if (dir === "down") {
    px(6, 7 + h, 1, 1, "#1b1b22");
    px(9, 7 + h, 1, 1, "#1b1b22");
    px(7, 9 + h, 2, 1, shade(skin, 0.7));
  }
  if (dir === "left") px(5, 7 + h, 1, 1, "#1b1b22");
  if (dir === "right") px(10, 7 + h, 1, 1, "#1b1b22");

  // hair
  const style = a.hairStyle, hd = shade(hair, 0.8);
  if (style !== 3) {
    px(4, 2 + h, 8, 3, hair);
    px(3, 3 + h, 1, 4, hair);
    px(12, 3 + h, 1, 4, hair);
  } else {
    px(4, 3 + h, 8, 1, hair);
  }
  if (dir === "up") {
    px(4, 3 + h, 8, 7, hair);
    px(4, 9 + h, 8, 1, hd);
  }
  if (dir === "left") px(8, 3 + h, 4, 5, hair);
  if (dir === "right") px(4, 3 + h, 4, 5, hair);
  if (style === 1) {
    px(3, 7 + h, 1, 6, hair);
    px(12, 7 + h, 1, 6, hair);
    if (dir === "up") px(4, 10 + h, 8, 3, hair);
  }
  if (style === 2) {
    px(6, 0 + h, 4, 2, hair);
    px(7, -1 + h, 2, 1, hd);
  }
  if (style === 4) {
    px(3, 2 + h, 10, 2, hair);
    px(2, 4 + h, 1, 3, hair);
    px(13, 4 + h, 1, 3, hair);
    px(5, 1 + h, 2, 1, hd);
    px(9, 1 + h, 2, 1, hd);
  }

  // extra
  if (a.extra === 1 && dir !== "up") {
    if (dir === "down") {
      px(5, 6 + h, 3, 2, "#111");
      px(8, 6 + h, 3, 2, "#111");
      px(6, 7 + h, 1, 1, "#9fd3ff");
      px(9, 7 + h, 1, 1, "#9fd3ff");
    } else px(dir === "left" ? 4 : 9, 6 + h, 3, 2, "#111");
  }
  if (a.extra === 2) {
    px(3, 3 + h, 10, 1, "#30343f");
    px(2, 5 + h, 2, 4, "#30343f");
    px(12, 5 + h, 2, 4, "#30343f");
    px(2, 6 + h, 1, 2, "#9945ff");
    px(13, 6 + h, 1, 2, "#9945ff");
  }
  if (a.extra === 3) {
    px(3, 1 + h, 10, 3, "#9945ff");
    if (dir === "down") px(4, 4 + h, 8, 1, "#7a2fe0");
    if (dir === "left") px(1, 3 + h, 3, 1, "#7a2fe0");
    if (dir === "right") px(12, 3 + h, 3, 1, "#7a2fe0");
  }
}

/** Adds a 1px dark outline around everything opaque in the region. */
function outline(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number) {
  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  const out = new Uint8ClampedArray(d);
  const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3]!);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (alpha(x, y)) continue;
      if (alpha(x - 1, y) || alpha(x + 1, y) || alpha(x, y - 1) || alpha(x, y + 1)) {
        const k = (y * w + x) * 4;
        out[k] = 11;
        out[k + 1] = 13;
        out[k + 2] = 18;
        out[k + 3] = 255;
      }
    }
  ctx.putImageData(new ImageData(out, w, h), x0, y0);
}

const lookOf = (look: string, seed = look) => parseLook(look) ?? defaultLook(seed);

/**
 * The full sprite sheet for a look: columns are walk frames, rows are
 * directions (DIRS order), each FRAME_W x FRAME_H with outline. Cached.
 */
const sheets = new Map<string, HTMLCanvasElement>();
export function avatarSheet(look: string): HTMLCanvasElement {
  const cached = sheets.get(look);
  if (cached) return cached;
  const a = lookOf(look);
  const c = document.createElement("canvas");
  c.width = FRAME_W * WALK_FRAMES;
  c.height = FRAME_H * DIRS.length;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  DIRS.forEach((dir, row) => {
    for (let f = 0; f < WALK_FRAMES; f++) {
      drawRaw(ctx, a, dir, f, f * FRAME_W + 1, row * FRAME_H + 1);
      outline(ctx, f * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H);
    }
  });
  sheets.set(look, c);
  return c;
}

/** Draws one frame of a look, scaled, with a soft floor shadow (for HTML use). */
export function drawAvatarFrame(
  ctx: CanvasRenderingContext2D,
  look: string,
  dir: Dir = "down",
  frame = 0,
  scale = 1,
  x = 0,
  y = 0,
) {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(x + 4 * scale, y + 23 * scale, 10 * scale, 2 * scale);
  ctx.drawImage(
    avatarSheet(look),
    frame * FRAME_W,
    DIRS.indexOf(dir) * FRAME_H,
    FRAME_W,
    FRAME_H,
    x,
    y,
    FRAME_W * scale,
    FRAME_H * scale,
  );
}
